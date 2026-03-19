import { type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../../types/database.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'
import { MeterService, type MeterPricePayload, type MeterPayload as MeterServiceMeterPayload } from './meter.service.js'
import { normalizeIdentifier } from '../../../utils/identifiers.js'
import { DomainError } from '../../../utils/domain-errors.js'

type ChangeKind = 'created' | 'updated' | 'unchanged'

export type FeaturePayload = {
  feature_family_id?: string
  feature_family_code?: string
  feature_code: string
  name: string
  description: string
  active?: boolean
  entitlement_required?: boolean
  default_budget_strategy: 'auto' | 'hot' | 'cold'
  metadata?: Record<string, unknown>
  meters?: FeatureMeterInput[]
  unit?: string
}

export type FeatureMeterInput = Omit<MeterServiceMeterPayload, 'meter_code'> & {
  meter_code?: string
  price?: MeterPricePayload
  priceCostRatio?: number
}

export type FeatureUpsertInput = {
  realmId: string
  feature: FeaturePayload
}

export type FeatureUpsertResult = {
  featureId: string
  meterId: string
  featureChange: ChangeKind
  meterChange: ChangeKind
  mappingChange: ChangeKind
  featureDiff?: Record<string, { current: unknown; next: unknown }>
  meterDiff?: Record<string, { current: unknown; next: unknown }>
}

export type FeatureDeleteResult = {
  featureDeleted: boolean
  softDeleted: boolean
  deletedMeters: string[]
  keptMeters: string[]
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

export class FeatureService {
  static async upsertFeature(
    db: Kysely<Database> | Transaction<Database>,
    input: FeatureUpsertInput,
  ): Promise<FeatureUpsertResult> {
    const realmId = input.realmId
    const featureCode = normalizeIdentifier(input.feature.feature_code, 'feature_code')
    return runInTransaction(db, async (trx) => {
      const feature = input.feature

      // Resolve feature_family_id from feature_family_code if only code is provided
      let featureFamilyId = feature.feature_family_id

      if (featureFamilyId) {
        const capRow = await trx
          .selectFrom('feature_families')
          .select('feature_family_id')
          .where('realm_id', '=', realmId)
          .where('feature_family_id', '=', featureFamilyId)
          .executeTakeFirst()
        if (!capRow) {
          throw new DomainError('VALIDATION.INVALID_INPUT', `feature_family_id ${featureFamilyId} not found in realm ${realmId}`, 422)
        }
      } else {
        const code = feature.feature_family_code
        if (!code) {
          throw new DomainError('VALIDATION.INVALID_INPUT', `feature ${featureCode} requires feature_family_id or feature_family_code`, 422)
        }
        const capRow = await trx
          .selectFrom('feature_families')
          .select(['feature_family_id'])
          .where('realm_id', '=', realmId)
          .where('feature_family_code', '=', code)
          .executeTakeFirst()
        if (!capRow) {
          throw new DomainError('VALIDATION.INVALID_INPUT', `feature_family_code ${code} not found in realm ${realmId}`, 422)
        }
        featureFamilyId = String(capRow.feature_family_id)
      }

      const existingFeature = await trx
        .selectFrom('features')
        .select([
          'feature_id',
          'feature_family_id',
          'name',
          'description',
          'active',
          'entitlement_required',
          'metadata',
          'default_budget_strategy',
        ])
        .where('realm_id', '=', realmId)
        .where('feature_code', '=', featureCode)
        .executeTakeFirst()

      let featureId: string
      let featureChange: ChangeKind = 'unchanged'
      let featureDiff: Record<string, { current: unknown; next: unknown }> | undefined
      const activeResolved = feature.active ?? (existingFeature ? Boolean(existingFeature.active) : true)

      if (!existingFeature) {
        const inserted = await trx
          .insertInto('features')
          .values({
            realm_id: realmId,
            feature_family_id: featureFamilyId,
            feature_code: featureCode,
            name: feature.name,
            description: feature.description,
            active: activeResolved,
            entitlement_required: feature.entitlement_required ?? undefined,
            default_budget_strategy: feature.default_budget_strategy,
            metadata: normalizeMetadata(feature.metadata),
          })
          .returning('feature_id')
          .executeTakeFirstOrThrow()
        featureId = String(inserted.feature_id)
        featureChange = 'created'
      } else {
        featureId = String(existingFeature.feature_id)
        const changes: Record<string, { current: unknown; next: unknown }> = {}
        if (existingFeature.name !== feature.name) changes.name = { current: existingFeature.name, next: feature.name }
        if (existingFeature.description !== feature.description) {
          changes.description = { current: existingFeature.description, next: feature.description }
        }
        if (Boolean(existingFeature.active) !== Boolean(activeResolved)) {
          changes.active = { current: existingFeature.active, next: activeResolved }
        }
        if (
          feature.entitlement_required !== undefined &&
          Boolean(existingFeature.entitlement_required) !== Boolean(feature.entitlement_required)
        ) {
          changes.entitlement_required = {
            current: existingFeature.entitlement_required,
            next: feature.entitlement_required,
          }
        }
        if (existingFeature.default_budget_strategy !== feature.default_budget_strategy) {
          changes.default_budget_strategy = {
            current: existingFeature.default_budget_strategy,
            next: feature.default_budget_strategy,
          }
        }
        if (existingFeature.feature_family_id !== featureFamilyId) {
          changes.feature_family_id = { current: existingFeature.feature_family_id, next: featureFamilyId }
        }
        if (!deepEqual(existingFeature.metadata ?? {}, normalizeMetadata(feature.metadata))) {
          changes.metadata = { current: existingFeature.metadata ?? {}, next: normalizeMetadata(feature.metadata) }
        }
        const needsUpdate = Object.keys(changes).length > 0
        if (needsUpdate) {
          await trx
            .updateTable('features')
            .set({
              feature_family_id: featureFamilyId,
              name: feature.name,
              description: feature.description,
              active: activeResolved,
              entitlement_required: feature.entitlement_required ?? undefined,
              default_budget_strategy: feature.default_budget_strategy,
              metadata: normalizeMetadata(feature.metadata),
            })
            .where('realm_id', '=', realmId)
            .where('feature_code', '=', featureCode)
            .executeTakeFirst()
          featureChange = 'updated'
          featureDiff = changes
        }
      }

      const existingPrimaryMapping = await trx
        .selectFrom('feature_meters as fm')
        .innerJoin('meters as m', 'm.meter_id', 'fm.meter_id')
        .select(['fm.meter_id as meter_id'])
        .where('fm.feature_id', '=', featureId)
        .where('fm.is_primary', '=', true)
        .where('m.realm_id', '=', realmId)
        .executeTakeFirst()

      const hasExistingPrimary = Boolean(existingPrimaryMapping?.meter_id)
      const meters = input.feature.meters ?? []
      let allMeters: FeatureMeterInput[] =
        meters.length > 0
          ? meters
          : [
              {
                meter_code: featureCode,
                unit: input.feature.unit ?? 'unit',
                scale: 0,
                rounding: 'round',
                active: true,
                metadata: {},
              },
            ]

      const pickFirstDefined = <T>(values: T[]): T | undefined => values.find((value) => value !== undefined)

      const inferPrimaryMeterFromPeers = (peerMeters: FeatureMeterInput[]): FeatureMeterInput => {
        const inferredUnit = pickFirstDefined(peerMeters.map((meter) => meter.unit)) ?? feature.unit ?? 'unit'
        const inferredScale = pickFirstDefined(peerMeters.map((meter) => meter.scale)) ?? 0
        const inferredRounding = pickFirstDefined(peerMeters.map((meter) => meter.rounding)) ?? 'round'
        const inferredSemanticKind = pickFirstDefined(peerMeters.map((meter) => meter.semantic_kind))
        const inferredActive = pickFirstDefined(peerMeters.map((meter) => meter.active)) ?? true
        const inferredMetadata = pickFirstDefined(peerMeters.map((meter) => meter.metadata))
        const inferredPrice = pickFirstDefined(peerMeters.map((meter) => meter.price))
        const inferredPriceCostRatio = pickFirstDefined(peerMeters.map((meter) => meter.priceCostRatio))
        return {
          meter_code: featureCode,
          unit: inferredUnit,
          scale: inferredScale,
          rounding: inferredRounding,
          semantic_kind: inferredSemanticKind,
          active: inferredActive,
          metadata: inferredMetadata ?? {},
          price: inferredPrice,
          priceCostRatio: inferredPriceCostRatio,
        }
      }

      let primaryMeters = allMeters.filter((m) => (m.meter_code ?? featureCode) === featureCode)
      if (primaryMeters.length === 0 && meters.length > 0 && !hasExistingPrimary) {
        const inferredPrimary = inferPrimaryMeterFromPeers(allMeters)
        allMeters = [...allMeters, inferredPrimary]
        primaryMeters = [inferredPrimary]
      }
      if (primaryMeters.length > 1 || (primaryMeters.length === 0 && !hasExistingPrimary)) {
        throw new DomainError(
          'VALIDATION.INVALID_INPUT',
          `feature ${featureCode} must declare exactly one primary meter matching feature_code; found ${primaryMeters.length}`,
          422,
        )
      }
      const primaryMeterInput = primaryMeters[0]

      const mergePriceFromPrimary = (
        price: FeatureMeterInput['price'] | undefined,
        primary: FeatureMeterInput['price'] | undefined,
      ): FeatureMeterInput['price'] | undefined => {
        if (!primary) return price
        const merged: Partial<MeterPricePayload> = price ? { ...price } : {}
        const source: Partial<MeterPricePayload> = primary ? { ...primary } : {}
        const fields: Array<keyof MeterPricePayload> = [
          'unit_cost_xusd',
          'unit_price_base_xusd',
          'unit_price_dynamic_xusd',
          'unit_price_xusd',
          'unit_quantity_minor',
          'rounding',
          'cost_unit_quantity_minor',
          'cost_rounding',
          'effective_at',
        ]
        for (const field of fields) {
          if (merged[field] === undefined && source[field] !== undefined) {
            ;(merged as Record<string, unknown>)[field] = source[field] as unknown
          }
        }
        return Object.keys(merged).length === 0 ? undefined : (merged as MeterPricePayload)
      }

      let primaryMeterShapeCache: { unit?: string; scale?: number; rounding?: 'round' | 'floor' | 'ceil' | 'truncate' } | null
      const getPrimaryMeterShape = async (): Promise<{
        unit?: string
        scale?: number
        rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
      }> => {
        if (primaryMeterShapeCache !== undefined) return primaryMeterShapeCache ?? {}
        const meterRow = await trx
          .selectFrom('meters')
          .select(['unit', 'scale', 'rounding'])
          .where('realm_id', '=', realmId)
          .where('meter_code', '=', featureCode)
          .limit(1)
          .executeTakeFirst()
        primaryMeterShapeCache = {
          unit: primaryMeterInput?.unit ?? meterRow?.unit ?? feature.unit ?? 'unit',
          scale: primaryMeterInput?.scale ?? meterRow?.scale ?? 0,
          rounding: primaryMeterInput?.rounding ?? (meterRow?.rounding as 'round' | 'floor' | 'ceil' | 'truncate' | undefined) ?? 'round',
        }
        return primaryMeterShapeCache
      }

      let primaryPriceFromDb: FeatureMeterInput['price'] | undefined
      const getPrimaryPrice = async (): Promise<FeatureMeterInput['price'] | undefined> => {
        if (primaryMeterInput?.price) return primaryMeterInput.price
        if (primaryPriceFromDb !== undefined) return primaryPriceFromDb
        const priceRow = await trx
          .selectFrom('meter_prices')
          .select([
            'unit_price_xusd',
            'unit_price_base_xusd',
            'unit_price_dynamic_xusd',
            'unit_quantity_minor',
            'rounding',
            'unit_cost_xusd',
            'cost_unit_quantity_minor',
            'cost_rounding',
            'effective_at',
          ])
          .where('realm_id', '=', realmId)
          .where('meter_code', '=', featureCode)
          .orderBy('effective_at', 'desc')
          .limit(1)
          .executeTakeFirst()
        if (!priceRow) {
          primaryPriceFromDb = undefined
          return undefined
        }
        primaryPriceFromDb = {
          unit_price_xusd: priceRow.unit_price_xusd ?? undefined,
          unit_price_base_xusd: priceRow.unit_price_base_xusd ?? undefined,
          unit_price_dynamic_xusd: priceRow.unit_price_dynamic_xusd ?? undefined,
          unit_quantity_minor: priceRow.unit_quantity_minor ?? undefined,
          rounding: priceRow.rounding ?? undefined,
          unit_cost_xusd: priceRow.unit_cost_xusd ?? 0,
          cost_unit_quantity_minor: priceRow.cost_unit_quantity_minor ?? undefined,
          cost_rounding: priceRow.cost_rounding ?? undefined,
          effective_at: priceRow.effective_at ?? undefined,
        }
        return primaryPriceFromDb
      }

      let primaryMeterId: string | undefined = existingPrimaryMapping?.meter_id ? String(existingPrimaryMapping.meter_id) : undefined
      let meterChange: ChangeKind = 'unchanged'
      let meterDiff: Record<string, { current: unknown; next: unknown }> | undefined
      let mappingChange: ChangeKind = 'unchanged'

      for (const m of allMeters) {
        const meterCode = m.meter_code ?? featureCode
        const isPrimary = meterCode === featureCode
        const primaryPrice = isPrimary ? m.price : await getPrimaryPrice()
        const priceForMeter = mergePriceFromPrimary(m.price, primaryPrice)
        const primaryShape = await getPrimaryMeterShape()
        const unit = m.unit ?? primaryShape.unit ?? 'unit'
        const scale = m.scale ?? primaryShape.scale ?? 0
        const rounding = m.rounding ?? primaryShape.rounding ?? 'round'
        const meterResult = await MeterService.upsertMeter(trx, {
          realmId,
          meter_code: meterCode,
          unit,
          scale,
          rounding,
          active: m.active ?? true,
          metadata: m.metadata ?? {},
          semantic_kind: m.semantic_kind,
          price: priceForMeter,
          priceCostRatio: m.priceCostRatio ?? 1,
        })

        if (isPrimary) {
          primaryMeterId = meterResult.meterId
          meterChange = meterResult.meterChange
          meterDiff = meterResult.meterDiff
        }

        const existingMapping = await trx
          .selectFrom('feature_meters')
          .select(['is_primary', 'metadata'])
          .where('feature_id', '=', featureId)
          .where('meter_id', '=', meterResult.meterId)
          .executeTakeFirst()

        const nextPrimaryFlag = isPrimary
        if (!existingMapping) {
          if (nextPrimaryFlag) {
            await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
          }
          await trx
            .insertInto('feature_meters')
            .values({
              feature_id: featureId,
              meter_id: meterResult.meterId,
              is_primary: nextPrimaryFlag,
              metadata: m.metadata ?? {},
            })
            .executeTakeFirst()
          mappingChange = nextPrimaryFlag ? 'created' : mappingChange
        } else {
          const needsPrimaryChange = Boolean(existingMapping.is_primary) !== Boolean(nextPrimaryFlag)
          const needsMetadataChange = !deepEqual(existingMapping.metadata ?? {}, m.metadata ?? {})
          if (needsPrimaryChange || needsMetadataChange) {
            if (nextPrimaryFlag) {
              await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
            }
            await trx
              .updateTable('feature_meters')
              .set({ is_primary: nextPrimaryFlag, metadata: m.metadata ?? {} })
              .where('feature_id', '=', featureId)
              .where('meter_id', '=', meterResult.meterId)
              .executeTakeFirst()
            mappingChange = needsPrimaryChange && nextPrimaryFlag ? 'updated' : mappingChange
          }
        }
      }

      if (primaryMeterId) {
        await trx
          .updateTable('feature_meters')
          .set({ is_primary: false })
          .where('feature_id', '=', featureId)
          .where('meter_id', '<>', primaryMeterId)
          .execute()
      }

      if (!primaryMeterId) {
        throw new DomainError('SERVER.CONFIG', `failed to upsert primary meter for feature ${featureCode}`, 500)
      }

      return { featureId, meterId: primaryMeterId, featureChange, meterChange, mappingChange, featureDiff, meterDiff }
    })
  }

  static async deleteFeature(
    db: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; featureCode: string },
  ): Promise<FeatureDeleteResult> {
    return runInTransaction(db, async (trx) => {
      const featureRow = await trx
        .selectFrom('features')
        .select(['feature_id', 'feature_code'])
        .where('realm_id', '=', params.realmId)
        .where('feature_code', '=', params.featureCode)
        .executeTakeFirst()
      if (!featureRow) {
        return { featureDeleted: false, softDeleted: false, deletedMeters: [], keptMeters: [] }
      }

      const hasPolicyRef = await trx
        .selectFrom('gate_policies')
        .select('policy_id')
        .where('realm_id', '=', params.realmId)
        .where('feature_code', '=', params.featureCode)
        .limit(1)
        .executeTakeFirst()

      const hasLeaseRef = await trx
        .selectFrom('gate_leases as gl')
        .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'gl.billing_account_id')
        .select('gl.lease_id')
        .where('ba.realm_id', '=', params.realmId)
        .where('gl.feature_code', '=', params.featureCode)
        .limit(1)
        .executeTakeFirst()

      const hasQuotaRef = await trx
        .selectFrom('gate_quota_counters as gqc')
        .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'gqc.billing_account_id')
        .select('gqc.counter_id')
        .where('ba.realm_id', '=', params.realmId)
        .where('gqc.feature_code', '=', params.featureCode)
        .limit(1)
        .executeTakeFirst()

      const hasRatingRef = await trx
        .selectFrom('billing_ratings')
        .select('rating_id')
        .where('realm_id', '=', params.realmId)
        .where('feature_code', '=', params.featureCode)
        .limit(1)
        .executeTakeFirst()

      if (hasPolicyRef || hasLeaseRef || hasQuotaRef || hasRatingRef) {
        await trx
          .updateTable('features')
          .set({ active: false })
          .where('feature_id', '=', featureRow.feature_id)
          .executeTakeFirst()
        return { featureDeleted: false, softDeleted: true, deletedMeters: [], keptMeters: [] }
      }

      const linkedMeters = await trx
        .selectFrom('feature_meters as fm')
        .innerJoin('meters as m', 'm.meter_id', 'fm.meter_id')
        .select(['fm.meter_id as meter_id', 'm.meter_code as meter_code', 'm.realm_id as realm_id'])
        .where('fm.feature_id', '=', featureRow.feature_id)
        .execute()

      await trx.deleteFrom('features').where('feature_id', '=', featureRow.feature_id).executeTakeFirst()

      const deletedMeters: string[] = []
      const keptMeters: string[] = []

      for (const meter of linkedMeters) {
        const linkedElsewhere = await trx
          .selectFrom('feature_meters')
          .select('feature_id')
          .where('meter_id', '=', meter.meter_id)
          .where('feature_id', '<>', featureRow.feature_id)
          .limit(1)
          .executeTakeFirst()

        const hasCommitLines = await trx
          .selectFrom('billing_rated_records as brr')
          .innerJoin('billing_ratings as br', 'br.rating_id', 'brr.rating_id')
          .select('brr.rating_id')
          .where('br.realm_id', '=', meter.realm_id)
          .where('brr.meter_code', '=', meter.meter_code)
          .limit(1)
          .executeTakeFirst()

        if (!linkedElsewhere && !hasCommitLines) {
          await trx.deleteFrom('meters').where('meter_id', '=', meter.meter_id).executeTakeFirst()
          deletedMeters.push(meter.meter_code)
        } else {
          keptMeters.push(meter.meter_code)
        }
      }

      return { featureDeleted: true, softDeleted: false, deletedMeters, keptMeters }
    })
  }
}
