import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PricingService,
  type MeterPriceInfo,
  type PricingItemResult,
  type PricingComputation,
} from '../../src/features/gate/services/pricing.service.js'
import type { CommitItemNormalized } from '../../src/features/gate/services/gate.types.js'
import * as gateUtils from '../../src/features/gate/services/gate.utils.js'

const FIXED_NOW = '2025-01-01T00:00:00.000Z'

const price: MeterPriceInfo = {
  unitPriceXusd: 2n,
  unitPriceBaseXusd: 2n,
  unitPriceDynamicXusd: 0n,
  unitQuantityMinor: 3n,
  rounding: 'nearest',
  unitCostXusd: 1n,
  costUnitQuantityMinor: 3n,
  costRounding: 'nearest',
  effectiveAt: new Date('2024-12-31T00:00:00Z'),
}

describe('PricingService', { tags: ['unit'] }, () => {
  let service: PricingService
  const hashSpy = vi.spyOn(gateUtils, 'hashRequest')
  const nowSpy = vi.spyOn(gateUtils, 'nowIso')

  beforeEach(() => {
    service = new PricingService()
    hashSpy.mockImplementation((payload: Record<string, unknown>) => JSON.stringify({ ...payload }))
    nowSpy.mockReturnValue(FIXED_NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates pricing identity that encodes key fields', () => {
    const id = service.createPricingIdentity({
      featureCode: 'feat',
      meterCode: 'meter',
      unitPriceXusd: 10n,
      unitQuantityMinor: 2n,
      rounding: 'ceil',
      effectiveAt: new Date('2024-01-01T00:00:00Z'),
    })
    expect(typeof id).toBe('string')
    expect(hashSpy).toHaveBeenCalled()
  })

  it('computes authorize estimate with worst-case blocks', () => {
    const est = service.computeAuthorizeEstimate(5, 'feat', 'meter', price)
    expect(est.worstCaseBlocks).toBe(2n)
    expect(est.estimateAmountXusd).toBe(4)
    expect(est.pricingIdentity).toBeTruthy()
  })

  it('computes pricing with residuals and cost', () => {
    const res = service.computePricingComputation({
      featureCode: 'feat',
      meterCode: 'meter',
      unit: 'unit',
      quantityMinor: 5,
      price,
      previousXusdRemainder: 1n, // carry to reach a block
      previousCostRemainder: 0n,
    })
    expect(res.blocksCharged).toBe(2n)
    expect(res.amountXusd).toBe(4n)
    expect(res.residualRemainder).toBe(0n)
    expect(typeof res.snapshot.computed_at).toBe('string')
    expect(res.costBlocksCharged).toBe(2n)
    expect(res.costXusd).toBe(2n)
  })

  it('computes prepaid pricing using remaining prepaid credit', () => {
    const res = service.computePrepaidPricingComputation({
      featureCode: 'feat',
      meterCode: 'meter',
      unit: 'unit',
      quantityMinor: 5,
      price,
      previousXusdRemainder: 2n, // prepaid covers part of first block
      previousCostRemainder: 0n,
    })
    expect(res.blocksCharged).toBe(1n)
    expect(res.amountXusd).toBe(2n)
    expect(res.residualRemainder).toBe(0n)
  })

  it('builds missing pricing computation with zero amounts', () => {
    const now = new Date('2024-01-02T00:00:00Z')
    const res = service.buildMissingPricingComputation({
      featureCode: 'feat',
      meterCode: 'meter',
      unit: 'u',
      quantityMinor: 10,
      now,
    })
    expect(res.amountXusd).toBe(0n)
    expect(res.snapshot.provenance?.source).toBe('missing')
    expect(res.unitPriceXusd).toBe(0n)
  })

  it('aggregates pricing results across items', () => {
    const mkSnapshot = (fingerprint: string) =>
      ({
        computed_at: FIXED_NOW,
        unit: 'unit',
        fingerprint,
        unit_price_xusd: '2',
        unit_quantity_minor: '1',
        rounding: 'floor',
        effective_at: price.effectiveAt.toISOString(),
        provenance: { source: 'aggregate', inputs: { feature_code: 'feat', items: ['m'] as string[] } },
      } as const)

    const mkComputation = (fingerprint: string, amount: bigint, cost: bigint, blocks: bigint): PricingComputation => ({
      snapshot: mkSnapshot(fingerprint),
      costSnapshot: mkSnapshot(`c${fingerprint}`),
      unitPriceXusd: 2n,
      unitQuantityMinor: 1n,
      rounding: 'floor',
      unitCostXusd: 1n,
      costUnitQuantityMinor: 1n,
      costRounding: 'floor',
      featureCode: 'feat',
      amountXusd: amount,
      costXusd: cost,
      pricingFingerprint: fingerprint,
      costPricingFingerprint: `c${fingerprint}`,
      pricingIdentity: `pi-${fingerprint}`,
      costPricingIdentity: `cpi-${fingerprint}`,
      effectiveAt: price.effectiveAt,
      blocksCharged: blocks,
      costBlocksCharged: blocks,
      residualRemainder: 0n,
      costResidualRemainder: 0n,
    })

    const item1: CommitItemNormalized = { meter_code: 'm1', quantityMinor: 3 }
    const item2: CommitItemNormalized = { meter_code: 'm2', quantityMinor: 2 }

    const itemResults: PricingItemResult[] = [
      { item: item1, price, computation: mkComputation('pf1', 6n, 3n, 3n) },
      { item: item2, price, computation: mkComputation('pf2', 4n, 2n, 2n) },
    ]

    const agg = service.buildAggregatePricing(
      'feat',
      'unit',
      7,
      10n,
      5n,
      5n,
      5n,
      new Date('2024-12-31T00:00:00Z'),
      itemResults,
    )
    expect(agg.amountXusd).toBe(10n)
    expect(agg.costXusd).toBe(5n)
    expect(agg.blocksCharged).toBe(5n)
    const inputs = agg.snapshot.provenance?.inputs as { items?: string[]; meter_code?: string }
    expect(inputs.items).toEqual(['m1', 'm2'])
  })
})
