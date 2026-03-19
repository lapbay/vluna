import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { MeterService } from './meter.service.js'
import { DomainError } from '../../../utils/domain-errors.js'

type Meter = BillingComponents['schemas']['Meter']
type MeterList = BillingComponents['schemas']['MeterList']
type MeterPrice = BillingComponents['schemas']['MeterPrice']

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim()
}

function parseBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be boolean` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be boolean` }, 422)
}

function parseSemanticKind(value: unknown): 'activity' | 'outcome' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'semantic_kind must be a string' }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'activity' || normalized === 'outcome') return normalized
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'semantic_kind must be activity or outcome' }, 422)
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
  }
  return { ...(value as Record<string, unknown>) }
}

function parseId(value: string, name: string): string {
  const trimmed = normalizeString(value)
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed.toLowerCase()
}

function parseDateMaybe(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'effective_at must be a valid date' }, 422)
  }
  return date
}

@Injectable()
export class MetersManagementService {
  async listMeters(req: AppRequest, query: Record<string, unknown>): Promise<MeterList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const q = normalizeString(query?.q)
    const active = parseBoolean(query?.active, 'active')
    const featureCode = normalizeString(query?.feature_code)
    const semanticKind = parseSemanticKind(query?.semantic_kind)
    const unit = normalizeString(query?.unit)

    let builder = trx
      .selectFrom('meters as m')
      .leftJoin('feature_meters as fm', (join) =>
        join.onRef('fm.meter_id', '=', 'm.meter_id').on('fm.is_primary', '=', true),
      )
      .leftJoin('features as f', 'f.feature_id', 'fm.feature_id')
      .leftJoin('meter_prices as mp', (join) =>
        join.onRef('mp.meter_code', '=', 'm.meter_code').onRef('mp.realm_id', '=', 'm.realm_id'),
      )
      .select([
        'm.meter_id as meter_id',
        'm.meter_code as meter_code',
        'm.semantic_kind as semantic_kind',
        'm.unit as unit',
        'm.scale as scale',
        'm.rounding as rounding',
        'm.active as active',
        'm.metadata as metadata',
        'm.created_at as created_at',
        'm.updated_at as updated_at',
        'fm.feature_id as feature_id',
        'f.feature_code as feature_code',
        'mp.unit_price_xusd as unit_price_xusd',
        'mp.unit_price_base_xusd as unit_price_base_xusd',
        'mp.unit_price_dynamic_xusd as unit_price_dynamic_xusd',
        'mp.unit_quantity_minor as unit_quantity_minor',
        'mp.rounding as price_rounding',
        'mp.unit_cost_xusd as unit_cost_xusd',
        'mp.cost_unit_quantity_minor as cost_unit_quantity_minor',
        'mp.cost_rounding as cost_rounding',
        'mp.effective_at as effective_at',
      ])
      .where('m.realm_id', '=', realmId)
      .orderBy('m.meter_id', 'asc')

    if (featureCode) {
      builder = builder
        .innerJoin('feature_meters as fm_filter', 'fm_filter.meter_id', 'm.meter_id')
        .innerJoin('features as f_filter', 'f_filter.feature_id', 'fm_filter.feature_id')
        .where('f_filter.realm_id', '=', realmId)
        .where('f_filter.feature_code', '=', featureCode)
    }

    if (q) {
      builder = builder.where('m.meter_code', 'ilike', `%${q}%`)
    }

    if (active !== undefined) {
      builder = builder.where('m.active', '=', active)
    }

    if (semanticKind) {
      builder = builder.where('m.semantic_kind', '=', semanticKind)
    }

    if (unit) {
      builder = builder.where('m.unit', '=', unit)
    }

