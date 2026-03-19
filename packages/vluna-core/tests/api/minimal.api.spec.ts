import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { Controller, Get, Module, Req } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { DbSessionInterceptor } from '../../src/support/db-session.interceptor.js'
import { EnvelopeInterceptor } from '../../src/support/envelope.interceptor.js'
import { TraceHeadersInterceptor } from '../../src/support/trace-headers.interceptor.js'
import { ExposeHeadersInterceptor } from '../../src/support/expose-headers.interceptor.js'
import type { AppRequest } from '../../src/types/app-request.js'
import * as dbModule from '../../src/db/index.js'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/types/database.js'
import { TokenStrategyRegistry } from '../../src/auth/tokens/token-strategy.registry.js'
import { PlatformTokenStrategy } from '../../src/auth/tokens/platform.token.strategy.js'
import { parseIncomingTrace } from '../../src/support/trace.util.js'
import type { FastifyInstance } from 'fastify'
import { HealthModule } from '../../src/modules/health.module.js'

@Controller('mgt/v1/debug')
class DebugController {
  @Get('ctx')
  ctx(@Req() req: AppRequest) {
    return {
      hasDb: !!req.ctx?.db,
      realmId: req.ctx?.realmId ?? null,
    }
  }
}

@Module({ controllers: [DebugController] })
class DebugModule {}

@Module({ imports: [HealthModule, DebugModule] })
class TestAppModule {}

describe('API minimal surface', { tags: ['api'] }, () => {
  let app: NestFastifyApplication
  let fastify: FastifyInstance

  const fakeTrx = { tag: 'trx' } as unknown as Kysely<Database>
  const executeSpy = vi.fn(async (cb: (trx: Kysely<Database>) => unknown) => cb(fakeTrx))
  const transactionSpy = vi.fn(() => ({ execute: executeSpy }))
  const dbSpy = vi.spyOn(dbModule, 'db').mockReturnValue({ transaction: transactionSpy } as unknown as Kysely<Database>)
  const setRlsSpy = vi.spyOn(dbModule, 'setRlsSession').mockResolvedValue()

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(TokenStrategyRegistry)
      .useValue({ register: vi.fn(), list: vi.fn(() => []) })
      .overrideProvider(PlatformTokenStrategy)
      .useValue({ name: 'platform', onModuleInit: vi.fn(), supports: vi.fn(), verify: vi.fn() })
      .compile()
    const adapter = new FastifyAdapter({ logger: false })
    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, { logger: false })
    app.setGlobalPrefix('api')

    // getInstance is typed loosely; cast to the Fastify shape we exercise in tests
    fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance
    fastify.addHook('onRequest', (req, _reply, done) => {
      const fReq = req as AppRequest
      fReq.ctx = fReq.ctx || {}
      const traceId = parseIncomingTrace(
        fReq.headers?.['traceparent'] as string | undefined,
        fReq.headers?.['x-request-id'] as string | undefined,
      )
      fReq.ctx.traceId = traceId
      const realmHeader = (fReq.headers?.['x-realm-id'] as string | undefined)?.trim()
      if (realmHeader) fReq.ctx.realmId = realmHeader
      fReq.ctx.isRealmAdmin = String(fReq.headers?.['x-realm-admin'] || '').toLowerCase() === 'true'
      done()
    })
    app.useGlobalInterceptors(
      new DbSessionInterceptor(),
      new EnvelopeInterceptor(),
      new TraceHeadersInterceptor(),
      new ExposeHeadersInterceptor(),
    )

    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }, 30000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await app?.close()
  }, 30000)

  it('wraps health output and emits trace headers', async () => {
    const traceId = '0123456789abcdef0123456789abcdef'
    const res = await fastify.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': traceId } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, code: 'OK', data: { service: 'vluna', status: 'healthy' } })
    expect(res.headers['traceparent']).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
    expect(res.headers['x-request-id']).toBe(traceId)
    const expose = String(res.headers['access-control-expose-headers'] || '')
    expect(expose.toLowerCase()).toContain('traceparent')
    expect(expose.toLowerCase()).toContain('x-request-id')
    expect(dbSpy).toHaveBeenCalled()
    expect(setRlsSpy).toHaveBeenCalled()
  })

  it('attaches db handle through DbSessionInterceptor on management route', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/mgt/v1/debug/ctx',
      headers: {
        'x-request-id': 'fedcba9876543210fedcba9876543210',
        'x-realm-id': 'realm_mgt',
        'x-realm-admin': 'true',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, code: 'OK', data: { hasDb: true, realmId: 'realm_mgt' } })
    expect(transactionSpy).toHaveBeenCalled()
    expect(executeSpy).toHaveBeenCalled()
    expect(setRlsSpy).toHaveBeenCalledWith(fakeTrx, {
      realmId: 'realm_mgt',
      billingAccountId: undefined,
      isRealmAdmin: true,
    })
  })
})
