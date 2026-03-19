import { Injectable, Logger } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import { db, REALM_ADMIN_PLACEHOLDER_ACCOUNT, setRlsSession } from '../db/index.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import type { Database } from '../types/database.js'
import { BillingPeriodService } from '../services/billing-period.service.js'
import { InvoiceProjectionService } from '../services/invoice-projection.service.js'
import { sendInvoiceToPaymentProvider } from '../services/invoice-outbound.service.js'
import { OverageCloseoutService } from '../services/overage-closeout.service.js'

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const DEFAULT_INTERVAL_MS = readPositiveInt(process.env.VLUNA_BILLING_CLOSEOUT_SWEEP_INTERVAL_MS, 30_000)
const DEFAULT_LIMIT = readPositiveInt(process.env.VLUNA_BILLING_CLOSEOUT_SWEEP_LIMIT, 50)
const FALLBACK_GRANT_CLEANUP_GUARD_MS = readPositiveInt(process.env.VLUNA_FALLBACK_GRANT_CLEANUP_GUARD_MS, 48 * 60 * 60 * 1000)

type BillingMode = 'prepaid' | 'postpaid' | 'hybrid'

function readBillingMode(metadata: unknown): BillingMode {
  if (!metadata || typeof metadata !== 'object') return 'prepaid'
  const rule = (metadata as Record<string, unknown>).rule
  if (!rule || typeof rule !== 'object') return 'prepaid'
  const raw = (rule as Record<string, unknown>).billing_mode
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v === 'postpaid' || v === 'hybrid' ? v : 'prepaid'
}

@Injectable()
export class BillingCloseoutSweepTask implements PeriodicTaskDefinition {
  readonly name = 'billing-closeout-sweep'
  readonly intervalMs = DEFAULT_INTERVAL_MS
  readonly runOnStart = false

  private readonly logger = new Logger(BillingCloseoutSweepTask.name)
  private readonly billingPeriodService = new BillingPeriodService()
  private readonly invoiceProjection = new InvoiceProjectionService(this.billingPeriodService)
  private readonly overageCloseout = new OverageCloseoutService()

