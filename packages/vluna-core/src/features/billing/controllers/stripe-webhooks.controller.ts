import { Controller, Headers, HttpCode, Inject, Param, Post, RawBodyRequest, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type Stripe from 'stripe'
import { verifyStripeEvent } from '../../../providers/stripe/webhooks.js'
import { db as getDb } from '../../../db/index.js'
import { StripeWebhookService } from '../services/stripe-webhook.service.js'
import { RealmConfigService } from '../../../security/realm-config.service.js'

@Controller('webhooks/stripe')
export class StripeWebhooksController {
  constructor(@Inject(RealmConfigService) private readonly realmConfig: RealmConfigService) {}

  @Post(':realmId')
  @HttpCode(200)
  async handleCatalog(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('stripe-signature') sig?: string,
    @Param('realmId') realmId?: string,
  ) {
    const raw = req.rawBody
    // try {
      if (!raw || !Buffer.isBuffer(raw)) {
        console.warn(JSON.stringify({ at: 'stripe.webhook.invalid', error: 'rawBody missing or not Buffer (fastify-raw-body not installed?)' }))
        return { ok: true }
      }
      const normalizedRealm = (realmId || '').trim()
      if (!normalizedRealm) {
        console.warn(JSON.stringify({ at: 'stripe.webhook.invalid', error: 'realmId missing in path' }))
        return { ok: true }
      }
      const runtime = await this.realmConfig.getStripeRuntime(normalizedRealm)
      const secret = runtime.config.webhookSecrets.catalog
      if (!secret) {
        console.warn(JSON.stringify({ at: 'stripe.webhook.reject', reason: 'webhook_secret_missing', realmId: normalizedRealm }))
        return { ok: true }
      }
      const event = verifyStripeEvent(raw as Buffer, sig, secret)
      const expectedLivemode = runtime.env === 'live'
      if (Boolean(event.livemode) !== expectedLivemode) {
        console.warn(JSON.stringify({ at: 'stripe.webhook.reject', reason: 'livemode_mismatch', id: event.id, type: event.type, realmId: normalizedRealm }))
        return { ok: true }
      }

      console.log(JSON.stringify({ at: 'stripe.webhook', type: event.type, id: event.id, livemode: event.livemode }))

      const db = getDb()

      if (event.type === 'checkout.session.completed') {
        await StripeWebhookService.handleCheckoutSessionCompleted(runtime, db, event as Stripe.CheckoutSessionCompletedEvent, normalizedRealm)
      } else if (event.type === 'payment_intent.succeeded') {
        await StripeWebhookService.handlePaymentIntentSucceeded(runtime, db, event as Stripe.PaymentIntentSucceededEvent, normalizedRealm)
      } else if (event.type === 'payment_intent.payment_failed') {
        await StripeWebhookService.handlePaymentIntentFailed(runtime, db, event as Stripe.PaymentIntentPaymentFailedEvent, normalizedRealm)
      } else if (event.type === 'invoice.paid') {
        await StripeWebhookService.handleInvoicePaid(runtime, db, event as Stripe.InvoicePaidEvent, normalizedRealm)
      } else if (event.type === 'invoice.payment_failed') {
        await StripeWebhookService.handleInvoicePaymentFailed(runtime, db, event as Stripe.InvoicePaymentFailedEvent, normalizedRealm)
      } else if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated') {
        await StripeWebhookService.handleChargeRefunded(runtime, db, event as Stripe.ChargeRefundedEvent, normalizedRealm)
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
        await StripeWebhookService.handleCustomerSubscriptionUpdated(runtime, db, event as Stripe.CustomerSubscriptionUpdatedEvent, normalizedRealm)
      } else if (event.type === 'customer.subscription.deleted') {
        await StripeWebhookService.handleCustomerSubscriptionDeleted(runtime, db, event as Stripe.CustomerSubscriptionDeletedEvent, normalizedRealm)
      }
      return { ok: true }
    // } catch (e: any) {
    //   console.warn(JSON.stringify({ at: 'stripe.webhook.invalid', error: e?.message }))
    //   return { ok: true }
    // }
  }
}
