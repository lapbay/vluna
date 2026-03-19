import { describe, it, expect } from 'vitest'
import Stripe from 'stripe'
import { verifyStripeEvent } from '../../../src/providers/stripe/webhooks.js'

describe('Stripe webhook verification', { tags: ['unit'] }, () => {
  it('accepts valid signature and test mode', () => {
    const secret = 'whsec_test_abc'
    const payload = JSON.stringify({ id: 'evt_1', type: 'product.created', livemode: false })
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
    const evt = verifyStripeEvent(Buffer.from(payload, 'utf8'), header, secret)
    expect(evt.id).toBe('evt_1')
  })

  it('rejects invalid signature', () => {
    const payload = JSON.stringify({ id: 'evt_2', type: 'price.updated', livemode: false })
    expect(() => verifyStripeEvent(Buffer.from(payload), 'bad', 'whsec_test_abc')).toThrow()
  })
})
