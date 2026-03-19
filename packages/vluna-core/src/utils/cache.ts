// Process-level, Redis-like async cache for vluna.
// Provides a subset of Redis client methods for easy future migration.

export class ProcessCache {
  private store = new Map<string, [expiresAt: number | null, value: unknown]>()

  async get<T = unknown>(key: string): Promise<T | null> {
    const now = Date.now()
    const entry = this.store.get(key)
    if (!entry) return null
    const [expiresAt, value] = entry
    if (expiresAt !== null && expiresAt <= now) {
      this.store.delete(key)
      return null
    }
    return value as T
  }

  async set(key: string, value: unknown, ex?: number): Promise<boolean> {
    const expiresAt = typeof ex === 'number' && isFinite(ex) ? Date.now() + Math.max(0, Math.floor(ex * 1000)) : null
    this.store.set(key, [expiresAt, value])
    return true
  }

  async setex(key: string, seconds: number, value: unknown): Promise<boolean> {
    return this.set(key, value, seconds)
  }

  async delete(key: string): Promise<number> {
    const had = this.store.delete(key)
    return had ? 1 : 0
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const entry = this.store.get(key)
    if (!entry) return false
    const [, value] = entry
    const expiresAt = Date.now() + Math.max(0, Math.floor(seconds * 1000))
    this.store.set(key, [expiresAt, value])
    return true
  }

  async ttl(key: string): Promise<number> {
    const now = Date.now()
    const entry = this.store.get(key)
    if (!entry) return -2
    const [expiresAt] = entry
    if (expiresAt === null) return -1
    const remaining = Math.floor((expiresAt - now) / 1000)
    return remaining > 0 ? remaining : -2
  }

  async clear(): Promise<void> {
    this.store.clear()
  }
}

export const cache = new ProcessCache()

