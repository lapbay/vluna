import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { db } from '../../db/index.js'
/* eslint-disable @typescript-eslint/no-explicit-any -- this file handles loose file payloads */

export type Principal = { id: string; type?: string }

type ClaimRule = { when: string; principal: { id: string; type?: string } }
type IssuerConf = {
  issuer: string
  jwks_uri?: string
  audiences?: string[]
  alg_whitelist?: string[]
  claim_rules: ClaimRule[]
  on_missing?: 'reject' | 'use_sub' | 'delegate_to_s2s'
}
type ScopeConf = { issuers: IssuerConf[] }
type ResolverConfig = {
  principal_resolver: {
    default: ScopeConf
    realms?: { id: string; inherit?: string; issuers?: IssuerConf[] }[]
  }
}

export type ResolveCtx = { realmId?: string }

export class PrincipalResolver {
  private cfg: ResolverConfig
  constructor(cfg: ResolverConfig) {
    this.cfg = cfg
  }

  static fromFile(filePath?: string): PrincipalResolver {
    const p = filePath || path.join(process.cwd(), 'config/principal_resolver.yaml')
    const raw = fs.readFileSync(p, 'utf8')
    const cfg = YAML.parse(raw) as ResolverConfig
    return new PrincipalResolver(cfg)
  }

  private norm(s: string | undefined): string {
    return String(s || '').replace(/\/$/, '')
  }

  private pickScope(ctx: ResolveCtx): ScopeConf {
    const pr = this.cfg.principal_resolver
    if (pr.realms && ctx.realmId) {
      const r = pr.realms.find(x => x.id === ctx.realmId)
      if (r) {
        if (r.issuers?.length) return { issuers: r.issuers }
        if (r.inherit === 'default') return pr.default
      }
    }
    return pr.default
  }

  private evalPresence(expr: string, claims: any): boolean {
    const m = expr.match(/^\s*has\(\s*['\"]([^'\"]+)['\"]\s*\)\s*$/)
    if (!m) return false
    const path = m[1]
    return this.jsonPathExists(path, claims)
  }

  private jsonPointerGet(ptr: string, obj: any): any {
    if (!ptr) return undefined
    if (ptr.startsWith('$/') || ptr.startsWith('$.')) ptr = ptr.slice(2)
    if (ptr.startsWith('/')) ptr = ptr.slice(1)
    const parts = ptr.split(/[\./]/).filter(Boolean)
    let cur: any = obj
    for (const k of parts) {
      if (cur == null) return undefined
      cur = cur[k]
    }
    return cur
  }

  private jsonPathExists(pathExpr: string, obj: any): boolean {
    const val = this.jsonPointerGet(pathExpr.startsWith('$.') ? pathExpr : '$.' + pathExpr, obj)
    return val !== undefined && val !== null && !(typeof val === 'string' && val.length === 0)
  }

  resolve(ctx: ResolveCtx, tokenClaims: any): Principal {
    const scope = this.pickScope(ctx)
    const iss = this.norm(tokenClaims?.iss)
    const issuerConf = scope.issuers.find(i => this.norm(i.issuer) === iss)
    if (!issuerConf) throw Object.assign(new Error('issuer_not_allowed'), { status: 401 })

    for (const rule of issuerConf.claim_rules || []) {
      if (this.evalPresence(rule.when, tokenClaims)) {
        const id = String(this.jsonPointerGet(rule.principal.id, tokenClaims) ?? '')
        if (!id) break
        return {
          id,
          type: rule.principal.type || 'unknown',
        }
      }
    }
    const mode = issuerConf.on_missing || 'reject'
    switch (mode) {
      case 'use_sub':
        return { id: String(tokenClaims?.sub || ''), type: 'user' }
      case 'delegate_to_s2s':
        throw Object.assign(new Error('principal_not_resolvable_use_s2s'), { status: 409 })
      case 'reject':
      default:
        throw Object.assign(new Error('principal_not_resolvable'), { status: 422 })
    }
  }
}

type DbResolverCacheEntry = { resolver: PrincipalResolver | null; expiresAt: number }
const DB_RESOLVER_TTL_MS = 60_000
const dbResolverCache = new Map<string, DbResolverCacheEntry>()
let fileResolverSingleton: PrincipalResolver | null = null

function getFileResolver(): PrincipalResolver {
  if (!fileResolverSingleton) fileResolverSingleton = PrincipalResolver.fromFile()
  return fileResolverSingleton
}

function buildDbResolver(input: unknown): PrincipalResolver | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const issuers = (input as { issuers?: IssuerConf[] }).issuers
  if (!Array.isArray(issuers) || issuers.length === 0) return null
  const cfg: ResolverConfig = {
    principal_resolver: {
      default: { issuers },
    },
  }
  return new PrincipalResolver(cfg)
}

async function getDbResolver(realmId?: string | null): Promise<PrincipalResolver | null> {
  const normalized = String(realmId || '').trim()
  if (!normalized) return null
  const cached = dbResolverCache.get(normalized)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.resolver

  const row = await db()
    .selectFrom('realms')
    .select(['metadata'])
    .where('realm_id', '=', normalized)
    .executeTakeFirst()

  const metadata = (row?.metadata ?? null) as Record<string, unknown> | null
  const resolver = buildDbResolver(metadata?.principal_resolver)
  dbResolverCache.set(normalized, { resolver, expiresAt: now + DB_RESOLVER_TTL_MS })
  return resolver
}

export async function resolvePrincipal(ctx: ResolveCtx, tokenClaims: any): Promise<Principal> {
  const resolver = await getDbResolver(ctx.realmId)
  if (resolver) return resolver.resolve(ctx, tokenClaims)
  return getFileResolver().resolve(ctx, tokenClaims)
}
