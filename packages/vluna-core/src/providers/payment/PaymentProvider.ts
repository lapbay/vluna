import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../types/database.js'

export type SyncCounters = {
  products: { created: number; updated: number; skipped: number }
  prices: { created: number; updated: number; archived: number; skipped: number }
  errors: number
}

export type SyncItemNote = {
  kind: 'product' | 'price'
  action: 'create' | 'update' | 'skip' | 'archive' | 'error'
  id?: string
  reason?: string
  details?: Record<string, unknown>
}

export type SyncReport = {
  startedAt: string
  finishedAt: string
  counters: SyncCounters
  notes: SyncItemNote[]
  suggestions?: string[]
}

export type CatalogSyncDirection = 'push' | 'pull'
export type CatalogSyncOptions = {
  dryRun?: boolean
  direction?: CatalogSyncDirection
}

export type ProviderOpContext = {
  traceId?: string
  realmId?: string
  billingAccountId?: string
  idempotencyKey?: string
  db?: Kysely<Database> | Transaction<Database>
}

export interface PaymentProvider {
  /** Stable provider id (e.g. 'stripe'). */
  providerId: string

  /** Ensure a provider customer exists for a billing account and return its id. */
  retrieveCustomer(
    ctx: ProviderOpContext,
    p: { billingAccountId: string; principalId?: string; email?: string; name?: string; metadata?: Record<string, unknown> },
  ): Promise<string>

  /** Optional bootstrap hook to pre-sync products/prices, register webhooks, etc. */
  bootstrap?(ctx: ProviderOpContext): Promise<void>
  /**
   * Catalog sync between local DB and provider catalog.
   */
  syncProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport>
  /**
   * Push local catalog into provider.
   */
  pushProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport>
  /**
   * Pull provider catalog into local DB.
   */
  pullProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport>

  /**
   * Create or ensure webhook endpoints exist for TEST mode.
   */
  registerWebhooks(ctx: ProviderOpContext): Promise<{ id: string; url: string }[]>

  // Placeholders for future flows
  createCheckoutSession(
    ctx: ProviderOpContext,
    p: {
      billingAccountId: string
      principalId?: string
      items: Array<{ catalogPriceId?: string; priceId?: string; quantity: number }>
      successUrl: string
      cancelUrl: string
      metadata?: Record<string, unknown>
    },
  ): Promise<{ checkoutUrl: string; sessionId: string }>
  refundPayment(_ctx: ProviderOpContext, _p: unknown): Promise<unknown>

  createPortalSession(
    ctx: ProviderOpContext,
    p: { billingAccountId: string; principalId?: string; returnUrl: string },
  ): Promise<{ portalUrl: string; sessionId: string }>

  /**
   * Optional invoicing support (provider-managed invoices). Implementations must be idempotent.
   * When implemented, callers are expected to already have created a canonical internal invoice
   * and pass stable internal identifiers via metadata for webhook back-linking.
   */
  sendInvoice?(
    ctx: ProviderOpContext,
    p: {
      billingAccountId: string
      billingInvoiceId: string
      invoiceNumber: string
      currency: string
      dueAt?: Date | null
      lines: Array<{ description: string; amountMinor: string; currency: string; metadata?: Record<string, unknown> }>
      metadata?: Record<string, unknown>
      finalize?: boolean
    },
  ): Promise<{
    providerInvoiceId: string
    providerCustomerId?: string
    hostedInvoiceUrl?: string
    status?: string
    rawProviderPayload?: Record<string, unknown>
  }>
}
