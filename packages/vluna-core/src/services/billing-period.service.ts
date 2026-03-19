import { Injectable } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

export type BillingPeriodSource =
  | 'provider.subscription'
  | 'binding'
  | 'plan'
  | 'realm_default'
  | 'manual'

export type BillingPeriodKind = 'subscription' | 'calendar' | 'fixed_days'
export type BillingPeriodCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
export type BillingPeriodIssueAnchor = 'calendar_start' | 'binding_start' | 'subscription_period_start'

export type BillingPeriodRule = {
  kind: BillingPeriodKind
  cadence?: BillingPeriodCadence
  issueAnchor: BillingPeriodIssueAnchor
  fixedDays?: number
  timezone: 'UTC'
  graceWindowSeconds: number
  billingMode?: 'prepaid' | 'postpaid' | 'hybrid'
}

export type ResolvedBillingMode = {
  billingMode: 'prepaid' | 'postpaid' | 'hybrid'
  source: Exclude<BillingPeriodSource, 'provider.subscription'> | 'unknown'
}

export type ResolvedBillingPeriod = {
  billingPeriodId: string
  periodStart: Date
  periodEnd: Date
  graceWindowSeconds: number
  source: BillingPeriodSource
  sourceRef: string | null
  sourceSubscriptionId?: string | null
  sourcePeriodStart?: Date | null
  sourcePeriodEnd?: Date | null
  rule: BillingPeriodRule
  status: Database['billing_periods']['status']
  frozenAt: Date | null
}

type BillingDefaultsMetadata = {
  billing_defaults?: {
    period?: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readNestedObject(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current: unknown = root
  for (const p of path) {
    if (!isRecord(current)) return null
    current = current[p]
  }
  return isRecord(current) ? current : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  return value
}

function clampNonNegativeInt(value: number | null, fallback: number): number {
  const v = value === null ? fallback : value
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.floor(v))
}

function daysInUtcMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month0 = date.getUTCMonth()
  const day = date.getUTCDate()
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = date.getUTCSeconds()
  const ms = date.getUTCMilliseconds()

  const targetMonth0 = month0 + months
  const targetYear = year + Math.floor(targetMonth0 / 12)
  const normalizedMonth0 = ((targetMonth0 % 12) + 12) % 12
  const maxDay = daysInUtcMonth(targetYear, normalizedMonth0)
  const clampedDay = Math.min(day, maxDay)

  return new Date(Date.UTC(targetYear, normalizedMonth0, clampedDay, hours, minutes, seconds, ms))
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

function startOfUtcWeek(date: Date): Date {
  // ISO-like week start (Monday) in UTC.
  const day = date.getUTCDay() // 0=Sun..6=Sat
  const diff = (day + 6) % 7
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
  return addUtcDays(d, -diff)
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
}

function startOfUtcQuarter(date: Date): Date {
  const month0 = date.getUTCMonth()
  const quarterStartMonth0 = month0 - (month0 % 3)
  return new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth0, 1, 0, 0, 0, 0))
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
}

function computeCalendarPeriod(at: Date, cadence: BillingPeriodCadence, issueAnchor: BillingPeriodIssueAnchor, bindingStart: Date): { start: Date; end: Date } {
  if (issueAnchor === 'calendar_start') {
    if (cadence === 'daily') {
      const start = startOfUtcDay(at)
      return { start, end: addUtcDays(start, 1) }
    }
    if (cadence === 'weekly') {
      const start = startOfUtcWeek(at)
      return { start, end: addUtcDays(start, 7) }
    }
    if (cadence === 'monthly') {
      const start = startOfUtcMonth(at)
      return { start, end: addUtcMonths(start, 1) }
    }
    if (cadence === 'quarterly') {
      const start = startOfUtcQuarter(at)
      return { start, end: addUtcMonths(start, 3) }
    }
    const start = startOfUtcYear(at)
    return { start, end: addUtcMonths(start, 12) }
  }

  // binding_start anchor: treat cadence as repeating from bindingStart (not aligned to calendar boundaries).
  const stepMonths = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : cadence === 'yearly' ? 12 : 0
  if (cadence === 'daily') {
    const anchor = startOfUtcDay(bindingStart)
    const atDay = startOfUtcDay(at)
    const deltaDays = Math.floor((atDay.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000))
    const start = addUtcDays(anchor, deltaDays)
    return { start, end: addUtcDays(start, 1) }
  }
  if (cadence === 'weekly') {
    const anchor = startOfUtcDay(bindingStart)
    const atDay = startOfUtcDay(at)
    const deltaDays = Math.floor((atDay.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000))
    const weeks = Math.floor(deltaDays / 7)
    const start = addUtcDays(anchor, weeks * 7)
    return { start, end: addUtcDays(start, 7) }
  }

  const anchor = bindingStart
  const monthDiffRaw = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth())
  const monthDiff = Math.max(0, monthDiffRaw)
  const step = stepMonths === 0 ? 1 : stepMonths
  const steps = Math.floor(monthDiff / step)
  let start = addUtcMonths(anchor, steps * step)
  if (start.getTime() > at.getTime() && steps > 0) {
    start = addUtcMonths(anchor, (steps - 1) * step)
  }
  return { start, end: addUtcMonths(start, step) }
}

