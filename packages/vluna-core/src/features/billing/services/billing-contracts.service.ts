import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { toJsonb } from '../../../utils/jsonb.js'
import { normalizeIdentifier } from '../../../utils/identifiers.js'

type BillingContract = BillingComponents['schemas']['BillingContract']
type BillingContractList = BillingComponents['schemas']['BillingContractList']
type ContractTerm = BillingComponents['schemas']['ContractTerm']
type ContractTermList = BillingComponents['schemas']['ContractTermList']
type ContractTermValue = ContractTerm['value_json']

type ContractStatus = 'active' | 'disabled'

type ContractTermKind = 'pricing' | 'e2r_param'

function normalizeTermKind(value: unknown): ContractTermKind {
  if (value === 'pricing' || value === 'e2r_param') return value
  // Backward-compatible default for older clients/specs.
  return 'e2r_param'
}

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return date
}

function normalizeStatus(value: unknown): ContractStatus | undefined {
  if (value === 'active' || value === 'disabled') return value
  return undefined
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
  }
  return { ...(value as Record<string, unknown>) }
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

@Injectable()
export class BillingContractsService {
  async listBillingContracts(req: AppRequest, query: Record<string, unknown>): Promise<BillingContractList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorDate = toDate(query?.cursor)
    const statusFilter = Array.isArray(query?.status)
      ? (query.status as string[]).filter((status): status is ContractStatus => status === 'active' || status === 'disabled')
      : undefined

    let builder = trx
      .selectFrom('billing_contracts')
      .select([
        'contract_id',
        'billing_account_id',
        'status',
        'effective_at',
        'name',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .orderBy('effective_at', 'desc')
      .orderBy('contract_id', 'desc')

    if (cursorDate) {
      builder = builder.where('effective_at', '<', cursorDate)
    }
    if (statusFilter && statusFilter.length > 0) {
      builder = builder.where('status', 'in', statusFilter)
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      contract_id: String(row.contract_id),
      billing_account_id: String(row.billing_account_id),
      status: row.status as ContractStatus,
      effective_at: row.effective_at.toISOString(),
      name: row.name ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingContract))
    const nextCursor = hasMore ? items[items.length - 1]?.effective_at ?? null : null

    return { items, next_cursor: nextCursor } satisfies BillingContractList
  }

