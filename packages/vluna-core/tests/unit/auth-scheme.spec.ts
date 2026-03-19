import { describe, it, expect } from 'vitest'
import { detectAuthScheme } from '../../src/auth/utils/auth-scheme.js'

describe('detectAuthScheme', { tags: ['unit'] }, () => {
  it('detects service scheme', () => {
    expect(detectAuthScheme('SVC-AUTH keyId=1')).toBe('service')
    expect(detectAuthScheme('srv-auth something')).toBe('service')
  })

  it('detects bearer scheme', () => {
    expect(detectAuthScheme('Bearer abc')).toBe('bearer')
  })

  it('returns undefined on empty or unknown', () => {
    expect(detectAuthScheme(undefined)).toBeUndefined()
    expect(detectAuthScheme('')).toBeUndefined()
    expect(detectAuthScheme('Basic abc')).toBeUndefined()
  })
})
