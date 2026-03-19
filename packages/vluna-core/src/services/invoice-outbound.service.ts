import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { isTransaction } from '../features/gate/services/gate.utils.js'
import { RealmConfigService } from '../security/realm-config.service.js'
import { setRlsSession } from '../db/index.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

export async function sendInvoiceToPaymentProvider(
  dbOrTrx: DbOrTrx,
  params: { realmId: string; billingAccountId: string; billingInvoiceId: string; finalize?: boolean; traceId?: string },
): Promise<{ provider: string; providerInvoiceId: string }> {
  if (!isTransaction(dbOrTrx)) {
    return dbOrTrx.transaction().execute((trx) => sendInvoiceToPaymentProvider(trx, params))
  }
  const trx = dbOrTrx

  await setRlsSession(trx, { realmId: params.realmId, billingAccountId: params.billingAccountId, isRealmAdmin: true })

  const invoice = await trx
    .selectFrom('billing_invoices')
    .select([
      'billing_invoice_id',
      'billing_account_id',
      'realm_id',
      'invoice_number',
      'currency',
      'provider',
      'provider_invoice_id',
      'provider_customer_id',
      'status',
      'due_at',
    ])
    .where('billing_invoice_id', '=', params.billingInvoiceId)
    .forUpdate()
    .executeTakeFirst()

  if (!invoice) {
    throw new Error('billing invoice not found')
  }

  if (invoice.provider && invoice.provider_invoice_id) {
    return { provider: invoice.provider, providerInvoiceId: invoice.provider_invoice_id }
  }

  const providerConfig = new RealmConfigService()
  const provider = await providerConfig.getPaymentProvider(params.realmId)
  if (!provider.sendInvoice) {
    throw new Error(`payment_provider_no_invoicing:${provider.providerId}`)
  }

  const lines = await trx
    .selectFrom('billing_invoice_lines')
    .select(['billing_invoice_line_id', 'description', 'total_amount_minor', 'metadata'])
    .where('billing_invoice_id', '=', params.billingInvoiceId)
    .orderBy('billing_invoice_line_id', 'asc')
    .execute()

  const payloadLines = lines
    .map((l) => ({
      description: String(l.description ?? ''),
      amountMinor: String(l.total_amount_minor ?? '0'),
      currency: String(invoice.currency),
      metadata: {
        billing_invoice_line_id: String(l.billing_invoice_line_id),
        ...(typeof l.metadata === 'object' && l.metadata ? (l.metadata as Record<string, unknown>) : {}),
      },
    }))
    .filter((l) => l.description.length > 0)

  const providerResult = await provider.sendInvoice(
    {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      traceId: params.traceId,
      idempotencyKey: `invoice:${params.billingInvoiceId}:send`,
      db: trx,
    },
    {
      billingAccountId: params.billingAccountId,
      billingInvoiceId: params.billingInvoiceId,
      invoiceNumber: String(invoice.invoice_number),
      currency: String(invoice.currency),
      dueAt: invoice.due_at,
      lines: payloadLines,
      metadata: {
        realm_id: params.realmId,
        billing_account_id: params.billingAccountId,
        billing_invoice_id: params.billingInvoiceId,
        invoice_number: String(invoice.invoice_number),
      },
      finalize: params.finalize,
    },
  )

  await trx
    .updateTable('billing_invoices')
    .set({
      provider: provider.providerId,
      provider_invoice_id: providerResult.providerInvoiceId,
      provider_customer_id: providerResult.providerCustomerId ?? invoice.provider_customer_id,
      hosted_invoice_url: providerResult.hostedInvoiceUrl ?? null,
      raw_provider_payload: providerResult.rawProviderPayload ?? sql`billing_invoices.raw_provider_payload`,
      status: providerResult.status
        ? (providerResult.status === 'paid' ? 'paid' : providerResult.status === 'void' ? 'void' : providerResult.status === 'uncollectible' ? 'uncollectible' : 'open')
        : (invoice.status === 'draft' ? 'open' : invoice.status),
      updated_at: sql`now()`,
    })
    .where('billing_invoice_id', '=', params.billingInvoiceId)
    .execute()

  return { provider: provider.providerId, providerInvoiceId: providerResult.providerInvoiceId }
}

