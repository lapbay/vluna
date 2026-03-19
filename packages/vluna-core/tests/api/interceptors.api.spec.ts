import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Controller, Get, Module, Req, Res } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import { DbSessionInterceptor } from '../../src/support/db-session.interceptor.js'
import { EnvelopeInterceptor } from '../../src/support/envelope.interceptor.js'
import { TraceHeadersInterceptor } from '../../src/support/trace-headers.interceptor.js'
import { ExposeHeadersInterceptor } from '../../src/support/expose-headers.interceptor.js'
import { PermissionsChangedInterceptor } from '../../src/support/permissions-changed.interceptor.js'
import { parseIncomingTrace } from '../../src/support/trace.util.js'
import type { AppRequest } from '../../src/types/app-request.js'
import * as dbModule from '../../src/db/index.js'
import type { Database } from '../../src/types/database.js'
import { TokenStrategyRegistry } from '../../src/auth/tokens/token-strategy.registry.js'
import { PlatformTokenStrategy } from '../../src/auth/tokens/platform.token.strategy.js'

@Controller('probe')
class ProbeController {
  @Get('plain')
  plain(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('Access-Control-Expose-Headers', 'foo')
    return { hello: 'world' }
  }

  @Get('error')
  error() {
    return { ok: false, code: 'VALIDATION.INVALID_INPUT', message: 'boom' }
  }

  @Get('trace')
  trace(@Req() req: AppRequest) {
    return { trace: req.ctx?.traceId ?? null }
  }

  @Get('db')
  dbInfo(@Req() req: AppRequest) {
    return { hasDb: !!req.ctx?.db, realm: req.ctx?.realmId ?? null }
  }

  @Get('perm')
  perm(@Req() req: AppRequest) {
    req.ctx = req.ctx || {}
    req.ctx.versionToken = 'v1'
    req.ctx.versionUser = 'v2'
    return { ok: true }
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

@Module({ imports: [ProbeModule] })
class TestAppModule {}

describe('API interceptors & wiring', { tags: ['api'] }, () => {
  let app: NestFastifyApplication
  let fastify: FastifyInstance

  const fakeTrx = { tag: 'trx' } as unknown as Kysely<Database>
  const executeSpy = vi.fn(async (cb: (trx: Kysely<Database>) => unknown) => cb(fakeTrx))
  const transactionSpy = vi.fn(() => ({ execute: executeSpy }))
  const _dbSpy = vi.spyOn(dbModule, 'db').mockReturnValue({ transaction: transactionSpy } as unknown as Kysely<Database>)
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
      const billingHeader = (fReq.headers?.['x-billing-account-id'] as string | undefined)?.trim()
      if (billingHeader) fReq.ctx.billingAccountId = billingHeader
      fReq.ctx.isRealmAdmin = String(fReq.headers?.['x-realm-admin'] || '').toLowerCase() === 'true'
      done()
    })

    app.useGlobalInterceptors(
      new DbSessionInterceptor(),
      new EnvelopeInterceptor(),
      new TraceHeadersInterceptor(),
      new ExposeHeadersInterceptor(),
      new PermissionsChangedInterceptor(),
    )

    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }, 30000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await app?.close()
  }, 30000)

  it('wraps plain output and merges exposed headers', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/probe/plain',
      headers: { 'x-request-id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, code: 'OK', data: { hello: 'world' } })
    const exposed = String(res.headers['access-control-expose-headers'] || '')
    expect(exposed.toLowerCase()).toContain('foo')
    expect(exposed.toLowerCase()).toContain('traceparent')
    expect(exposed.toLowerCase()).toContain('x-request-id')
  })


  it('maps error envelopes to HTTP status', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/probe/error' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ ok: false, code: 'VALIDATION.INVALID_INPUT', message: 'boom' })
  })

  it('emits trace headers and new span per response', async () => {
    const traceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const first = await fastify.inject({ method: 'GET', url: '/api/probe/trace', headers: { 'x-request-id': traceId } })
    const second = await fastify.inject({ method: 'GET', url: '/api/probe/trace', headers: { 'x-request-id': traceId } })

    const firstParent = String(first.headers['traceparent'] || '')
    const secondParent = String(second.headers['traceparent'] || '')
    expect(firstParent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
    expect(secondParent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
    expect(firstParent).not.toEqual(secondParent)
  })

  it('signals permissions change via header', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/probe/perm' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-permissions-changed']).toBe('1')
  })

  it('sets db session with realm when present', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/probe/db',
      headers: { 'x-realm-id': 'realm_api', 'x-realm-admin': 'true' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, code: 'OK', data: { hasDb: true, realm: 'realm_api' } })
    expect(setRlsSpy).toHaveBeenCalledWith(fakeTrx, {
      realmId: 'realm_api',
      billingAccountId: undefined,
      isRealmAdmin: true,
    })
  })

  it('still attaches db when realm missing and swallows setRls errors', async () => {
    setRlsSpy.mockRejectedValueOnce(new Error('boom'))
    const res = await fastify.inject({ method: 'GET', url: '/api/probe/db' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, code: 'OK', data: { hasDb: true, realm: null } })
    expect(transactionSpy).toHaveBeenCalled()
    expect(executeSpy).toHaveBeenCalled()
  })
})
