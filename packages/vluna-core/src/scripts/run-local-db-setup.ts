import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { INestApplication } from '@nestjs/common'
import { setupDatabaseWithGuards } from '../db/setup.js'

type RunLocalDbSetupOptions = {
  app?: INestApplication
  migrationDirs?: string[]
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '../..')
const defaultMigrationDirs = [
  path.resolve(packageRoot, 'migrations/base'),
  path.resolve(packageRoot, '../../apps/app-community/migrations'),
]

export async function runLocalDbSetup(opts?: RunLocalDbSetupOptions) {
  const migrationDirs = opts?.migrationDirs || defaultMigrationDirs
  await setupDatabaseWithGuards({ migrationDirs })
}

async function main() {
  try {
    await runLocalDbSetup()
    console.log('[db] local setup complete')
  } catch (err) {
    console.error('[db] local setup failed', err)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main()
}
