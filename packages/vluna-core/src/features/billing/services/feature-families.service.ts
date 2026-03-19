import { HttpException, Injectable } from '@nestjs/common'
import { sql, type Kysely } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'

type FeatureFamily = BillingComponents['schemas']['FeatureFamily']
type FeatureFamilyList = BillingComponents['schemas']['FeatureFamilyList']

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

@Injectable()
export class FeatureFamiliesService {
  async listFeatureFamilies(req: AppRequest, query: Record<string, unknown>): Promise<FeatureFamilyList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const q = normalizeString(query?.q)
    const active = parseBoolean(query?.active, 'active')

    let builder = trx
      .selectFrom('feature_families')
      .select([
        'feature_family_id',
        'feature_family_code',
        'name',
        'description',
        'entitlement_required',
        'is_fallback',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .orderBy('feature_family_id', 'asc')

    if (q) {
      builder = builder.where((eb) =>
        eb.or([
          eb('feature_family_code', 'ilike', `%${q}%`),
          eb('name', 'ilike', `%${q}%`),
        ]),
      )
    }

    if (active !== undefined) {
      builder = builder.where('active', '=', active)
    }

    if (cursor) {
      builder = builder.where('feature_family_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      feature_family_id: String(row.feature_family_id),
      feature_family_code: String(row.feature_family_code),
      name: normalizeFeatureFamilyName(row.name, row.feature_family_code),
      description: normalizeDescription(row.description),
      entitlement_required: Boolean(row.entitlement_required),
      is_fallback: Boolean(row.is_fallback),
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies FeatureFamily))

    const nextCursor = hasMore ? items[items.length - 1]?.feature_family_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies FeatureFamilyList
  }

  async getFeatureFamily(req: AppRequest, featureFamilyId: string): Promise<FeatureFamily> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureFamilyId, 'feature_family_id')

