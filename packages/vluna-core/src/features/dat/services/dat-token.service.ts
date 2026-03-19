import { HttpException, Injectable } from '@nestjs/common'
import { createSecretKey, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { pool } from '../../../db/index.js'
import type { DatSessionGrant } from '../../../auth/policies/dat-authorization.policy.js'
import type { DatSessionClaims } from '../types/session.js'

const DEFAULT_AUDIENCE = 'vluna.dat'
const DEFAULT_ISSUER = 'vluna.dat'
const DEFAULT_TTL_SEC = 900
const MIN_TTL_SEC = 60
const MAX_TTL_SEC = 3600

@Injectable()
export class DatTokenService {
  private readonly audience = (process.env.VLUNA_DAT_TOKEN_AUDIENCE || '').trim() || DEFAULT_AUDIENCE
  private readonly issuer = (process.env.VLUNA_DAT_TOKEN_ISSUER || '').trim() || DEFAULT_ISSUER

  async issue(grant: DatSessionGrant): Promise<{ token: string; expires_at: string; expires_in: number; jti: string }> {
    const now = Math.floor(Date.now() / 1000)
    const ttl = clampTtl(grant.ttl_sec)
    const exp = now + ttl
    const jti = randomUUID()
    const subject = `${grant.subject_type}:${grant.subject_id}`

    const payload: Omit<DatSessionClaims, 'sub' | 'aud' | 'iss' | 'iat' | 'exp' | 'jti'> = {
      token_use: 'dat',
      tu: 'dat',
      edition: String(process.env.VLUNA_EDITION || 'oss'),
      subject_type: grant.subject_type,
      subject_id: grant.subject_id,
      organization_id: grant.organization_id,
      binding_type: grant.binding_type,
      allowed_realms: Array.from(new Set(grant.allowed_realms)),
      granted_scopes: Array.from(new Set(grant.granted_scopes)),
      selected_realm: grant.default_realm,
    }

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(jti)
      .setSubject(subject)
      .sign(this.signingKey())

    return {
      token,
      expires_at: new Date(exp * 1000).toISOString(),
      expires_in: ttl,
      jti,
    }
  }

  async verify(token: string): Promise<DatSessionClaims> {
    const verified = await jwtVerify(token, this.signingKey(), {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['HS256'],
    })
    const claims = verified.payload as unknown as DatSessionClaims
    if (claims.tu !== 'dat' && claims.token_use !== 'dat') {
      throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: 'token_use mismatch' }, 401)
    }
    const revoked = await pool.query('select 1 from dat_revoked_jtis where jti = $1 limit 1', [claims.jti])
    if (revoked.rowCount && revoked.rowCount > 0) {
      throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: 'token revoked' }, 401)
    }
    return claims
  }

  async revoke(jti: string, details?: { subject_id?: string; organization_id?: string; reason?: string; expires_at?: string }) {
    const normalized = String(jti || '').trim()
    if (!normalized) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'jti is required' }, 422)
    }
    await pool.query(
      `
      insert into dat_revoked_jtis (jti, token_use, subject_id, organization_id, reason, expires_at)
      values ($1, 'dat', nullif($2, ''), nullif($3, ''), nullif($4, ''), $5::timestamptz)
      on conflict (jti) do nothing
      `,
      [
        normalized,
        String(details?.subject_id || ''),
        String(details?.organization_id || ''),
        String(details?.reason || ''),
        details?.expires_at || null,
      ],
    )
  }

  private signingKey() {
    const configured = (process.env.VLUNA_DAT_TOKEN_SIGNING_KEY || process.env.BILLING_MASTER_KEY || '').trim()
    if (configured) {
      return createSecretKey(Buffer.from(configured, 'utf8'))
    }
    const env = String(process.env.NODE_ENV || '').toLowerCase()
    if (env === 'production') {
      throw new Error('VLUNA_DAT_TOKEN_SIGNING_KEY (or BILLING_MASTER_KEY) is required in production')
    }
    return createSecretKey(Buffer.from('dev-only-vluna-dat-secret', 'utf8'))
  }
}

function clampTtl(value: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : DEFAULT_TTL_SEC
  if (normalized <= 0) return DEFAULT_TTL_SEC
  return Math.min(Math.max(normalized, MIN_TTL_SEC), MAX_TTL_SEC)
}

