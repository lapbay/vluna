import { describe, it, expect } from 'vitest'
import { errEnvelope, okEnvelope } from '../../src/common/envelope.js'

describe('envelope helpers', { tags: ['unit'] }, () => {
  it('produces a success envelope with defaults', () => {
    const env = okEnvelope({ hello: 'world' }, { meta: { traceId: 't1' } })
    expect(env.ok).toBe(true)
    expect(env.code).toBe('OK')
    expect(env.data).toEqual({ hello: 'world' })
    expect(env.meta).toEqual({ traceId: 't1' })
  })

  it('produces an error envelope with default message', () => {
    const env = errEnvelope('VALIDATION.INVALID_INPUT')
    expect(env.ok).toBe(false)
    expect(env.code).toBe('VALIDATION.INVALID_INPUT')
    expect(env.message).toBeDefined()
  })
})
