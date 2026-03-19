import { sql } from 'kysely'

export function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`
}

