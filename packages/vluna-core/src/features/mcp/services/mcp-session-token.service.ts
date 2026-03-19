import { Injectable } from '@nestjs/common'
import { createSecretKey, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { McpSessionClaims } from '../types/session.js'
import type { McpSessionGrant } from '../../../auth/policies/mcp-authorization.policy.js'

const DEFAULT_AUDIENCE = 'vluna.mcp'
const DEFAULT_ISSUER = 'vluna.mcp'
const DEFAULT_TTL_SEC = 900
const MIN_TTL_SEC = 60
const MAX_TTL_SEC = 3600

@Injectable()
export class McpSessionTokenService {
  private readonly audience = (process.env.VLUNA_MCP_TOKEN_AUDIENCE || '').trim() || DEFAULT_AUDIENCE
  private readonly issuer = (process.env.VLUNA_MCP_TOKEN_ISSUER || '').trim() || DEFAULT_ISSUER

  async issue(grant: McpSessionGrant): Promise<{ token: string; expires_at: string; expires_in: number }> {
    const now = Math.floor(Date.now() / 1000)
    const ttl = clampTtl(grant.ttl_sec)
    const exp = now + ttl
    const jti = randomUUID()
    const subject = `${grant.subject_type}:${grant.subject_id}`
    const payload: Omit<McpSessionClaims, 'sub' | 'aud' | 'iss' | 'iat' | 'exp' | 'jti'> = {
      token_use: 'mcp',
      tu: 'mcp',
      edition: String(process.env.VLUNA_EDITION || 'oss'),
      subject_type: grant.subject_type,
      subject_id: grant.subject_id,
      organization_id: grant.organization_id,
      binding_type: grant.binding_type,
      allowed_realms: Array.from(new Set(grant.allowed_realms)),
      granted_scopes: Array.from(new Set(grant.granted_scopes)),
      selected_realm: grant.default_realm,
    }

    const jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(jti)
      .setSubject(subject)

    const token = await jwt.sign(this.signingKey())
    return {
      token,
      expires_at: new Date(exp * 1000).toISOString(),
      expires_in: ttl,
    }
  }

  async verify(token: string): Promise<McpSessionClaims> {
    const result = await jwtVerify(token, this.signingKey(), {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['HS256'],
    })
    return result.payload as unknown as McpSessionClaims
  }

  async selectRealm(claims: McpSessionClaims, realmId: string): Promise<{ token: string; expires_at: string; expires_in: number }> {
    const grant: McpSessionGrant = {
      subject_type: claims.subject_type,
      subject_id: claims.subject_id,
      organization_id: claims.organization_id,
      binding_type: claims.binding_type,
      allowed_realms: claims.allowed_realms,
      granted_scopes: claims.granted_scopes,
      default_realm: realmId,
      ttl_sec: Math.max(MIN_TTL_SEC, claims.exp - Math.floor(Date.now() / 1000)),
    }
    return this.issue(grant)
  }

  private signingKey() {
    const source = (process.env.BILLING_MASTER_KEY || '').trim()
    const seed = source || 'dev-only-vluna-mcp-secret'
    return createSecretKey(Buffer.from(seed, 'utf8'))
  }
}

function clampTtl(value: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : DEFAULT_TTL_SEC
  if (normalized <= 0) return DEFAULT_TTL_SEC
  return Math.min(Math.max(normalized, MIN_TTL_SEC), MAX_TTL_SEC)
}
