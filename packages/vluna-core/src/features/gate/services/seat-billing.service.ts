import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Kysely } from 'kysely'
import type { Database } from '../../../types/database.js'
import { setRlsSession } from '../../../db/index.js'
import { DEFAULT_BUNDLE_KEY } from '../../../constants/billing.js'
import { runInTransaction, parseOptionalNonNegativeInt } from './gate.utils.js'
import { normalizeIdentifier } from '../../../utils/identifiers.js'
import { GateService } from './gate.service.js'
import { WILDCARD_FEATURE_CODE } from './gate.types.js'

const DEFAULT_INTERVAL_SEC = 24 * 60 * 60

type SeatPolicyRow = {
  bundle_id: string
  policy_id: string
  feature_code: string
  limit_count: unknown
  window_sec: number | string
  status: string
  metadata: Record<string, unknown> | null
}

type SeatBillingPolicy = {
  bundleId: string
  policyId: string
  seatFeatureCode: string
  limitCount: number
  windowSec: number
  billingFeatureCode: string
  billingMeterCode: string
  billingMode: 'assigned' | 'active_window'
}

@Injectable()
export class SeatBillingService {
  private readonly logger = new Logger(SeatBillingService.name)

  constructor(@Inject(GateService) private readonly gateService: GateService) {}

  async emitSeatUsageSnapshots(
    db: Kysely<Database>,
    params: { realmId: string; asOf: Date; intervalSec?: number },
  ): Promise<{ accountsConsidered: number; ratingsEmitted: number; skipped: number; failed: number }> {
    const intervalSec = params.intervalSec ?? DEFAULT_INTERVAL_SEC
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      throw new Error('seat billing interval must be positive')
    }

    const windowEndMs = Math.floor(params.asOf.getTime() / (intervalSec * 1000)) * intervalSec * 1000
    const windowStartMs = windowEndMs - intervalSec * 1000
    if (windowStartMs <= 0) {
      return { accountsConsidered: 0, ratingsEmitted: 0, skipped: 0, failed: 0 }
    }

    const windowEnd = new Date(windowEndMs)
    const windowStart = new Date(windowStartMs)

    const { defaultBundleId, policiesByBundle, accounts } = await db.transaction().execute(async (trx) => {
      await setRlsSession(trx, { realmId: params.realmId, isRealmAdmin: true })

      const defaultBundle = await trx
        .selectFrom('gate_policy_bundles')
        .select(['bundle_id'])
        .where('realm_id', '=', params.realmId)
        .where('bundle_key', '=', DEFAULT_BUNDLE_KEY)
        .executeTakeFirst()

      const defaultBundleId = defaultBundle?.bundle_id ? String(defaultBundle.bundle_id) : null
      if (!defaultBundleId) {
        throw new Error('default bundle not configured for realm')
      }

      const policyRows = (await trx
        .selectFrom('gate_policies')
        .innerJoin('gate_policy_bundles as b', 'b.bundle_id', 'gate_policies.bundle_id')
        .select([
          'gate_policies.bundle_id as bundle_id',
          'gate_policies.policy_id as policy_id',
          'gate_policies.feature_code as feature_code',
          'gate_policies.limit_count as limit_count',
          'gate_policies.window_sec as window_sec',
          'gate_policies.status as status',
          'gate_policies.metadata as metadata',
        ])
        .where('gate_policies.realm_id', '=', params.realmId)
        .where('gate_policies.kind', '=', 'seats')
        .where('gate_policies.status', '<>', 'disabled')
        .where('b.status', '=', 'active')
        .execute()) as SeatPolicyRow[]

      const policiesByBundle = new Map<string, SeatPolicyRow[]>()
      for (const row of policyRows) {
        const bundleId = String(row.bundle_id)
        const list = policiesByBundle.get(bundleId) ?? []
        const rowFeatureScope = this.normalizeSeatPolicyFeatureCode(row.feature_code)
        const existingIndex = list.findIndex(
          (entry) => this.normalizeSeatPolicyFeatureCode(entry.feature_code) === rowFeatureScope)
        if (existingIndex === -1) {
          list.push(row)
        } else if (this.rankPolicyStatus(row.status) < this.rankPolicyStatus(list[existingIndex]?.status ?? 'disabled')) {
          list[existingIndex] = row
        }
        policiesByBundle.set(bundleId, list)
      }

      const accounts = await trx
        .selectFrom('billing_accounts')
        .select(['billing_account_id', 'current_bundle_id'])
        .where('realm_id', '=', params.realmId)
        .execute()

      return {
        defaultBundleId,
        policiesByBundle,
        accounts: accounts.map((row) => ({
          billingAccountId: String(row.billing_account_id),
          bundleId: row.current_bundle_id ? String(row.current_bundle_id) : null,
        })),
      }
    })

    let accountsConsidered = 0
    let ratingsEmitted = 0
    let skipped = 0
    let failed = 0

