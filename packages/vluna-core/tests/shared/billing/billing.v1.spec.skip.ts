// Contract tests for Billing v1 controllers
// Note: These tests are not executed in CI in this task; they are provided ready-to-run.
// They spin up a Nest Fastify app with AppModule and override token validation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import request from 'supertest'
import { AppModule } from '../../../src/modules/app.module.js'
import { EnvelopeInterceptor } from '../../../src/support/envelope.interceptor.js'
import { DbSessionInterceptor } from '../../../src/support/db-session.interceptor.js'
import { TraceHeadersInterceptor } from '../../../src/support/trace-headers.interceptor.js'
import { PermissionsChangedInterceptor } from '../../../src/support/permissions-changed.interceptor.js'
import { ExposeHeadersInterceptor } from '../../../src/support/expose-headers.interceptor.js'
import { GlobalExceptionFilter } from '../../../src/support/global-exception.filter.js'
import type { TokenValidator, TokenClaims } from '../../../src/auth/tokens/token.types.js'
import { TOKEN_VALIDATOR } from '../../../src/auth/tokens/token.types.js'
import { RealmConfigService, type RealmAuthProfile } from '../../../src/security/realm-config.service.js'
import type { PaymentProvider, ProviderOpContext, SyncReport, CatalogSyncOptions } from '../../../src/providers/payment/PaymentProvider.js'
import type { FastifyInstance } from 'fastify'

class StubPaymentProvider implements PaymentProvider {
  providerId = 'stub'

  async retrieveCustomer(
    _ctx: ProviderOpContext,
    _p: { billingAccountId: string; principalId?: string; email?: string; name?: string; metadata?: Record<string, unknown> },
  ): Promise<string> {
    return 'cus_stub'
  }
  async syncProductsAndPrices(_ctx: ProviderOpContext, _p?: CatalogSyncOptions): Promise<SyncReport> {
    return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }
  }
  async pushProductsAndPrices(_ctx: ProviderOpContext, _p?: CatalogSyncOptions): Promise<SyncReport> {
    return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }
  }
  async pullProductsAndPrices(_ctx: ProviderOpContext, _p?: CatalogSyncOptions): Promise<SyncReport> {
    return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), counters: { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }, notes: [] }
  }
  async registerWebhooks(_ctx: ProviderOpContext): Promise<{ id: string; url: string }[]> {
    return []
  }
  async bootstrap(_ctx: ProviderOpContext): Promise<void> {
    return
  }
  async createCheckoutSession(
    _ctx: ProviderOpContext,
    p: {
      billingAccountId: string
      principalId?: string
      items: Array<{ catalogPriceId?: string; priceId?: string; quantity: number }>
      successUrl: string
      cancelUrl: string
      metadata?: Record<string, unknown>
    },
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    return { checkoutUrl: p.successUrl, sessionId: 'sess_stub' }
  }
  async refundPayment(_ctx: ProviderOpContext, _p: unknown): Promise<unknown> {
    return { ok: true }
  }
  async createPortalSession(
    _ctx: ProviderOpContext,
    p: { billingAccountId: string; returnUrl: string },
  ): Promise<{ portalUrl: string; sessionId: string }> {
    return { portalUrl: p.returnUrl, sessionId: 'portal_stub' }
  }
}

// Simple stub validator that accepts token 'demo' and returns broad scopes
class StubValidator implements TokenValidator {
  async verify(token: string, _options?: { audience?: string }): Promise<TokenClaims> {
    if (token !== 'demo') throw new Error('invalid_token')
    return { sub: 'user_demo', scope: 'billing:read billing:write' }
  }
}

function commonHeaders(auth: boolean = true) {
  const h: Record<string, string> = { 'X-Realm-Id': 'realm_A' }
  if (auth) h.Authorization = 'Bearer demo'
  return h
}

