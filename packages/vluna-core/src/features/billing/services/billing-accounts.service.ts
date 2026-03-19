import { Injectable, HttpException } from '@nestjs/common'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../../types/database.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import { setRlsSession } from '../../../db/index.js'

type BillingAccountList = BillingComponents['schemas']['BillingAccountList']
type BillingAccount = BillingComponents['schemas']['BillingAccount']
type BillingAccountBillingDetailsMasked = BillingComponents['schemas']['BillingAccountBillingDetailsMasked']
type BillingAccountBillingDetailsUpdateRequest =
  BillingComponents['schemas']['BillingAccountBillingDetailsUpdateRequest']
type BillingAccountBillingDetailsAddress =
  BillingComponents['schemas']['BillingAccountBillingDetailsAddress']

@Injectable()
export class BillingAccountsService {
  async listBillingAccounts(req: AppRequest, query: Record<string, unknown>): Promise<BillingAccountList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorRaw = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const sortBy = query?.sort_by === 'created_at' ? 'created_at' : 'billing_account_id'
    const sortOrder = query?.sort_order === 'desc' ? 'desc' : 'asc'
    const billingAccountIds = normalizeArray(query?.billing_account_id)
    const principalId = normalizeString(query?.billing_principal_id)
    const bundleId = normalizeString(query?.current_bundle_id)
    const createdAfter = toDate(query?.created_after)
    const createdBefore = toDate(query?.created_before)
    const search = normalizeString(query?.q)
    const expand = normalizeArray(query?.expand)
    const includeBillingDetails = expand.includes('billing_details')

    let builder = trx
      .selectFrom('billing_accounts as ba')
      .select([
        'ba.billing_account_id',
        'ba.billing_principal_id',
        'ba.current_bundle_id',
        'ba.metadata',
        'ba.created_at',
      ])
      .where('ba.realm_id', '=', realmId)

    if (includeBillingDetails) {
      builder = builder
        .leftJoin('billing_account_billing_details as bbd', 'bbd.billing_account_id', 'ba.billing_account_id')
        .select([
          sql`bbd.billing_account_id`.as('billing_details_id'),
          'bbd.billing_email',
          'bbd.legal_name',
          'bbd.entity_type',
          'bbd.default_address',
          'bbd.tax_ids',
          sql`bbd.metadata`.as('billing_details_metadata'),
          'bbd.last_updated_by',
          'bbd.source_updated_at',
          sql`bbd.created_at`.as('billing_details_created_at'),
          sql`bbd.updated_at`.as('billing_details_updated_at'),
        ])
    }

    if (billingAccountIds.length > 0) {
      builder = builder.where('ba.billing_account_id', 'in', billingAccountIds)
    }
    if (principalId) {
      builder = builder.where('ba.billing_principal_id', '=', principalId)
    }
    if (bundleId) {
      builder = builder.where('ba.current_bundle_id', '=', bundleId)
    }
    if (createdAfter) {
      builder = builder.where('ba.created_at', '>', createdAfter)
    }
    if (createdBefore) {
      builder = builder.where('ba.created_at', '<', createdBefore)
    }
    if (search) {
      const like = `%${search}%`
      builder = builder.where((eb) =>
        eb.or([
          eb(sql`ba.billing_account_id::text`, 'ilike', like),
          eb('ba.billing_principal_id', 'ilike', like)
        ]),
      )
    }

    if (sortBy === 'created_at') {
      builder = builder.orderBy('ba.created_at', sortOrder)
      if (cursorRaw) {
        const cursorDate = toDate(cursorRaw)
        if (cursorDate) {
          builder = builder.where('ba.created_at', sortOrder === 'asc' ? '>' : '<', cursorDate)
        }
      }
    } else {
      builder = builder.orderBy('ba.billing_account_id', sortOrder)
      if (cursorRaw) {
        builder = builder.where('ba.billing_account_id', sortOrder === 'asc' ? '>' : '<', cursorRaw)
      }
    }