function readPeriodRuleFromMetadata(
  realmMeta: Record<string, unknown>,
  profileMeta: Record<string, unknown>,
  bindingMeta: Record<string, unknown>,
): BillingPeriodRule {
  const realmDefaults = readNestedObject(realmMeta, ['billing_defaults', 'period']) ?? readNestedObject(realmMeta, ['billing_defaults', 'period']) ?? {}
  const profileDefaults = readNestedObject(profileMeta, ['billing_defaults', 'period']) ?? {}
  const bindingPeriod = readNestedObject(bindingMeta, ['billing', 'period']) ?? {}

  const merged: Record<string, unknown> = { ...realmDefaults, ...profileDefaults, ...bindingPeriod }

  const kindRaw = readString(merged.kind) ?? 'calendar'
  const kind: BillingPeriodKind = (kindRaw === 'subscription' || kindRaw === 'fixed_days' || kindRaw === 'calendar') ? kindRaw : 'calendar'

  const cadenceRaw = readString(merged.cadence) ?? 'monthly'
  const cadence: BillingPeriodCadence = (cadenceRaw === 'daily' || cadenceRaw === 'weekly' || cadenceRaw === 'monthly' || cadenceRaw === 'quarterly' || cadenceRaw === 'yearly')
    ? cadenceRaw
    : 'monthly'

  const anchorRaw = readString(merged.issue_anchor) ?? readString(merged.issueAnchor) ?? 'calendar_start'
  const issueAnchor: BillingPeriodIssueAnchor = (anchorRaw === 'calendar_start' || anchorRaw === 'binding_start' || anchorRaw === 'subscription_period_start')
    ? anchorRaw
    : 'calendar_start'

  const fixedDays = readNumber(merged.fixed_days ?? merged.fixedDays) ?? null

  const grace = clampNonNegativeInt(readNumber(merged.grace_window_seconds ?? merged.graceWindowSeconds), 86400)

  const modeRaw = readString(merged.billing_mode ?? merged.billingMode)
  const billingMode = (modeRaw === 'prepaid' || modeRaw === 'postpaid' || modeRaw === 'hybrid') ? modeRaw : undefined

  return {
    kind,
    cadence: kind === 'calendar' ? cadence : undefined,
    issueAnchor,
    fixedDays: kind === 'fixed_days' ? clampNonNegativeInt(fixedDays, 30) : undefined,
    timezone: 'UTC',
    graceWindowSeconds: grace,
    billingMode,
  }
}

function resolveBillingModeFromMetadata(
  realmMeta: Record<string, unknown>,
  planMeta: Record<string, unknown>,
  assignmentMeta: Record<string, unknown>,
): ResolvedBillingMode {
  const realmDefaults = readNestedObject(realmMeta, ['billing_defaults', 'period']) ?? {}
  const planDefaults = readNestedObject(planMeta, ['billing_defaults', 'period']) ?? {}
  const assignmentPeriod = readNestedObject(assignmentMeta, ['billing', 'period']) ?? {}

  const readMode = (value: unknown): 'prepaid' | 'postpaid' | 'hybrid' | null => {
    const raw = readString(value)
    if (raw === 'prepaid' || raw === 'postpaid' || raw === 'hybrid') return raw
    return null
  }

  const bindingMode = readMode(assignmentPeriod.billing_mode ?? assignmentPeriod.billingMode)
  if (bindingMode) return { billingMode: bindingMode, source: 'binding' }

  const planMode = readMode(planDefaults.billing_mode ?? planDefaults.billingMode)
  if (planMode) return { billingMode: planMode, source: 'plan' }

  const realmMode = readMode(realmDefaults.billing_mode ?? realmDefaults.billingMode)
  if (realmMode) return { billingMode: realmMode, source: 'realm_default' }

  return { billingMode: 'prepaid', source: 'unknown' }
}