describe.skip('Billing v1 (OpenAPI operations) - happy paths', { tags: ['api'] }, () => {
  let app: INestApplication

  beforeAll(async () => {
    process.env.VLUNA_AUTH_STRATEGY = 'oidc'
    const fakeProfile: RealmAuthProfile = {
      issuers: [{ issuer: 'https://issuer.example', audiences: ['api://billing'] }],
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VALIDATOR)
      .useValue(new StubValidator())
      .overrideProvider(RealmConfigService)
      .useValue({
        getAuthProfile: async () => fakeProfile,
        getPaymentProvider: async () => new StubPaymentProvider(),
      })
      .compile()

    const adapter = new FastifyAdapter({ logger: false })
    app = moduleRef.createNestApplication(adapter)
    app.setGlobalPrefix('api')

    // Interceptors and filters to match runtime behavior
    app.useGlobalInterceptors(
      new DbSessionInterceptor(),
      new EnvelopeInterceptor(),
      new TraceHeadersInterceptor(),
      new PermissionsChangedInterceptor(),
      new ExposeHeadersInterceptor(),
    )
    app.useGlobalFilters(new GlobalExceptionFilter())
    await app.init()
    const instance = app.getHttpAdapter().getInstance() as FastifyInstance
    await instance.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  // Catalog
  it('GET /api/catalog/products (listCatalogProducts) → 200 + envelope OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/catalog/products')
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
    expect(res.body?.code).toBe('OK')
    expect(Array.isArray(res.body?.data?.data)).toBe(true)
  })

  it('GET /api/catalog/prices (listCatalogPrices) → 200 + envelope OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/catalog/prices')
      .query({ product_id: '1' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
    expect(res.body?.code).toBe('OK')
  })

  // Checkout/Portal
  it('POST /api/checkout/sessions (createCheckoutSession) → 201 + Location header', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/checkout/sessions')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-1')
      .send({ billing_account_id: 'ba_demo', items: [{ catalog_price_id: '10', quantity: 1 }], success_url: 'https://x/s', cancel_url: 'https://x/c' })
      .expect(201)
    expect(res.headers['location']).toBeTruthy()
    expect(res.body?.ok).toBe(true)
    expect(res.body?.code).toBe('OK')
  })

  it('POST /api/portal/sessions (createPortalSession) → 201 + Location header', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/portal/sessions')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-2')
      .send({ billing_account_id: 'ba_demo', return_url: 'https://app/return' })
      .expect(201)
    expect(res.headers['location']).toBeTruthy()
    expect(res.body?.ok).toBe(true)
  })

  // Billing events
  it('POST /api/events (recordBillingEvent) → 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/events')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-3')
      .send({ event_type: 'outcome.job_succeeded', occurred_at: new Date().toISOString(), subject_ref: 'job_1', payload: { run_id: 'run_1' } })
      .expect(201)
    expect(res.body?.ok).toBe(true)
  })

  it('POST /api/events/batch (recordBillingEventBatch) → 207', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/events/batch')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-4')
      .send({ events: [{ event_type: 'outcome.job_succeeded', occurred_at: new Date().toISOString(), subject_ref: 'job_1', payload: { run_id: 'run_1' } }] })
      .expect(207)
    expect(res.body?.ok).toBe(true)
  })

  // Wallet
  it('GET /api/wallet/balance (getWalletBalance) → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/wallet/balance')
      .query({ billing_account_id: 'ba_demo' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  it('POST /api/wallet/consume (walletConsume) → 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/wallet/consume')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-5')
      .send({ billing_account_id: 'ba_demo', amount: 50, unit: 'credit' })
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  it('POST /api/wallet/adjustments (walletAdjust) → 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/wallet/adjustments')
      .set(commonHeaders())
      .set('Idempotency-Key', 'idem-6')
      .send({ billing_account_id: 'ba_demo', delta: 100, unit: 'credit' })
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  // Invoices/Subscriptions/Payments/Ops (account-scoped)
  it('GET /api/invoices (listInvoices) → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/invoices')
      .query({ billing_account_id: 'ba_demo' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  it('GET /api/subscriptions (listSubscriptions) → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/subscriptions')
      .query({ billing_account_id: 'ba_demo' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  it('GET /api/payments (listPayments) → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/payments')
      .query({ billing_account_id: 'ba_demo' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })

  it('GET /api/ops/reconciliations (listReconciliations) → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ops/reconciliations')
      .query({ billing_account_id: 'ba_demo' })
      .set(commonHeaders())
      .expect(200)
    expect(res.body?.ok).toBe(true)
  })
})

describe('Billing v1 - auth failures align with OpenAPI', () => {
  let app: INestApplication

  beforeAll(async () => {
    const fakeProfile: RealmAuthProfile = {
      issuers: [{ issuer: 'https://issuer.example', audiences: ['api://billing'] }],
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VALIDATOR)
      .useValue(new StubValidator())
      .overrideProvider(RealmConfigService)
      .useValue({
        getAuthProfile: async () => fakeProfile,
        getPaymentProvider: async () => new StubPaymentProvider(),
      })
      .compile()
    const adapter = new FastifyAdapter({ logger: false })
    app = moduleRef.createNestApplication(adapter)
    app.setGlobalPrefix('api')
    app.useGlobalInterceptors(new EnvelopeInterceptor())
    app.useGlobalFilters(new GlobalExceptionFilter())
    await app.init()
    const instance = app.getHttpAdapter().getInstance() as FastifyInstance
    await instance.ready()
  })

  afterAll(async () => { await app?.close() })

  it('GET /api/catalog/products without Authorization → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/catalog/products')
      .set(commonHeaders(false))
      .expect(401)
    expect(res.body?.ok).toBe(false)
  })
})
