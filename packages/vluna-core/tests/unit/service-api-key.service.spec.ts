import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ServiceApiKeyService } from '../../src/security/service-api-key.service.js'
import { ServiceApiKeyError } from '../../src/security/service-api-key.helpers.js'

const ORIGINAL_ENV = { ...process.env }

describe('ServiceApiKeyService', { tags: ['unit'] }, () => {
  beforeEach(() => {
    process.env.BILLING_MASTER_KEY = '616263' // 'abc' hex
    process.env.NODE_ENV = 'local'
    process.env.VLUNA_PLATFORM_TOKEN_VERSION = '1'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('derives and caches platform token secret per realm', () => {
    const svc = new ServiceApiKeyService()
    const s1 = svc.getPlatformTokenSecret('realm1')
    const s2 = svc.getPlatformTokenSecret('realm1')
    expect(s1.secret.equals(s2.secret)).toBe(true)
    expect(s1).toBe(s2) // same cached entry
  })

  it('produces stable derived secret for known inputs (golden vector)', () => {
    const svc = new ServiceApiKeyService()
    const secret = svc.getPlatformTokenSecret('realm1')
    // Derived using HKDF-SHA256 with master=0x616263, salt=sha256("platform-token:realm1:v1"), envTag=local, length=32.
    expect(secret.secret.toString('hex')).toBe('d787d588868a2a063cc3f235c552a70082130a1d5f6427b9395066c093d6ab19')
  })

  it('changes cache key when version differs', () => {
    const svc = new ServiceApiKeyService()
    const v1 = svc.getPlatformTokenSecret('realm1')
    process.env.VLUNA_PLATFORM_TOKEN_VERSION = '2'
    const v2 = svc.getPlatformTokenSecret('realm1')
    expect(v1.keyId).not.toBe(v2.keyId)
    expect(v1.secret.equals(v2.secret)).toBe(false)
  })

  it('throws when master key missing', () => {
    delete process.env.BILLING_MASTER_KEY
    const svc = new ServiceApiKeyService()
    expect(() => svc.getPlatformTokenSecret('realm1')).toThrow(ServiceApiKeyError)
  })
})
