import Stripe from 'stripe'

/**
 * Verify and parse a Stripe webhook event using the provided signing secret.
 * Does not require an API client or secret key.
 */
export function verifyStripeEvent(rawBody: Buffer, signatureHeader: string | undefined, secret: string) {
  if (!signatureHeader) throw new Error('Missing stripe-signature header')
  if (!secret) throw new Error('Missing Stripe webhook secret')
  return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret)
}