    builder = builder.orderBy('ba.billing_account_id', sortOrder)

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => {
      const base = {
        billing_account_id: String(row.billing_account_id),
        billing_principal_id: row.billing_principal_id,
        current_bundle_id: row.current_bundle_id ?? null,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        created_at: row.created_at.toISOString(),
      } satisfies BillingAccount

      if (!includeBillingDetails) return base

      const details = mapBillingDetailsMasked(row, String(row.billing_account_id))
      return {
        ...base,
        billing_details: details,
      } satisfies BillingAccount
    })
    const nextCursor =
      hasMore
        ? (sortBy === 'created_at'
            ? items[items.length - 1]?.created_at ?? null
            : items[items.length - 1]?.billing_account_id ?? null)
        : null

    return { items, next_cursor: nextCursor } satisfies BillingAccountList
  }

  async updateBillingAccountBillingDetails(
    req: AppRequest,
    billingAccountId: string,
    body: BillingAccountBillingDetailsUpdateRequest,
  ): Promise<BillingAccountBillingDetailsMasked> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const exists = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    if (!exists) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }

    const patch = normalizeBillingDetailsPatch(body)
    if (!patch.hasChanges) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'no billing details updates provided' }, 422)
    }

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const upsertValues = {
      billing_account_id: billingAccountId,
      ...toDbJsonValues(patch.values),
      last_updated_by: 'ops',
      updated_at: sql<Date>`now()`,
    } as const

    await trx
      .insertInto('billing_account_billing_details')
      .values(upsertValues)
      .onConflict((oc) =>
        oc.column('billing_account_id').doUpdateSet({
          ...toDbJsonValues(patch.values),
          last_updated_by: 'ops',
          updated_at: sql<Date>`now()`,
        }),
      )
      .executeTakeFirst()

    const row = await trx
      .selectFrom('billing_account_billing_details')
      .select([
        sql`billing_account_id`.as('billing_details_id'),
        'billing_email',
        'legal_name',
        'entity_type',
        'default_address',
        'tax_ids',
        sql`metadata`.as('billing_details_metadata'),
        'last_updated_by',
        'source_updated_at',
        sql`created_at`.as('billing_details_created_at'),
        sql`updated_at`.as('billing_details_updated_at'),
      ])
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'billing details unavailable' }, 500)
    }

    const details = mapBillingDetailsMasked(row, billingAccountId)
    if (!details) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'billing details unavailable' }, 500)
    }
    return details
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const trx = req?.ctx?.db
    if (!trx) throw new HttpException({ code: 'SERVER.CONFIG', message: 'DB session unavailable' }, 500)
    return trx
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req?.ctx?.realmId
    if (!realmId) throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing' }, 400)
    return realmId
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return [String(value).trim()].filter(Boolean)
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.valueOf()) ? null : date
}

type BillingDetailsRow = {
  billing_details_id: string | null
  billing_email: string | null
  legal_name: string | null
  entity_type: string | null
  default_address: BillingAccountBillingDetailsAddress | null
  tax_ids: Record<string, unknown>[] | null
  billing_details_metadata: Record<string, unknown> | null
  last_updated_by: string | null
  source_updated_at: Date | null
  billing_details_created_at: Date | null
  billing_details_updated_at: Date | null
}

type TaxIdInput = {
  type?: unknown
  value?: unknown
  country_code?: unknown
  status?: unknown
}

type BillingDetailsPatch = {
  hasChanges: boolean
  values: {
    billing_email?: string | null
    legal_name?: string | null
    entity_type?: 'individual' | 'company' | 'unknown' | null
    default_address?: BillingAccountBillingDetailsAddress | null
    tax_ids?: Record<string, unknown>[] | null
    metadata?: Record<string, unknown>
  }
}

function toDbJsonValues(values: BillingDetailsPatch['values']): BillingDetailsPatch['values'] {
  const next = { ...values }
  if (Object.prototype.hasOwnProperty.call(values, 'default_address')) {
    next.default_address =
      values.default_address === null
        ? null
        : (sql`${JSON.stringify(values.default_address)}::jsonb` as unknown as BillingDetailsPatch['values']['default_address'])
  }
  if (Object.prototype.hasOwnProperty.call(values, 'tax_ids')) {
    next.tax_ids =
      values.tax_ids === null
        ? null
        : (sql`${JSON.stringify(values.tax_ids)}::jsonb` as unknown as BillingDetailsPatch['values']['tax_ids'])
  }
  return next
}

