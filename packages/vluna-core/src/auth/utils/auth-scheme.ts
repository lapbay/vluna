export type AuthScheme = 'service' | 'bearer'

export function detectAuthScheme(authorization?: string | string[] | null): AuthScheme | undefined {
  if (!authorization) return undefined
  const raw = Array.isArray(authorization) ? authorization[0] : authorization
  if (!raw) return undefined
  const normalized = raw.trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (lower.startsWith('svc-auth ') || lower.startsWith('srv-auth ')) {
    return 'service'
  }
  if (lower.startsWith('bearer ')) {
    return 'bearer'
  }
  return undefined
}
