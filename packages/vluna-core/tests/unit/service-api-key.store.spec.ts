import { describe, it, expect } from 'vitest'
import { getServiceApiKeyRegistry, setServiceApiKeyRegistry, getServiceApiKey } from '../../src/security/service-api-key.store.js'
import type { DerivedServiceApiKey } from '../../src/security/service-api-key.helpers.js'

describe('service-api-key.store', { tags: ['unit'] }, () => {
  it('stores and retrieves registry entries', () => {
    const entry: DerivedServiceApiKey = {
      keyId: 'k1',
      status: 'active',
      allowedRealms: ['r1'],
      allowedAccounts: [],
      scopes: [],
      kdfAlgorithm: 'HKDF-SHA256',
      kdfVersion: 1,
      envTag: 'local',
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      secret: Buffer.from('abc'),
      secretBase64: Buffer.from('abc').toString('base64'),
      secretHex: Buffer.from('abc').toString('hex'),
    }
    const map = new Map<string, DerivedServiceApiKey>([['k1', entry]])
    setServiceApiKeyRegistry(map)
    const reg = getServiceApiKeyRegistry()
    expect(reg.get('k1')).toBe(entry)
    expect(getServiceApiKey('k1')).toBe(entry)
  })
})
