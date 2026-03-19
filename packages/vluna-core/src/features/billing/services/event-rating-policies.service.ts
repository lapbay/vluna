import crypto from 'node:crypto'
import { HttpException, Injectable } from '@nestjs/common'
import { sql, type Kysely } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { compileEventToRatingsDsl, getRequiredContractTermKeys } from '../../../services/event-to-ratings.dsl.js'

type EventRatingPolicy = BillingComponents['schemas']['EventRatingPolicy']
type EventRatingPolicyList = BillingComponents['schemas']['EventRatingPolicyList']
type EventRatingPolicyVersion = BillingComponents['schemas']['EventRatingPolicyVersion']
type EventRatingPolicyVersionList = BillingComponents['schemas']['EventRatingPolicyVersionList']
type EventRatingPolicyVersionValidationResult = BillingComponents['schemas']['EventRatingPolicyVersionValidationResult']
type EventRatingPolicyVersionValidationError = BillingComponents['schemas']['EventRatingPolicyVersionValidationError']

type PolicyStatus = 'active' | 'disabled'
type PolicyVersionStatus = 'draft' | 'active' | 'deprecated'

const POLICY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

function sha256Base64Url(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url')
}

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return date
}

function normalizePolicyStatus(value: unknown): PolicyStatus | undefined {
  if (value === 'active' || value === 'disabled') return value
  return undefined
}

function normalizePolicyVersionStatus(value: unknown): PolicyVersionStatus | undefined {
  if (value === 'draft' || value === 'active' || value === 'deprecated') return value
  return undefined
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim()
}

