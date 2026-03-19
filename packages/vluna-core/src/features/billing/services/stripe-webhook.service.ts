import type Stripe from 'stripe'
import { sql, type Kysely, type Transaction } from 'kysely'
import { callStripe } from '../../../providers/stripe/client.js'
import type { Database } from '../../../types/database.js'
import { setRlsSession } from '../../../db/index.js'
import {
  processSubscriptionPurchase,
  processOneTimePurchase,
  syncSubscriptionSnapshot,
  type CatalogPriceMapping,
  type PriceQuantities,
  type PurchaseEventContext,
  type SubscriptionSnapshot,
} from '../../../services/billing-purchase.service.js'
import type { RealmStripeRuntime } from '../../../security/realm-config.service.js'
import { ensureBillingAccount } from '../../../security/principal/billing-account.resolver.js'
import { closeoutPaidInvoice } from '../../../services/payment-closeout.service.js'
import { generateInvoiceNumber } from '../../../services/invoice-number.js'
import { BillingPeriodService } from '../../../services/billing-period.service.js'

// ---------- Stripe type helpers ----------
type StripePI = Stripe.PaymentIntent
type StripeInvoice = Stripe.Invoice
type StripeCharge = Stripe.Charge
type StripeRefund = Stripe.Refund
type StripeSession = Stripe.Checkout.Session
type StripeSub = Stripe.Subscription

type StripeObjectForContext = StripePI | StripeInvoice | StripeSession | StripeSub | StripeCharge | StripeRefund

const isPaymentIntent = (o: StripeObjectForContext): o is StripePI => (o as StripePI).object === 'payment_intent'
const isInvoice = (o: StripeObjectForContext): o is StripeInvoice => (o as StripeInvoice).object === 'invoice'
const isCheckoutSession = (o: StripeObjectForContext): o is StripeSession => (o as StripeSession).object === 'checkout.session'
const isSubscription = (o: StripeObjectForContext): o is StripeSub => (o as StripeSub).object === 'subscription'
const isCharge = (o: StripeObjectForContext): o is StripeCharge => (o as StripeCharge).object === 'charge'

function extractInternalBillingInvoiceId(invoice: Stripe.Invoice): string | null {
  const meta = (invoice.metadata as Record<string, unknown> | null | undefined) ?? undefined
  if (!meta) return null
  const candidates = [
    meta.billing_invoice_id,
    meta.billingInvoiceId,
    meta.internal_invoice_id,
    meta.internalInvoiceId,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

function buildSubscriptionSnapshot(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const items = subscription.items?.data ?? []
  return {
    provider: 'stripe',
    externalSubscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : new Date(),
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
    cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    items: items
      .map((item) => {
        const priceId = typeof item.price === 'string' ? item.price : item.price?.id
        if (!priceId) return null
        const quantity = Number(item.quantity ?? 0)
        return {
          providerPriceId: priceId,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        }
      })
      .filter(Boolean) as Array<{ providerPriceId: string; quantity: number }>,
  }
}

function buildPurchaseEventContext(params: {
  eventId: string
  session: Stripe.Checkout.Session
  idempotencyPrefix?: string | null
}): PurchaseEventContext {
  return {
    provider: 'stripe',
    eventId: params.eventId,
    session: {
      id: params.session.id,
      metadata: (params.session.metadata as Record<string, unknown> | null | undefined) ?? undefined,
    },
    idempotencyPrefix: params.idempotencyPrefix ?? null,
  }
}

async function resolveInternalSubscriptionId(
  trx: Transaction<Database>,
  billingAccountId: string,
  externalSubscriptionId: string | null,
): Promise<string | null> {
  if (!externalSubscriptionId) return null
  const row = await trx
    .selectFrom('provider_subscription_links as psl')
    .innerJoin('subscriptions as cs', 'cs.subscription_id', 'psl.subscription_id')
    .select(['cs.subscription_id'])
    .where('psl.provider', '=', 'stripe')
    .where('psl.external_subscription_id', '=', externalSubscriptionId)
    .where('cs.billing_account_id', '=', billingAccountId)
    .executeTakeFirst()
  return row?.subscription_id ? String(row.subscription_id) : null
}

function deriveInvoicePeriod(inv: Stripe.Invoice): { periodStart: Date; periodEnd: Date } | null {
  const lines = inv.lines?.data ?? []
  const candidates = lines
    .map((line) => {
      const start = line.period?.start
      const end = line.period?.end
      if (typeof start !== 'number' || typeof end !== 'number') return null
      if (end <= start) return null
      const isSubscriptionLine =
        line.type === 'subscription' || Boolean(line.subscription) || Boolean(line.subscription_item)
      const duration = end - start
      return { isSubscriptionLine, duration, periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000) }
    })
    .filter(Boolean) as Array<{ isSubscriptionLine: boolean; duration: number; periodStart: Date; periodEnd: Date }>

  if (candidates.length > 0) {
    const preferred = candidates
      .filter((c) => c.isSubscriptionLine)
      .sort((a, b) => b.duration - a.duration)[0]
    const best = preferred ?? candidates.sort((a, b) => b.duration - a.duration)[0]
    return { periodStart: best.periodStart, periodEnd: best.periodEnd }
  }

  if (inv.subscription && typeof inv.subscription !== 'string') {
    const start = inv.subscription.current_period_start
    const end = inv.subscription.current_period_end
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      return { periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000) }
    }
  }

  if (typeof inv.period_start === 'number' && typeof inv.period_end === 'number' && inv.period_end > inv.period_start) {
    return { periodStart: new Date(inv.period_start * 1000), periodEnd: new Date(inv.period_end * 1000) }
  }

  return null
}

const billingPeriodService = new BillingPeriodService()

async function ensureBillingPeriodForStripeInvoice(
  trx: Transaction<Database>,
  params: { realmId: string; billingAccountId: string; periodStart: Date; periodEnd: Date; sourceRef: string },
): Promise<string> {
  const period = await billingPeriodService.ensureBillingPeriodInstance(trx, {
    realmId: params.realmId,
    billingAccountId: params.billingAccountId,
    at: params.periodStart,
  })

  await trx
    .updateTable('billing_periods')
    .set({
      source_period_start: sql`coalesce(billing_periods.source_period_start, ${params.periodStart})`,
      source_period_end: sql`coalesce(billing_periods.source_period_end, ${params.periodEnd})`,
      updated_at: new Date(),
    })
    .where('billing_period_id', '=', period.billingPeriodId)
    .execute()

  return period.billingPeriodId
}