    for (const account of accounts) {
      accountsConsidered += 1
      const bundleId = account.bundleId ?? defaultBundleId
      const policyRows = policiesByBundle.get(bundleId) ?? []
      if (policyRows.length === 0) {
        skipped += 1
        continue
      }

      for (const policyRow of policyRows) {
        const policy = this.parseSeatBillingPolicy(policyRow, windowEnd)
        if (!policy) {
          skipped += 1
          continue
        }

        try {
          const seatCount = await this.countSeatsForAccount(db, {
            realmId: params.realmId,
            billingAccountId: account.billingAccountId,
            policy,
            windowEnd,
          })

          if (seatCount <= 0) {
            skipped += 1
            continue
          }

          const idempotencyKey = `seat.usage.v1:${account.billingAccountId}:${policy.seatFeatureCode}:${policy.billingMeterCode}:${windowStart.toISOString()}`
          const body = {
            feature_code: policy.billingFeatureCode,
            quantity_minor: String(seatCount),
            meters: [
              {
                meter_code: policy.billingMeterCode,
                quantity_minor: String(seatCount),
              },
            ],
            metadata: {
              seat_billing: {
                mode: policy.billingMode,
                window_start: windowStart.toISOString(),
                window_end: windowEnd.toISOString(),
                policy_id: policy.policyId,
                seat_feature_code: policy.seatFeatureCode,
                limit_count: policy.limitCount,
                seat_window_sec: policy.windowSec,
              },
            },
          }

          await this.gateService.ingestInternal(
            db,
            { realmId: params.realmId, billingAccountId: account.billingAccountId },
            body,
            idempotencyKey,
            'activity',
          )

          ratingsEmitted += 1
        } catch (error) {
          failed += 1
          this.logger.warn(`seat usage billing failed for account=${account.billingAccountId}, feature=${policy.seatFeatureCode}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    return { accountsConsidered, ratingsEmitted, skipped, failed }
  }

  private async countSeatsForAccount(
    db: Kysely<Database>,
    params: { realmId: string; billingAccountId: string; policy: SeatBillingPolicy; windowEnd: Date },
  ): Promise<number> {
    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId: params.realmId, billingAccountId: params.billingAccountId })

      const query = trx
        .selectFrom('gate_seats')
        .select((eb) => eb.fn.countAll<number>().as('seat_count'))
        .where('billing_account_id', '=', params.billingAccountId)
        .$if(params.policy.seatFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
        .$if(params.policy.seatFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', params.policy.seatFeatureCode))
        .where('state', '=', 'active')

      if (params.policy.billingMode === 'active_window') {
        const cutoff = new Date(params.windowEnd.getTime() - params.policy.windowSec * 1000)
        query.where('last_seen_at', '>=', cutoff)
      }

      const row = await query.executeTakeFirst()
      const count = Number(row?.seat_count ?? 0)
      if (!Number.isFinite(count) || count < 0) {
        return 0
      }
      return Math.floor(count)
    })
  }

  private parseSeatBillingPolicy(row: SeatPolicyRow, windowEnd: Date): SeatBillingPolicy | null {
    const metadata = row.metadata ?? null
    const billingFeatureCodeRaw = typeof metadata?.billing_feature_code === 'string'
      ? metadata?.billing_feature_code
      : ''
    const billingMeterCodeRaw = typeof metadata?.billing_meter_code === 'string'
      ? metadata?.billing_meter_code
      : ''

    if (!billingFeatureCodeRaw || !billingMeterCodeRaw) {
      return null
    }

    let billingFeatureCode: string
    let billingMeterCode: string
    let seatFeatureCode: string
    try {
      seatFeatureCode = this.normalizeSeatPolicyFeatureCode(row.feature_code)
      billingFeatureCode = normalizeIdentifier(billingFeatureCodeRaw, 'feature_code')
      billingMeterCode = normalizeIdentifier(billingMeterCodeRaw, 'meter_code')
    } catch (error) {
      this.logger.warn(`seat billing metadata invalid: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    const limitCount = this.parseSeatLimit(row.limit_count, row.policy_id)
    const windowSec = this.parseWindowSec(row.window_sec, row.policy_id)

    const billingModeRaw = typeof metadata?.billing_mode === 'string' ? metadata.billing_mode.trim().toLowerCase() : ''
    const billingMode = billingModeRaw === 'active_window'
      ? 'active_window'
      : billingModeRaw === 'assigned'
        ? 'assigned'
        : windowSec > 0
          ? 'active_window'
          : 'assigned'

    if (billingMode === 'active_window' && windowSec <= 0) {
      this.logger.warn(`seat billing policy ${row.policy_id} cannot use active_window with window_sec <= 0 (as_of=${windowEnd.toISOString()})`)
      return null
    }

    return {
      bundleId: String(row.bundle_id),
      policyId: String(row.policy_id),
      seatFeatureCode,
      limitCount,
      windowSec,
      billingFeatureCode,
      billingMeterCode,
      billingMode,
    }
  }

  private parseSeatLimit(raw: unknown, policyId: string): number {
    if (raw === null || raw === undefined) {
      throw new Error(`seats policy ${policyId} missing limit_count`)
    }
    const parsed = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : '')
    if (!Number.isFinite(parsed) || parsed < -1) {
      throw new Error(`seats policy ${policyId} invalid limit_count`)
    }
    return Math.floor(parsed)
  }

  private parseWindowSec(raw: number | string, policyId: string): number {
    const parsed = parseOptionalNonNegativeInt(raw, 'window_sec')
    if (parsed === undefined) {
      throw new Error(`seats policy ${policyId} missing window_sec`)
    }
    return Math.floor(parsed)
  }

  private rankPolicyStatus(status: string): number {
    switch (status) {
      case 'default':
        return 0
      case 'ceiling':
        return 1
      case 'assignable':
        return 2
      default:
        return 3
    }
  }

  private normalizeSeatPolicyFeatureCode(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('feature_code must be a string')
    }
    const trimmed = value.trim()
    if (!trimmed) {
      throw new Error('feature_code is required')
    }
    if (trimmed === WILDCARD_FEATURE_CODE) {
      return WILDCARD_FEATURE_CODE
    }
    return normalizeIdentifier(trimmed, 'feature_code')
  }
}