    if (cursor) {
      builder = builder.where('m.meter_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => this.mapMeterRow(row))
    const nextCursor = hasMore ? items[items.length - 1]?.meter_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies MeterList
  }

  async getMeter(req: AppRequest, meterId: string): Promise<Meter> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(meterId, 'meter_id')

    const row = await trx
      .selectFrom('meters as m')
      .leftJoin('feature_meters as fm', (join) =>
        join.onRef('fm.meter_id', '=', 'm.meter_id').on('fm.is_primary', '=', true),
      )
      .leftJoin('features as f', 'f.feature_id', 'fm.feature_id')
      .leftJoin('meter_prices as mp', (join) =>
        join.onRef('mp.meter_code', '=', 'm.meter_code').onRef('mp.realm_id', '=', 'm.realm_id'),
      )
      .select([
        'm.meter_id as meter_id',
        'm.meter_code as meter_code',
        'm.semantic_kind as semantic_kind',
        'm.unit as unit',
        'm.scale as scale',
        'm.rounding as rounding',
        'm.active as active',
        'm.metadata as metadata',
        'm.created_at as created_at',
        'm.updated_at as updated_at',
        'fm.feature_id as feature_id',
        'f.feature_code as feature_code',
        'mp.unit_price_xusd as unit_price_xusd',
        'mp.unit_price_base_xusd as unit_price_base_xusd',
        'mp.unit_price_dynamic_xusd as unit_price_dynamic_xusd',
        'mp.unit_quantity_minor as unit_quantity_minor',
        'mp.rounding as price_rounding',
        'mp.unit_cost_xusd as unit_cost_xusd',
        'mp.cost_unit_quantity_minor as cost_unit_quantity_minor',
        'mp.cost_rounding as cost_rounding',
        'mp.effective_at as effective_at',
      ])
      .where('m.realm_id', '=', realmId)
      .where('m.meter_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'meter not found' }, 404)
    }

    return this.mapMeterRow(row)
  }

  async upsertMeter(
    req: AppRequest,
    body: {
      meter_code: string
      feature_code?: string
      unit?: string
      scale?: number
      rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
      semantic_kind?: 'activity' | 'outcome'
      active?: boolean
      metadata?: Record<string, unknown>
      meter_prices?: MeterPrice
    },
  ): Promise<{ created: boolean; meter: Meter }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const meterCode = normalizeString(body?.meter_code)
    if (!meterCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meter_code is required' }, 422)
    }

    const metadata = normalizeMetadata(body?.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('meters')
      .select(['meter_id'])
      .where('realm_id', '=', realmId)
      .where('meter_code', '=', meterCode)
      .executeTakeFirst()

    let result: Awaited<ReturnType<typeof MeterService.upsertMeter>>
    try {
      result = await MeterService.upsertMeter(trx, {
        realmId,
        meter_code: meterCode,
        feature_code: body?.feature_code,
        unit: body?.unit,
        scale: body?.scale,
        rounding: body?.rounding,
        semantic_kind: body?.semantic_kind,
        active: body?.active,
        metadata,
        price: body?.meter_prices
          ? {
              unit_cost_xusd: body.meter_prices.unit_cost_xusd ?? '0',
              unit_price_xusd: body.meter_prices.unit_price_xusd,
              unit_price_base_xusd: body.meter_prices.unit_price_base_xusd,
              unit_price_dynamic_xusd: body.meter_prices.unit_price_dynamic_xusd,
              unit_quantity_minor: body.meter_prices.unit_quantity_minor,
              rounding: body.meter_prices.rounding,
              cost_unit_quantity_minor: body.meter_prices.cost_unit_quantity_minor,
              cost_rounding: body.meter_prices.cost_rounding,
              effective_at: parseDateMaybe(body.meter_prices.effective_at),
            }
          : undefined,
        priceCostRatio: 1,
      })
    } catch (error) {
      if (error instanceof DomainError) {
        throw new HttpException({ code: error.code, message: error.message, details: error.details }, error.status)
      }
      throw error
    }

    const meter = await this.getMeter(req, result.meterId)
    return { created: !existing, meter }
  }

  async updateMeter(
    req: AppRequest,
    meterId: string,
    body: {
      feature_code?: string
      unit?: string
      scale?: number
      rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
      semantic_kind?: 'activity' | 'outcome'
      active?: boolean
      metadata?: Record<string, unknown>
      meter_prices?: MeterPrice
    },
  ): Promise<Meter> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(meterId, 'meter_id')

    const existing = await trx
      .selectFrom('meters')
      .select(['meter_id', 'meter_code'])
      .where('realm_id', '=', realmId)
      .where('meter_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'meter not found' }, 404)
    }

