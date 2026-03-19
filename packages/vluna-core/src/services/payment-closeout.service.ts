import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { bigintFromUnknown, isTransaction } from '../features/gate/services/gate.utils.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

function extractFallbackGrantId(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const scope = (metadata as Record<string, unknown>).scope
  if (!scope || typeof scope !== 'object') return null
  const id = (scope as Record<string, unknown>).fallback_grant_id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

export async function closeoutPaidInvoice(
  dbOrTrx: DbOrTrx,
  params: { billingInvoiceId: string; now?: Date },
): Promise<void> {
  if (!isTransaction(dbOrTrx)) {
    await dbOrTrx.transaction().execute((trx) => closeoutPaidInvoice(trx, params))
    return
  }
  const trx = dbOrTrx

  const now = params.now ?? new Date()

  const invoice = await trx
    .selectFrom('billing_invoices')
    .select(['billing_invoice_id', 'realm_id', 'billing_account_id', 'billing_period_id', 'status', 'metadata'])
    .where('billing_invoice_id', '=', params.billingInvoiceId)
    .forUpdate()
    .executeTakeFirst()
  if (!invoice) return
  if (invoice.status !== 'paid') return
  if (!invoice.billing_period_id) return

  const totals = await trx
    .selectFrom('billing_invoice_allocations')
    .select([
      sql`count(*)`.as('allocation_count'),
      sql`coalesce(sum(amount_xusd), 0)`.as('totals_xusd'),
    ])
    .where('billing_invoice_id', '=', params.billingInvoiceId)
    .executeTakeFirstOrThrow()

  const allocationCount = Number(totals.allocation_count ?? 0)
  const totalsXusd = bigintFromUnknown(totals.totals_xusd) ?? 0n

  const overageGrantId = extractFallbackGrantId(invoice.metadata as Record<string, unknown> | null | undefined)

  await trx
    .insertInto('billing_period_closeouts')
    .values({
      realm_id: invoice.realm_id,
      billing_account_id: invoice.billing_account_id,
      billing_period_id: String(invoice.billing_period_id),
      mode: 'invoice',
      status: 'completed',
      overage_grant_id: overageGrantId,
      totals_xusd: totalsXusd.toString(),
      allocation_count: allocationCount,
      started_at: now,
      completed_at: now,
      metadata: {
        billing_invoice_id: String(invoice.billing_invoice_id),
      },
    })
    .onConflict((oc) =>
      oc.columns(['billing_period_id', 'mode']).doUpdateSet({
        status: 'completed',
        overage_grant_id: overageGrantId,
        totals_xusd: totalsXusd.toString(),
        allocation_count: allocationCount,
        completed_at: now,
        updated_at: now,
      }),
    )
    .execute()

  if (overageGrantId) {
    await trx
      .updateTable('ledger_grants')
      .set({
        issuance_status: 'closed',
        closure_kind: 'none',
        closed_at: now,
        updated_at: now,
      })
      .where('grant_id', '=', overageGrantId)
      .execute()
  }
}

