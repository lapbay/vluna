import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { startPostgres } from '../utils/db.js'

let pgHandle: Awaited<ReturnType<typeof startPostgres>>
let client: Client | null = null
let skipSuite = false

describe('Postgres session guards', { tags: ['db'] }, () => {
  beforeAll(async () => {
    try {
      pgHandle = await startPostgres()
      if ('skip' in pgHandle) {
        skipSuite = true
        return
      }
      client = new Client({ connectionString: pgHandle.connectionString })
      await client.connect()
    } catch (err) {
      skipSuite = true
      console.warn('[db test] skipping rls smoke:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await client?.end()
    if (pgHandle && 'stop' in pgHandle) {
      await pgHandle.stop()
    }
  })

  it('accepts setting realm/billing session variables', async () => {
    if (skipSuite || !client) return
    await client.query(`select set_config('app.realm_id', 'realm_db', false)`)
    await client.query(`select set_config('app.billing_account_id', 'ba_db', false)`)
    const res = await client.query<{ realm: string | null; ba: string | null }>(
      `select current_setting('app.realm_id', true) as realm, current_setting('app.billing_account_id', true) as ba`,
    )
    expect(res.rows[0].realm).toBe('realm_db')
    expect(res.rows[0].ba).toBe('ba_db')
  })
})