@Injectable()
export class BillingPeriodService {
  async resolveBillingModeForAt(
    trx: DbOrTrx,
    params: { realmId: string; billingAccountId: string; at: Date; realmMeta?: Record<string, unknown> },
  ): Promise<ResolvedBillingMode> {
    const realmMeta = params.realmMeta ?? (await trx
      .selectFrom('realms')
      .select(['metadata'])
      .where('realm_id', '=', params.realmId)
      .executeTakeFirst()
      .then((row) => (row?.metadata ?? {}) as Record<string, unknown>))

    const assignment = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .select([
        'bpa.metadata',
        sql`bpl.metadata`.as('plan_metadata'),
      ])
      .where('bpa.billing_account_id', '=', params.billingAccountId)
      .where('bpa.status', '=', 'active')
      .where('bpl.active', '=', true)
      .where('bpl.kind', 'in', ['base', 'addon'])
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', params.at),
          eb.or([eb('bpa.window_end', '>', params.at), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .orderBy('bpl.priority', 'desc')
      .orderBy('bpa.assignment_id', 'desc')
      .executeTakeFirst()

    const assignmentMeta = (assignment?.metadata ?? {}) as Record<string, unknown>
    const planMeta = ((assignment?.plan_metadata ?? {}) as Record<string, unknown>) ?? {}

    return resolveBillingModeFromMetadata(
      realmMeta as Record<string, unknown>,
      planMeta as Record<string, unknown>,
      assignmentMeta as Record<string, unknown>,
    )
  }

  async resolvePeriodForAt(
    trx: DbOrTrx,
    params: { realmId: string; billingAccountId: string; at: Date; realmMeta?: Record<string, unknown> },
  ): Promise<{
    periodStart: Date
    periodEnd: Date
    graceWindowSeconds: number
    source: BillingPeriodSource
    sourceRef: string | null
    sourceSubscriptionId: string | null
    sourcePeriodStart: Date | null
    sourcePeriodEnd: Date | null
    rule: BillingPeriodRule
  }> {
    const realmMeta = params.realmMeta ?? (await trx
      .selectFrom('realms')
      .select(['metadata'])
      .where('realm_id', '=', params.realmId)
      .executeTakeFirst()
      .then((row) => (row?.metadata ?? {}) as Record<string, unknown>))

    // Provider subscription period wins when present.
    const subscription = await trx
      .selectFrom('subscriptions')
      .select(['subscription_id', 'current_period_start', 'current_period_end'])
      .where('billing_account_id', '=', params.billingAccountId)
      .where('current_period_start', '<=', params.at)
      .where('current_period_end', '>', params.at)
      .where('status', 'in', ['trialing', 'active', 'past_due'])
      .orderBy('current_period_start', 'desc')
      .executeTakeFirst()

    const assignment = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .select([
        'bpa.assignment_id',
        'bpa.window_start',
        'bpa.metadata',
        sql`bpl.metadata`.as('plan_metadata'),
      ])
      .where('bpa.billing_account_id', '=', params.billingAccountId)
      .where('bpa.status', '=', 'active')
      .where('bpl.active', '=', true)
      .where('bpl.kind', 'in', ['base', 'addon'])
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', params.at),
          eb.or([eb('bpa.window_end', '>', params.at), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .orderBy('bpl.priority', 'desc')
      .orderBy('bpa.assignment_id', 'desc')
      .executeTakeFirst()

    const assignmentMeta = (assignment?.metadata ?? {}) as Record<string, unknown>
    const planMeta = ((assignment?.plan_metadata ?? {}) as Record<string, unknown>) ?? {}

    const rule = readPeriodRuleFromMetadata(
      (realmMeta as BillingDefaultsMetadata) as unknown as Record<string, unknown>,
      (planMeta as BillingDefaultsMetadata) as unknown as Record<string, unknown>,
      assignmentMeta,
    )

    // Canonical billing periods are always natural months (UTC); issue_anchor affects only metadata.
    const forcedRule: BillingPeriodRule = {
      ...rule,
      kind: 'calendar',
      cadence: 'monthly',
      issueAnchor: 'calendar_start',
      fixedDays: undefined,
    }
    const graceWindowSeconds = forcedRule.graceWindowSeconds

    const { start: periodStart, end: periodEnd } = computeCalendarPeriod(
      params.at,
      'monthly',
      'calendar_start',
      startOfUtcMonth(params.at),
    )

    const sourceSubscriptionId = subscription ? String(subscription.subscription_id) : null
    const sourcePeriodStart = subscription ? subscription.current_period_start : null
    const sourcePeriodEnd = subscription ? subscription.current_period_end : null

    if (subscription) {
      return {
        periodStart,
        periodEnd,
        graceWindowSeconds,
        source: 'provider.subscription',
        sourceRef: `subscription:${subscription.subscription_id}`,
        sourceSubscriptionId,
        sourcePeriodStart,
        sourcePeriodEnd,
        rule: forcedRule,
      }
    }

    const source: BillingPeriodSource = assignment ? 'binding' : 'realm_default'
    const sourceRef = assignment?.assignment_id ? `bpa:${assignment.assignment_id}` : null
    return {
      periodStart,
      periodEnd,
      graceWindowSeconds,
      source,
      sourceRef,
      sourceSubscriptionId: null,
      sourcePeriodStart: null,
      sourcePeriodEnd: null,
      rule: forcedRule,
    }
  }

  async ensureBillingPeriodInstance(
    trx: DbOrTrx,
    params: { realmId: string; billingAccountId: string; at: Date },
  ): Promise<ResolvedBillingPeriod> {
    const resolved = await this.resolvePeriodForAt(trx, params)

    const row = await trx
      .insertInto('billing_periods')
      .values({
        realm_id: params.realmId,
        billing_account_id: params.billingAccountId,
        period_start: resolved.periodStart,
        period_end: resolved.periodEnd,
        grace_window_seconds: resolved.graceWindowSeconds,
        source: resolved.source,
        source_ref: resolved.sourceRef,
        source_subscription_id: resolved.sourceSubscriptionId,
        source_period_start: resolved.sourcePeriodStart,
        source_period_end: resolved.sourcePeriodEnd,
        status: 'open',
        frozen_at: null,
        closed_at: null,
        metadata: {
          rule: {
            kind: resolved.rule.kind,
            cadence: resolved.rule.cadence,
            issue_anchor: resolved.rule.issueAnchor,
            fixed_days: resolved.rule.fixedDays,
            timezone: resolved.rule.timezone,
            grace_window_seconds: resolved.rule.graceWindowSeconds,
            billing_mode: resolved.rule.billingMode,
          },
        },
      })
      .onConflict((oc) =>
        oc
          .columns(['billing_account_id', 'period_start', 'period_end'])
          .doUpdateSet({
            grace_window_seconds: sql`excluded.grace_window_seconds`,
            source: sql`excluded.source`,
            source_ref: sql`excluded.source_ref`,
            source_subscription_id: sql`excluded.source_subscription_id`,
            source_period_start: sql`excluded.source_period_start`,
            source_period_end: sql`excluded.source_period_end`,
            metadata: sql`excluded.metadata`,
            updated_at: sql`now()`,
          }),
      )
      .returning([
        'billing_period_id',
        'period_start',
        'period_end',
        'grace_window_seconds',
        'source',
        'source_ref',
        'status',
        'frozen_at',
      ])
      .executeTakeFirstOrThrow()

    return {
      billingPeriodId: String(row.billing_period_id),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      graceWindowSeconds: row.grace_window_seconds,
      source: row.source as BillingPeriodSource,
      sourceRef: row.source_ref,
      sourceSubscriptionId: (resolved.sourceSubscriptionId ?? null) as string | null,
      sourcePeriodStart: (resolved.sourcePeriodStart ?? null) as Date | null,
      sourcePeriodEnd: (resolved.sourcePeriodEnd ?? null) as Date | null,
      rule: resolved.rule,
      status: row.status,
      frozenAt: row.frozen_at,
    }
  }

  async freezeIfDue(
    trx: DbOrTrx,
    params: { billingPeriodId: string; now?: Date },
  ): Promise<boolean> {
    const now = params.now ?? new Date()
    const row = await trx
      .selectFrom('billing_periods')
      .select(['billing_period_id', 'period_end', 'grace_window_seconds', 'status'])
      .where('billing_period_id', '=', params.billingPeriodId)
      .executeTakeFirst()
    if (!row) return false
    if (row.status !== 'open') return false

    const freezeAt = new Date(row.period_end.getTime() + row.grace_window_seconds * 1000)
    if (now.getTime() < freezeAt.getTime()) return false

    const updated = await trx
      .updateTable('billing_periods')
      .set({ status: 'frozen', frozen_at: now, updated_at: now })
      .where('billing_period_id', '=', params.billingPeriodId)
      .where('status', '=', 'open')
      .executeTakeFirst()
    return Number(updated.numUpdatedRows ?? 0) > 0
  }
}
