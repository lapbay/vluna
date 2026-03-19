import { describe, it, expect } from 'vitest'
import {
  applyContractPricingAdjustments,
  parseContractPricingTermV1,
  resolveContractPricingBase,
} from '../../src/features/gate/services/contract-pricing.js'

describe('contract-pricing', { tags: ['unit'] }, () => {
  it('parses schema v1', () => {
    const term = parseContractPricingTermV1({
      schema: 'vluna/contract_pricing:v1',
      meter_code: 'demo.outcome',
      price: { base: 'unit_price_xusd', adjustments: [{ op: 'fixed', unit_price_xusd: '5' }] },
    })
    expect(term.schema).toBe('vluna/contract_pricing:v1')
    expect(term.meter_code).toBe('demo.outcome')
  })

  it('rejects schema mismatch', () => {
    expect(() =>
      parseContractPricingTermV1({ schema: 'nope', meter_code: 'x' }),
    ).toThrow(/schema mismatch/)
  })

  it('applies fixed + multiplier + delta with clamping', () => {
    const base = 10n
    const out = applyContractPricingAdjustments(base, [
      { op: 'fixed', unit_price_xusd: '7' },
      { op: 'multiplier', multiplier: '2/3', rounding: 'nearest' },
      { op: 'delta', delta_xusd: '-100' },
    ])
    expect(out).toBe(0n)
  })

  it('supports decimal multiplier strings', () => {
    const base = 10n
    const out = applyContractPricingAdjustments(base, [
      { op: 'multiplier', multiplier: '1.2', rounding: 'nearest' },
    ])
    expect(out).toBe(12n)
  })

  it('resolves base from unit_price, unit_cost, and cost', () => {
    const baseUnitPriceXusd = 20n
    const baseUnitCostXusd = 8n
    const resolvedCost = 11n

    expect(resolveContractPricingBase({
      side: 'price',
      base: 'unit_price_xusd',
      baseUnitPriceXusd,
      baseUnitCostXusd,
      resolvedCostXusd: resolvedCost,
    })).toBe(20n)

    expect(resolveContractPricingBase({
      side: 'price',
      base: 'unit_cost_xusd',
      baseUnitPriceXusd,
      baseUnitCostXusd,
      resolvedCostXusd: resolvedCost,
    })).toBe(8n)

    expect(resolveContractPricingBase({
      side: 'price',
      base: 'cost',
      baseUnitPriceXusd,
      baseUnitCostXusd,
      resolvedCostXusd: resolvedCost,
    })).toBe(11n)
  })
})