export class StripeWebhookService {

  static async handleCheckoutSessionCompleted(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.CheckoutSessionCompletedEvent,
    pathRealmId: string,
  ): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session
    const stripe = runtime.client

    const billingAccountIdFromMeta = String(
      session.metadata?.billing_account_id ||
        session.client_reference_id ||
        '',
    ).trim()

    const principalIdFromMeta = String(session.metadata?.principal_id || '').trim()
    const realmIdFromMeta = String(session.metadata?.realm_id || '').trim()

    const customerId = normalizeStripeId(session.customer)

    await db.transaction().execute(async (trx) => {
      let billingAccountId = billingAccountIdFromMeta

      const accountRow = billingAccountId
        ? await trx
            .selectFrom('billing_accounts')
            .select(['billing_account_id', 'realm_id'])
            .where('billing_account_id', '=', billingAccountId)
            .executeTakeFirst()
        : null

      // If billing_account_id missing or unknown, try resolving via principal_id + realm_id
      let realmId = pathRealmId || accountRow?.realm_id || realmIdFromMeta || ''
      if (accountRow?.realm_id && pathRealmId && accountRow.realm_id !== pathRealmId) {
        throw new Error('realm_id mismatch between webhook path and billing_account record')
      }
      if ((!billingAccountId || !accountRow) && principalIdFromMeta && realmId) {
        const resolution = await ensureBillingAccount({ realmId, principalId: principalIdFromMeta, autoCreate: true })
        if (resolution) {
          billingAccountId = resolution.billingAccountId
          realmId = resolution.realmId
        }
      }

      if (!billingAccountId) {
        throw new Error('checkout.session.completed missing billing_account_id metadata/client_reference_id/principal_id')
      }

      const shouldProcess = await upsertProviderEvent(trx, billingAccountId, event)
      if (!shouldProcess) return

      realmId = realmId || accountRow?.realm_id || ''
      if (!realmId) {
        throw new Error('checkout.session.completed missing realm_id (billing_accounts lookup + metadata)')
      }

      await setRlsSession(trx, {
        realmId,
        billingAccountId,
        isRealmAdmin: true,
      })

      await upsertProviderCustomer(trx, {
        billingAccountId,
        providerCustomerId: customerId,
      })

      await insertSnapshot(trx, {
        billingAccountId,
        provider: 'stripe',
        entityId: session.id,
        entityKind: 'checkout.session',
        payload: event.data.object,
      })

      let subscription: Stripe.Subscription | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        subscription = await callStripe(
          () => stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] }),
          { op: 'subscriptions.retrieve', traceId: event.id },
        )
        await insertSnapshot(trx, {
          billingAccountId,
          provider: 'stripe',
          entityId: subscription.id,
          entityKind: 'subscription',
          payload: subscription,
        })
      }

      const expandedSession = session.line_items?.data?.length
        ? session
        : await callStripe(
            () =>
              stripe.checkout.sessions.retrieve(session.id, {
                expand: ['line_items.data.price.product'],
              }),
            { op: 'checkout.sessions.retrieve', traceId: event.id },
          )

      const lineItems = expandedSession.line_items?.data || []
      if (lineItems.length === 0) {
        throw new Error('checkout.session has no line items after expansion')
      }

      const priceQuantities = aggregateLineItems(lineItems)
      if (priceQuantities.size === 0) {
        throw new Error('checkout.session line items missing price ids')
      }

      const priceMappings = await fetchCatalogPrices(trx, priceQuantities)
      if (priceMappings.size === 0) {
        throw new Error('No catalog price mapping found for checkout session line items')
      }

      const eventCtx = buildPurchaseEventContext({
        eventId: event.id,
        session,
        idempotencyPrefix: session.payment_intent
          ? `stripe:pi:${session.payment_intent}`
          : `stripe:cs:${session.id}`,
      })

      if (subscription) {
        await processSubscriptionPurchase(trx, {
          billingAccountId,
          realmId,
          subscription: buildSubscriptionSnapshot(subscription),
          priceQuantities,
          priceMappings,
          event: eventCtx,
        })
      } else {
        await processOneTimePurchase(trx, {
          billingAccountId,
          realmId,
          priceQuantities,
          priceMappings,
          event: eventCtx,
        })
      }

      await trx
        .updateTable('provider_events')
        .set({ status: 'processed', processed_at: new Date() })
        .where('provider', '=', 'stripe')
        .where('external_event_id', '=', event.id)
        .execute()
    })
  }

  static async handlePaymentIntentSucceeded(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.PaymentIntentSucceededEvent,
    pathRealmId: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const obj = event.data.object as Stripe.PaymentIntent
      const ctx = await resolveBillingContext(trx, obj, pathRealmId || runtime.realmId, runtime)
      const processed = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!processed) return

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      const pi = await callStripe(
        () =>
          runtime.client.paymentIntents.retrieve(obj.id, {
            expand: ['customer', 'invoice', 'invoice.lines.data.price'],
          }),
        { op: 'paymentIntents.retrieve', traceId: event.id },
      )

      await insertSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        provider: 'stripe',
        entityId: pi.id,
        entityKind: 'payment_intent',
        payload: pi,
      })

      // Ensure provider_customer mapping even if checkout path didn't run first
      if (pi.customer && typeof pi.customer === 'string') {
        await upsertProviderCustomer(trx, {
          billingAccountId: ctx.billingAccountId,
          providerCustomerId: pi.customer,
        })
      }

      const invoiceId = normalizeStripeId(pi.invoice)
      const internalInvoice = invoiceId
        ? await trx
            .selectFrom('billing_invoices')
            .select(['billing_invoice_id'])
            .where('provider', '=', 'stripe')
            .where('provider_invoice_id', '=', invoiceId)
            .where('billing_account_id', '=', ctx.billingAccountId)
            .executeTakeFirst()
        : null
      let subscriptionId: string | null = null
      if (pi.invoice && typeof pi.invoice !== 'string') {
        const sub = pi.invoice.subscription
        if (sub) {
          subscriptionId = normalizeStripeId(sub)
        }
      }

      await trx
        .insertInto('billing_payments')
        .values({
          realm_id: ctx.realmId,
          billing_account_id: ctx.billingAccountId,
          billing_invoice_id: internalInvoice?.billing_invoice_id ? String(internalInvoice.billing_invoice_id) : null,
          provider: 'stripe',
          provider_payment_id: pi.id,
          provider_customer_id: normalizeStripeId(pi.customer),
          provider_invoice_id: normalizeStripeId(invoiceId ?? null),
          provider_subscription_id: subscriptionId,
          status: 'succeeded',
          amount_minor: BigInt(pi.amount_received ?? pi.amount ?? 0).toString(),
          currency: pi.currency.toUpperCase(),
          occurred_at: new Date(pi.created * 1000),
          raw_provider_payload: pi as unknown as Record<string, unknown>,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'provider_payment_id'])
            .where('provider', 'is not', null)
            .where('provider_payment_id', 'is not', null)
            .doUpdateSet({
            billing_account_id: ctx.billingAccountId,
            billing_invoice_id: internalInvoice?.billing_invoice_id ? String(internalInvoice.billing_invoice_id) : null,
            realm_id: ctx.realmId,
            provider_customer_id: normalizeStripeId(pi.customer),
            provider_invoice_id: normalizeStripeId(invoiceId ?? null),
            provider_subscription_id: subscriptionId,
            status: 'succeeded',
            amount_minor: BigInt(pi.amount_received ?? pi.amount ?? 0).toString(),
            currency: pi.currency.toUpperCase(),
            occurred_at: new Date(pi.created * 1000),
            raw_provider_payload: pi as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }),
        )
        .execute()

      // Precompute price info for reuse (invoice may be expanded above)
      const prePriceQuantities = await derivePriceQuantitiesFromPaymentIntent(pi)
      const prePriceMappings = prePriceQuantities.size ? await fetchCatalogPrices(trx, prePriceQuantities) : new Map<string, CatalogPriceMapping>()

      // If subscription is available through invoice, capture it for purchase processing
      let subscription: Stripe.Subscription | null = null
      if (pi.invoice && typeof pi.invoice !== 'string' && pi.invoice.subscription && prePriceMappings.size) {
        const subId = typeof pi.invoice.subscription === 'string' ? pi.invoice.subscription : null
        if (subId) {
          subscription = await callStripe(
            () => runtime.client.subscriptions.retrieve(subId, { expand: ['items.data.price'] }),
            { op: 'subscriptions.retrieve', traceId: event.id },
          )
        }
      }

      const eventCtx = buildPurchaseEventContext({
        eventId: event.id,
        session: { id: 'pi-' + pi.id, metadata: pi.metadata } as Stripe.Checkout.Session,
        idempotencyPrefix: `stripe:pi:${pi.id}`,
      })

      if (subscription) {
        await processSubscriptionPurchase(trx, {
          billingAccountId: ctx.billingAccountId,
          realmId: ctx.realmId,
          subscription: buildSubscriptionSnapshot(subscription),
          priceQuantities: prePriceQuantities,
          priceMappings: prePriceMappings,
          event: eventCtx,
        })
      } else {
        await processOneTimePurchase(trx, {
          billingAccountId: ctx.billingAccountId,
          realmId: ctx.realmId,
          priceQuantities: prePriceQuantities,
          priceMappings: prePriceMappings,
          event: eventCtx,
        })
      }

      await markProviderEventProcessed(trx, event)
    })
  }

  static async handlePaymentIntentFailed(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.PaymentIntentPaymentFailedEvent,
    pathRealmId: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const obj = event.data.object as Stripe.PaymentIntent
      const ctx = await resolveBillingContext(trx, obj, pathRealmId || runtime.realmId, runtime)
      const processed = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!processed) return

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      const pi = await callStripe(
        () =>
          runtime.client.paymentIntents.retrieve(obj.id, {
            expand: ['customer', 'invoice'],
          }),
        { op: 'paymentIntents.retrieve', traceId: event.id },
      )

      await insertSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        provider: 'stripe',
        entityId: pi.id,
        entityKind: 'payment_intent',
        payload: pi,
      })

      await trx
        .insertInto('billing_payments')
        .values({
          realm_id: ctx.realmId,
          billing_account_id: ctx.billingAccountId,
          billing_invoice_id: null,
          provider: 'stripe',
          provider_payment_id: pi.id,
          provider_customer_id: normalizeStripeId(pi.customer),
          provider_invoice_id: normalizeStripeId(pi.invoice ?? null),
          provider_subscription_id: null,
          status: 'failed',
          amount_minor: BigInt(pi.amount ?? 0).toString(),
          currency: pi.currency.toUpperCase(),
          occurred_at: new Date(pi.created * 1000),
          raw_provider_payload: pi as unknown as Record<string, unknown>,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'provider_payment_id'])
            .where('provider', 'is not', null)
            .where('provider_payment_id', 'is not', null)
            .doUpdateSet({
            billing_account_id: ctx.billingAccountId,
            realm_id: ctx.realmId,
            provider_customer_id: normalizeStripeId(pi.customer),
            provider_invoice_id: normalizeStripeId(pi.invoice ?? null),
            status: 'failed',
            amount_minor: BigInt(pi.amount ?? 0).toString(),
            currency: pi.currency.toUpperCase(),
            occurred_at: new Date(pi.created * 1000),
            raw_provider_payload: pi as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }),
        )
        .execute()

      await markProviderEventProcessed(trx, event)
    })
  }

  static async handleInvoicePaid(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.InvoicePaidEvent,
    pathRealmId: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const obj = event.data.object as Stripe.Invoice
      const ctx = await resolveBillingContext(trx, obj, pathRealmId || runtime.realmId, runtime)
      const processed = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!processed) return

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      const inv = await callStripe(
        () =>
          runtime.client.invoices.retrieve(obj.id, {
            expand: ['payment_intent', 'subscription', 'customer', 'lines.data.price'],
          }),
        { op: 'invoices.retrieve', traceId: event.id },
      )

      await insertSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        provider: 'stripe',
        entityId: inv.id,
        entityKind: 'invoice',
        payload: inv,
      })

      const derivedPeriod = deriveInvoicePeriod(inv)
      if (!derivedPeriod) {
        throw new Error(`invoice_period_unusable:${inv.id}`)
      }
      const externalSubscriptionId = normalizeStripeId(inv.subscription)
      const internalSubscriptionId = await resolveInternalSubscriptionId(trx, ctx.billingAccountId, externalSubscriptionId)

      const maybeInternalInvoiceId = extractInternalBillingInvoiceId(inv)
      if (maybeInternalInvoiceId) {
        const exists = await trx
          .selectFrom('billing_invoices')
          .select(['billing_invoice_id'])
          .where('billing_invoice_id', '=', maybeInternalInvoiceId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .executeTakeFirst()

        if (exists) {
          const periodId = await ensureBillingPeriodForStripeInvoice(trx, {
            realmId: ctx.realmId,
            billingAccountId: ctx.billingAccountId,
            periodStart: derivedPeriod.periodStart,
            periodEnd: derivedPeriod.periodEnd,
            sourceRef: `stripe:invoice:${inv.id}`,
          })

          const status: Database['billing_invoices']['status'] = 'paid'
          const baseUpdates = {
            billing_period_id: periodId,
            provider: 'stripe',
            provider_invoice_id: inv.id,
            provider_subscription_id: externalSubscriptionId,
            provider_customer_id: normalizeStripeId(inv.customer),
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
            status,
            paid_at: inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : new Date(),
            finalized_at: inv.status_transitions?.finalized_at
              ? new Date(inv.status_transitions.finalized_at * 1000)
              : null,
            raw_provider_payload: inv as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }
          const updates = internalSubscriptionId
            ? { ...baseUpdates, subscription_id: internalSubscriptionId }
            : baseUpdates

          await trx.updateTable('billing_invoices').set(updates).where('billing_invoice_id', '=', maybeInternalInvoiceId).execute()

          await closeoutPaidInvoice(trx, { billingInvoiceId: maybeInternalInvoiceId, now: new Date() })
          await markProviderEventProcessed(trx, event)
          return
        }
      }

      const periodId = await ensureBillingPeriodForStripeInvoice(trx, {
        realmId: ctx.realmId,
        billingAccountId: ctx.billingAccountId,
        periodStart: derivedPeriod.periodStart,
        periodEnd: derivedPeriod.periodEnd,
        sourceRef: `stripe:invoice:${inv.id}`,
      })

      const base = {
        realm_id: ctx.realmId,
        billing_account_id: ctx.billingAccountId,
        billing_period_id: periodId,
        subscription_id: internalSubscriptionId,
        invoice_number: generateInvoiceNumber({
          billingPeriodId: periodId,
          provider: 'stripe',
          providerInvoiceId: inv.id,
        }),
        provider: 'stripe',
        provider_invoice_id: inv.id,
        provider_subscription_id: externalSubscriptionId,
        provider_customer_id: normalizeStripeId(inv.customer),
        currency: inv.currency.toUpperCase(),
        subtotal_minor: BigInt(inv.subtotal ?? 0).toString(),
        tax_minor: BigInt(inv.tax ?? 0).toString(),
        total_minor: BigInt(inv.total ?? 0).toString(),
        period_start: derivedPeriod.periodStart,
        period_end: derivedPeriod.periodEnd,
        due_at: inv.due_date ? new Date(inv.due_date * 1000) : null,
        finalized_at: inv.status_transitions?.finalized_at
          ? new Date(inv.status_transitions.finalized_at * 1000)
          : null,
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        raw_provider_payload: inv as unknown as Record<string, unknown>,
      }

      await trx
        .insertInto('billing_invoices')
        .values({
          ...base,
          status: 'paid',
          paid_at: inv.status_transitions?.paid_at
            ? new Date(inv.status_transitions.paid_at * 1000)
            : new Date(),
          canceled_at: null,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'provider_invoice_id'])
            .where('provider', 'is not', null)
            .where('provider_invoice_id', 'is not', null)
            .doUpdateSet({
            billing_period_id: sql`excluded.billing_period_id`,
            status: 'paid',
            total_minor: BigInt(inv.total ?? 0).toString(),
            subtotal_minor: BigInt(inv.subtotal ?? 0).toString(),
            tax_minor: BigInt(inv.tax ?? 0).toString(),
            paid_at: inv.status_transitions?.paid_at
              ? new Date(inv.status_transitions.paid_at * 1000)
              : new Date(),
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
            raw_provider_payload: inv as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }),
        )
        .execute()

      const invoiceRow = await trx
        .selectFrom('billing_invoices')
        .select(['billing_invoice_id'])
        .where('provider', '=', 'stripe')
        .where('provider_invoice_id', '=', inv.id)
        .executeTakeFirstOrThrow()

        await trx
        .updateTable('billing_payments')
        .set({ billing_invoice_id: invoiceRow.billing_invoice_id, updated_at: new Date() })
        .where('billing_account_id', '=', ctx.billingAccountId)
        .where('provider', '=', 'stripe')
        .where('provider_invoice_id', '=', inv.id)
        .execute()

      await trx.deleteFrom('billing_invoice_lines').where('billing_invoice_id', '=', invoiceRow.billing_invoice_id).execute()

      const linePriceIds = Array.from(
        new Set(
          inv.lines.data
            .map((line) => (typeof line.price === 'string' ? line.price : line.price?.id))
            .filter((id): id is string => Boolean(id)),
        ),
      )
      const catalogPriceRows = linePriceIds.length
        ? await trx
            .selectFrom('catalog_prices')
            .select(['catalog_price_id', 'provider_price_id'])
            .where('provider_price_id', 'in', linePriceIds)
            .execute()
        : []
      const catalogPriceByProviderId = new Map<string, string>()
      for (const row of catalogPriceRows) {
        catalogPriceByProviderId.set(String(row.provider_price_id), String(row.catalog_price_id))
      }

      for (const line of inv.lines.data) {
        const providerPriceId = typeof line.price === 'string' ? line.price : line.price?.id
        const catalogPriceId = providerPriceId ? catalogPriceByProviderId.get(providerPriceId) ?? null : null
        await trx
          .insertInto('billing_invoice_lines')
          .values({
            billing_invoice_id: invoiceRow.billing_invoice_id,
            line_kind: deriveLineKind(line),
            description: line.description ?? null,
            quantity: BigInt(line.quantity ?? 1).toString(),
            unit_amount_minor: BigInt(line.price?.unit_amount ?? 0).toString(),
            total_amount_minor: BigInt(line.amount ?? 0).toString(),
            catalog_price_id: catalogPriceId,
            meter_code: (line.metadata as Record<string, unknown> | undefined)?.meter_code as string | null,
          })
          .execute()
      }

      await markProviderEventProcessed(trx, event)
    })
  }

  static async handleInvoicePaymentFailed(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.InvoicePaymentFailedEvent,
    pathRealmId: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const obj = event.data.object as Stripe.Invoice
      const ctx = await resolveBillingContext(trx, obj, pathRealmId || runtime.realmId, runtime)
      const processed = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!processed) return

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      const inv = await callStripe(
        () =>
          runtime.client.invoices.retrieve(obj.id, {
            expand: ['payment_intent', 'subscription', 'customer', 'lines.data.price'],
          }),
        { op: 'invoices.retrieve', traceId: event.id },
      )

      await insertSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        provider: 'stripe',
        entityId: inv.id,
        entityKind: 'invoice',
        payload: inv,
      })

      const derivedPeriod = deriveInvoicePeriod(inv)
      if (!derivedPeriod) {
        throw new Error(`invoice_period_unusable:${inv.id}`)
      }
      const externalSubscriptionId = normalizeStripeId(inv.subscription)
      const internalSubscriptionId = await resolveInternalSubscriptionId(trx, ctx.billingAccountId, externalSubscriptionId)

      const maybeInternalInvoiceId = extractInternalBillingInvoiceId(inv)
      if (maybeInternalInvoiceId) {
        const exists = await trx
          .selectFrom('billing_invoices')
          .select(['billing_invoice_id'])
          .where('billing_invoice_id', '=', maybeInternalInvoiceId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .executeTakeFirst()

        if (exists) {
          const periodId = await ensureBillingPeriodForStripeInvoice(trx, {
            realmId: ctx.realmId,
            billingAccountId: ctx.billingAccountId,
            periodStart: derivedPeriod.periodStart,
            periodEnd: derivedPeriod.periodEnd,
            sourceRef: `stripe:invoice:${inv.id}`,
          })

          const status: Database['billing_invoices']['status'] =
            inv.status === 'uncollectible' ? 'uncollectible' : 'open'
          const baseUpdates = {
            billing_period_id: periodId,
            provider: 'stripe',
            provider_invoice_id: inv.id,
            provider_subscription_id: externalSubscriptionId,
            provider_customer_id: normalizeStripeId(inv.customer),
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
            status,
            finalized_at: inv.status_transitions?.finalized_at
              ? new Date(inv.status_transitions.finalized_at * 1000)
              : null,
            raw_provider_payload: inv as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }
          const updates = internalSubscriptionId
            ? { ...baseUpdates, subscription_id: internalSubscriptionId }
            : baseUpdates

          await trx.updateTable('billing_invoices').set(updates).where('billing_invoice_id', '=', maybeInternalInvoiceId).execute()

          await markProviderEventProcessed(trx, event)
          return
        }
      }

      const periodId = await ensureBillingPeriodForStripeInvoice(trx, {
        realmId: ctx.realmId,
        billingAccountId: ctx.billingAccountId,
        periodStart: derivedPeriod.periodStart,
        periodEnd: derivedPeriod.periodEnd,
        sourceRef: `stripe:invoice:${inv.id}`,
      })

      const base = {
        realm_id: ctx.realmId,
        billing_account_id: ctx.billingAccountId,
        billing_period_id: periodId,
        subscription_id: internalSubscriptionId,
        invoice_number: generateInvoiceNumber({
          billingPeriodId: periodId,
          provider: 'stripe',
          providerInvoiceId: inv.id,
        }),
        provider: 'stripe',
        provider_invoice_id: inv.id,
        provider_subscription_id: externalSubscriptionId,
        provider_customer_id: normalizeStripeId(inv.customer),
        currency: inv.currency.toUpperCase(),
        subtotal_minor: BigInt(inv.subtotal ?? 0).toString(),
        tax_minor: BigInt(inv.tax ?? 0).toString(),
        total_minor: BigInt(inv.total ?? 0).toString(),
        period_start: derivedPeriod.periodStart,
        period_end: derivedPeriod.periodEnd,
        due_at: inv.due_date ? new Date(inv.due_date * 1000) : null,
        finalized_at: inv.status_transitions?.finalized_at
          ? new Date(inv.status_transitions.finalized_at * 1000)
          : null,
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        raw_provider_payload: inv as unknown as Record<string, unknown>,
      }

      await trx
        .insertInto('billing_invoices')
        .values({
          ...base,
          status: inv.status === 'uncollectible' ? 'uncollectible' : 'open',
          paid_at: null,
          canceled_at: null,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'provider_invoice_id'])
            .where('provider', 'is not', null)
            .where('provider_invoice_id', 'is not', null)
            .doUpdateSet({
            billing_period_id: sql`excluded.billing_period_id`,
            status: inv.status === 'uncollectible' ? 'uncollectible' : 'open',
            total_minor: BigInt(inv.total ?? 0).toString(),
            subtotal_minor: BigInt(inv.subtotal ?? 0).toString(),
            tax_minor: BigInt(inv.tax ?? 0).toString(),
            paid_at: null,
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
            raw_provider_payload: inv as unknown as Record<string, unknown>,
            updated_at: new Date(),
          }),
        )
        .execute()

      const invoiceRow = await trx
        .selectFrom('billing_invoices')
        .select(['billing_invoice_id'])
        .where('provider', '=', 'stripe')
        .where('provider_invoice_id', '=', inv.id)
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('billing_payments')
        .set({ billing_invoice_id: invoiceRow.billing_invoice_id, updated_at: new Date() })
        .where('billing_account_id', '=', ctx.billingAccountId)
        .where('provider', '=', 'stripe')
        .where('provider_invoice_id', '=', inv.id)
        .execute()

      await trx.deleteFrom('billing_invoice_lines').where('billing_invoice_id', '=', invoiceRow.billing_invoice_id).execute()

      const linePriceIds = Array.from(
        new Set(
          inv.lines.data
            .map((line) => (typeof line.price === 'string' ? line.price : line.price?.id))
            .filter((id): id is string => Boolean(id)),
        ),
      )
      const catalogPriceRows = linePriceIds.length
        ? await trx
            .selectFrom('catalog_prices')
            .select(['catalog_price_id', 'provider_price_id'])
            .where('provider_price_id', 'in', linePriceIds)
            .execute()
        : []
      const catalogPriceByProviderId = new Map<string, string>()
      for (const row of catalogPriceRows) {
        catalogPriceByProviderId.set(String(row.provider_price_id), String(row.catalog_price_id))
      }

      for (const line of inv.lines.data) {
        const providerPriceId = typeof line.price === 'string' ? line.price : line.price?.id
        const catalogPriceId = providerPriceId ? catalogPriceByProviderId.get(providerPriceId) ?? null : null
        await trx
          .insertInto('billing_invoice_lines')
          .values({
            billing_invoice_id: invoiceRow.billing_invoice_id,
            line_kind: deriveLineKind(line),
            description: line.description ?? null,
            quantity: BigInt(line.quantity ?? 1).toString(),
            unit_amount_minor: BigInt(line.price?.unit_amount ?? 0).toString(),
            total_amount_minor: BigInt(line.amount ?? 0).toString(),
            catalog_price_id: catalogPriceId,
            meter_code: (line.metadata as Record<string, unknown> | undefined)?.meter_code as string | null,
          })
          .execute()
      }

      await markProviderEventProcessed(trx, event)
    })
  }

  static async handleChargeRefunded(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.ChargeRefundedEvent | Stripe.ChargeRefundUpdatedEvent,
    pathRealmId: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const rawObj = event.data.object as Stripe.Charge | Stripe.Refund
      const chargeId =
        (rawObj as Stripe.Refund).object === 'refund'
          ? String((rawObj as Stripe.Refund).charge)
          : (rawObj as Stripe.Charge).id

      const charge = await callStripe(
        () =>
          runtime.client.charges.retrieve(chargeId, {
            expand: ['payment_intent', 'refunds'],
          }),
        { op: 'charges.retrieve', traceId: event.id },
      )

      const ctx = await resolveBillingContext(trx, charge, pathRealmId || runtime.realmId, runtime)
      const processed = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!processed) return

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      await insertSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        provider: 'stripe',
        entityId: charge.id,
        entityKind: 'charge',
        payload: charge,
      })

      const paymentIntentId = normalizeStripeId(charge.payment_intent)
      if (!paymentIntentId) {
        await markProviderEventProcessed(trx, event)
        return
      }

      const billingPayment = await trx
        .selectFrom('billing_payments')
        .selectAll()
        .where('provider', '=', 'stripe')
        .where('provider_payment_id', '=', paymentIntentId)
        .executeTakeFirst()

      if (!billingPayment) {
        await markProviderEventProcessed(trx, event)
        return
      }

      for (const refund of charge.refunds?.data || []) {
        await trx
          .insertInto('billing_payment_refunds')
          .values({
            realm_id: ctx.realmId,
            billing_payment_id: billingPayment.billing_payment_id,
            provider: 'stripe',
            provider_refund_id: refund.id,
            provider_charge_id: charge.id,
            amount_minor: BigInt(refund.amount ?? 0).toString(),
            currency: refund.currency.toUpperCase(),
            status: refund.status as 'pending' | 'succeeded' | 'failed' | 'canceled',
            occurred_at: new Date(refund.created * 1000),
            raw_provider_payload: refund as unknown as Record<string, unknown>,
          })
          .onConflict((oc) =>
            oc.columns(['provider', 'provider_refund_id']).doUpdateSet({
              status: refund.status as 'pending' | 'succeeded' | 'failed' | 'canceled',
              amount_minor: BigInt(refund.amount ?? 0).toString(),
              updated_at: new Date(),
              raw_provider_payload: refund as unknown as Record<string, unknown>,
            }),
          )
          .execute()
      }

      const refundRows = await trx
        .selectFrom('billing_payment_refunds')
        .select(['amount_minor', 'status'])
        .where('billing_payment_id', '=', billingPayment.billing_payment_id)
        .execute()

      const totalRefunded = refundRows
        .filter((r) => r.status === 'succeeded')
        .reduce((sum, r) => sum + BigInt(r.amount_minor as unknown as string), BigInt(0))

      let newStatus: typeof billingPayment.status = billingPayment.status
      if (totalRefunded === BigInt(0)) {
        newStatus = billingPayment.status
      } else if (totalRefunded >= BigInt(billingPayment.amount_minor as unknown as string)) {
        newStatus = 'refunded'
      } else {
        newStatus = 'partially_refunded'
      }

      if (newStatus !== billingPayment.status) {
      await trx
        .updateTable('billing_payments')
        .set({ status: newStatus, updated_at: new Date() })
        .where('billing_payment_id', '=', billingPayment.billing_payment_id)
        .execute()
      }

      await markProviderEventProcessed(trx, event)
    })
  }

  static async handleCustomerSubscriptionUpdated(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.CustomerSubscriptionUpdatedEvent,
    pathRealmId: string,
  ): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription
    await db.transaction().execute(async (trx: Transaction<Database>) => {
      const ctx = await resolveBillingContext(trx, subscription, pathRealmId || runtime.realmId, runtime)
      const shouldProcess = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!shouldProcess) return

      const link = await trx
        .selectFrom('provider_subscription_links')
        .select(['subscription_id'])
        .where('provider', '=', 'stripe')
        .where('external_subscription_id', '=', subscription.id)
        .executeTakeFirst()

      if (!link) {
        await markProviderEventProcessed(trx, event)
        return
      }

      const priceMappings = await mapSubscriptionPrices(trx, subscription)
      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })
      await syncSubscriptionSnapshot(trx, {
        billingAccountId: ctx.billingAccountId,
        subscription: buildSubscriptionSnapshot(subscription),
        priceMappings,
        checkoutSessionId: 'webhook-update',
      })
      await markProviderEventProcessed(trx, event)
    })
  }

  static async handleCustomerSubscriptionDeleted(
    runtime: RealmStripeRuntime,
    db: Kysely<Database>,
    event: Stripe.CustomerSubscriptionDeletedEvent,
    pathRealmId: string,
  ): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription
    await db.transaction().execute(async (trx: Transaction<Database>) => {
      const ctx = await resolveBillingContext(trx, subscription, pathRealmId || runtime.realmId, runtime)
      const shouldProcess = await upsertProviderEvent(trx, ctx.billingAccountId, event)
      if (!shouldProcess) return

      const link = await trx
        .selectFrom('provider_subscription_links')
        .select(['subscription_id'])
        .where('provider', '=', 'stripe')
        .where('external_subscription_id', '=', subscription.id)
        .executeTakeFirst()

      if (!link) {
        await markProviderEventProcessed(trx, event)
        return
      }

      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

      await trx
        .updateTable('subscriptions')
        .set({
          status: 'canceled',
          cancel_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : new Date(),
          cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
          updated_at: new Date(),
        })
        .where('subscription_id', '=', link.subscription_id)
        .execute()

      await trx
        .deleteFrom('provider_subscription_links')
        .where('provider', '=', 'stripe')
        .where('external_subscription_id', '=', subscription.id)
        .execute()

      await markProviderEventProcessed(trx, event)
    })
  }
}

