import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'

const filename = '20251111_03_core_events_init.sql'

export async function up(db) {
  const here = path.dirname(fileURLToPath(new URL(import.meta.url)))
  const sqlPath = path.resolve(here, 'sql', filename)
  const sqlText = await fs.readFile(sqlPath, 'utf8')
  if (!sqlText.trim()) return
  await sql.raw(sqlText).execute(db)
}

export async function down() {
  // no-op to avoid destructive rollback
}
