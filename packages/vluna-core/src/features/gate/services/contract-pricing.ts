import type { RoundingMode } from './gate.types.js'

export type ContractTermKind = 'pricing' | 'e2r_param'

export type ContractPricingBase = 'unit_price_xusd' | 'unit_cost_xusd' | 'cost'

export type ContractPricingAdjustment =
  | { op: 'fixed'; unit_price_xusd: string }
  | { op: 'multiplier'; multiplier: string; rounding?: RoundingMode }
  | { op: 'delta'; delta_xusd: string }

export type ContractPricingSide = {
  base?: ContractPricingBase
  adjustments?: ContractPricingAdjustment[]
}

export type ContractPricingTermV1 = {
  schema: 'vluna/contract_pricing:v1'
  meter_code: string
  price?: ContractPricingSide
  cost?: ContractPricingSide
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseIntString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (!/^-?[0-9]+$/.test(trimmed)) throw new Error(`${field} must be an integer string`)
  return trimmed
}

function parseNonNegativeIntString(value: unknown, field: string): string {
  const s = parseIntString(value, field)
  if (s.startsWith('-')) throw new Error(`${field} must be >= 0`)
  return s
}

function parsePositiveIntString(value: unknown, field: string): string {
  const s = parseNonNegativeIntString(value, field)
  if (s === '0') throw new Error(`${field} must be >= 1`)
  return s
}

function parseMultiplier(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`)
  // Accept a non-negative decimal ("1", "1.25") or a non-negative fraction ("5/4").
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return trimmed
  if (/^[0-9]+\/[0-9]+$/.test(trimmed)) return trimmed
  throw new Error(`${field} must be a decimal like "1.25" or a fraction like "5/4"`)
}

function parseRoundingMode(value: unknown, field: string): RoundingMode | undefined {
  if (value === undefined) return undefined
  if (value === 'floor' || value === 'nearest' || value === 'ceil') return value
  throw new Error(`${field} must be one of: floor, nearest, ceil`)
}

function parseBase(value: unknown, field: string): ContractPricingBase | undefined {
  if (value === undefined) return undefined
  if (value === 'unit_price_xusd' || value === 'unit_cost_xusd' || value === 'cost') return value
  throw new Error(`${field} must be one of: unit_price_xusd, unit_cost_xusd, cost`)
}

function parseAdjustments(value: unknown, field: string): ContractPricingAdjustment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`)
    const op = entry.op
    if (op === 'fixed') {
      return { op, unit_price_xusd: parseNonNegativeIntString(entry.unit_price_xusd, `${field}[${index}].unit_price_xusd`) }
    }
    if (op === 'multiplier') {
      return {
        op,
        multiplier: parseMultiplier(entry.multiplier, `${field}[${index}].multiplier`),
        rounding: parseRoundingMode(entry.rounding, `${field}[${index}].rounding`),
      }
    }
    if (op === 'delta') {
      return { op, delta_xusd: parseIntString(entry.delta_xusd, `${field}[${index}].delta_xusd`) }
    }
    throw new Error(`${field}[${index}].op is invalid`)
  })
}

function parseSide(value: unknown, field: string): ContractPricingSide | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return {
    base: parseBase(value.base, `${field}.base`),
    adjustments: parseAdjustments(value.adjustments, `${field}.adjustments`),
  }
}

export function parseContractPricingTermV1(valueJson: unknown): ContractPricingTermV1 {
  if (!isRecord(valueJson)) throw new Error('contract pricing term must be an object')
  const schema = valueJson.schema
  if (schema !== 'vluna/contract_pricing:v1') throw new Error('contract pricing term schema mismatch')
  const meterCode = valueJson.meter_code
  if (typeof meterCode !== 'string' || meterCode.trim().length === 0) {
    throw new Error('meter_code is required')
  }
  return {
    schema,
    meter_code: meterCode.trim(),
    price: parseSide(valueJson.price, 'price'),
    cost: parseSide(valueJson.cost, 'cost'),
  }
}

function parseMultiplierToRatio(multiplier: string): { numer: bigint; denom: bigint } {
  const trimmed = multiplier.trim()
  if (trimmed.includes('/')) {
    const [numerStr, denomStr] = trimmed.split('/')
    const denom = BigInt(parsePositiveIntString(denomStr, 'multiplier.denom'))
    const numer = BigInt(parseNonNegativeIntString(numerStr, 'multiplier.numer'))
    return { numer, denom }
  }

  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(trimmed)
  if (!match) throw new Error('multiplier must be a decimal like "1.25" or a fraction like "5/4"')

  const integerPart = match[1]
  const fractionPart = match[2] ?? ''
  if (fractionPart.length === 0) return { numer: BigInt(integerPart), denom: 1n }
  if (fractionPart.length > 18) throw new Error('multiplier decimal scale must be <= 18')

  const numerStr = `${integerPart}${fractionPart}`
  const denom = 10n ** BigInt(fractionPart.length)
  const numer = BigInt(numerStr)
  return { numer, denom }
}

export function applyContractPricingAdjustments(unitPrice: bigint, adjustments: ContractPricingAdjustment[] | undefined): bigint {
  let price = unitPrice
  if (!adjustments || adjustments.length === 0) return price
  for (const adj of adjustments) {
    if (adj.op === 'fixed') {
      price = BigInt(adj.unit_price_xusd)
    } else if (adj.op === 'delta') {
      price = price + BigInt(adj.delta_xusd)
    } else if (adj.op === 'multiplier') {
      const { numer, denom } = parseMultiplierToRatio(adj.multiplier)
      const scaled = price * numer
      const rounding: RoundingMode = adj.rounding ?? 'nearest'
      if (rounding === 'floor') {
        price = scaled / denom
      } else if (rounding === 'ceil') {
        price = (scaled + denom - 1n) / denom
      } else {
        price = (scaled + denom / 2n) / denom
      }
    }
    if (price < 0n) price = 0n
  }
  return price
}

export function resolveContractPricingBase(params: {
  side: 'price' | 'cost'
  base: ContractPricingBase | undefined
  baseUnitPriceXusd: bigint
  baseUnitCostXusd: bigint
  resolvedCostXusd?: bigint
}): bigint {
  const base = params.base ?? (params.side === 'cost' ? 'unit_cost_xusd' : 'unit_price_xusd')
  if (base === 'unit_price_xusd') return params.baseUnitPriceXusd
  if (base === 'unit_cost_xusd') return params.baseUnitCostXusd
  if (base === 'cost') {
    if (params.resolvedCostXusd === undefined) {
      throw new Error('price.base=cost requires resolved cost')
    }
    return params.resolvedCostXusd
  }
  return params.baseUnitPriceXusd
}
