import { describe, expect, it, vi } from 'vitest'
type ViMock = ReturnType<typeof vi.fn>
import type { ExecutionContext } from '@nestjs/common'
import { HttpException } from '@nestjs/common'
import { ServiceAuthGuard } from '../../src/auth/guards/service-auth.guard.js'
import { PrincipalGuard } from '../../src/auth/guards/principal.guard.js'
import type { AppRequest } from '../../src/types/app-request.js'
import type { DerivedServiceApiKey } from '../../src/security/service-api-key.helpers.js'
import type { ServiceApiKeyService } from '../../src/security/service-api-key.service.js'

vi.mock('../../src/security/service-request.verifier.js', () => ({
  parseAuthorizationHeader: vi.fn(),
  verifyServiceRequest: vi.fn(),
}))
vi.mock('../../src/security/principal/principal.resolver.js', () => ({
  resolvePrincipal: vi.fn(),
}))

const { parseAuthorizationHeader, verifyServiceRequest } = await import('../../src/security/service-request.verifier.js')
const { resolvePrincipal } = await import('../../src/security/principal/principal.resolver.js')

function createContext(req: AppRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext
}

describe('ServiceAuthGuard', { tags: ['api'] }, () => {
  const baseKey: DerivedServiceApiKey = {
    keyId: 'k1',
    secret: Buffer.from('s'),
    secretHex: Buffer.from('s').toString('hex'),
    secretBase64: Buffer.from('s').toString('base64'),
    envTag: 'test',
    status: 'active',
    scopes: ['*'],
    allowedRealms: [],
    allowedAccounts: [],
    kdfAlgorithm: 'HKDF-SHA256',
    kdfVersion: 1,
    createdAt: new Date(),
    expiresAt: null,
    lastUsedAt: null,
  }

  it('skips when scheme is not service', async () => {
    const guard = new ServiceAuthGuard({ getKey: vi.fn(), loadSecrets: vi.fn() } as unknown as ServiceApiKeyService)
    const req = { headers: {}, ctx: { authScheme: 'bearer' } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('throws when service auth missing header', async () => {
    const guard = new ServiceAuthGuard({ getKey: vi.fn(), loadSecrets: vi.fn() } as unknown as ServiceApiKeyService)
    const req = { headers: {}, ctx: { authScheme: 'service' } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
  })

  it('populates ctx on successful verification', async () => {
    const serviceApiKeyService = {
      getKey: vi.fn(() => baseKey),
      loadSecrets: vi.fn(),
    }
    ;(parseAuthorizationHeader as ViMock).mockReturnValue({ keyId: 'k1' })
    ;(verifyServiceRequest as ViMock).mockReturnValue({
      ok: true,
      parsed: { timestampISO: 't', nonce: 'n', algorithm: 'hmac' },
      canonical: 'canon',
      verified: { realmId: 'realm-x', principalId: 'p1', billingAccountId: 'ba1' },
    })
    const guard = new ServiceAuthGuard(serviceApiKeyService as unknown as ServiceApiKeyService)
    const req = {
      method: 'POST',
      url: '/api/test',
      headers: { authorization: 'SVC ...' },
      ctx: { authScheme: 'service' },
    } as unknown as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.ctx?.serviceApiKey?.keyId).toBe('k1')
    expect(req.ctx?.realmId).toBe('realm-x')
    expect(req.ctx?.serviceAuthBinding).toEqual({ principalId: 'p1', billingAccountId: 'ba1' })
  })

  it('rejects when realm missing', async () => {
    const serviceApiKeyService = {
      getKey: vi.fn(() => baseKey),
      loadSecrets: vi.fn(),
    }
    ;(parseAuthorizationHeader as ViMock).mockReturnValue({ keyId: 'k1' })
    ;(verifyServiceRequest as ViMock).mockReturnValue({
      ok: true,
      parsed: { timestampISO: 't', nonce: 'n', algorithm: 'hmac' },
      canonical: 'canon',
      verified: { realmId: '', principalId: 'p1', billingAccountId: '' },
    })
    const guard = new ServiceAuthGuard(serviceApiKeyService as unknown as ServiceApiKeyService)
    const req = { method: 'GET', url: '/', headers: { authorization: 'SVC ...' }, ctx: { authScheme: 'service' } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
  })
})

describe('PrincipalGuard', { tags: ['api'] }, () => {
  it('returns true if principal already present', async () => {
    const guard = new PrincipalGuard()
    const req = { headers: {}, ctx: { principal: { id: 'p' } } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('extracts platform principal from claims', async () => {
    const guard = new PrincipalGuard()
    const req = { headers: {}, ctx: { claims: { tu: 'plt', principal_id: 'p123' } } } as unknown as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.ctx?.principal).toEqual({ id: 'p123', type: 'platform' })
  })

  it('throws when claims missing for bearer', async () => {
    const guard = new PrincipalGuard()
    const req = { headers: {}, ctx: { authScheme: 'bearer' } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
  })

  it('resolves principal via resolver', async () => {
    ;(resolvePrincipal as ViMock).mockReturnValue({ id: 'u1', type: 'user' })
    const guard = new PrincipalGuard()
    const req = { headers: {}, ctx: { claims: { sub: 'u1' }, realmId: 'realm1' } } as AppRequest
    const ctx = createContext(req)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.ctx?.principal).toEqual({ id: 'u1', type: 'user' })
  })
})
