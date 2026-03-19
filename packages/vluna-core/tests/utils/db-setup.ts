import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropAllTables, extractPasswordFromDatabaseUri, runSqlFile, withDatabaseConnection } from '../../src/db/index.js'
import { startPostgres } from './db.js'

type DbSetupOptions = {
  /**
   * Optional superuser connection string (used for DDL/drop/grants). If omitted, uses TEST_DB_SUPERUSER_URL.
   */
  superuserUri?: string
  /**
   * App/user connection string for running the tests. Defaults to the same DB started by startPostgres.
   */
  appUri?: string
  /**
   * Extra SQL fixture files (absolute paths) to run after dropAllTables.
   */
  fixtures?: string[]
  /**
   * Whether to skip dropAllTables (useful when reusing an existing DB).
   */
  skipDropAll?: boolean
}

export type DbTestContext = {
  connectionString: string
  superuserConnectionString: string
  stop: () => Promise<void>
}

/**
 * Prepare an isolated Postgres for DB-tagged tests:
 * - starts Postgres (or uses TEST_DB_URL)
 * - optionally performs DDL/fixtures under superuser connection
 * - returns app connection string and stop hook
 */
export async function prepareDbTestContext(opts?: DbSetupOptions): Promise<DbTestContext> {
  const handle = await startPostgres()
  if ('skip' in handle && handle.skip) {
    throw new Error(`DB unavailable: ${handle.reason}`)
  }

  const baseUri = (opts?.appUri || (handle as { connectionString: string }).connectionString).trim()

  // Default superuser URI to provided value, env override, or base URI.
  const superUri = (opts?.superuserUri?.trim() || process.env.TEST_DB_SUPERUSER_URL?.trim() || baseUri)
  const appPassword = extractPasswordFromDatabaseUri(process.env.TEST_DB_URL) || 'vlunatest'

  // App URI uses vluna role with same password/host/db as base URI.
  const appUri = (() => {
    const u = new URL(baseUri)
    u.username = 'vlunatest'
    u.password = appPassword
    return u.toString()
  })()

  const fixtures = opts?.fixtures ?? []
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = path.resolve(scriptDir, '../..')
  const grantSqlPath = path.resolve(packageRoot, 'migrations/base/sql/grant_user.sql')

  const run = async () => {
    if (!opts?.skipDropAll) {
      await dropAllTables()
    }

    // Ensure role grants if password available
    if (appPassword) {
      try {
        await runSqlFile(grantSqlPath, { settings: { 'app.vluna_password': appPassword, 'app.vluna_role': 'vlunatest'  } })
      } catch (err) {
        // Non-fatal for tests; surface to caller to decide
        throw err
      }
    }

    for (const fixture of fixtures) {
      await runSqlFile(fixture)
    }
  }

  await withDatabaseConnection(superUri, run)

  return {
    connectionString: appUri,
    superuserConnectionString: superUri,
    stop: async () => {
      if ('stop' in handle && typeof handle.stop === 'function') {
        await handle.stop()
      }
    },
  }
}
