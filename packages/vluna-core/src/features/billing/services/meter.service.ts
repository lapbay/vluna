import { type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../../types/database.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'
import type { MeterSemanticKind } from '../../gate/services/gate.types.js'
import { normalizeIdentifier } from '../../../utils/identifiers.js'
import { DomainError } from '../../../utils/domain-errors.js'

type ChangeKind = 'created' | 'updated' | 'unchanged'

export type MeterPayload = {
  meter_code: string
  semantic_kind?: MeterSemanticKind
  unit?: string
  scale?: number
  rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
  active?: boolean
  metadata?: Record<string, unknown>
}

export type MeterPricePayload = {
  unit_cost_xusd: number | string
  unit_price_base_xusd?: number | string
  unit_price_dynamic_xusd?: number | string
  unit_price_xusd?: number | string
  unit_quantity_minor?: number | string
  rounding?: 'floor' | 'nearest' | 'ceil'
  cost_unit_quantity_minor?: number | string
  cost_rounding?: 'floor' | 'nearest' | 'ceil'
  effective_at?: Date
  metadata?: Record<string, unknown>
}

export type MeterWithPrice = MeterPayload & {
  price?: MeterPricePayload
  priceCostRatio?: number
}

export type UpsertMeterInput = MeterWithPrice & {
  realmId: string
  feature_code?: string,
  semantic_kind?: string
}

export type UpsertMeterResult = {
  meterId: string
  meterChange: ChangeKind
  meterDiff?: Record<string, { current: unknown; next: unknown }>
  priceChange: ChangeKind
  priceDiff?: Record<string, { current: unknown; next: unknown }>
  mappingChange?: ChangeKind
}

export type DeleteMeterResult = {
  meterDeleted: boolean
  priceDeleted: boolean
  softDeleted: boolean
  reason?: string
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function toInt(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export class MeterService {
  static async upsertMeter(
    db: Kysely<Database> | Transaction<Database>,
    input: UpsertMeterInput,
  ): Promise<UpsertMeterResult> {
    const realmId = input.realmId
    const meterCode = normalizeIdentifier(input.meter_code, 'meter_code')
    const featureCode = input.feature_code ? normalizeIdentifier(input.feature_code, 'feature_code') : undefined
    const price = input.price
    const priceCostRatio = input.priceCostRatio ?? 1
    return runInTransaction(db, async (trx) => {
      const existing = await trx
        .selectFrom('meters')
        .select(['meter_id', 'semantic_kind', 'unit', 'scale', 'rounding', 'active', 'metadata'])
        .where('realm_id', '=', realmId)
        .where('meter_code', '=', meterCode)
        .executeTakeFirst()

      let meterId: string
      let meterChange: ChangeKind = 'unchanged'
      let meterDiff: Record<string, { current: unknown; next: unknown }> | undefined

      if (!existing) {
        const inserted = await trx
          .insertInto('meters')
          .values({
            realm_id: realmId,
            meter_code: meterCode,
            semantic_kind: input.semantic_kind ?? 'activity',
            unit: input.unit ?? 'unit',
            scale: input.scale ?? 0,
            rounding: input.rounding ?? 'round',
            active: input.active ?? true,
            metadata: normalizeMetadata(input.metadata),
          })
          .returning('meter_id')
          .executeTakeFirstOrThrow()
        meterId = String(inserted.meter_id)
        meterChange = 'created'
      } else {
        meterId = String(existing.meter_id)
        const changes: Record<string, { current: unknown; next: unknown }> = {}
        const semanticKindNext = input.semantic_kind ?? (existing.semantic_kind as MeterSemanticKind) ?? 'activity'
        if ((existing.semantic_kind as unknown as string) !== semanticKindNext) {
          changes.semantic_kind = { current: existing.semantic_kind, next: semanticKindNext }
        }
        const unitNext = input.unit ?? existing.unit ?? 'unit'
        const scaleNext = input.scale ?? existing.scale ?? 0
        const roundingNext = input.rounding ?? existing.rounding ?? 'round'
        if (existing.unit !== unitNext) changes.unit = { current: existing.unit, next: unitNext }
        if (Number(existing.scale) !== Number(scaleNext)) changes.scale = { current: existing.scale, next: scaleNext }
        if (existing.rounding !== roundingNext) changes.rounding = { current: existing.rounding, next: roundingNext }
        const activeNext = input.active ?? existing.active
        if (Boolean(existing.active) !== Boolean(activeNext)) {
          changes.active = { current: existing.active, next: activeNext }
        }
        const metadataNext = normalizeMetadata(input.metadata ?? existing.metadata)
        if (!deepEqual(existing.metadata ?? {}, metadataNext)) {
          changes.metadata = { current: existing.metadata ?? {}, next: metadataNext }
        }
        if (Object.keys(changes).length > 0) {
          await trx
            .updateTable('meters')
            .set({
              semantic_kind: semanticKindNext,
              unit: unitNext,
              scale: scaleNext,
              rounding: roundingNext,
              active: activeNext,
              metadata: metadataNext,
            })
            .where('realm_id', '=', realmId)
            .where('meter_code', '=', meterCode)
            .executeTakeFirst()
          meterChange = 'updated'
          meterDiff = changes
        }
      }

      let priceChange: ChangeKind = 'unchanged'
      let priceDiff: Record<string, { current: unknown; next: unknown }> | undefined
      if (price) {
        const priceRow = await trx
          .selectFrom('meter_prices')
          .select((eb) => [
            eb.ref('unit_price_xusd').as('unit_price_xusd'),
            eb.ref('unit_price_base_xusd').as('unit_price_base_xusd'),
            eb.ref('unit_price_dynamic_xusd').as('unit_price_dynamic_xusd'),
            eb.ref('unit_quantity_minor').as('unit_quantity_minor'),
            eb.ref('rounding').as('rounding'),
            eb.ref('unit_cost_xusd').as('unit_cost_xusd'),
            eb.ref('cost_unit_quantity_minor').as('cost_unit_quantity_minor'),
            eb.ref('cost_rounding').as('cost_rounding'),
            eb.ref('effective_at').as('effective_at'),
          ])
          .where('realm_id', '=', realmId)
          .where('meter_code', '=', meterCode)
          .orderBy('effective_at', 'desc')
          .limit(1)
          .executeTakeFirst()

        const defaults = {
          unit_quantity_minor: toInt(price.unit_quantity_minor, undefined as unknown as number),
          cost_unit_quantity_minor: toInt(price.cost_unit_quantity_minor, undefined as unknown as number),
          rounding: price.rounding,
          cost_rounding: price.cost_rounding,
        }
        const resolvedUnitQty = defaults.unit_quantity_minor ?? defaults.cost_unit_quantity_minor ?? 1
        const resolvedCostQty = defaults.cost_unit_quantity_minor ?? defaults.unit_quantity_minor ?? resolvedUnitQty
        const resolvedRounding = defaults.rounding ?? defaults.cost_rounding ?? 'nearest'
        const resolvedCostRounding = defaults.cost_rounding ?? defaults.rounding ?? resolvedRounding
        const unitCost = toInt(price.unit_cost_xusd, 0)
        const providedBase = price.unit_price_base_xusd as number | string | undefined
        const providedDynamic = price.unit_price_dynamic_xusd as number | string | undefined
        const providedPrice = price.unit_price_xusd as number | string | undefined

        const inferredBase = providedBase !== undefined ? toInt(providedBase, 0) : unitCost * priceCostRatio
        const inferredDynamic = providedDynamic !== undefined ? toInt(providedDynamic, 0) : 0
        const inferredPrice = providedPrice !== undefined ? toInt(providedPrice, inferredBase + inferredDynamic) : inferredBase + inferredDynamic
        // If price given but base missing, derive base from price - dynamic (not below zero)
        const unitPriceBase = providedBase !== undefined ? toInt(providedBase, inferredBase) : Math.max(inferredPrice - inferredDynamic, 0)
        const unitPriceDynamic = providedDynamic !== undefined ? toInt(providedDynamic, 0) : inferredDynamic
        const unitPrice = providedPrice !== undefined ? toInt(providedPrice, unitPriceBase + unitPriceDynamic) : unitPriceBase + unitPriceDynamic
        const nextPrice = {
          unit_price_xusd: unitPrice,
          unit_price_base_xusd: unitPriceBase,
          unit_price_dynamic_xusd: unitPriceDynamic,
          unit_quantity_minor: resolvedUnitQty,
          rounding: resolvedRounding,
          unit_cost_xusd: unitCost,
          cost_unit_quantity_minor: resolvedCostQty,
          cost_rounding: resolvedCostRounding,
          effective_at: price.effective_at ?? new Date(),
        }

        if (!priceRow) {
          await trx
            .insertInto('meter_prices')
            .values({ realm_id: realmId, meter_code: meterCode, ...nextPrice })
            .executeTakeFirst()
          priceChange = 'created'
        } else {
          const changes: Record<string, { current: unknown; next: unknown }> = {}
          for (const key of Object.keys(nextPrice) as Array<keyof typeof nextPrice>) {
            const curr = priceRow[key as keyof typeof priceRow]
            const next = nextPrice[key]
            if (key === 'effective_at') {
              const currDate = curr ? new Date(curr as Date) : null
              const nextDate = next ? new Date(next as Date) : null
              if (currDate?.getTime() !== nextDate?.getTime()) {
                changes.effective_at = { current: currDate ?? null, next: nextDate ?? null }
              }
              continue
            }
            if (curr !== next) {
              changes[key] = { current: curr, next }
            }
          }
          if (Object.keys(changes).length > 0) {
            await trx
              .updateTable('meter_prices')
              .set(nextPrice)
              .where('realm_id', '=', realmId)
              .where('meter_code', '=', meterCode)
              .executeTakeFirst()
            priceChange = 'updated'
            priceDiff = changes
          }
        }
      }

      let mappingChange: ChangeKind = 'unchanged'
      if (featureCode) {
        const featureRow = await trx
          .selectFrom('features')
          .select('feature_id')
          .where('realm_id', '=', realmId)
          .where('feature_code', '=', featureCode)
          .executeTakeFirst()
        if (!featureRow) {
          throw new DomainError('VALIDATION.INVALID_INPUT', `feature ${featureCode} not found in realm ${realmId}`, 422)
        }
        const featureId = featureRow.feature_id
        const isPrimary = featureCode === meterCode
        const mapping = await trx
          .selectFrom('feature_meters')
          .select(['is_primary'])
          .where('feature_id', '=', featureId)
          .where('meter_id', '=', meterId)
          .executeTakeFirst()

        if (!mapping) {
          if (isPrimary) {
            await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
          }
          await trx
            .insertInto('feature_meters')
            .values({
              feature_id: featureId,
              meter_id: meterId,
              is_primary: isPrimary,
              metadata: normalizeMetadata(input.metadata),
            })
            .executeTakeFirst()
          mappingChange = 'created'
        } else if (isPrimary && !mapping.is_primary) {
          await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
          await trx
            .updateTable('feature_meters')
            .set({ is_primary: true, metadata: normalizeMetadata(input.metadata) })
            .where('feature_id', '=', featureId)
            .where('meter_id', '=', meterId)
            .executeTakeFirst()
          mappingChange = 'updated'
        }
      }

      return { meterId, meterChange, meterDiff, priceChange, priceDiff, mappingChange }
    })
  }

  static async deleteMeter(
    db: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; meterCode: string },
  ): Promise<DeleteMeterResult> {
    const { realmId, meterCode } = params
    return runInTransaction(db, async (trx) => {
      const meterRow = await trx
        .selectFrom('meters')
        .select(['meter_id'])
        .where('realm_id', '=', realmId)
        .where('meter_code', '=', meterCode)
        .executeTakeFirst()
      if (!meterRow) {
        return { meterDeleted: false, priceDeleted: false, softDeleted: false, reason: 'not_found' }
      }
      const meterId = meterRow.meter_id

      const featureRef = await trx
        .selectFrom('feature_meters')
        .select('feature_id')
        .where('meter_id', '=', meterId)
        .limit(1)
        .executeTakeFirst()
      if (featureRef) {
        await trx
          .updateTable('meters')
          .set({ active: false })
          .where('realm_id', '=', realmId)
          .where('meter_code', '=', meterCode)
          .executeTakeFirst()
        return { meterDeleted: false, priceDeleted: false, softDeleted: true, reason: 'has_feature_mapping' }
      }

      const commitRef = await trx
        .selectFrom('billing_rated_records')
        .select('rating_id')
        .where('meter_code', '=', meterCode)
        .limit(1)
        .executeTakeFirst()
      if (commitRef) {
        await trx
          .updateTable('meters')
          .set({ active: false })
          .where('realm_id', '=', realmId)
          .where('meter_code', '=', meterCode)
          .executeTakeFirst()
        return { meterDeleted: false, priceDeleted: false, softDeleted: true, reason: 'has_commits' }
      }

      await trx.deleteFrom('meter_prices').where('realm_id', '=', realmId).where('meter_code', '=', meterCode).execute()
      const priceDeleted = true

      await trx.deleteFrom('meters').where('realm_id', '=', realmId).where('meter_code', '=', meterCode).executeTakeFirst()

      return { meterDeleted: true, priceDeleted, softDeleted: false }
    })
  }
}
