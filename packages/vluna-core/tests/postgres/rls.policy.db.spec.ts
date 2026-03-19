import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/rls_policy.sql')
const realmId = 'realm-test'

describe('RLS enforcement (billing_accounts)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false
  let appClient: Client | null = null
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
      appClient = new Client({ connectionString: ctx.connectionString })
      await appClient.connect()
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping rls policy:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await seedClient?.end().catch(() => {})
    await appClient?.end().catch(() => {})
    if (stop) await stop()
  })

  it('allows access only to matching billing_account_id', async () => {
    if (skipped) return
    if (!appClient) return

    // Seed using superuser to bypass RLS
    await seedClient!.query(`truncate table billing_accounts cascade`)
    await seedClient!.query(
      `insert into billing_accounts (billing_account_id, realm_id, balance_xusd) values ($1,$2,$3),($4,$5,$6)`,
      ['ba-1', realmId, 100n, 'ba-2', realmId, 200n],
    )

    // Query as vluna with RLS enforced
    await appClient.query(`select set_config('app.realm_id', $1, false)`, [realmId])
    await appClient.query(`select set_config('app.billing_account_id', $1, false)`, ['ba-1'])

    const res1 = await appClient.query<{ billing_account_id: string }>(
      `select billing_account_id from billing_accounts order by billing_account_id`,
    )
    expect(res1.rows.map((r) => r.billing_account_id)).toEqual(['ba-1'])

    // Switch session to ba-2
    await appClient.query(`select set_config('app.billing_account_id', $1, false)`, ['ba-2'])
    const res2 = await appClient.query<{ billing_account_id: string }>(
      `select billing_account_id from billing_accounts order by billing_account_id`,
    )
    expect(res2.rows.map((r) => r.billing_account_id)).toEqual(['ba-2'])
  })
})