  async getBillingContract(req: AppRequest, contractId: string): Promise<BillingContract> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const row = await trx
      .selectFrom('billing_contracts')
      .select([
        'contract_id',
        'billing_account_id',
        'status',
        'effective_at',
        'name',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('contract_id', '=', contractId)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'contract not found' }, 404)
    }

    return {
      contract_id: String(row.contract_id),
      billing_account_id: String(row.billing_account_id),
      status: row.status as ContractStatus,
      effective_at: row.effective_at.toISOString(),
      name: row.name ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingContract
  }

  async upsertBillingContract(
    req: AppRequest,
    body: { effective_at: string; status?: ContractStatus; name?: string | null; metadata?: Record<string, unknown> },
  ): Promise<{ created: boolean; contract: BillingContract }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const effectiveAt = toDate(body?.effective_at)
    if (!effectiveAt) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'effective_at is required' }, 422)
    }
    const status = normalizeStatus(body?.status) ?? 'active'
    const metadata = normalizeMetadata(body?.metadata) ?? {}
    const name = body?.name === undefined ? undefined : body.name

    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('billing_contracts')
      .select(['contract_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('effective_at', '=', effectiveAt)
      .executeTakeFirst()

    const row = await trx
      .insertInto('billing_contracts')
      .values({
        realm_id: realmId,
        billing_account_id: billingAccountId,
        status,
        effective_at: effectiveAt,
        name: name === undefined ? null : name,
        metadata,
      })
      .onConflict((oc) =>
        oc.columns(['realm_id', 'billing_account_id', 'effective_at']).doUpdateSet({
          status,
          name: name === undefined ? sql`billing_contracts.name` : (name as string | null),
          metadata,
          updated_at: sql`now()`,
        }),
      )
      .returning([
        'contract_id',
        'billing_account_id',
        'status',
        'effective_at',
        'name',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow()

    const contract = {
      contract_id: String(row.contract_id),
      billing_account_id: String(row.billing_account_id),
      status: row.status as ContractStatus,
      effective_at: row.effective_at.toISOString(),
      name: row.name ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingContract

    return { created: !existing, contract }
  }

  async updateBillingContract(
    req: AppRequest,
    contractId: string,
    body: { status?: ContractStatus; name?: string | null; metadata?: Record<string, unknown> },
  ): Promise<BillingContract> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const status = body?.status === undefined ? undefined : normalizeStatus(body.status)
    if (body?.status !== undefined && !status) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid status' }, 422)
    }
    const metadata = normalizeMetadata(body?.metadata)
    const name = body?.name === undefined ? undefined : body.name

    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('billing_contracts')
      .select(['contract_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('contract_id', '=', contractId)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'contract not found' }, 404)
    }

    const row = await trx
      .updateTable('billing_contracts')
      .set({
        status: status ?? sql`billing_contracts.status`,
        name: name === undefined ? sql`billing_contracts.name` : (name as string | null),
        metadata: metadata ?? sql`billing_contracts.metadata`,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('contract_id', '=', contractId)
      .returning([
        'contract_id',
        'billing_account_id',
        'status',
        'effective_at',
        'name',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow()

    return {
      contract_id: String(row.contract_id),
      billing_account_id: String(row.billing_account_id),
      status: row.status as ContractStatus,
      effective_at: row.effective_at.toISOString(),
      name: row.name ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingContract
  }

  async listContractTerms(
    req: AppRequest,
    contractId: string,
    query: Record<string, unknown>,
  ): Promise<ContractTermList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const contract = await trx
      .selectFrom('billing_contracts')
      .select(['contract_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('contract_id', '=', contractId)
      .executeTakeFirst()
    if (!contract) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'contract not found' }, 404)
    }

    const termKeys = Array.isArray(query?.term_key)
      ? (query.term_key as unknown[]).map((v) => String(v)).filter(Boolean)
      : typeof query?.term_key === 'string'
        ? [String(query.term_key)]
        : undefined
    const kind = typeof query?.kind === 'string' ? normalizeTermKind(query.kind) : undefined
    const asOf = toDate(query?.as_of)
    const latest = Boolean(query?.latest)
    const at = asOf ?? new Date()

    let builder = trx
      .selectFrom('contract_terms')
      .select(['contract_id', 'kind', 'term_key', 'effective_at', 'value_json'])
      .where('contract_id', '=', contractId)

    if (kind) {
      builder = builder.where('kind', '=', kind)
    }
    if (termKeys && termKeys.length > 0) {
      builder = builder.where(
        'term_key',
        'in',
        termKeys.map((k) => normalizeIdentifier(k, 'term_key')),
      )
    }

    if (latest) {
      builder = builder
        .distinctOn(['term_key'])
        .where('effective_at', '<=', at)
        .orderBy('term_key', 'asc')
        .orderBy('effective_at', 'desc')
    } else {
      builder = builder.orderBy('term_key', 'asc').orderBy('effective_at', 'desc')
    }

    const rows = await builder.execute()
    const items = rows.map((row) => ({
      contract_id: String(row.contract_id),
      kind: normalizeTermKind(row.kind),
      term_key: String(row.term_key),
      effective_at: row.effective_at.toISOString(),
      value_json: row.value_json as ContractTermValue,
    } satisfies ContractTerm))

    return { items, next_cursor: null } satisfies ContractTermList
  }

  async upsertContractTerm(
    req: AppRequest,
    contractId: string,
    body: { kind?: string; term_key: string; effective_at: string; value_json: ContractTermValue },
  ): Promise<{ created: boolean; term: ContractTerm }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const kind = normalizeTermKind(body?.kind)
    let termKey: string
    try {
      termKey = normalizeIdentifier(body?.term_key, 'term_key')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid term_key'
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message }, 422)
    }
    const effectiveAt = toDate(body?.effective_at)
    if (!effectiveAt) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'effective_at is required' }, 422)
    }
    if (body?.value_json === undefined) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'value_json is required' }, 422)
    }

    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const contract = await trx
      .selectFrom('billing_contracts')
      .select(['contract_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('contract_id', '=', contractId)
      .executeTakeFirst()
    if (!contract) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'contract not found' }, 404)
    }

    const existing = await trx
      .selectFrom('contract_terms')
      .select(['value_json'])
      .where('contract_id', '=', contractId)
      .where('kind', '=', kind)
      .where('term_key', '=', termKey)
      .where('effective_at', '=', effectiveAt)
      .executeTakeFirst()

    if (existing) {
      if (!deepEqual(existing.value_json, body.value_json)) {
        throw new HttpException({ code: 'CONFLICT', message: 'term already exists with different value_json' }, 409)
      }
      return {
        created: false,
        term: {
          contract_id: contractId,
          kind,
          term_key: termKey,
          effective_at: effectiveAt.toISOString(),
          value_json: existing.value_json as ContractTermValue,
        } satisfies ContractTerm,
      }
    }

    const row = await trx
      .insertInto('contract_terms')
      .values({
        contract_id: contractId,
        kind,
        term_key: termKey,
        effective_at: effectiveAt,
        value_json: toJsonb(body.value_json),
      })
      .returning(['contract_id', 'kind', 'term_key', 'effective_at', 'value_json'])
      .executeTakeFirstOrThrow()

    return {
      created: true,
      term: {
        contract_id: String(row.contract_id),
        kind: normalizeTermKind(row.kind),
        term_key: String(row.term_key),
        effective_at: row.effective_at.toISOString(),
        value_json: row.value_json as ContractTermValue,
      } satisfies ContractTerm,
    }
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

  private requireBillingAccountId(req: AppRequest): string {
    const billingAccountId = req?.ctx?.billingAccountId
    if (!billingAccountId) throw new HttpException({ code: 'AUTH.MISSING_ACCOUNT', message: 'billing_account_id missing' }, 400)
    return billingAccountId
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}
