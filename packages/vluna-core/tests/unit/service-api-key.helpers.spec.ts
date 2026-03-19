import { describe, it, expect } from 'vitest'
import {
  buildInfo,
  coerceStringArray,
  deriveSecret,
  parseMasterKey,
  ServiceApiKeyError,
} from '../../src/security/service-api-key.helpers.js'

describe('service-api-key.helpers parseMasterKey', { tags: ['unit'] }, () => {
  it('parses hex/base64/utf8', () => {
    expect(parseMasterKey('616263')).toEqual(Buffer.from('abc', 'utf8'))
    expect(parseMasterKey(Buffer.from('abc').toString('base64'))).toEqual(Buffer.from('abc'))
    expect(parseMasterKey('plain-text')).toEqual(Buffer.from('plain-text', 'utf8'))
  })

  it('throws on empty', () => {
    expect(() => parseMasterKey('')).toThrow(ServiceApiKeyError)
    expect(() => parseMasterKey(undefined)).toThrow(ServiceApiKeyError)
  })
})

describe('service-api-key.helpers deriveSecret', { tags: ['unit'] }, () => {
  const master = Buffer.from('master-key')
  const salt = Buffer.from('salt')

  it('derives deterministic HKDF secret', () => {
    const a = deriveSecret({
      algorithm: 'HKDF-SHA256',
      masterKey: master,
      salt,
      keyId: 'k1',
      envTag: 'local',
      kdfVersion: 1,
      length: 16,
    })
    const b = deriveSecret({
      algorithm: 'HKDF-SHA256',
      masterKey: master,
      salt,
      keyId: 'k1',
      envTag: 'local',
      kdfVersion: 1,
      length: 16,
    })
    expect(a.equals(b)).toBe(true)
    expect(a.length).toBe(16)
  })

  it('derives deterministic HMAC secret', () => {
    const s = deriveSecret({
      algorithm: 'HMAC-SHA256',
      masterKey: master,
      salt,
      keyId: 'k2',
      envTag: 'dev',
      kdfVersion: 2,
      length: 8,
    })
    expect(s.length).toBe(8)
  })
})

describe('service-api-key.helpers misc', { tags: ['unit'] }, () => {
  it('buildInfo uses null separators', () => {
    const info = buildInfo('id', 'env', 1)
    expect(info.includes(0x00)).toBe(true)
  })

  it('coerceStringArray filters invalid entries', () => {
    expect(coerceStringArray(['a', '', 'b'])).toEqual(['a', 'b'])
    expect(coerceStringArray(undefined)).toEqual([])
  })
})