    const metadata = body?.metadata === undefined ? undefined : normalizeMetadata(body.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    try {
      await MeterService.upsertMeter(trx, {
        realmId,
        meter_code: String(existing.meter_code),
        feature_code: body?.feature_code,
        unit: body?.unit,
        scale: body?.scale,
        rounding: body?.rounding,
        semantic_kind: body?.semantic_kind,
        active: body?.active,
        metadata,
        price: body?.meter_prices
          ? {
              unit_cost_xusd: body.meter_prices.unit_cost_xusd ?? '0',
              unit_price_xusd: body.meter_prices.unit_price_xusd,
              unit_price_base_xusd: body.meter_prices.unit_price_base_xusd,
              unit_price_dynamic_xusd: body.meter_prices.unit_price_dynamic_xusd,
              unit_quantity_minor: body.meter_prices.unit_quantity_minor,
              rounding: body.meter_prices.rounding,
              cost_unit_quantity_minor: body.meter_prices.cost_unit_quantity_minor,
              cost_rounding: body.meter_prices.cost_rounding,
              effective_at: parseDateMaybe(body.meter_prices.effective_at),
            }
          : undefined,
        priceCostRatio: 1,
      })
    } catch (error) {
      if (error instanceof DomainError) {
        throw new HttpException({ code: error.code, message: error.message, details: error.details }, error.status)
      }
      throw error
    }

    return this.getMeter(req, id)
  }

  private mapMeterRow(row: {
    meter_id: unknown
    meter_code: unknown
    feature_id: unknown
    feature_code: unknown
    unit: unknown
    scale: unknown
    rounding: unknown
    semantic_kind: unknown
    active: unknown
    metadata: unknown
    created_at: Date
    updated_at: Date
    unit_price_xusd: unknown
    unit_price_base_xusd: unknown
    unit_price_dynamic_xusd: unknown
    unit_quantity_minor: unknown
    price_rounding: unknown
    unit_cost_xusd: unknown
    cost_unit_quantity_minor: unknown
    cost_rounding: unknown
    effective_at: Date | null
  }): Meter {
    return {
      meter_id: String(row.meter_id),
      meter_code: String(row.meter_code),
      feature_id: row.feature_id ? String(row.feature_id) : undefined,
      feature_code: row.feature_code ? String(row.feature_code) : undefined,
      unit: String(row.unit ?? ''),
      scale: Number(row.scale ?? 0),
      rounding: row.rounding as Meter['rounding'],
      semantic_kind: row.semantic_kind as Meter['semantic_kind'],
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      meter_prices: this.mapMeterPrice(row),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies Meter
  }

  private mapMeterPrice(row: {
    unit_price_xusd: unknown
    unit_price_base_xusd: unknown
    unit_price_dynamic_xusd: unknown
    unit_quantity_minor: unknown
    price_rounding: unknown
    unit_cost_xusd: unknown
    cost_unit_quantity_minor: unknown
    cost_rounding: unknown
    effective_at: Date | null
  }): MeterPrice | undefined {
    const hasAnyPrice =
      row.unit_price_xusd !== undefined &&
      row.unit_price_xusd !== null
        ? true
        : row.unit_cost_xusd !== undefined && row.unit_cost_xusd !== null
          ? true
          : row.unit_price_base_xusd !== undefined && row.unit_price_base_xusd !== null
    if (!hasAnyPrice) return undefined
    return {
      unit_price_xusd: row.unit_price_xusd === undefined ? undefined : String(row.unit_price_xusd),
      unit_price_base_xusd: row.unit_price_base_xusd === undefined ? undefined : String(row.unit_price_base_xusd),
      unit_price_dynamic_xusd: row.unit_price_dynamic_xusd === undefined ? undefined : String(row.unit_price_dynamic_xusd),
      unit_quantity_minor: row.unit_quantity_minor === undefined ? undefined : String(row.unit_quantity_minor),
      rounding: row.price_rounding as MeterPrice['rounding'],
      unit_cost_xusd: row.unit_cost_xusd === undefined ? undefined : String(row.unit_cost_xusd),
      cost_unit_quantity_minor: row.cost_unit_quantity_minor === undefined ? undefined : String(row.cost_unit_quantity_minor),
      cost_rounding: row.cost_rounding as MeterPrice['cost_rounding'],
      effective_at: row.effective_at ? row.effective_at.toISOString() : undefined,
    }
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const db = req?.ctx?.db
    if (!db) {
      throw new HttpException({ code: 'SERVER.DB_UNAVAILABLE', message: 'database unavailable' }, 503)
    }
    return db
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req?.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }
    return realmId
  }
}