function normalizeStripeId(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && (value as { id?: unknown }).id) {
    const idVal = (value as { id?: unknown }).id
    if (typeof idVal === 'string') return idVal
  }
  return null
}

type ProviderCustomerInput = {
  billingAccountId: string
  providerCustomerId?: string | null
}

async function upsertProviderCustomer(trx: Transaction<Database>, input: ProviderCustomerInput): Promise<void> {
  if (!input.providerCustomerId) return

  await trx
    .insertInto('provider_customers')
    .values({
      billing_account_id: input.billingAccountId,
      provider: 'stripe',
      provider_customer_id: input.providerCustomerId,
    })
    .onConflict((oc) =>
      oc.columns(['billing_account_id', 'provider']).doUpdateSet({
        provider_customer_id: input.providerCustomerId,
        updated_at: new Date(),
      }),
    )
    .execute()
}

type SnapshotInput = {
  billingAccountId: string
  provider: string
  entityId: string
  entityKind: string
  payload: unknown
}

async function insertSnapshot(trx: Transaction<Database>, input: SnapshotInput): Promise<void> {
  await trx
    .insertInto('provider_state_snapshots')
    .values({
      billing_account_id: input.billingAccountId,
      provider: input.provider,
      entity_id: input.entityId,
      entity_kind: input.entityKind,
      json: input.payload as Record<string, unknown>,
    })
    .execute()
}

