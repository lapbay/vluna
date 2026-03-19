import { describe, it, expect, vi } from 'vitest'
import { newSpanId, newTraceId, parseIncomingTrace } from '../../src/support/trace.util.js'

describe('trace.util', { tags: ['unit'] }, () => {
  it('generates hex ids of expected length', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('prefers traceparent over x-request-id and falls back to new id', () => {
    const tp = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'
    expect(parseIncomingTrace(tp, 'ffffffffffffffffffffffffffffffff')).toBe('1234567890abcdef1234567890abcdef')
    expect(parseIncomingTrace(undefined, 'ffffffffffffffffffffffffffffffff')).toBe('ffffffffffffffffffffffffffffffff')
    vi.spyOn(global.Math, 'random').mockReturnValue(0) // deterministic newTraceId
    expect(parseIncomingTrace(undefined, undefined)).toMatch(/^[0-9a-f]{32}$/)
    vi.restoreAllMocks()
  })
})