function parsePolicyId(value: string, name: string): string {
  const trimmed = normalizeString(value)
  if (!trimmed || !POLICY_ID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed
}

function err(code: string, message: string, details?: Record<string, unknown>): EventRatingPolicyVersionValidationError {
  return { code, message, details: details ?? {} }
}

const activeVersionSql = () =>
  sql<string | null>`
    (
      select v.policy_version
      from event_rating_policy_versions as v
      where v.realm_id = event_rating_policies.realm_id
        and v.policy_id = event_rating_policies.policy_id
        and v.status = 'active'
        and v.effective_at <= now()
      order by v.effective_at desc
      limit 1
    )
  `.as('active_version')

@Injectable()
export class EventRatingPoliciesService {
  async listPolicies(req: AppRequest, query: Record<string, unknown>): Promise<EventRatingPolicyList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''

    let builder = trx
      .selectFrom('event_rating_policies')
      .select(['policy_id', 'name', 'status', 'created_at', 'updated_at'])
      .select(activeVersionSql())
      .where('realm_id', '=', realmId)
      .orderBy('policy_id', 'asc')

    if (cursor) {
      builder = builder.where('policy_id', '>', parsePolicyId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      policy_id: String(row.policy_id),
      name: String(row.name),
      status: row.status as PolicyStatus,
      active_version: row.active_version === null || row.active_version === undefined ? null : String(row.active_version),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies EventRatingPolicy))

    const nextCursor = hasMore ? items[items.length - 1]?.policy_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies EventRatingPolicyList
  }

  async getPolicy(req: AppRequest, policyId: string): Promise<EventRatingPolicy> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')
    const row = await trx
      .selectFrom('event_rating_policies')
      .select(['policy_id', 'name', 'status', 'created_at', 'updated_at'])
      .select(activeVersionSql())
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()
    if (!row) throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    return {
      policy_id: String(row.policy_id),
      name: String(row.name),
      status: row.status as PolicyStatus,
      active_version: row.active_version === null || row.active_version === undefined ? null : String(row.active_version),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies EventRatingPolicy
  }

  async upsertPolicy(
    req: AppRequest,
    body: { policy_id: string; name: string; status?: PolicyStatus },
  ): Promise<{ created: boolean; policy: EventRatingPolicy }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const policyId = parsePolicyId(body?.policy_id, 'policy_id')
    const name = normalizeString(body?.name)
    if (!name) throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    const status = normalizePolicyStatus(body?.status) ?? 'active'

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('event_rating_policies')
      .select(['policy_id'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', policyId)
      .executeTakeFirst()

    await trx
      .insertInto('event_rating_policies')
      .values({ realm_id: realmId, policy_id: policyId, name, status })
      .onConflict((oc) =>
        oc.columns(['realm_id', 'policy_id']).doUpdateSet({
          name,
          status,
          updated_at: sql`now()`,
        }),
      )
      .executeTakeFirstOrThrow()

    return {
      created: !existing,
      policy: await this.getPolicy(req, policyId),
    }
  }

  async updatePolicy(
    req: AppRequest,
    policyId: string,
    body: { name?: string; status?: PolicyStatus },
  ): Promise<EventRatingPolicy> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    const name = body?.name === undefined ? undefined : normalizeString(body.name)
    if (body?.name !== undefined && !name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name must be non-empty' }, 422)
    }
    const status = body?.status === undefined ? undefined : normalizePolicyStatus(body.status)
    if (body?.status !== undefined && !status) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid status' }, 422)
    }

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('event_rating_policies')
      .select(['policy_id'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()
    if (!existing) throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)

    await trx
      .updateTable('event_rating_policies')
      .set({
        name: name === undefined ? sql`event_rating_policies.name` : name,
        status: status === undefined ? sql`event_rating_policies.status` : status,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirstOrThrow()

    return this.getPolicy(req, id)
  }

  async deletePolicy(req: AppRequest, policyId: string): Promise<{ deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('event_rating_policies')
      .select(['status'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    }

    if (String(existing.status) !== 'disabled') {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'policy must be disabled before delete' }, 422)
    }

    const deleted = await trx
      .deleteFrom('event_rating_policies')
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    const deletedCount = Number(deleted?.numDeletedRows ?? 0)
    if (deletedCount <= 0) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    }

    return { deleted: true }
  }

  async listPolicyVersions(
    req: AppRequest,
    policyId: string,
    query: Record<string, unknown>,
  ): Promise<EventRatingPolicyVersionList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    const policy = await trx
      .selectFrom('event_rating_policies')
      .select(['policy_id'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()
    if (!policy) throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorDate = toDate(query?.cursor)

    let builder = trx
      .selectFrom('event_rating_policy_versions')
      .select(['policy_id', 'policy_version', 'status', 'effective_at', 'dsl_json', 'dsl_hash', 'created_at', 'updated_at'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .orderBy('effective_at', 'desc')
      .orderBy('policy_version', 'desc')

    if (cursorDate) {
      builder = builder.where('effective_at', '<', cursorDate)
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      policy_id: String(row.policy_id),
      policy_version: String(row.policy_version),
      status: row.status as PolicyVersionStatus,
      effective_at: row.effective_at.toISOString(),
      dsl_json: (row.dsl_json ?? {}) as Record<string, unknown>,
      dsl_hash: String(row.dsl_hash),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies EventRatingPolicyVersion))

    const nextCursor = hasMore ? items[items.length - 1]?.effective_at ?? null : null
    return { items, next_cursor: nextCursor } satisfies EventRatingPolicyVersionList
  }

  async getPolicyVersion(req: AppRequest, policyId: string, policyVersion: string): Promise<EventRatingPolicyVersion> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')
    const row = await trx
      .selectFrom('event_rating_policy_versions')
      .select(['policy_id', 'policy_version', 'status', 'effective_at', 'dsl_json', 'dsl_hash', 'created_at', 'updated_at'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .executeTakeFirst()
    if (!row) throw new HttpException({ code: 'NOT_FOUND', message: 'policy version not found' }, 404)
    return {
      policy_id: String(row.policy_id),
      policy_version: String(row.policy_version),
      status: row.status as PolicyVersionStatus,
      effective_at: row.effective_at.toISOString(),
      dsl_json: (row.dsl_json ?? {}) as Record<string, unknown>,
      dsl_hash: String(row.dsl_hash),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies EventRatingPolicyVersion
  }

  async updatePolicyVersion(
    req: AppRequest,
    policyId: string,
    policyVersion: string,
    body: { status?: PolicyVersionStatus; effective_at?: string; dsl_json?: unknown },
  ): Promise<EventRatingPolicyVersion> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('event_rating_policy_versions')
      .select(['policy_id', 'policy_version', 'status', 'effective_at', 'dsl_json', 'dsl_hash', 'created_at', 'updated_at'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .executeTakeFirst()
    if (!existing) throw new HttpException({ code: 'NOT_FOUND', message: 'policy version not found' }, 404)
    if (String(existing.status) !== 'draft') {
      throw new HttpException({ code: 'CONFLICT', message: 'policy_version is immutable' }, 409)
    }

    const status = body?.status === undefined ? (existing.status as PolicyVersionStatus) : normalizePolicyVersionStatus(body.status)
    if (body?.status !== undefined && !status) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid status' }, 422)
    }

    const effectiveAt =
      body?.effective_at === undefined ? existing.effective_at : toDate(body?.effective_at)
    if (body?.effective_at !== undefined && !effectiveAt) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'effective_at is required' }, 422)
    }

    let dslJson = body?.dsl_json === undefined ? existing.dsl_json : body.dsl_json
    let dslHash = String(existing.dsl_hash)
    if (body?.dsl_json !== undefined) {
      const validation = await this.validateDsl(req, dslJson)
      if (!validation.valid) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'dsl_json invalid', details: { errors: validation.errors } }, 422)
      }
      dslHash = validation.computed_dsl_hash
    }

    if (status === 'active') {
      const policy = await trx
        .selectFrom('event_rating_policies')
        .select(['status'])
        .where('realm_id', '=', realmId)
        .where('policy_id', '=', id)
        .executeTakeFirst()
      if (!policy) throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
      if (String(policy.status) === 'disabled') {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'policy is disabled' }, 422)
      }
    }

    const row = await trx
      .updateTable('event_rating_policy_versions')
      .set({
        status,
        effective_at: effectiveAt as Date,
        dsl_json: dslJson as Record<string, unknown>,
        dsl_hash: dslHash,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .returning(['policy_id', 'policy_version', 'status', 'effective_at', 'dsl_json', 'dsl_hash', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    return {
      policy_id: String(row.policy_id),
      policy_version: String(row.policy_version),
      status: row.status as PolicyVersionStatus,
      effective_at: row.effective_at.toISOString(),
      dsl_json: (row.dsl_json ?? {}) as Record<string, unknown>,
      dsl_hash: String(row.dsl_hash),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies EventRatingPolicyVersion
  }

  async deletePolicyVersion(req: AppRequest, policyId: string, policyVersion: string): Promise<{ deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('event_rating_policy_versions')
      .select(['status'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy version not found' }, 404)
    }
    if (String(existing.status) !== 'draft') {
      throw new HttpException({ code: 'CONFLICT', message: 'policy_version is immutable' }, 409)
    }

    const deleted = await trx
      .deleteFrom('event_rating_policy_versions')
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .executeTakeFirst()

    const deletedCount = Number(deleted?.numDeletedRows ?? 0)
    if (deletedCount <= 0) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy version not found' }, 404)
    }

    return { deleted: true }
  }

  async validateDsl(req: AppRequest, dslJson: unknown): Promise<EventRatingPolicyVersionValidationResult> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const computedDslHash = sha256Base64Url(stableStringify(dslJson))
    const errors: EventRatingPolicyVersionValidationError[] = []

    let compiled: ReturnType<typeof compileEventToRatingsDsl> | null = null
    try {
      compiled = compileEventToRatingsDsl(dslJson)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'invalid dsl_json'
      errors.push(err('dsl_invalid', message))
      return {
        valid: false,
        computed_dsl_hash: computedDslHash,
        summary: { compile_error: message },
        errors,
      } satisfies EventRatingPolicyVersionValidationResult
    }

    const requiredTermKeys = getRequiredContractTermKeys(compiled)

    const featureCodes = Array.from(new Set(compiled.intents.map((i) => i.featureCode).filter(Boolean)))
    const meterCodes = Array.from(new Set(compiled.intents.flatMap((i) => i.meters.map((m) => m.meterCode)).filter(Boolean)))

    const expectedMeterKind = 'outcome'

    const featureRows = featureCodes.length === 0
      ? []
      : await trx
        .selectFrom('features')
        .select(['feature_id', 'feature_code'])
        .where('realm_id', '=', realmId)
        .where('feature_code', 'in', featureCodes)
        .execute()
    const meterRows = meterCodes.length === 0
      ? []
      : await trx
        .selectFrom('meters')
        .select(['meter_id', 'meter_code', 'semantic_kind'])
        .where('realm_id', '=', realmId)
        .where('meter_code', 'in', meterCodes)
        .execute()

    const foundFeatures = new Set(featureRows.map((r) => String(r.feature_code)))
    const foundMeters = new Map(meterRows.map((r) => [String(r.meter_code), String(r.semantic_kind)] as const))

    const missingFeatureCodes = featureCodes.filter((c) => !foundFeatures.has(c))
    const missingMeterCodes = meterCodes.filter((c) => !foundMeters.has(c))
    const wrongKindMeterCodes = meterCodes.filter((c) => {
      const kind = foundMeters.get(c)
      return kind !== undefined && kind !== expectedMeterKind
    })

    if (missingFeatureCodes.length > 0) {
      errors.push(err('feature_missing', 'unknown feature_code(s)', { feature_codes: missingFeatureCodes }))
    }
    if (missingMeterCodes.length > 0) {
      errors.push(err('meter_missing', 'unknown meter_code(s)', { meter_codes: missingMeterCodes }))
    }
    if (wrongKindMeterCodes.length > 0) {
      errors.push(err('meter_semantic_kind_invalid', `meters must have semantic_kind='${expectedMeterKind}'`, { meter_codes: wrongKindMeterCodes }))
    }

    const requestedPairs = compiled.intents.flatMap((intent) => intent.meters.map((m) => ({ featureCode: intent.featureCode, meterCode: m.meterCode })))
    const pairKey = (p: { featureCode: string; meterCode: string }) => `${p.featureCode}::${p.meterCode}`
    const distinctPairs = Array.from(new Map(requestedPairs.map((p) => [pairKey(p), p] as const)).values())

    const mappedPairs = new Set<string>()
    if (distinctPairs.length > 0 && featureCodes.length > 0 && meterCodes.length > 0) {
      const rows = await trx
        .selectFrom('feature_meters as fm')
        .innerJoin('features as f', 'f.feature_id', 'fm.feature_id')
        .innerJoin('meters as m', 'm.meter_id', 'fm.meter_id')
        .select(['f.feature_code as feature_code', 'm.meter_code as meter_code'])
        .where('f.realm_id', '=', realmId)
        .where('m.realm_id', '=', realmId)
        .where('f.feature_code', 'in', featureCodes)
        .where('m.meter_code', 'in', meterCodes)
        .execute()
      for (const row of rows) {
        mappedPairs.add(`${String(row.feature_code)}::${String(row.meter_code)}`)
      }
    }

    const unmappedPairs = distinctPairs
      .filter((p) => foundFeatures.has(p.featureCode) && foundMeters.has(p.meterCode) && !mappedPairs.has(pairKey(p)))
      .map((p) => ({ feature_code: p.featureCode, meter_code: p.meterCode }))

    if (unmappedPairs.length > 0) {
      errors.push(err('feature_meter_unmapped', 'meter_code not allowed for feature_code', { pairs: unmappedPairs }))
    }

    return {
      valid: errors.length === 0,
      computed_dsl_hash: computedDslHash,
      summary: {
        dsl_version: compiled.dsl_version,
        engine: compiled.engine,
        match_event_type: compiled.match.eventTypeExact,
        required_contract_term_keys: requiredTermKeys,
        feature_codes: featureCodes,
        meter_codes: meterCodes,
        expected_meter_semantic_kind: expectedMeterKind,
      },
      errors,
    } satisfies EventRatingPolicyVersionValidationResult
  }

  async createPolicyVersion(
    req: AppRequest,
    policyId: string,
    body: { policy_version: string; status?: PolicyVersionStatus; effective_at: string; dsl_json: unknown },
  ): Promise<{ created: boolean; version: EventRatingPolicyVersion }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parsePolicyId(policyId, 'policy_id')

    const policyVersion = normalizeString(body?.policy_version)
    if (!policyVersion) throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'policy_version is required' }, 422)
    const effectiveAt = toDate(body?.effective_at)
    if (!effectiveAt) throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'effective_at is required' }, 422)
    const status = normalizePolicyVersionStatus(body?.status) ?? 'active'
    const dslJson = body?.dsl_json

    const validation = await this.validateDsl(req, dslJson)
    if (!validation.valid) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'dsl_json invalid', details: { errors: validation.errors } }, 422)
    }
    const dslHash = validation.computed_dsl_hash

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const policy = await trx
      .selectFrom('event_rating_policies')
      .select(['policy_id', 'status'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()
    if (!policy) throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    if (String(policy.status) === 'disabled') {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'policy is disabled' }, 422)
    }

    const existing = await trx
      .selectFrom('event_rating_policy_versions')
      .select(['dsl_hash'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .where('policy_version', '=', policyVersion)
      .executeTakeFirst()

    if (existing) {
      const existingHash = String(existing.dsl_hash)
      if (existingHash !== dslHash) {
        throw new HttpException({ code: 'CONFLICT', message: 'policy_version is immutable (dsl_hash mismatch)' }, 409)
      }
      const version = await this.getPolicyVersion(req, id, policyVersion)
      return { created: false, version }
    }

    const row = await trx
      .insertInto('event_rating_policy_versions')
      .values({
        realm_id: realmId,
        policy_id: id,
        policy_version: policyVersion,
        status,
        effective_at: effectiveAt,
        dsl_json: dslJson as Record<string, unknown>,
        dsl_hash: dslHash,
      })
      .returning(['policy_id', 'policy_version', 'status', 'effective_at', 'dsl_json', 'dsl_hash', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    return {
      created: true,
      version: {
        policy_id: String(row.policy_id),
        policy_version: String(row.policy_version),
        status: row.status as PolicyVersionStatus,
        effective_at: row.effective_at.toISOString(),
        dsl_json: (row.dsl_json ?? {}) as Record<string, unknown>,
        dsl_hash: String(row.dsl_hash),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      } satisfies EventRatingPolicyVersion,
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
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}