type BillingContext = {
  billingAccountId: string
  realmId: string
}

async function resolveBillingContext(
  trx: Transaction<Database>,
  obj: StripeObjectForContext,
  realmId: string,
  runtime?: RealmStripeRuntime,
): Promise<BillingContext> {
  // Ensure RLS can read mapping tables; billing_account_id unknown yet, so use admin posture scoped to realm
  await setRlsSession(trx, { realmId, isRealmAdmin: true })

  const candidates: Array<{ kind: 'customer' | 'subscription' | 'metadata'; value: string }> = []

  const customerId = isPaymentIntent(obj)
    ? typeof obj.customer === 'string'
      ? obj.customer
      : null
    : isInvoice(obj)
      ? typeof obj.customer === 'string'
        ? obj.customer
        : null
      : isCheckoutSession(obj)
        ? typeof obj.customer === 'string'
          ? obj.customer
          : null
        : isCharge(obj)
          ? typeof obj.customer === 'string'
            ? obj.customer
            : null
          : isSubscription(obj)
            ? typeof obj.customer === 'string'
              ? obj.customer
              : null
            : null
  if (customerId) candidates.push({ kind: 'customer', value: customerId })

  const subscriptionId =
    isSubscription(obj)
      ? obj.id
      : isInvoice(obj) && obj.subscription
        ? typeof obj.subscription === 'string'
          ? obj.subscription
          : null
        : isPaymentIntent(obj) && obj.invoice && typeof obj.invoice !== 'string' && obj.invoice.subscription
          ? typeof obj.invoice.subscription === 'string'
            ? obj.invoice.subscription
            : null
        : isCheckoutSession(obj) && obj.subscription
          ? typeof obj.subscription === 'string'
            ? obj.subscription
            : obj.subscription.id
          : null
  if (subscriptionId) candidates.push({ kind: 'subscription', value: subscriptionId })

  const metaBa =
    (isCheckoutSession(obj) && (obj.metadata?.billing_account_id || obj.client_reference_id)) ||
    (isPaymentIntent(obj) && obj.metadata?.billing_account_id) ||
    (isInvoice(obj) && obj.metadata?.billing_account_id) ||
    (isSubscription(obj) && (obj.metadata?.billing_account_id || obj.metadata?.client_reference_id))
  if (metaBa) candidates.push({ kind: 'metadata', value: String(metaBa) })

  for (const candidate of candidates) {
    if (candidate.kind === 'customer') {
      const row = await trx
        .selectFrom('provider_customers as pc')
        .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'pc.billing_account_id')
        .select(['pc.billing_account_id as billing_account_id', 'ba.realm_id as realm_id'])
        .where('pc.provider', '=', 'stripe')
        .where('pc.provider_customer_id', '=', candidate.value)
        .executeTakeFirst()
      if (row) return { billingAccountId: row.billing_account_id, realmId: row.realm_id }

      // fallback: fetch customer metadata and repair mapping
      if (runtime) {
        try {
          const remote = await callStripe(
            () => runtime.client.customers.retrieve(candidate.value),
            { op: 'customers.retrieve', traceId: 'resolve-billing-context' },
          )
          if ((remote as Stripe.Customer).deleted) {
            // cannot infer from deleted customer
          } else {
            const meta = (remote as Stripe.Customer).metadata as Record<string, unknown> | undefined
            const baFromMeta = meta?.billing_account_id
            if (baFromMeta && typeof baFromMeta === 'string') {
              const acct = await trx
                .selectFrom('billing_accounts')
                .select(['billing_account_id', 'realm_id'])
                .where('billing_account_id', '=', baFromMeta)
                .executeTakeFirst()
              if (acct) {
                await setRlsSession(trx, {
                  realmId: acct.realm_id,
                  billingAccountId: acct.billing_account_id,
                  isRealmAdmin: true,
                })
                await upsertProviderCustomer(trx, { billingAccountId: acct.billing_account_id, providerCustomerId: candidate.value })
                return { billingAccountId: acct.billing_account_id, realmId: acct.realm_id }
              }
            }
          }
        } catch {
          // ignore and continue
        }
      }
    }
    if (candidate.kind === 'subscription') {
      const row = await trx
        .selectFrom('provider_subscription_links as psl')
        .innerJoin('subscriptions as cs', 'cs.subscription_id', 'psl.subscription_id')
        .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'cs.billing_account_id')
        .select(['cs.billing_account_id as billing_account_id', 'ba.realm_id as realm_id'])
        .where('psl.provider', '=', 'stripe')
        .where('psl.external_subscription_id', '=', candidate.value)
        .executeTakeFirst()
      if (row) return { billingAccountId: row.billing_account_id, realmId: row.realm_id }
      if (isSubscription(obj) && obj.metadata?.billing_account_id) {
        const acct = await trx
          .selectFrom('billing_accounts')
          .select(['billing_account_id', 'realm_id'])
          .where('billing_account_id', '=', obj.metadata.billing_account_id)
          .executeTakeFirst()
        if (acct) return { billingAccountId: acct.billing_account_id, realmId: acct.realm_id }
      }
    }
    if (candidate.kind === 'metadata') {
      const row = await trx
        .selectFrom('billing_accounts')
        .select(['billing_account_id', 'realm_id'])
        .where('billing_account_id', '=', candidate.value)
        .executeTakeFirst()
      if (row) return { billingAccountId: row.billing_account_id, realmId: row.realm_id }
    }
  }

  throw new Error('billing_account_resolution_failed')
}

