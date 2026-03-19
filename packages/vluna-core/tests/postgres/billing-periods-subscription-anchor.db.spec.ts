import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { db, withDatabaseConnection } from '../../src/db/index.js'
import { BillingPeriodService } from '../../src/services/billing-period.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/billing_periods_subscription_anchor.sql')
const realmId = 'realm-test'
const billingAccountId = '11111111-1111-1111-1111-111111111111'

describe('billing periods anchored to subscription period start (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false
  let seedClient: Client | null = null
  let superConn: string | undefined

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
      superConn = ctx.superuserConnectionString
      seedClient = new Client({ connectionString: superConn })
      await seedClient.connect()
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping billing periods anchored to subscription:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await seedClient?.end().catch(() => {})
    if (stop) await stop()
  })

  async function seedBaseState(params: { rule: Record<string, unknown> }): Promise<void> {
    if (!seedClient) throw new Error('seedClient unavailable')

    await seedClient.query('truncate table billing_periods cascade')
    await seedClient.query('truncate table subscriptions cascade')
    await seedClient.query('truncate table billing_plan_assignments cascade')
    await seedClient.query('truncate table billing_plans cascade')
    await seedClient.query('truncate table billing_accounts cascade')
    await seedClient.query('truncate table realms cascade')

    await seedClient.query(`insert into realms (realm_id, name, metadata) values ($1, $2, $3::jsonb)`, [
      realmId,
      'Realm Test',
      JSON.stringify({}),
    ])
    await seedClient.query(
      `insert into billing_accounts (billing_account_id, realm_id, billing_principal_id) values ($1, $2, $3)`,
      [billingAccountId, realmId, 'principal-1'],
    )

    await seedClient.query(
      `insert into billing_plans (realm_id, plan_code, name, kind, priority, active, metadata) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [realmId, 'pro', 'Pro', 'base', 100, true, JSON.stringify({})],
    )

    const planRes = await seedClient.query<{ plan_id: string }>(
      `select plan_id from billing_plans where realm_id = $1 and plan_code = $2`,
      [realmId, 'pro'],
    )
    const planId = planRes.rows[0]!.plan_id

    await seedClient.query(
      `
      insert into billing_plan_assignments (
        billing_account_id, plan_id, source_kind, source_ref, window_start, window_end, status, metadata
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        billingAccountId,
        planId,
        'provider.subscription',
        'seed:1',
        '2025-01-01T00:00:00Z',
        null,
        'active',
        JSON.stringify({ billing: { period: params.rule } }),
      ],
    )
  }

  it('derives monthly billing periods within an annual subscription', async () => {
    if (skipped) return
    if (!seedClient) return

    await seedBaseState({
      rule: {
        kind: 'calendar',
        cadence: 'monthly',
        issue_anchor: 'subscription_period_start',
        timezone: 'UTC',
        grace_window_seconds: 0,
      },
    })

    const subscriptionStart = new Date('2025-01-15T12:34:56Z')
    const subscriptionEnd = new Date('2026-01-15T12:34:56Z')
    const at = new Date('2025-03-20T00:00:00Z')

    const subRes = await seedClient.query<{ subscription_id: string }>(
      `insert into subscriptions (billing_account_id, status, current_period_start, current_period_end) values ($1, $2, $3, $4) returning subscription_id`,
      [billingAccountId, 'active', subscriptionStart.toISOString(), subscriptionEnd.toISOString()],
    )
    const subscriptionId = String(subRes.rows[0]!.subscription_id)

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const svc = new BillingPeriodService()
        const period = await svc.ensureBillingPeriodInstance(trx, { realmId, billingAccountId, at })
        expect(period.periodStart.toISOString()).toBe('2025-03-15T12:34:56.000Z')
        expect(period.periodEnd.toISOString()).toBe('2025-04-15T12:34:56.000Z')
      })
    })

    const rows = await seedClient.query<{
      period_start: Date
      period_end: Date
      source_subscription_id: string | null
      source_period_start: Date | null
      source_period_end: Date | null
    }>(
      `
      select period_start, period_end, source_subscription_id, source_period_start, source_period_end
      from billing_periods
      where billing_account_id = $1
      order by billing_period_id asc
      `,
      [billingAccountId],
    )
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0]!.period_start.toISOString()).toBe('2025-03-15T12:34:56.000Z')
    expect(rows.rows[0]!.period_end.toISOString()).toBe('2025-04-15T12:34:56.000Z')
    expect(String(rows.rows[0]!.source_subscription_id)).toBe(subscriptionId)
    expect(rows.rows[0]!.source_period_start?.toISOString()).toBe(subscriptionStart.toISOString())
    expect(rows.rows[0]!.source_period_end?.toISOString()).toBe(subscriptionEnd.toISOString())
  })

  it('clamps <1 month subscriptions into a single short billing period', async () => {
    if (skipped) return
    if (!seedClient) return

    await seedBaseState({
      rule: {
        kind: 'calendar',
        cadence: 'monthly',
        issue_anchor: 'subscription_period_start',
        timezone: 'UTC',
        grace_window_seconds: 0,
      },
    })

    const subscriptionStart = new Date('2025-02-01T00:00:00Z')
    const subscriptionEnd = new Date('2025-02-08T00:00:00Z')
    const at = new Date('2025-02-03T00:00:00Z')

    await seedClient.query(
      `insert into subscriptions (billing_account_id, status, current_period_start, current_period_end) values ($1, $2, $3, $4)`,
      [billingAccountId, 'active', subscriptionStart.toISOString(), subscriptionEnd.toISOString()],
    )

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const svc = new BillingPeriodService()
        const period = await svc.ensureBillingPeriodInstance(trx, { realmId, billingAccountId, at })
        expect(period.periodStart.toISOString()).toBe(subscriptionStart.toISOString())
        expect(period.periodEnd.toISOString()).toBe(subscriptionEnd.toISOString())
      })
    })
  })

  it('clamps the last period end to subscription end for non-integer months', async () => {
    if (skipped) return
    if (!seedClient) return

    await seedBaseState({
      rule: {
        kind: 'calendar',
        cadence: 'monthly',
        issue_anchor: 'subscription_period_start',
        timezone: 'UTC',
        grace_window_seconds: 0,
      },
    })

    const subscriptionStart = new Date('2025-01-15T12:34:56Z')
    const subscriptionEnd = new Date('2025-03-01T12:34:56Z') // ~45 days
    const at = new Date('2025-02-20T00:00:00Z')

    await seedClient.query(
      `insert into subscriptions (billing_account_id, status, current_period_start, current_period_end) values ($1, $2, $3, $4)`,
      [billingAccountId, 'active', subscriptionStart.toISOString(), subscriptionEnd.toISOString()],
    )

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const svc = new BillingPeriodService()
        const period = await svc.ensureBillingPeriodInstance(trx, { realmId, billingAccountId, at })
        expect(period.periodStart.toISOString()).toBe('2025-02-15T12:34:56.000Z')
        expect(period.periodEnd.toISOString()).toBe(subscriptionEnd.toISOString())
      })
    })
  })
})
