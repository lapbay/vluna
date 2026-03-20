import { HttpException, Injectable } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pool } from '../../../db/index.js'

type BootstrapRow = {
  token_id: string
  token_value: string
  subject_type: string
  subject_id: string
  organization_id: string | null
  allowed_realms: string[] | null
  granted_scopes: string[] | null
  issued_by: string | null
  status: string
  expires_at: Date | string | null
  last_used_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

type BootstrapView = {
  token_id: string
  token?: string
  token_masked: string
  subject_type: string
  subject_id: string
  organization_id: string | null
  allowed_realms: string[]
  granted_scopes: string[]
  issued_by: string | null
  status: string
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  updated_at: string
}

type CreateBootstrapParams = {
  realm_id: string
  subject_id: string
  organization_id?: string
  allowed_realms?: string[]
  granted_scopes: Array<'mcp:read' | 'mcp:write'>
  issued_by?: string
  expires_at?: string
}

@Injectable()
export class DatBootstrapManagementService {
  async create(
    params: CreateBootstrapParams,
    options?: { requireAllowedRealms?: boolean; requireCurrentRealmIncluded?: boolean },
  ): Promise<BootstrapView | null> {
    const allowedRealms = normalizeStringArray(params.allowed_realms)
    const requireAllowedRealms = options?.requireAllowedRealms !== false
    const requireCurrentRealmIncluded = options?.requireCurrentRealmIncluded !== false
    if (requireAllowedRealms && !allowedRealms.length) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'allowed_realms is required' }, 422)
    }
    if (requireCurrentRealmIncluded && allowedRealms.length > 0 && !allowedRealms.includes(params.realm_id)) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'allowed_realms must include current realm' }, 403)
    }
    const scopes = Array.from(new Set(params.granted_scopes))
    if (!scopes.length) scopes.push('mcp:read')
    const tokenId = `dbt_${randomUUID().replace(/-/g, '')}`
    const secret = randomBytes(24).toString('base64url')
    const tokenValue = `datb_${tokenId}_${secret}`
    const tokenHash = sha256Hex(tokenValue)

    const result = await pool.query<BootstrapRow>(
      `
      insert into dat_bootstrap_tokens (
        token_id,
        token_hash,
        token_value,
        subject_type,
        subject_id,
        organization_id,
        allowed_realms,
        granted_scopes,
        issued_by,
        status,
        expires_at
      )
      values (
        $1, $2, $3, 'operator', $4, nullif($5, ''), $6::text[], $7::text[], nullif($8, ''), 'active', $9::timestamptz
      )
      returning *
      `,
      [
        tokenId,
        tokenHash,
        tokenValue,
        params.subject_id,
        params.organization_id || '',
        allowedRealms.length > 0 ? allowedRealms : null,
        scopes,
        params.issued_by || '',
        params.expires_at || null,
      ],
    )
    return mapBootstrapRow(result.rows[0], true)
  }

  async listForRealm(realmId: string) {
    const result = await pool.query<BootstrapRow>(
      `
      select *
      from dat_bootstrap_tokens
      where allowed_realms @> array[$1]::text[]
      order by created_at desc
      `,
      [realmId],
    )
    return result.rows.map((row) => mapBootstrapRow(row, false))
  }

  async listForSubject(subjectId: string) {
    const normalizedSubjectId = String(subjectId || '').trim()
    if (!normalizedSubjectId) return []
    const result = await pool.query<BootstrapRow>(
      `
      select *
      from dat_bootstrap_tokens
      where subject_id = $1
      order by created_at desc
      `,
      [normalizedSubjectId],
    )
    return result.rows.map((row) => mapBootstrapRow(row, false))
  }

  async revealForRealm(realmId: string, tokenId: string): Promise<{ token_id: string; token: string; token_masked: string }> {
    const id = String(tokenId || '').trim()
    if (!id) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'token_id is required' }, 422)
    }
    const result = await pool.query<Pick<BootstrapRow, 'token_id' | 'token_value'>>(
      `
      select token_id, token_value
      from dat_bootstrap_tokens
      where token_id = $1
        and allowed_realms @> array[$2]::text[]
      limit 1
      `,
      [id, realmId],
    )
    const row = result.rows[0]
    if (!row?.token_value) {
      throw new HttpException({ code: 'DAT.BOOTSTRAP_TOKEN_NOT_FOUND', message: 'bootstrap token not found' }, 404)
    }
    return {
      token_id: row.token_id,
      token: row.token_value,
      token_masked: maskToken(row.token_value),
    }
  }

  async revealForSubject(subjectId: string, tokenId: string): Promise<{ token_id: string; token: string; token_masked: string }> {
    const normalizedSubjectId = String(subjectId || '').trim()
    const id = String(tokenId || '').trim()
    if (!normalizedSubjectId) {
      throw new HttpException({ code: 'AUTH.MISSING_SUBJECT', message: 'subject_id is required' }, 401)
    }
    if (!id) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'token_id is required' }, 422)
    }
    const result = await pool.query<Pick<BootstrapRow, 'token_id' | 'token_value'>>(
      `
      select token_id, token_value
      from dat_bootstrap_tokens
      where token_id = $1
        and subject_id = $2
      limit 1
      `,
      [id, normalizedSubjectId],
    )
    const row = result.rows[0]
    if (!row?.token_value) {
      throw new HttpException({ code: 'DAT.BOOTSTRAP_TOKEN_NOT_FOUND', message: 'bootstrap token not found' }, 404)
    }
    return {
      token_id: row.token_id,
      token: row.token_value,
      token_masked: maskToken(row.token_value),
    }
  }

  async revokeForRealm(realmId: string, tokenId: string) {
    const id = String(tokenId || '').trim()
    if (!id) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'token_id is required' }, 422)
    }
    const result = await pool.query(
      `
      update dat_bootstrap_tokens
      set status = 'revoked', updated_at = now()
      where token_id = $1
        and allowed_realms @> array[$2]::text[]
      `,
      [id, realmId],
    )
    return Number(result.rowCount || 0) > 0
  }

  async revokeForSubject(subjectId: string, tokenId: string) {
    const normalizedSubjectId = String(subjectId || '').trim()
    const id = String(tokenId || '').trim()
    if (!normalizedSubjectId) {
      throw new HttpException({ code: 'AUTH.MISSING_SUBJECT', message: 'subject_id is required' }, 401)
    }
    if (!id) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'token_id is required' }, 422)
    }
    const result = await pool.query(
      `
      update dat_bootstrap_tokens
      set status = 'revoked', updated_at = now()
      where token_id = $1
        and subject_id = $2
      `,
      [id, normalizedSubjectId],
    )
    return Number(result.rowCount || 0) > 0
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry || '').trim()).filter(Boolean)
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function mapBootstrapRow(row: BootstrapRow | undefined, includeToken: boolean) {
  if (!row) return null
  const tokenValue = String(row.token_value || '')
  return {
    token_id: row.token_id,
    ...(includeToken ? { token: tokenValue } : {}),
    token_masked: maskToken(tokenValue),
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    organization_id: row.organization_id,
    allowed_realms: normalizeStringArray(row.allowed_realms),
    granted_scopes: normalizeStringArray(row.granted_scopes),
    issued_by: row.issued_by,
    status: row.status,
    expires_at: toIso(row.expires_at),
    last_used_at: toIso(row.last_used_at),
    created_at: toIso(row.created_at)!,
    updated_at: toIso(row.updated_at)!,
  }
}

function maskToken(value: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (normalized.length <= 12) return '****'
  return `${normalized.slice(0, 10)}...${normalized.slice(-4)}`
}