async function upsertProviderEvent(
  trx: Transaction<Database>,
  billingAccountId: string,
  event: Stripe.Event,
): Promise<boolean> {
  const existing = await trx
    .selectFrom('provider_events')
    .select(['provider_event_id', 'status'])
    .where('provider', '=', 'stripe')
    .where('external_event_id', '=', event.id)
    .executeTakeFirst()

  if (existing && existing.status === 'processed') {
    return false
  }

  if (existing) {
    await trx
      .updateTable('provider_events')
      .set({
        billing_account_id: billingAccountId,
        event_type: event.type,
        payload: event as unknown as Record<string, unknown>,
        status: 'received',
        processed_at: null,
      })
      .where('provider_event_id', '=', existing.provider_event_id)
      .execute()
    return true
  }

  await trx
    .insertInto('provider_events')
    .values({
      billing_account_id: billingAccountId,
      provider: 'stripe',
      external_event_id: event.id,
      event_type: event.type,
      status: 'received',
      payload: event as unknown as Record<string, unknown>,
    })
    .execute()
  return true
}

async function markProviderEventProcessed(trx: Transaction<Database>, event: Stripe.Event): Promise<void> {
  await trx
    .updateTable('provider_events')
    .set({
      status: 'processed',
      processed_at: new Date(),
    })
    .where('provider', '=', 'stripe')
    .where('external_event_id', '=', event.id)
    .execute()
}

