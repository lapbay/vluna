const DEFAULT_SCHEMA = 'control_plane'
const DB_SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

export function resolveDbSchema(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.VLUNA_DB_SCHEMA ?? DEFAULT_SCHEMA).trim()
  if (!raw) {
    throw new Error('[db] invalid VLUNA_DB_SCHEMA: empty value is not allowed')
  }
  if (!DB_SCHEMA_IDENTIFIER.test(raw)) {
    throw new Error(`[db] invalid VLUNA_DB_SCHEMA (must be lowercase identifier): ${raw}`)
  }
  return raw
}

export const DB_SCHEMA = resolveDbSchema()

