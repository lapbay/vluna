import type { components as GateComponents } from '../../../contracts/gate.js'
import { toSafeNumber } from './gate.utils.js'

export type GateHint = GateComponents['schemas']['Hint']

type NumericLike = number | bigint | undefined | null

function toMinor(value: NumericLike, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'bigint') return toSafeNumber(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  return fallback
}

export function quotaRemainingHint(maxQuantity: NumericLike, message?: string): GateHint {
  return {
    type: 'quota.remaining',
    max_quantity_minor: toMinor(maxQuantity),
    message: message
  }
}

export function rateLimitHint(seconds: number, remaining: number, until?: Date): GateHint {
  const safeSeconds = Math.max(0, Math.ceil(seconds))
  return {
    type: 'rate.limit',
    seconds: safeSeconds,
    remaining: remaining,
    ...(until ? { until: until.toISOString() } : {}),
  }
}

export function xusdShortfallHint(shortfall: NumericLike): GateHint {
  return {
    type: 'funding.xusd_shortfall',
    shortfall_xusd: toMinor(shortfall),
  }
}

export function budgetShortfallHint(budgetId: string | number, shortfall: NumericLike): GateHint {
  return {
    type: 'budget.shortfall',
    budget_id: String(budgetId),
    shortfall_xusd: toMinor(shortfall),
  }
}

export function lowHeadroomHint(headroom: NumericLike, threshold?: NumericLike): GateHint {
  const headroomXusd = toMinor(headroom)
  const thresholdXusd = threshold !== undefined ? toMinor(threshold) : undefined
  return {
    type: 'budget.low_headroom',
    headroom_xusd: headroomXusd,
    ...(thresholdXusd !== undefined ? { threshold_xusd: thresholdXusd } : {}),
  }
}

export function pricingChangedHint(
  previousFingerprint: string,
  currentFingerprint: string,
): GateHint {
  return {
    type: 'pricing.changed',
    previous_fingerprint: previousFingerprint,
    current_fingerprint: currentFingerprint,
  }
}

export function leaseExpiredHint(params: { expiresAt: Date; deltaMs: number; graceMs: number }): GateHint {
  const deltaMs = Math.max(0, Math.floor(params.deltaMs))
  const graceMs = Math.max(0, Math.floor(params.graceMs))
  return {
    type: 'lease.expired',
    expires_at: params.expiresAt.toISOString(),
    delta_ms: deltaMs,
    grace_ms: graceMs,
    exceeded_grace: deltaMs > graceMs,
  }
}

export function leaseClosedAtCommitHint(state: string): GateHint {
  return {
    type: 'lease.closed_at_commit',
    state,
  }
}

export function policyWindowNotFoundHint(featureCode: string): GateHint {
  return {
    type: 'policy.window_not_found',
    feature_code: featureCode,
  }
}

export function featureMeterNotAllowedHint(featureCode: string, meters: string[]): GateHint {
  return {
    type: 'feature.meter_not_allowed',
    feature_code: featureCode,
    meters,
  }
}

export function pricingNotConfiguredHint(featureCode: string, meters: string[]): GateHint {
  return {
    type: 'pricing.not_configured',
    feature_code: featureCode,
    meters,
  }
}

export function contractPricingInvalidTermHint(params: {
  meterCode: string
  contractId: string
  termKey: string
  message?: string
}): GateHint {
  return {
    type: 'pricing.contract_term_invalid',
    meter_code: params.meterCode,
    contract_id: params.contractId,
    term_key: params.termKey,
    ...(params.message ? { message: params.message } : {}),
  }
}

export function contractPricingMeterPriceMissingHint(params: {
  meterCode: string
  contractId: string
  termKey: string
  message?: string
}): GateHint {
  return {
    type: 'pricing.meter_price_missing',
    meter_code: params.meterCode,
    contract_id: params.contractId,
    term_key: params.termKey,
    ...(params.message ? { message: params.message } : {}),
  }
}
