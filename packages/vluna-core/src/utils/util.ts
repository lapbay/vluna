const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseUuidId(id: string | number | null | undefined): string | null {
  if (id == null) return null
  const trimmed = String(id).trim()
  if (!trimmed || !UUID_RE.test(trimmed)) return null
  return trimmed.toLowerCase()
}

// Deprecated alias; keep for compatibility with callers outside this repo.
export function parseNumericId(id: string | number | null | undefined): string | null {
  return parseUuidId(id)
}