    const row = await trx
      .selectFrom('feature_families')
      .select([
        'feature_family_id',
        'feature_family_code',
        'name',
        'description',
        'entitlement_required',
        'is_fallback',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature_family not found' }, 404)
    }

    return {
      feature_family_id: String(row.feature_family_id),
      feature_family_code: String(row.feature_family_code),
      name: normalizeFeatureFamilyName(row.name, row.feature_family_code),
      description: normalizeDescription(row.description),
      entitlement_required: Boolean(row.entitlement_required),
      is_fallback: Boolean(row.is_fallback),
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies FeatureFamily
  }

  async upsertFeatureFamily(
    req: AppRequest,
    body: {
      feature_family_code: string
      name?: string | null
      description?: string | null
      entitlement_required?: boolean
      active?: boolean
      metadata?: Record<string, unknown>
    },
  ): Promise<{ created: boolean; feature_family: FeatureFamily }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const featureFamilyCode = normalizeString(body?.feature_family_code)
    if (!featureFamilyCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_family_code is required' }, 422)
    }
    const name = normalizeString(body?.name) || featureFamilyCode
    const description = normalizeDescription(body?.description)
    const entitlementRequired = body?.entitlement_required ?? true
    const active = body?.active ?? true
    const metadata = normalizeMetadata(body?.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('feature_families')
      .select(['feature_family_id', 'is_fallback'])
      .where('realm_id', '=', realmId)
      .where('feature_family_code', '=', featureFamilyCode)
      .executeTakeFirst()

    if (existing?.is_fallback) {
      throw new HttpException({
        code: 'VALIDATION.INVALID_INPUT',
        message: 'cannot update fallback feature_family',
      }, 422)
    }

    let row
    if (existing) {
      row = await trx
        .updateTable('feature_families')
        .set({
          name,
          description,
          entitlement_required: entitlementRequired,
          active,
          metadata,
          updated_at: sql`now()`,
        })
        .where('realm_id', '=', realmId)
        .where('feature_family_code', '=', featureFamilyCode)
        .returning([
          'feature_family_id',
          'feature_family_code',
          'is_fallback',
          'name',
          'description',
          'entitlement_required',
          'active',
          'metadata',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow()
    } else {
      row = await trx
        .insertInto('feature_families')
        .values({
          realm_id: realmId,
          feature_family_code: featureFamilyCode,
          name,
          description: description === undefined ? '' : description,
          entitlement_required: entitlementRequired,
          active,
          metadata,
        })
        .returning([
          'feature_family_id',
          'feature_family_code',
          'is_fallback',
          'name',
          'description',
          'entitlement_required',
          'active',
          'metadata',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow()
    }

    return {
      created: !existing,
      feature_family: {
        feature_family_id: String(row.feature_family_id),
        feature_family_code: String(row.feature_family_code),
        name: normalizeFeatureFamilyName(row.name, row.feature_family_code),
        description: normalizeDescription(row.description),
        entitlement_required: Boolean(row.entitlement_required),
        is_fallback: Boolean(row.is_fallback),
        active: Boolean(row.active),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      } satisfies FeatureFamily,
    }
  }

  async deleteFeatureFamily(
    req: AppRequest,
    featureFamilyId: string,
  ): Promise<{ deleted: boolean; soft_deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureFamilyId, 'feature_family_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('feature_families')
      .select(['feature_family_id'])
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature_family not found' }, 404)
    }

    const featureRef = await trx
      .selectFrom('features')
      .select(['feature_id'])
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .limit(1)
      .executeTakeFirst()

    if (featureRef) {
      await trx
        .updateTable('feature_families')
        .set({ active: false, updated_at: sql`now()` })
        .where('realm_id', '=', realmId)
        .where('feature_family_id', '=', id)
        .executeTakeFirst()
      return { deleted: false, soft_deleted: true }
    }

    const deleted = await trx
      .deleteFrom('feature_families')
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .executeTakeFirst()

    const deletedCount = Number(deleted?.numDeletedRows ?? 0)
    if (deletedCount <= 0) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature_family not found' }, 404)
    }

    return { deleted: true, soft_deleted: false }
  }

  async updateFeatureFamily(
    req: AppRequest,
    featureFamilyId: string,
    body: {
      name?: string
      description?: string | null
      entitlement_required?: boolean
      active?: boolean
      metadata?: Record<string, unknown>
    },
  ): Promise<FeatureFamily> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureFamilyId, 'feature_family_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('feature_families')
      .select([
        'feature_family_id',
        'feature_family_code',
        'name',
        'description',
        'entitlement_required',
        'is_fallback',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature_family not found' }, 404)
    }

    if (existing.is_fallback) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot update fallback feature_family' }, 422)
    }

    const name = body?.name === undefined ? String(existing.name) : normalizeString(body.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }
    const description =
      body?.description === undefined ? (existing.description ?? '') : (body.description ?? '')
    const entitlementRequired =
      body?.entitlement_required === undefined
        ? Boolean(existing.entitlement_required)
        : Boolean(body.entitlement_required)
    const active = body?.active === undefined ? Boolean(existing.active) : Boolean(body.active)
    const metadata = body?.metadata === undefined ? (existing.metadata ?? {}) : normalizeMetadata(body.metadata)

    const row = await trx
      .updateTable('feature_families')
      .set({
        name,
        description,
        entitlement_required: entitlementRequired,
        active,
        metadata,
      })
      .where('realm_id', '=', realmId)
      .where('feature_family_id', '=', id)
      .returning([
        'feature_family_id',
        'feature_family_code',
        'name',
        'description',
        'entitlement_required',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow()

    return {
      feature_family_id: String(row.feature_family_id),
      feature_family_code: String(row.feature_family_code),
      name: normalizeFeatureFamilyName(row.name, row.feature_family_code),
      description: normalizeDescription(row.description),
      entitlement_required: Boolean(row.entitlement_required),
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies FeatureFamily
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

function normalizeFeatureFamilyName(name: unknown, featureFamilyCode: unknown): string {
  const normalizedName = normalizeString(name)
  if (normalizedName) return normalizedName
  return normalizeString(featureFamilyCode)
}

function normalizeDescription(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}
