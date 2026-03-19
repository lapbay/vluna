import type { components as GateComponents } from '../contracts/gate.js'
import { defaultMessageFor, type ErrorCode } from '../contracts/error-codes.js'

type GateHint = GateComponents['schemas']['Hint']

export type Envelope<T = unknown> = {
  ok: boolean
  code: ErrorCode
  message?: string
  data?: T
  meta?: Record<string, unknown>
  hints?: GateHint[]
}

export function okEnvelope<T>(
  data?: T,
  opts?: { traceId?: string; meta?: Record<string, unknown>; hints?: GateHint[] },
) {
  const e: Envelope<T> = { ok: true, code: 'OK', data, meta: opts?.meta, hints: opts?.hints }
  return e
}

// Contract-aware error envelope; leaves HTTP status setting to interceptors/filters.
export function errEnvelope(
  code: ErrorCode,
  opts?: { message?: string; traceId?: string; meta?: Record<string, unknown>; hints?: GateHint[] },
) {
  // Use generated helper for default messages
  const message = opts?.message ?? defaultMessageFor(code)
  const e: Envelope = { ok: false, code, message, meta: opts?.meta, hints: opts?.hints }
  return e
}
