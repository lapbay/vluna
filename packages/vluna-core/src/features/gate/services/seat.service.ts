import { Injectable, HttpException } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../types/database.js'
import type { AppRequest } from '../../../types/app-request.js'
import { setRlsSession } from '../../../db/index.js'
import { DEFAULT_BUNDLE_KEY } from '../../../constants/billing.js'
import { runInTransaction, parseOptionalNonNegativeInt } from './gate.utils.js'
import { WILDCARD_FEATURE_CODE } from './gate.types.js'

const MAX_SEAT_ID_LENGTH = 256

type SeatPolicyRow = {
  policy_id: string
  feature_code: string
  limit_count: unknown
  window_sec: number | string
  status: string
  metadata: Record<string, unknown> | null
}

type SeatPolicy = {
  policyId: string
  limitCount: number
  windowSec: number
  metadata: Record<string, unknown> | null
  seatScopeFeatureCode: string
}

export type SeatRecord = {
  feature_code: string
  seat_id: string
  state: 'active' | 'revoked'
  assigned_at: string
  last_seen_at: string
  revoked_at: string | null
}

@Injectable()
export class SeatService {
  async enforceSeatLimit(
    trx: Kysely<Database> | Transaction<Database>,
    params: {
      realmId: string
      billingAccountId: string
      featureCode: string
      seatId?: string
      bundleId?: string | null
    },
  ): Promise<{ seatId: string; policy: SeatPolicy } | null> {
    const policy = await this.loadSeatPolicy(trx, {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      featureCode: params.featureCode,
      bundleId: params.bundleId ?? null,
    })

    if (!policy || !params.seatId) {
      return null
    }

    const seatId = this.normalizeSeatId(params.seatId, { required: true })

    const now = new Date()
    const seatScopeFeatureCode = policy.seatScopeFeatureCode
    const existing = await trx
      .selectFrom('gate_seats')
      .select(['seat_row_id', 'state', 'last_seen_at'])
      .where('billing_account_id', '=', params.billingAccountId)
      .$if(seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
        qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
      .$if(seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
        qb.where('feature_code', '=', seatScopeFeatureCode))
      .where('seat_id', '=', seatId)
      .forUpdate()
      .executeTakeFirst()

    if (existing) {
      if (existing.state === 'revoked') {
        throw new HttpException({ code: 'SEAT.REVOKED', message: 'seat is revoked' }, 403)
      }
      const lastSeenAt = existing.last_seen_at instanceof Date
        ? existing.last_seen_at
        : new Date(existing.last_seen_at)
      const cutoff = policy.windowSec > 0 ? new Date(now.getTime() - policy.windowSec * 1000) : null
      const isActive = cutoff ? lastSeenAt >= cutoff : true
      if (isActive) {
        await trx
          .updateTable('gate_seats')
          .set({ last_seen_at: now, updated_at: now })
          .where('seat_row_id', '=', existing.seat_row_id)
          .execute()
        return { seatId, policy }
      }
    }

    if (policy.limitCount === 0) {
      throw new HttpException({ code: 'SEAT.LIMIT_EXCEEDED', message: 'seat limit exceeded' }, 403)
    }

    if (policy.limitCount !== -1) {
      await sql`select pg_advisory_xact_lock(hashtext(${params.billingAccountId}), hashtext('gate.seats'))`.execute(trx)
      const cutoff = policy.windowSec > 0 ? new Date(now.getTime() - policy.windowSec * 1000) : null
      let countQuery = trx
        .selectFrom('gate_seats')
        .select((eb) => eb.fn.countAll<number>().as('active_count'))
        .where('billing_account_id', '=', params.billingAccountId)
        .$if(seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
        .$if(seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', seatScopeFeatureCode))
        .where('state', '=', 'active')
      if (cutoff) {
        countQuery = countQuery.where('last_seen_at', '>=', cutoff)
      }
      const countRow = await countQuery.executeTakeFirst()

      const activeCount = Number(countRow?.active_count ?? 0)
      if (!Number.isFinite(activeCount) || activeCount >= policy.limitCount) {
        throw new HttpException({ code: 'SEAT.LIMIT_EXCEEDED', message: 'seat limit exceeded' }, 403)
      }
    }

    if (existing) {
      await trx
        .updateTable('gate_seats')
        .set({
          state: 'active',
          assigned_at: now,
          last_seen_at: now,
          revoked_at: null,
          updated_at: now,
        })
        .where('seat_row_id', '=', existing.seat_row_id)
        .execute()
    } else {
      await trx
        .insertInto('gate_seats')
        .values({
          billing_account_id: params.billingAccountId,
          feature_code: seatScopeFeatureCode,
          seat_id: seatId,
          state: 'active',
          assigned_at: now,
          last_seen_at: now,
        })
        .execute()
    }

    return { seatId, policy }
  }

  async listActiveSeats(req: AppRequest, featureCodeInput: unknown): Promise<SeatRecord[]> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }

    const featureCode = this.normalizeFeatureCode(featureCodeInput)

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId })
      const seatScopeFeatureCode = await this.resolveSeatScopeFeatureCode(trx, {
        realmId,
        billingAccountId,
        featureCode,
      })
      const rows = await trx
        .selectFrom('gate_seats')
        .select(['feature_code', 'seat_id', 'state', 'assigned_at', 'last_seen_at', 'revoked_at'])
        .where('billing_account_id', '=', billingAccountId)
        .$if(seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
        .$if(seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', seatScopeFeatureCode))
        .where('state', '=', 'active')
        .orderBy('assigned_at', 'asc')
        .execute()

      return rows.map((row) => this.toSeatRecord(row))
    })
  }

  async revokeSeat(req: AppRequest, featureCodeInput: unknown, seatIdInput: unknown): Promise<SeatRecord> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }

    const featureCode = this.normalizeFeatureCode(featureCodeInput)
    const seatId = this.normalizeSeatId(seatIdInput, { required: true })
    const now = new Date()

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId })
      const seatScopeFeatureCode = await this.resolveSeatScopeFeatureCode(trx, {
        realmId,
        billingAccountId,
        featureCode,
      })

      const existing = await trx
        .selectFrom('gate_seats')
        .select(['seat_row_id', 'feature_code', 'seat_id', 'state', 'assigned_at', 'last_seen_at', 'revoked_at'])
        .where('billing_account_id', '=', billingAccountId)
        .$if(seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
        .$if(seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', seatScopeFeatureCode))
        .where('seat_id', '=', seatId)
        .executeTakeFirst()

      if (!existing) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'seat not found' }, 404)
      }

      if (existing.state === 'revoked') {
        return this.toSeatRecord(existing)
      }

      const updated = await trx
        .updateTable('gate_seats')
        .set({
          state: 'revoked',
          revoked_at: now,
          updated_at: now,
        })
        .where('seat_row_id', '=', existing.seat_row_id)
        .returning(['feature_code', 'seat_id', 'state', 'assigned_at', 'last_seen_at', 'revoked_at'])
        .executeTakeFirstOrThrow(() => new Error('failed to revoke seat'))

      return this.toSeatRecord(updated)
    })
  }

  async restoreSeat(req: AppRequest, featureCodeInput: unknown, seatIdInput: unknown): Promise<SeatRecord> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }

    const featureCode = this.normalizeFeatureCode(featureCodeInput)
    const seatId = this.normalizeSeatId(seatIdInput, { required: true })
    const now = new Date()

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId })
      const seatScopeFeatureCode = await this.resolveSeatScopeFeatureCode(trx, {
        realmId,
        billingAccountId,
        featureCode,
      })

      const existing = await trx
        .selectFrom('gate_seats')
        .select(['seat_row_id', 'feature_code', 'seat_id', 'state', 'assigned_at', 'last_seen_at', 'revoked_at'])
        .where('billing_account_id', '=', billingAccountId)
        .$if(seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
        .$if(seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
          qb.where('feature_code', '=', seatScopeFeatureCode))
        .where('seat_id', '=', seatId)
        .executeTakeFirst()

      if (!existing) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'seat not found' }, 404)
      }

      if (existing.state === 'active') {
        return this.toSeatRecord(existing)
      }

      const policy = await this.loadSeatPolicy(trx, { realmId, billingAccountId, featureCode })
      if (!policy) {
        throw new HttpException({ code: 'SEAT.POLICY_MISSING', message: 'seats policy not configured' }, 422)
      }

      if (policy.limitCount !== -1) {
        await sql`select pg_advisory_xact_lock(hashtext(${billingAccountId}), hashtext('gate.seats'))`.execute(trx)
        const cutoff = policy.windowSec > 0 ? new Date(now.getTime() - policy.windowSec * 1000) : null
        let countQuery = trx
          .selectFrom('gate_seats')
          .select((eb) => eb.fn.countAll<number>().as('active_count'))
          .where('billing_account_id', '=', billingAccountId)
          .$if(policy.seatScopeFeatureCode === WILDCARD_FEATURE_CODE, (qb) =>
            qb.where('feature_code', '=', WILDCARD_FEATURE_CODE))
          .$if(policy.seatScopeFeatureCode !== WILDCARD_FEATURE_CODE, (qb) =>
            qb.where('feature_code', '=', policy.seatScopeFeatureCode))
          .where('state', '=', 'active')
        if (cutoff) {
          countQuery = countQuery.where('last_seen_at', '>=', cutoff)
        }
        const countRow = await countQuery.executeTakeFirst()

        const activeCount = Number(countRow?.active_count ?? 0)
        if (!Number.isFinite(activeCount) || activeCount >= policy.limitCount) {
          throw new HttpException({ code: 'SEAT.LIMIT_EXCEEDED', message: 'seat limit exceeded' }, 403)
        }
      }

      const updated = await trx
        .updateTable('gate_seats')
        .set({
          state: 'active',
          assigned_at: now,
          last_seen_at: now,
          revoked_at: null,
          updated_at: now,
        })
        .where('seat_row_id', '=', existing.seat_row_id)
        .returning(['feature_code', 'seat_id', 'state', 'assigned_at', 'last_seen_at', 'revoked_at'])
        .executeTakeFirstOrThrow(() => new Error('failed to restore seat'))

      return this.toSeatRecord(updated)
    })
  }

  normalizeSeatId(input: unknown, opts?: { required?: boolean }): string {
    const required = opts?.required !== false
    let raw = ''
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'seat_id must be a valid number' }, 422)
      }
      raw = String(input)
    } else if (typeof input === 'string') {
      raw = input
    }
    const value = raw.trim()
    if (!value) {
      if (required) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'seat_id is required' }, 422)
      }
      return ''
    }
    if (value.length > MAX_SEAT_ID_LENGTH) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'seat_id exceeds max length' }, 422)
    }
    return value
  }

  private async loadSeatPolicy(
    trx: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; billingAccountId: string; featureCode: string; bundleId?: string | null },
  ): Promise<SeatPolicy | null> {
    const bundleId = await this.resolveBundleId(trx, {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      bundleId: params.bundleId ?? null,
    })

    const rows = await trx
      .selectFrom('gate_policies')
      .innerJoin('gate_policy_bundles as b', 'b.bundle_id', 'gate_policies.bundle_id')
      .select([
        'gate_policies.policy_id as policy_id',
        'gate_policies.feature_code as feature_code',
        'gate_policies.limit_count as limit_count',
        'gate_policies.window_sec as window_sec',
        'gate_policies.status as status',
        'gate_policies.metadata as metadata',
      ])
      .where('gate_policies.realm_id', '=', params.realmId)
      .where('gate_policies.bundle_id', '=', bundleId)
      .where('gate_policies.feature_code', 'in', [params.featureCode, WILDCARD_FEATURE_CODE])
      .where('gate_policies.kind', '=', 'seats')
      .where('gate_policies.status', '<>', 'disabled')
      .where('b.status', '=', 'active')
      .execute() as SeatPolicyRow[]

    if (rows.length === 0) {
      return null
    }

    const selected = rows.sort((a, b) => this.compareSeatPoliciesForFeature(a, b, params.featureCode))[0]
    if (!selected) return null

    const limitCount = this.parseSeatLimit(selected.limit_count, selected.policy_id)
    const windowSec = this.parseWindowSec(selected.window_sec, selected.policy_id)
    const seatScopeFeatureCode = this.normalizeSeatScopeFeatureCode(selected.feature_code)

    return {
      policyId: selected.policy_id,
      limitCount,
      windowSec,
      metadata: selected.metadata ?? null,
      seatScopeFeatureCode,
    }
  }

  private async resolveSeatScopeFeatureCode(
    trx: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; billingAccountId: string; featureCode: string },
  ): Promise<string> {
    const policy = await this.loadSeatPolicy(trx, params)
    if (policy) return policy.seatScopeFeatureCode
    return this.normalizeSeatScopeFeatureCode(params.featureCode)
  }

  private async resolveBundleId(
    trx: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; billingAccountId: string; bundleId?: string | null },
  ): Promise<string> {
    if (params.bundleId) {
      return String(params.bundleId)
    }

    const accountRow = await trx
      .selectFrom('billing_accounts')
      .select(['current_bundle_id'])
      .where('billing_account_id', '=', params.billingAccountId)
      .where('realm_id', '=', params.realmId)
      .executeTakeFirst()

    const accountBundle = accountRow?.current_bundle_id ? String(accountRow.current_bundle_id) : null
    if (accountBundle) {
      return accountBundle
    }

    const defaultBundle = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id'])
      .where('realm_id', '=', params.realmId)
      .where('bundle_key', '=', DEFAULT_BUNDLE_KEY)
      .executeTakeFirst()

    if (!defaultBundle?.bundle_id) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'default bundle not configured for realm' }, 500)
    }

    return String(defaultBundle.bundle_id)
  }

  private parseSeatLimit(raw: unknown, policyId: string): number {
    if (raw === null || raw === undefined) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: `seats policy ${policyId} missing limit_count` }, 500)
    }
    const parsed = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : '')
    if (!Number.isFinite(parsed) || parsed < -1) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: `seats policy ${policyId} invalid limit_count` }, 500)
    }
    return Math.floor(parsed)
  }

  private parseWindowSec(raw: number | string, policyId: string): number {
    const parsed = parseOptionalNonNegativeInt(raw, 'window_sec')
    if (parsed === undefined) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: `seats policy ${policyId} missing window_sec` }, 500)
    }
    return Math.floor(parsed)
  }

  private rankPolicyStatus(status: string): number {
    switch (status) {
      case 'default':
        return 0
      case 'ceiling':
        return 1
      case 'assignable':
        return 2
      default:
        return 3
    }
  }

  private compareSeatPoliciesForFeature(a: SeatPolicyRow, b: SeatPolicyRow, featureCode: string): number {
    const featureMatchA = this.policyFeatureMatchRank(a.feature_code, featureCode)
    const featureMatchB = this.policyFeatureMatchRank(b.feature_code, featureCode)
    if (featureMatchA !== featureMatchB) return featureMatchA - featureMatchB
    return this.rankPolicyStatus(a.status) - this.rankPolicyStatus(b.status)
  }

  private policyFeatureMatchRank(policyFeatureCode: string, featureCode: string): number {
    const normalizedPolicyFeatureCode = this.normalizeSeatScopeFeatureCode(policyFeatureCode)
    if (normalizedPolicyFeatureCode === this.normalizeSeatScopeFeatureCode(featureCode) && normalizedPolicyFeatureCode !== WILDCARD_FEATURE_CODE) {
      return 0
    }
    if (normalizedPolicyFeatureCode === WILDCARD_FEATURE_CODE) {
      return 1
    }
    return 2
  }

  private toSeatRecord(row: {
    feature_code: string
    seat_id: string
    state: string
    assigned_at: Date | string
    last_seen_at: Date | string
    revoked_at: Date | string | null
  }): SeatRecord {
    const assignedAt = row.assigned_at instanceof Date ? row.assigned_at : new Date(row.assigned_at)
    const lastSeenAt = row.last_seen_at instanceof Date ? row.last_seen_at : new Date(row.last_seen_at)
    const revokedAt = row.revoked_at
      ? row.revoked_at instanceof Date
        ? row.revoked_at
        : new Date(row.revoked_at)
      : null

    return {
      feature_code: row.feature_code,
      seat_id: row.seat_id,
      state: row.state === 'revoked' ? 'revoked' : 'active',
      assigned_at: assignedAt.toISOString(),
      last_seen_at: lastSeenAt.toISOString(),
      revoked_at: revokedAt ? revokedAt.toISOString() : null,
    }
  }

  private normalizeFeatureCode(input: unknown): string {
    if (typeof input !== 'string') {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_code is required' }, 422)
    }
    const value = input.trim()
    if (!value) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_code is required' }, 422)
    }
    return this.normalizeSeatScopeFeatureCode(value)
  }

  private normalizeSeatScopeFeatureCode(featureCode: string): string {
    const normalized = featureCode.trim()
    if (!normalized) return normalized
    if (normalized === WILDCARD_FEATURE_CODE) {
      return WILDCARD_FEATURE_CODE
    }
    return normalized
  }
}
