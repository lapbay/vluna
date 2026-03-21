import { DEFAULT_REDACTED_VALUE } from './audit.constants.js'

const GLOBAL_SENSITIVE_KEYS = new Set([
  'secret',
  'token',
  'apikey',
  'password',
  'authorization',
  'accesstoken',
  'refreshtoken',
])

export function redactAuditValue(
  value: unknown,
  options: {
    redactPaths?: string[]
    maskPaths?: string[]
  } = {},
): unknown {
  const maskPathSet = new Set((options.maskPaths ?? []).map((path) => normalizePath(path).join('.')).filter(Boolean))
  const cloned = cloneAndRedact(value, [], maskPathSet)
  for (const path of options.redactPaths ?? []) {
    const segments = normalizePath(path)
    if (segments.length === 0) continue
    applyExplicitRedaction(cloned, segments)
  }
  return cloned
}

function cloneAndRedact(value: unknown, parentPath: string[] = [], maskPathSet: Set<string> = new Set()): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => cloneAndRedact(entry, parentPath, maskPathSet))
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return DEFAULT_REDACTED_VALUE
  if (typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...parentPath, key]
    const pathKey = nextPath.join('.')
    if (maskPathSet.has(pathKey)) {
      output[key] = maskAuditString(entry)
      continue
    }
    output[key] = shouldRedactKey(key) ? DEFAULT_REDACTED_VALUE : cloneAndRedact(entry, nextPath, maskPathSet)
  }
  return output
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return GLOBAL_SENSITIVE_KEYS.has(normalized)
}

function normalizePath(path: string): string[] {
  return String(path || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function applyExplicitRedaction(value: unknown, segments: string[]) {
  if (!value || typeof value !== 'object') return
  if (segments.length === 0) return

  const [head, ...tail] = segments
  if (!(head in (value as Record<string, unknown>))) return

  if (tail.length === 0) {
    ;(value as Record<string, unknown>)[head] = DEFAULT_REDACTED_VALUE
    return
  }

  const next = (value as Record<string, unknown>)[head]
  if (Array.isArray(next)) {
    for (const item of next) {
      applyExplicitRedaction(item, tail)
    }
    return
  }
  applyExplicitRedaction(next, tail)
}

function maskAuditString(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  if (!raw) return DEFAULT_REDACTED_VALUE
  if (raw.length <= 8) return `${raw.slice(0, 1)}⋯${raw.slice(-1)}`
  return `${raw.slice(0, 4)}⋯${raw.slice(-4)}`
}
