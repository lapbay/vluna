import { Injectable } from '@nestjs/common'
import { okEnvelope } from '../../../common/envelope.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import type { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import type { ProviderOpContext } from '../../../providers/payment/PaymentProvider.js'
import { RealmConfigService } from '../../../security/realm-config.service.js'
import type { Database } from '../../../types/database.js'
import type { Kysely, Transaction } from 'kysely'

type CreatePortalBody = JsonRequestBody<BillingOps, 'createPortalSession'>
type CreatePortal201 = JsonResponse<BillingOps, 'createPortalSession', 201>

@Injectable()
export class PortalApiService {
  constructor(private readonly realmConfig: RealmConfigService) {}

  async createPortalSession(input: {
    traceId?: string
    realmId: string
    billingAccountId: string
    idempotencyKey?: string
    principalId?: string
    db?: Kysely<Database> | Transaction<Database>
    body: CreatePortalBody
  }): Promise<CreatePortal201> {
    const ctx: ProviderOpContext = {
      traceId: input.traceId,
      realmId: input.realmId,
      billingAccountId: input.billingAccountId,
      idempotencyKey: input.idempotencyKey,
      db: input.db,
    }
    const provider = await this.realmConfig.getPaymentProvider(input.realmId)
    const result = await provider.createPortalSession(ctx, {
      billingAccountId: input.billingAccountId,
      principalId: input.principalId,
      returnUrl: input.body.return_url,
    })
    const data: BillingComponents['schemas']['CreatePortalSessionResponse'] = { portal_url: result.portalUrl }
    return okEnvelope(data, { meta: { location: result.portalUrl } }) as CreatePortal201
  }
}
