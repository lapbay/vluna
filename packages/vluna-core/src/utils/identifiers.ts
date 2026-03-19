export type IdentifierKind = 'term_key' | 'feature_code' | 'meter_code'

const ALLOWED_RE = /^[a-z0-9._/@:-]+$/
const ALNUM_RE = /^[a-z0-9]$/

export function normalizeIdentifier(value: unknown, kind: IdentifierKind): string {
  if (typeof value !== 'string') {
    throw new Error(`${kind} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${kind} is required`)
  }

  const canonical = trimmed.toLowerCase()

  if (canonical.length < 1 || canonical.length > 128) {
    throw new Error(`${kind} must be 1..128 chars`)
  }
  if (!ALLOWED_RE.test(canonical)) {
    throw new Error(`${kind} must match [a-z0-9._/@:-]+`)
  }
  const first = canonical[0]
  const last = canonical[canonical.length - 1]
  if (!first || !last || !ALNUM_RE.test(first) || !ALNUM_RE.test(last)) {
    throw new Error(`${kind} must start and end with [a-z0-9]`)
  }
  return canonical
}
