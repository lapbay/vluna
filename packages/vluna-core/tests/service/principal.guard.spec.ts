import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { HttpException, type ExecutionContext } from '@nestjs/common'
import { PrincipalGuard } from '../../src/auth/guards/principal.guard.js'
import type { AppRequest } from '../../src/types/app-request.js'
import * as resolver from '../../src/security/principal/principal.resolver.js'

vi.mock('../../src/security/principal/principal.resolver.js')

function makeReq(ctx: Partial<AppRequest['ctx']> = {}, headers: Record<string, string> = {}): AppRequest {
  const req = {
    headers,
    ctx: { ...ctx },
  } as unknown as AppRequest
  return req
}

function makeCtx(req: AppRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext
}

describe('PrincipalGuard', { tags: ['service'] }, () => {
  const resolvePrincipal = resolver.resolvePrincipal as unknown as Mock

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses platform token claims when tu=plt', async () => {
    const req = makeReq({ claims: { tu: 'plt', principal_id: 'user123' } })
    const guard = new PrincipalGuard()
    const allowed = await guard.canActivate(makeCtx(req))
    expect(allowed).toBe(true)
    expect(req.ctx?.principal?.id).toBe('user123')
    expect(resolvePrincipal).not.toHaveBeenCalled()
  })

  it('resolves principal from claims via resolver', async () => {
    resolvePrincipal.mockReturnValue({ id: 'p1', type: 'user' })
    const req = makeReq({ claims: { sub: 'abc' }, realmId: 'realmA' }, { 'x-realm-id': 'realmA' })
    const guard = new PrincipalGuard()
    const allowed = await guard.canActivate(makeCtx(req))
    expect(allowed).toBe(true)
    expect(req.ctx?.principal?.id).toBe('p1')
    expect(resolvePrincipal).toHaveBeenCalled()
  })

  it('throws when claims missing for bearer scheme', async () => {
    const req = makeReq({}, { authorization: 'Bearer token' })
    const guard = new PrincipalGuard()
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(HttpException)
  })

  it('propagates resolver errors as HttpException with status', async () => {
    const error = new Error('bad') as Error & { status?: number }
    error.status = 422
    resolvePrincipal.mockImplementation(() => {
      throw error
    })
    const req = makeReq({ claims: { sub: 'abc' }, realmId: 'realmA' }, { authorization: 'Bearer token' })
    const guard = new PrincipalGuard()
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(HttpException)
  })
})
