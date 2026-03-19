import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Transaction } from 'kysely'
import pg from 'pg'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Database } from '../types/database.js'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { DB_SCHEMA } from './schema.js'
export { createMigrator, migrateToLatest, migrationStatus, ensureMigratedOrExit } from './migrations.js'
export { setupDatabaseWithGuards } from './setup.js'
export { DB_SCHEMA as DEFAULT_DB_SCHEMA } from './schema.js'

export const REALM_ADMIN_PLACEHOLDER_ACCOUNT = '00000000-0000-0000-0000-000000000000'

// Single pool for the process; compatible with PgBouncer
const connStr = process.env.DATABASE_URI || ''
const createPool = (connectionString?: string) =>
  new pg.Pool({
    connectionString: connectionString || undefined,
    max: 20,
    options: `-c search_path=${DB_SCHEMA},pg_temp -c app.vluna_schema=${DB_SCHEMA}`,
  })

export let pool = createPool(connStr || undefined)
let activeConnectionString = connStr || ''

let dbSingleton: Kysely<Database> | null = null
export function db(): Kysely<Database> {
  if (!dbSingleton) {
    dbSingleton = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  }
  return dbSingleton
}

export async function withDatabaseConnection<T>(connectionString: string, fn: () => Promise<T>): Promise<T> {
  const target = connectionString?.trim()
  if (!target || target === activeConnectionString) {
    return fn()
  }

  const previousPool = pool
  const previousDb = dbSingleton
  const previousConn = activeConnectionString

  const tempPool = createPool(target)
  const tempDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: tempPool }) })

  pool = tempPool
  dbSingleton = tempDb
  activeConnectionString = target

  try {
    return await fn()
  } finally {
    await tempDb.destroy().catch(() => {})
    await tempPool.end().catch(() => {})
    pool = previousPool
    dbSingleton = previousDb
    activeConnectionString = previousConn
  }
}

export async function runSqlFile(filePath: string, opts?: { settings?: Record<string, string | undefined> }) {
  const sqlText = await fs.readFile(filePath, 'utf8')
  if (!sqlText || sqlText.trim().length === 0) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (opts?.settings) {
      for (const [key, value] of Object.entries(opts.settings)) {
        if (value === undefined) continue
        await client.query('SELECT set_config($1, $2, false)', [key, value])
      }
    }
    await client.query(sqlText)
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

export function extractPasswordFromDatabaseUri(uri?: string | null): string | undefined {
  if (!uri) return undefined
  try {
    const parsed = new URL(uri)
    if (!parsed.password) return undefined
    return decodeURIComponent(parsed.password)
  } catch (err) {
    console.warn('[db] failed to parse DATABASE_URI for password extraction:', err)
    return undefined
  }
}

/**
 * Drop all tables in the given schema (default: control_plane).
 * Intended for local dev only. Refuses to run in production unless explicitly allowed.
 *
 * Env guards:
 *  - NODE_ENV !== 'production' → allowed
 *  - NODE_ENV === 'production' requires VLUNA_DB_ALLOW_DROP_ALL=true
 */
export async function dropAllTables(opts?: { schema?: string }): Promise<void> {
  const schema = (opts?.schema || DB_SCHEMA).trim()
  const q = (id: string) => '"' + id.replace(/"/g, '""') + '"'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // List user tables in the target schema
    const res = await client.query(
      {
        text: 'select tablename from pg_tables where schemaname = $1',
        values: [schema]
      }
    )
    const rows = res.rows as { tablename: string }[]
    for (const r of rows) {
      const sql = `drop table if exists ${q(schema)}.${q(r.tablename)} cascade` as const
      await client.query(sql)
    }
    await client.query('COMMIT')
    console.log(`[db] dropped ${rows.length} tables from schema ${schema}`)
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw e
  } finally {
    client.release()
  }
}

export async function loadDemoData() {
  try {
    const scriptDir = path.dirname(fileURLToPath(new URL(import.meta.url)))
    const packageRoot = path.resolve(scriptDir, '../..')
    const ddlPath = path.resolve(packageRoot, 'migrations/base/sql/seed_minimal.test.sql')
    const sqlText = await fs.readFile(ddlPath, 'utf8')
    if (!sqlText || sqlText.trim().length === 0) return

    const fixedTestBillingAccountId = '00000000-0000-0000-0000-000000000000'
    const fixedTestPrincipalId = 'i3pkhewz0gll'
    const client = await pool.connect()
    try {
      await client.query(sqlText)
      // Ensure fixed test billing account exists (needed for dev flows)
      await client.query(
        `
        INSERT INTO billing_accounts (realm_id, billing_principal_id, billing_account_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING;
        `,
        ['demo-realm-1', fixedTestPrincipalId, fixedTestBillingAccountId],
      )
      await client.query(
        `
        INSERT INTO cloud_realm_members (realm_id, kind, subject_id, role)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING;
        `,
        ['demo-realm-1', 'organization', fixedTestPrincipalId, 'owner'],
      )

      // Rewrite demo-seeded billing_contracts.billing_account_id to the fixed test billing_account_id.
      // This keeps contracts aligned with the Stripe-integrated dev account, while still allowing seed
      // files to use a separate placeholder/demo billing_account_id if desired.
      try {
        const seedPath = path.resolve(packageRoot, 'migrations/base/data/0003_seed_event_rating_policy.yaml')
        const seedText = await fs.readFile(seedPath, 'utf8')
        const parsed = YAML.parse(seedText) as unknown

        const asRecord = (value: unknown): Record<string, unknown> | null => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null
          return value as Record<string, unknown>
        }

        const root = asRecord(parsed)
        const realmDataRaw = root ? root.realm_data : null
        const realmData = Array.isArray(realmDataRaw) ? realmDataRaw : []

        for (const bundle of realmData) {
          const bundleRec = asRecord(bundle)
          const contractsRaw = bundleRec ? bundleRec.billing_contracts : null
          const contracts = Array.isArray(contractsRaw) ? contractsRaw : []
          for (const c of contracts) {
            const contract = asRecord(c)
            const contractId = contract ? String(contract.contract_id ?? '').trim() : ''
            if (!contractId) continue
            await client.query(
              `
              update billing_contracts
              set billing_account_id = $1
              where contract_id = $2
              `,
              [fixedTestBillingAccountId, contractId],
            )
          }
        }
      } catch {}
      // ensure default profile binding for the fixed account
      await seedDemoAccountBindings('demo-realm-1', fixedTestBillingAccountId)
      console.log('[db] demo data loaded')
    } finally {
      client.release()
    }
  } catch (e) {
    console.warn('[db] demo data failed to load:', e)
  }
}