function aggregateLineItems(lineItems: Stripe.LineItem[]): PriceQuantities {
  const map: PriceQuantities = new Map()
  for (const item of lineItems) {
    const price = item.price
    const priceId = typeof price === 'string' ? price : price?.id
    if (!priceId) continue
    const quantity = Number(item.quantity || 0)
    if (Number.isNaN(quantity) || quantity <= 0) continue
    const current = map.get(priceId) || { quantity: 0 }
    current.quantity += quantity
    map.set(priceId, current)
  }
  return map
}

async function fetchCatalogPrices(
  trx: Transaction<Database>,
  priceQuantities: PriceQuantities,
): Promise<Map<string, CatalogPriceMapping>> {
  const providerPriceIds = Array.from(priceQuantities.keys())
  if (providerPriceIds.length === 0) return new Map()

  const rows = await trx
    .selectFrom('catalog_prices')
    .innerJoin('catalog_products', 'catalog_products.catalog_product_id', 'catalog_prices.catalog_product_id')
    .select([
      'catalog_prices.catalog_price_id as catalog_price_id',
      'catalog_prices.catalog_product_id as catalog_product_id',
      'catalog_prices.provider_price_id as provider_price_id',
      'catalog_prices.currency as currency',
      'catalog_prices.metadata as metadata',
      'catalog_products.metadata as product_metadata',
    ])
    .where('catalog_prices.provider_price_id', 'in', providerPriceIds)
    .execute()

  const map = new Map<string, CatalogPriceMapping>()
  for (const row of rows) {
    map.set(row.provider_price_id, {
      catalog_price_id: row.catalog_price_id,
      catalog_product_id: row.catalog_product_id,
      provider_price_id: row.provider_price_id,
      currency: row.currency,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      product_metadata: (row.product_metadata as Record<string, unknown> | null) ?? null,
    })
  }
  return map
}

