import { createRequire } from 'node:module'
import { Client } from 'pg'

type ContainerHandle = {
  connectionString: string
  stop: () => Promise<void>
  container?: unknown
}

const DEFAULT_IMAGE = process.env.POSTGRES_IMAGE ?? 'postgres:16-alpine'
const REQUIRED_SERVER_VERSION = 160000

async function assertServerVersion(connectionString: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  const res = await client.query<{ server_version_num: string }>('show server_version_num;')
  await client.end()

  const serverVersion = Number(res.rows[0].server_version_num)
  if (Number.isNaN(serverVersion) || serverVersion < REQUIRED_SERVER_VERSION) {
    throw new Error(`Postgres 16+ required for tests (found ${res.rows[0].server_version_num ?? 'unknown'})`)
  }
}

/**
 * Start Postgres for integration tests. Honors TEST_DB_URL when provided.
 * Returns a connection string and a stop hook that is a no-op when using external DB.
 */
export async function startPostgres(): Promise<ContainerHandle | { skip: true; reason: string }> {
  const externalUrl = process.env.TEST_DB_SUPERUSER_URL || process.env.TEST_DB_URL
  if (externalUrl) {
    await assertServerVersion(externalUrl)
    return { connectionString: externalUrl, stop: async () => Promise.resolve() }
  }

  // Default to disabling Ryuk to avoid local hangs unless explicitly overridden.
  if (process.env.TESTCONTAINERS_RYUK_DISABLED === undefined) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'
  }

  const req = createRequire(import.meta.url)
  type PgContainerInstance = {
    withStartupTimeout(ms: number): PgContainerInstance
    withUsername(u: string): PgContainerInstance
    withPassword(p: string): PgContainerInstance
    withDatabase(d: string): PgContainerInstance
    start(): Promise<{ getConnectionUri(): string; stop(): Promise<void> }>
  }
  type PgContainerCtor = new (image?: string) => PgContainerInstance

  let PgCtor: PgContainerCtor | undefined
  try {
    PgCtor = req('@testcontainers/postgresql').PostgreSqlContainer as PgContainerCtor
  } catch {
    return { skip: true, reason: '@testcontainers/postgresql not installed' }
  }
  if (!PgCtor) {
    return { skip: true, reason: '@testcontainers/postgresql unavailable' }
  }

  const startTimeoutMs = Number(process.env.TESTCONTAINERS_START_TIMEOUT_MS || '30000')
  const container = await new PgCtor(DEFAULT_IMAGE)
    .withStartupTimeout(startTimeoutMs)
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    .start()

  const connectionString = container.getConnectionUri()
  await assertServerVersion(connectionString)

  return {
    connectionString,
    container,
    stop: async () => container.stop(),
  }
}