function mapBillingDetailsMasked(row: unknown, fallbackBillingAccountId: string): BillingAccountBillingDetailsMasked | null {
  const detailsRow = row as BillingDetailsRow
  if (!detailsRow.billing_details_id) return null

  const taxIds = normalizeTaxIds(detailsRow.tax_ids)
  const maskedTaxIds = taxIds
    ? taxIds
        .map((taxId) => {
          const type = normalizeOptionalString(taxId.type)
          const value = normalizeOptionalString(taxId.value)
          if (!type || !value) return null
          return {
            type,
            value_masked: maskSensitive(value),
            country_code: normalizeOptionalString(taxId.country_code),
            status: normalizeOptionalString(taxId.status),
          }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : null

  return {
    billing_account_id: detailsRow.billing_details_id ?? fallbackBillingAccountId,
    billing_email: normalizeOptionalString(detailsRow.billing_email),
    legal_name: normalizeOptionalString(detailsRow.legal_name),
    entity_type: normalizeEntityTypeFromDb(detailsRow.entity_type),
    default_address: normalizeAddressFromDb(detailsRow.default_address),
    tax_ids: maskedTaxIds,
    metadata: detailsRow.billing_details_metadata ?? {},
    last_updated_by: normalizeLastUpdatedBy(detailsRow.last_updated_by),
    source_updated_at: detailsRow.source_updated_at ? detailsRow.source_updated_at.toISOString() : null,
    created_at: detailsRow.billing_details_created_at
      ? detailsRow.billing_details_created_at.toISOString()
      : new Date(0).toISOString(),
    updated_at: detailsRow.billing_details_updated_at
      ? detailsRow.billing_details_updated_at.toISOString()
      : new Date(0).toISOString(),
  }
}

function normalizeBillingDetailsPatch(body: BillingAccountBillingDetailsUpdateRequest): BillingDetailsPatch {
  const values: BillingDetailsPatch['values'] = {}

  if (Object.prototype.hasOwnProperty.call(body, 'billing_email')) {
    values.billing_email = normalizeNullableString(body.billing_email)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'legal_name')) {
    values.legal_name = normalizeNullableString(body.legal_name)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'entity_type')) {
    values.entity_type = parseEntityType(body.entity_type)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'default_address')) {
    values.default_address = normalizeAddress(body.default_address)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tax_ids')) {
    values.tax_ids = normalizeTaxIdsPayload(body.tax_ids)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    values.metadata = normalizeMetadata(body.metadata)
  }

  return { hasChanges: Object.keys(values).length > 0, values }
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'value must be a string or null' }, 422)
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function parseEntityType(value: unknown): 'individual' | 'company' | 'unknown' | null {
  if (value === null || value === undefined) return null
  if (value === 'individual' || value === 'company' || value === 'unknown') return value
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'entity_type is invalid' }, 422)
}

function normalizeEntityTypeFromDb(value: unknown): 'individual' | 'company' | 'unknown' | null {
  if (value === 'individual' || value === 'company' || value === 'unknown') return value
  return null
}

function normalizeLastUpdatedBy(value: unknown): 'user' | 'provider' | 'ops' | 'system' {
  if (value === 'user' || value === 'provider' || value === 'ops' || value === 'system') return value
  return 'system'
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
}

function normalizeAddress(value: unknown): BillingAccountBillingDetailsAddress | null {
  if (value === null) return null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>
    const line1 = normalizeOptionalString(candidate.line1)
    const city = normalizeOptionalString(candidate.city)
    const countryCode = normalizeOptionalString(candidate.country_code)
    if (!line1 || !city || !countryCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'default_address is missing required fields' }, 422)
    }
    const line2 = candidate.line2 === undefined ? undefined : normalizeNullableString(candidate.line2)
    const region = candidate.region === undefined ? undefined : normalizeNullableString(candidate.region)
    const postalCode = candidate.postal_code === undefined ? undefined : normalizeNullableString(candidate.postal_code)
    return {
      line1,
      line2,
      city,
      region,
      postal_code: postalCode,
      country_code: countryCode,
    }
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'default_address must be an object' }, 422)
}

function normalizeAddressFromDb(value: unknown): BillingAccountBillingDetailsAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const line1 = normalizeOptionalString(candidate.line1)
  const city = normalizeOptionalString(candidate.city)
  const countryCode = normalizeOptionalString(candidate.country_code)
  if (!line1 || !city || !countryCode) return null
  const line2 = candidate.line2 === undefined ? undefined : normalizeNullableString(candidate.line2)
  const region = candidate.region === undefined ? undefined : normalizeNullableString(candidate.region)
  const postalCode = candidate.postal_code === undefined ? undefined : normalizeNullableString(candidate.postal_code)
  return {
    line1,
    line2,
    city,
    region,
    postal_code: postalCode,
    country_code: countryCode,
  }
}

function normalizeTaxIds(value: unknown): TaxIdInput[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return value
    .map((item) => (item && typeof item === 'object' ? (item as TaxIdInput) : null))
    .filter((item): item is TaxIdInput => Boolean(item))
}

function normalizeTaxIdsPayload(value: unknown): Record<string, unknown>[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'tax_ids must be an array' }, 422)
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'tax_ids items must be objects' }, 422)
    }
    return item as Record<string, unknown>
  })
}

function maskSensitive(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`
}
