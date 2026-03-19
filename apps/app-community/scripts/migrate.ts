import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, pool } from '@vluna/vluna-core/db'
import { migrateToLatest, migrationStatus } from '@vluna/vluna-core/db/migrations'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const migrationDirs = [
  path.resolve(appRoot, '../../packages/vluna-core/migrations/base'),
  path.resolve(appRoot, './migrations'),
]

const command = process.argv[2]?.toLowerCase() || 'latest'

async function main() {
  if (command === 'status') {
    const migrations = await migrationStatus(db(), migrationDirs)
    migrations.forEach((m) => {
      console.log(`${m.migrationName}: ${m.status}`)
    })
    return
  }

  if (command !== 'latest') {
    throw new Error(`Unknown command "${command}". Use "latest" or "status".`)
  }

  await migrateToLatest(db(), migrationDirs)
}

main()
  .catch((err) => {
    console.error('[migrate] failed', err)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await db().destroy()
    } catch {}
    try {
      await pool.end()
    } catch {}
  })
