import fs from 'node:fs/promises'
import path from 'node:path'
import { Migrator, FileMigrationProvider, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import { DB_SCHEMA } from './schema.js'

type MigrationDirs = string[]

const asUniqueAbsoluteDirs = (dirs: MigrationDirs): string[] => {
  const uniq = new Set(
    dirs
      .filter(Boolean)
      .map((d) => path.resolve(d))
  )
  return Array.from(uniq)
}

class MultiFolderMigrationProvider implements MigrationProvider {
  private readonly providers: FileMigrationProvider[]

  constructor(dirs: string[]) {
    this.providers = dirs.map(
      (dir) =>
        new FileMigrationProvider({
          fs,
          path,
          migrationFolder: dir,
        }),
    )
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const merged: Record<string, Migration> = {}
    for (const provider of this.providers) {
      const migrations = await provider.getMigrations()
      for (const [name, migration] of Object.entries(migrations)) {
        if (merged[name]) {
          throw new Error(`Duplicate migration name detected: ${name}`)
        }
        merged[name] = migration
      }
    }
    return merged
  }
}

export const createMigrator = <DB>(db: Kysely<DB>, migrationDirs: MigrationDirs) => {
  const dirs = asUniqueAbsoluteDirs(migrationDirs)
  if (dirs.length === 0) {
    throw new Error('No migration directories provided')
  }
  return new Migrator({
    db,
    provider: new MultiFolderMigrationProvider(dirs),
    migrationTableSchema: DB_SCHEMA,
  })
}

export async function migrateToLatest<DB>(db: Kysely<DB>, migrationDirs: MigrationDirs) {
  const migrator = createMigrator(db, migrationDirs)
  const result = await migrator.migrateToLatest()

  for (const m of result.results ?? []) {
    console.log(`[migrate] ${m.status?.padEnd(7)} ${m.migrationName}`)
  }

  if (result.error) {
    console.error('[migrate] failed', result.error)
    throw result.error
  }

  return result
}

export async function migrationStatus<DB>(db: Kysely<DB>, migrationDirs: MigrationDirs) {
  const migrator = createMigrator(db, migrationDirs)
  const migrations = await migrator.getMigrations()
  return migrations
}

export async function ensureMigratedOrExit<DB>(db: Kysely<DB>, migrationDirs: MigrationDirs) {
  try {
    await migrateToLatest(db, migrationDirs)
  } catch (err) {
    console.error('[migrate] fatal error, exiting', err)
    try {
      const maybeDb = db as unknown as { destroy?: () => Promise<void> }
      if (typeof maybeDb.destroy === 'function') await maybeDb.destroy()
    } catch {}
    process.exit(1)
  }
}