function deriveLineKind(line: Stripe.InvoiceLineItem): 'recurring' | 'usage' | 'one_time' | 'discount' | 'tax' | 'other' {
  if (line.type === 'subscription') return 'recurring'
  const hasUsageRecord = 'usage_record' in line && Boolean((line as { usage_record?: unknown }).usage_record)
  if (hasUsageRecord) return 'usage'
  if (line.type === 'invoiceitem') return 'one_time'
  if ((line.amount ?? 0) < 0) return 'discount'
  return 'other'
}

async function mapSubscriptionPrices(
  trx: Transaction<Database>,
  subscription: Stripe.Subscription,
): Promise<Map<string, CatalogPriceMapping>> {
  const items = subscription.items?.data ?? []
  const priceIds = items
    .map((item) => (typeof item.price === 'string' ? item.price : item.price?.id))
    .filter((id): id is string => Boolean(id))
  if (priceIds.length === 0) return new Map()

  return fetchCatalogPrices(
    trx,
    new Map(priceIds.map((id) => [id, { quantity: Number(items.find((it) => (typeof it.price === 'string' ? it.price : it.price?.id) === id)?.quantity ?? 1) }])),
  )
}

async function derivePriceQuantitiesFromPaymentIntent(pi: Stripe.PaymentIntent): Promise<PriceQuantities> {
  // Prefer invoice lines if present
  const rawInvoice = pi.invoice && typeof pi.invoice !== 'string' ? (pi.invoice as Stripe.Invoice) : null
  const lines = rawInvoice?.lines?.data ?? []
  if (!rawInvoice || lines.length === 0) return new Map()

  const map: PriceQuantities = new Map()
  for (const line of lines) {
    const priceId = typeof line.price === 'string' ? line.price : line.price?.id
    if (!priceId) continue
    const quantity = Number(line.quantity ?? 1)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    const current = map.get(priceId) || { quantity: 0 }
    current.quantity += quantity
    map.set(priceId, current)
  }
  return map
}
