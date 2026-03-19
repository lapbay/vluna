import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Controller, Get, Module, UseGuards, Req } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { RealmGuard } from '../../src/auth/guards/realm.guard.js'
import { RealmConfigService, type RealmAuthProfile } from '../../src/security/realm-config.service.js'
import type { PaymentProvider } from '../../src/providers/payment/PaymentProvider.js'
import type { AppRequest } from '../../src/types/app-request.js'

const fakeProfile: RealmAuthProfile = { issuers: [{ issuer: 'https://example', audiences: ['api://billing'] }] }

@Controller('ping')
@UseGuards(RealmGuard)
class PingController {
  @Get()
  ping(@Req() req: AppRequest) {
    return { realm: req.ctx?.realmId ?? null }
  }
}

describe('API - RealmGuard wiring', { tags: ['api'] }, () => {
  const realmConfigMock: Pick<
    RealmConfigService,
    'getAuthProfile' | 'getPaymentProvider' | 'getBillingDefaultsPeriod' | 'getRealmStatus' | 'getRealmAccessAllowlist'
  > = {
    getRealmStatus: async () => 'active',
    getAuthProfile: async (realmId: string) => ({ ...fakeProfile, realmId }),
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

  @Module({
    controllers: [PingController],
    providers: [
      RealmGuard,
      { provide: RealmConfigService, useValue: realmConfigMock },
    ],
  })
  class AppModule {}

  let app: NestFastifyApplication

  beforeAll(async () => {
    const adapter = new FastifyAdapter({ logger: false })
    app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: false })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('returns 400 without X-Realm-Id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(400)
  })

  it('passes realm to controller when header present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { 'x-realm-id': 'realm_api' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ realm: 'realm_api' })
  })
})
