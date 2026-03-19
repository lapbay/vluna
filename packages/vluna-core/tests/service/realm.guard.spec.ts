import { describe, it, expect } from 'vitest'
import { HttpException, type ExecutionContext } from '@nestjs/common'
import { RealmGuard } from '../../src/auth/guards/realm.guard.js'
import type { RealmConfigService, RealmAuthProfile } from '../../src/security/realm-config.service.js'
import type { PaymentProvider } from '../../src/providers/payment/PaymentProvider.js'
import type { AppRequest } from '../../src/types/app-request.js'

const fakeProfile: RealmAuthProfile = {
  issuers: [{ issuer: 'https://example', audiences: ['api://billing'] }],
}

function makeContext(headers: Record<string, string>): ExecutionContext {
  const req: AppRequest = { headers, ctx: {} } as AppRequest
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext
}

describe('RealmGuard', { tags: ['service'] }, () => {
  it('populates ctx when X-Realm-Id is present', async () => {
    const realmConfig: Pick<
      RealmConfigService,
      'getAuthProfile' | 'getPaymentProvider' | 'getBillingDefaultsPeriod' | 'getRealmStatus' | 'getRealmAccessAllowlist'
    > = {
      getRealmStatus: async () => 'active',
      getAuthProfile: async (realmId: string) => ({ ...fakeProfile, issuerRoot: realmId }),
      getPaymentProvider: async () =>
        ({
          providerId: 'stripe',
          retrieveCustomer: async () => 'cus_test',
          syncProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pushProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pullProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          registerWebhooks: async () => [],
          createCheckoutSession: async () => ({ checkoutUrl: '', sessionId: '' }),
          refundPayment: async () => ({}),
          createPortalSession: async () => ({ portalUrl: '', sessionId: '' }),
        }) as PaymentProvider,
      getBillingDefaultsPeriod: async () => null,
      getRealmAccessAllowlist: async () => [],
    }
    const guard = new RealmGuard(realmConfig as RealmConfigService)
    const ctx = makeContext({ 'x-realm-id': 'realm_123' })

    const allowed = await guard.canActivate(ctx)

    const req = ctx.switchToHttp().getRequest<AppRequest>()
    expect(allowed).toBe(true)
    expect(req.ctx?.realmId).toBe('realm_123')
    expect(req.ctx?.realmConfig?.auth).toBeDefined()
  })

  it('throws 400 when X-Realm-Id is missing', async () => {
    const realmConfig: Pick<
      RealmConfigService,
      'getAuthProfile' | 'getPaymentProvider' | 'getBillingDefaultsPeriod' | 'getRealmStatus' | 'getRealmAccessAllowlist'
    > = {
      getRealmStatus: async () => 'active',
      getAuthProfile: async () => fakeProfile,
      getPaymentProvider: async () =>
        ({
          providerId: 'stripe',
          retrieveCustomer: async () => 'cus_test',
          syncProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pushProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pullProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          registerWebhooks: async () => [],
          createCheckoutSession: async () => ({ checkoutUrl: '', sessionId: '' }),
          refundPayment: async () => ({}),
          createPortalSession: async () => ({ portalUrl: '', sessionId: '' }),
        }) as PaymentProvider,
      getBillingDefaultsPeriod: async () => null,
      getRealmAccessAllowlist: async () => [],
    }
    const guard = new RealmGuard(realmConfig as RealmConfigService)
    const ctx = makeContext({})

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
  })

  it('throws 404 when realm not found', async () => {
    const realmConfig: Pick<
      RealmConfigService,
      'getAuthProfile' | 'getPaymentProvider' | 'getBillingDefaultsPeriod' | 'getRealmStatus' | 'getRealmAccessAllowlist'
    > = {
      getRealmStatus: async () => {
        const err = new Error('not found') as Error & { code?: string }
        err.code = 'realm_not_found'
        throw err
      },
      getAuthProfile: async () => fakeProfile,
      getPaymentProvider: async () =>
        ({
          providerId: 'stripe',
          retrieveCustomer: async () => 'cus_test',
          syncProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pushProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          pullProductsAndPrices: async () => ({ startedAt: '', finishedAt: '', counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }),
          registerWebhooks: async () => [],
          createCheckoutSession: async () => ({ checkoutUrl: '', sessionId: '' }),
          refundPayment: async () => ({}),
          createPortalSession: async () => ({ portalUrl: '', sessionId: '' }),
        }) as PaymentProvider,
      getBillingDefaultsPeriod: async () => null,
      getRealmAccessAllowlist: async () => [],
    }
    const guard = new RealmGuard(realmConfig as RealmConfigService)
    const ctx = makeContext({ 'x-realm-id': 'missing' })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
  })
})
