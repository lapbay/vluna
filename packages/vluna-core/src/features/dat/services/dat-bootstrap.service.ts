import { HttpException, Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { pool } from '../../../db/index.js'
import type { DatBootstrapPrincipal, DatScope } from '../../../auth/policies/dat-authorization.policy.js'

type BootstrapRow = {
  token_id: string
  subject_type: string
  subject_id: string
  organization_id: string | null
  allowed_realms: string[] | null
  granted_scopes: string[] | null
  status: string
  expires_at: Date | string | null
}

@Injectable()
export class DatBootstrapService {
  async verifyBootstrapToken(token: string): Promise<DatBootstrapPrincipal> {
    const normalized = String(token || '').trim()
    if (!normalized) {
      throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'bootstrap token required' }, 401)
    }
    const tokenHash = sha256Hex(normalized)
    const result = await pool.query<BootstrapRow>(
      `
      select
        token_id,
        subject_type,
        subject_id,
        organization_id,
        allowed_realms,
        granted_scopes,
        status,
        expires_at
      from dat_bootstrap_tokens
      where token_hash = $1
      limit 1
      `,
      [tokenHash],
    )
    const row = result.rows[0]
    if (!row) {
      throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'bootstrap token not recognized' }, 401)
    }
    if (row.status !== 'active') {
      throw new HttpException({ code: 'AUTH.BOOTSTRAP_TOKEN_REVOKED', message: 'bootstrap token is not active' }, 401)
    }
    if (isExpired(row.expires_at)) {
      throw new HttpException({ code: 'AUTH.BOOTSTRAP_TOKEN_REVOKED', message: 'bootstrap token expired' }, 401)
    }

    await pool.query('update dat_bootstrap_tokens set last_used_at = now(), updated_at = now() where token_id = $1', [row.token_id])

    const scopes = normalizeScopes(row.granted_scopes)
    const allowedRealms = normalizeStringArray(row.allowed_realms)

    return {
      token_id: row.token_id,
      subject_type: 'operator',
      subject_id: String(row.subject_id || '').trim(),
      organization_id: row.organization_id ? String(row.organization_id).trim() : undefined,
      granted_scopes: scopes,
      allowed_realms: allowedRealms,
    }
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry || '').trim()).filter(Boolean)
}

function normalizeScopes(value: unknown): DatScope[] {
  const scopes = normalizeStringArray(value)
  const normalized = new Set<DatScope>()
  for (const scope of scopes) {
    if (scope === 'mcp:read' || scope === 'mcp:write') normalized.add(scope)
  }
  return Array.from(normalized)
}

function isExpired(value: Date | string | null): boolean {
  if (!value) return false
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return true
  return date.getTime() <= Date.now()
}