  private async cleanupOldFallbackGrants(
    trx: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; billingAccountIds: string[]; now: Date },
  ): Promise<number> {
    const cutoff = new Date(params.now.getTime() - FALLBACK_GRANT_CLEANUP_GUARD_MS)
    let closedCount = 0

    for (const billingAccountId of params.billingAccountIds) {
      await setRlsSession(trx, { realmId: params.realmId, billingAccountId, isRealmAdmin: true })

      const currentPeriod = await this.billingPeriodService.ensureBillingPeriodInstance(trx, {
        realmId: params.realmId,
        billingAccountId,
        at: params.now,
      })

      const candidates = await trx
        .selectFrom('ledger_grants as g')
        .select(['g.grant_id', 'g.window_start', 'g.window_end'])
        .where('g.billing_account_id', '=', billingAccountId)
        .where('g.kind', '=', 'fallback')
        .where('g.issuance_status', '!=', 'closed')
        .where('g.pending_reserved_xusd', '=', '0')
        .where('g.window_end', 'is not', null)
        .where('g.window_end', '<', cutoff)
        .where((eb) =>
          eb.or([
            eb('g.window_start', 'is', null),
            eb('g.window_start', '!=', currentPeriod.periodStart),
            eb('g.window_end', '!=', currentPeriod.periodEnd),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('billing_rating_allocations as a')
                .select(sql`1`.as('one'))
                .whereRef('a.grant_id', '=', 'g.grant_id')
                .where('a.settlement_state', 'in', ['pending', 'settling']),
            ),
          ),
        )
        .orderBy('g.window_end', 'asc')
        .limit(DEFAULT_LIMIT)
        .execute()

      if (candidates.length === 0) continue

      const grantIds = candidates.map((row) => String(row.grant_id))
      const updated = await trx
        .updateTable('ledger_grants')
        .set({
          issuance_status: 'closed',
          closure_kind: 'none',
          closed_at: params.now,
          updated_at: params.now,
          metadata: sql`coalesce(ledger_grants.metadata, '{}'::jsonb) || ${JSON.stringify({
            closure: {
              kind: 'sweep_cleanup',
              at: params.now.toISOString(),
              reason: 'fallback grant does not match current billing period; closing to avoid stale buckets',
            },
          })}::jsonb`,
        })
        .where('grant_id', 'in', grantIds)
        .executeTakeFirst()

      closedCount += Number(updated.numUpdatedRows ?? 0)
    }

    return closedCount
  }

  async run(): Promise<void> {
    const dbHandle = db()
    const realms = await dbHandle
      .selectFrom('realms')
      .select(['realm_id'])
      .where('status', '=', 'active')
      .orderBy('realm_id', 'asc')
      .execute()

    const now = new Date()

    let periodsFrozen = 0
    let waived = 0
    let invoicesProposed = 0
    let invoicesSent = 0
    let fallbackCleaned = 0

    for (const row of realms) {
      const realmId = String(row.realm_id)
      const stats = await dbHandle.transaction().execute(async (trx) => {
        await setRlsSession(trx, {
          realmId,
          billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT,
          isRealmAdmin: true,
        })

        const due = await trx
          .selectFrom('billing_periods')
          .select(['billing_period_id', 'billing_account_id'])
          .where('realm_id', '=', realmId)
          .where('status', '=', 'open')
          .where(sql<boolean>`billing_periods.period_end + make_interval(secs => billing_periods.grace_window_seconds) <= ${now}`)
          .orderBy('period_end', 'asc')
          .limit(DEFAULT_LIMIT)
          .execute()

        let frozenHere = 0
        const touchedAccounts = new Set<string>()
        for (const p of due) {
          touchedAccounts.add(String(p.billing_account_id))
          await setRlsSession(trx, { realmId, billingAccountId: String(p.billing_account_id), isRealmAdmin: true })
          const ok = await this.billingPeriodService.freezeIfDue(trx, { billingPeriodId: String(p.billing_period_id), now })
          if (ok) frozenHere += 1
        }

        await setRlsSession(trx, {
          realmId,
          billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT,
          isRealmAdmin: true,
        })

        const frozen = await trx
          .selectFrom('billing_periods as bp')
          .leftJoin('billing_period_closeouts as bpc', (join) =>
            join
              .onRef('bpc.billing_period_id', '=', 'bp.billing_period_id')
              .on('bpc.mode', '=', sql.lit('waive')),
          )
          .select(['bp.billing_period_id', 'bp.billing_account_id', 'bp.metadata', 'bpc.billing_period_closeout_id'])
          .where('bp.realm_id', '=', realmId)
          .where('bp.status', '=', 'frozen')
          .orderBy('bp.period_end', 'asc')
          .limit(DEFAULT_LIMIT)
          .execute()

        let waivedHere = 0
        let proposedHere = 0
        let sentHere = 0

        for (const p of frozen) {
          const billingAccountId = String(p.billing_account_id)
          touchedAccounts.add(billingAccountId)
          const mode = readBillingMode(p.metadata)

          await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

          if (mode === 'prepaid') {
            if (!p.billing_period_closeout_id) {
              const res = await this.overageCloseout.closeoutWaiveForBillingPeriodId(trx, { billingPeriodId: String(p.billing_period_id), now })
              if (res.ok) waivedHere += 1
            }
            continue
          }

          const proposal = await this.invoiceProjection.createInvoiceProposalForBillingPeriodId(trx, {
            billingPeriodId: String(p.billing_period_id),
            at: now,
          })
          proposedHere += 1

          const invoiceRow = await trx
            .selectFrom('billing_invoices')
            .select(['total_minor', 'provider', 'provider_invoice_id'])
            .where('billing_invoice_id', '=', proposal.billingInvoiceId)
            .executeTakeFirst()

          const totalMinor = invoiceRow?.total_minor ? BigInt(String(invoiceRow.total_minor)) : 0n
          if (totalMinor <= 0n) continue
          if (invoiceRow?.provider && invoiceRow?.provider_invoice_id) continue

          await sendInvoiceToPaymentProvider(trx, {
            realmId,
            billingAccountId,
            billingInvoiceId: proposal.billingInvoiceId,
            finalize: true,
          })
          sentHere += 1
        }

        await setRlsSession(trx, {
          realmId,
          billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT,
          isRealmAdmin: true,
        })
        const cleanedHere = await this.cleanupOldFallbackGrants(trx, {
          realmId,
          billingAccountIds: Array.from(touchedAccounts),
          now,
        })

        return { frozenHere, waivedHere, proposedHere, sentHere, cleanedHere }
      })

      periodsFrozen += stats.frozenHere
      waived += stats.waivedHere
      invoicesProposed += stats.proposedHere
      invoicesSent += stats.sentHere
      fallbackCleaned += stats.cleanedHere
    }

    if (periodsFrozen + waived + invoicesProposed + invoicesSent + fallbackCleaned === 0) {
      this.logger.debug('Billing closeout sweep had no work')
      return
    }
    this.logger.log(
      `Billing closeout sweep completed (periods_frozen=${periodsFrozen} waive_closeouts=${waived} invoices_proposed=${invoicesProposed} invoices_sent=${invoicesSent} fallback_grants_closed=${fallbackCleaned})`,
    )
  }
}
