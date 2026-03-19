import { Injectable } from '@nestjs/common'
import { okEnvelope } from '../../../common/envelope.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import type { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import type { ProviderOpContext } from '../../../providers/payment/PaymentProvider.js'
import { RealmConfigService } from '../../../security/realm-config.service.js'
import type { Database } from '../../../types/database.js'
import { SubscriptionValidationService } from './subscription-validation.service.js'
import type { Kysely, Transaction } from 'kysely'

type CreateCheckoutBody = JsonRequestBody<BillingOps, 'createCheckoutSession'>
type CreateCheckout201 = JsonResponse<BillingOps, 'createCheckoutSession', 201>

@Injectable()
export class CheckoutApiService {
  constructor(private readonly realmConfig: RealmConfigService) {}

  async createCheckoutSession(input: {
    traceId?: string
    realmId: string
    billingAccountId: string
    idempotencyKey?: string
    principalId?: string
    db?: Kysely<Database> | Transaction<Database>
    body: CreateCheckoutBody
  }): Promise<CreateCheckout201> {
    const ctx: ProviderOpContext = {
      traceId: input.traceId,
      realmId: input.realmId,
      billingAccountId: input.billingAccountId,
      idempotencyKey: input.idempotencyKey,
      db: input.db,
    }
    const provider = await this.realmConfig.getPaymentProvider(input.realmId)
    const body = input.body

    const items = (body.items || []).map((it) => ({
      catalogPriceId: it.catalog_price_id,
      priceId: it.price_id,
      quantity: Number(it.quantity || 1),
    }))
    if (ctx.db && input.billingAccountId) {
      const validation = await SubscriptionValidationService.checkConflicts(
        ctx.db,
        input.billingAccountId,
        items,
      )

      if (!validation.allow) {
        const portal = await provider.createPortalSession(ctx, {
          billingAccountId: input.billingAccountId,
          principalId: input.principalId,
          returnUrl: body.success_url,
        })
        const data: BillingComponents['schemas']['CreateCheckoutSessionResponse'] = { checkout_url: portal.portalUrl }
        return okEnvelope(data, { meta: { location: portal.portalUrl, conflict: true } }) as CreateCheckout201
      }
    }

    const result = await provider.createCheckoutSession(ctx, {
      billingAccountId: input.billingAccountId,
      principalId: input.principalId,
      items,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
      metadata: body.metadata,
    })
    const data: BillingComponents['schemas']['CreateCheckoutSessionResponse'] = { checkout_url: result.checkoutUrl }
    return okEnvelope(data, { meta: { location: result.checkoutUrl } }) as CreateCheckout201
  }
}
