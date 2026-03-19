import Stripe from 'stripe'
import { newTraceId } from '../../support/trace.util.js'

export type StripeEnv = 'test' | 'live'

const API_VERSION: Stripe.LatestApiVersion = '2024-06-20'

export type StripeClientConfig = {
  env: StripeEnv
  apiKey?: string
  requestTimeoutMs?: number
  maxNetworkRetries?: number
}

/**
 * Create a configured Stripe client.
 * - Pins apiVersion to avoid breaking changes.
 * - Sets appInfo for observability.
 * - Enables network retries for 429/5xx with backoff.
 * - Uses TEST key by default for this demo.
 */
export function createStripeClient(cfg: StripeClientConfig): Stripe {
  const env: StripeEnv = cfg.env
  const apiKey = (cfg.apiKey || '').trim()
  if (!apiKey) {
    throw new Error('CONFIG: Missing Stripe API key for env=' + env)
  }

  const client = new Stripe(apiKey, {
    apiVersion: API_VERSION,
    maxNetworkRetries: cfg.maxNetworkRetries ?? 2,
    timeout: cfg.requestTimeoutMs ?? 20_000,
    appInfo: {
      name: 'vluna-billing-demo',
      url: 'https://example.local',
      version: '0.1.0',
    },
  })

  return client
}

export type StripeCallMeta = {
  traceId?: string
  op: string
}

/**
 * Helper to call Stripe SDK functions and emit structured logs including requestId and traceId.
 */
export async function callStripe<T>(fn: () => Promise<T>, meta: StripeCallMeta): Promise<T> {
  const traceId = meta.traceId || newTraceId()
  try {
    const result = await fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any 
    const anyRes = result as any
    const reqId: string | undefined = anyRes?.lastResponse?.requestId || anyRes?.lastResponse?.headers?.['request-id']
    console.log(JSON.stringify({ at: 'stripe.call.ok', op: meta.op, traceId, requestId: reqId }))
    return result
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any 
    const e = err as any
    const reqId: string | undefined = e?.raw?.requestId || e?.requestId
    console.error(JSON.stringify({ at: 'stripe.call.err', op: meta.op, traceId, requestId: reqId, error: e?.message }))
    throw err
  }
}

export const STRIPE_CONSTANTS = { API_VERSION }
