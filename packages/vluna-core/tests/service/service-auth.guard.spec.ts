import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { HttpException, type ExecutionContext } from '@nestjs/common'
import { ServiceAuthGuard } from '../../src/auth/guards/service-auth.guard.js'
import type { ServiceApiKeyService } from '../../src/security/service-api-key.service.js'
import type { DerivedServiceApiKey } from '../../src/security/service-api-key.helpers.js'
import type { AppRequest } from '../../src/types/app-request.js'
import * as verifier from '../../src/security/service-request.verifier.js'

vi.mock('../../src/security/service-request.verifier.js')

function makeReq(headers: Record<string, string> = {}, ctx: Partial<AppRequest['ctx']> = {}): AppRequest {
  const req = {
    method: 'POST',
    url: '/api/v1/resource',
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

const baseKey: DerivedServiceApiKey = {
  keyId: 'k1',
  status: 'active',
  allowedRealms: [],
  allowedAccounts: [],
  scopes: [],
  kdfAlgorithm: 'HKDF-SHA256',
  kdfVersion: 1,
  envTag: 'local',
  createdAt: new Date(),
  expiresAt: null,
  lastUsedAt: null,
  secret: Buffer.from('secret'),
  secretBase64: Buffer.from('secret').toString('base64'),
  secretHex: Buffer.from('secret').toString('hex'),
}

describe('ServiceAuthGuard', { tags: ['service'] }, () => {
  const parseAuth = verifier.parseAuthorizationHeader as unknown as Mock
  const verifyReq = verifier.verifyServiceRequest as unknown as Mock

  beforeEach(() => {
    vi.restoreAllMocks()
    parseAuth.mockReturnValue({
      keyId: 'k1',
      signature: 'sig',
      timestampISO: '2025-01-01T00:00:00Z',
      nonce: 'n',
      algorithm: 'HMAC-SHA256',
    })
    verifyReq.mockReturnValue({
      ok: true,
      parsed: { keyId: 'k1', signature: 'sig', timestampISO: '2025-01-01T00:00:00Z', nonce: 'n', algorithm: 'HMAC-SHA256' },
      canonical: 'canon',
      verified: { realmId: 'realmA', billingAccountId: 'ba1', principalId: 'p1' },
    })
  })

  it('populates ctx on successful service auth', async () => {
    const svc: Pick<ServiceApiKeyService, 'getKey' | 'loadSecrets'> = {
      getKey: vi.fn().mockReturnValue(baseKey),
      loadSecrets: vi.fn(),
    }
    const req = makeReq(
      {
        authorization: 'SVC-AUTH keyId=k1',
        'x-realm-id': 'realmA',
        'x-billing-account-id': 'ba1',
        'x-principal-id': 'p1',
      },
      { authScheme: 'service' },
    )
    const guard = new ServiceAuthGuard(svc as ServiceApiKeyService)
    const allowed = await guard.canActivate(makeCtx(req))

    expect(allowed).toBe(true)
    expect(req.ctx?.realmId).toBe('realmA')
    expect(req.ctx?.serviceAuthBinding?.billingAccountId).toBe('ba1')
    expect(req.ctx?.serviceApiKey?.keyId).toBe('k1')
    expect(verifyReq).toHaveBeenCalled()
  })

  it('rejects when key not found', async () => {
    const svc: Pick<ServiceApiKeyService, 'getKey' | 'loadSecrets'> = {
      getKey: vi.fn().mockReturnValue(undefined),
      loadSecrets: vi.fn().mockResolvedValue(undefined),
    }
    const req = makeReq({ authorization: 'SVC-AUTH keyId=missing' }, { authScheme: 'service' })
    const guard = new ServiceAuthGuard(svc as ServiceApiKeyService)
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(HttpException)
  })

  it('rejects when realm not allowed', async () => {
    const svc: Pick<ServiceApiKeyService, 'getKey' | 'loadSecrets'> = {
      getKey: vi.fn().mockReturnValue({ ...baseKey, allowedRealms: ['r1'] }),
      loadSecrets: vi.fn(),
    }
    const req = makeReq(
      {
        authorization: 'SVC-AUTH keyId=k1',
        'x-realm-id': 'r2',
        'content-digest': 'sha-256=:x:',
      },
      { authScheme: 'service' },
    )
    // keep verifyRequest returning ok; failure should arise from realm constraint
    const guard = new ServiceAuthGuard(svc as ServiceApiKeyService)
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(HttpException)
  })

  it('rejects on signature mismatch', async () => {
    verifyReq.mockReturnValue({
      ok: false,
      code: 'signature_mismatch',
      message: 'bad sig',
      parsed: { keyId: 'k1', signature: 'sig', timestampISO: 'ts', nonce: 'n', algorithm: 'HMAC-SHA256' },
    })
    const svc: Pick<ServiceApiKeyService, 'getKey' | 'loadSecrets'> = {
      getKey: vi.fn().mockReturnValue(baseKey),
      loadSecrets: vi.fn(),
    }
    const req = makeReq({ authorization: 'SVC-AUTH keyId=k1', 'x-realm-id': 'realmA', 'content-digest': 'sha-256=:x:' }, { authScheme: 'service' })
    const guard = new ServiceAuthGuard(svc as ServiceApiKeyService)
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(HttpException)
  })
})
