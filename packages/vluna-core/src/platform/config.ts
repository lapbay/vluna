/**
 * Simple env flag helper. Treats '1', 'true', 'yes', 'on' (case-insensitive) as true.
 */
export function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw === null) return defaultValue
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