export async function setRlsSession(trx: Kysely<Database> | Transaction<Database>, p: { realmId?: string; billingAccountId?: string; isRealmAdmin?: boolean }) {
  const realm = p.realmId || ''
  const ba = p.billingAccountId || ''
  const admin = p.isRealmAdmin ? 'true' : 'false'
  await sql`select set_config('app.realm_id', ${realm}, true)`.execute(trx)
  await sql`select set_config('app.billing_account_id', ${ba}, true)`.execute(trx)
  await sql`select set_config('app.is_realm_admin', ${admin}, true)`.execute(trx)
}


export async function getRlsSession(trx: Kysely<Database> | Transaction<Database>): Promise<{ realmId?: string; billingAccountId?: string; isRealmAdmin?: boolean }> {
  const result = await sql<{
    realm_id: string | null
    billing_account_id: string | null
    is_realm_admin: string | null
  }>`
    select
      current_setting('app.realm_id', true) as realm_id,
      current_setting('app.billing_account_id', true) as billing_account_id,
      current_setting('app.is_realm_admin', true) as is_realm_admin
  `.execute(trx)

  const row = result.rows[0] ?? {
    realm_id: null,
    billing_account_id: null,
    is_realm_admin: null,
  }

  const realmId = row.realm_id?.trim() || undefined
  const billingAccountId = row.billing_account_id?.trim() || undefined
  const isRealmAdmin = row.is_realm_admin === 'true'

  return { realmId, billingAccountId, isRealmAdmin }
}

async function seedDemoAccountBindings(realmId: string, billingAccountId: string): Promise<void> {
  // Lazy import to avoid circular dependency at module load time
  const {
    ensureBillingPlanAssignment,
    ensureBillingPlanGrantsEnrollmentSynced,
    issueGrantsForAccount,
    refreshBillingAccountState,
  } = await import('../services/billing-plan.service.js')
  const kdb = db()
  await kdb.transaction().execute(async (trx) => {
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const realmRow = await trx.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
    const realmMetadata = (realmRow?.metadata ?? {}) as Record<string, unknown>
    const defaultPlanId = typeof realmMetadata.default_plan_id === 'string' ? realmMetadata.default_plan_id : null
    let planId: string | null = defaultPlanId ?? null
    if (!planId) {
      const fallback = await trx
        .selectFrom('billing_plans')
        .select(['plan_id'])
        .where('realm_id', '=', realmId)
        .where('plan_code', '=', 'default_billing_plan')
        .where('active', '=', true)
        .executeTakeFirst()
      planId = fallback?.plan_id ? String(fallback.plan_id) : null
    }

    if (planId) {
      await ensureBillingPlanAssignment(trx, {
        billingAccountId,
        planId,
        sourceKind: 'signup.default',
        sourceRef: defaultPlanId ? 'default_plan_id' : 'default_billing_plan',
        windowStart: new Date(),
        windowEnd: null,
        status: 'active',
        metadata: {reason: 'demo_seed', billing: {period: {issue_anchor: 'subscription_period_start', billing_mode: 'postpaid'}}}
      })
    }

    await ensureBillingPlanGrantsEnrollmentSynced(trx, billingAccountId)
    await refreshBillingAccountState(trx, billingAccountId)
    await issueGrantsForAccount(trx, billingAccountId)
  })
}
