import { describe, it, expect } from 'vitest'
import { createStripeClient, STRIPE_CONSTANTS } from '../../../src/providers/stripe/client.js'

describe('Stripe client factory', { tags: ['unit'] }, () => {
  it('initializes in test mode with pinned apiVersion', () => {
    const s = createStripeClient({ env: 'test', apiKey: 'sk_test_123' })
    // @ts-expect-error private field access for test
    const version = s.getApiField('version')
    expect(version).toBe(STRIPE_CONSTANTS.API_VERSION)
  })

  it('throws when api key missing', () => {
    expect(() => createStripeClient({ env: 'test', apiKey: '' })).toThrow(/Missing Stripe API key/)
  })
})
