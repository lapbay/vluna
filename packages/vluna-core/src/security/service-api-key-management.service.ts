import { Inject, Injectable } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { ServiceApiKeyError } from './service-api-key.helpers.js'
import { ServiceApiKeyService } from './service-api-key.service.js'

export type ServiceApiKeyListItem = {
  key_id: string
  status: string
  env_tag: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}

export type ServiceApiKeyCreateResult = {
  key_id: string
  secret: string
  env_tag: string
  created_at: string
}

export type ServiceApiKeyListResult = {
  items: ServiceApiKeyListItem[]
  next_cursor: string | null
}

type ServiceApiKeyListQuery = {
  limit?: number
  cursor?: string | null
}

type ServiceApiKeyCreateInput = {
  expires_at?: string | Date | null
}

type ServiceApiKeyCursorPayload = {
  created_at: string
  key_id: string
}

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
}

function encodeCursor(payload: ServiceApiKeyCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decodeCursor(value: string): { createdAt: Date; keyId: string } {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Partial<ServiceApiKeyCursorPayload>
    const createdAtRaw = String(parsed.created_at ?? '').trim()
    const keyId = String(parsed.key_id ?? '').trim()
    if (!createdAtRaw || !keyId) {
      throw new ServiceApiKeyError('invalid cursor')
    }
    const createdAt = new Date(createdAtRaw)
    if (Number.isNaN(createdAt.getTime())) {
      throw new ServiceApiKeyError('invalid cursor timestamp')
    }
    return { createdAt, keyId }
  } catch (error) {
    if (error instanceof ServiceApiKeyError) throw error
    throw new ServiceApiKeyError('invalid cursor')
  }
}

function normalizeExpiresAt(value: ServiceApiKeyCreateInput['expires_at']): Date | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ServiceApiKeyError('expires_at must be a valid timestamp')
    return value
  }
  const raw = String(value).trim()
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new ServiceApiKeyError('expires_at must be a valid timestamp')
  }
  return parsed
}

@Injectable()
export class ServiceApiKeyManagementService {
  constructor(@Inject(ServiceApiKeyService) private readonly serviceApiKeyService: ServiceApiKeyService) {}

  async listServiceApiKeys(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    query: ServiceApiKeyListQuery = {},
  ): Promise<ServiceApiKeyListResult> {
    const normalizedRealm = realmId.trim()
    if (!normalizedRealm) {
      throw new ServiceApiKeyError('realm_id is required')
    }

    await this.ensureRealmExists(trx, normalizedRealm)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const cursorData = cursor ? decodeCursor(cursor) : null

    let builder = trx
      .selectFrom('service_api_keys')
      .select(['key_id', 'status', 'env_tag', 'created_at', 'expires_at', 'last_used_at', 'allowed_realms'])
      .where(sql<boolean>`${normalizedRealm} = any(service_api_keys.allowed_realms)`)
      .orderBy('created_at', 'desc')
      .orderBy('key_id', 'desc')

    if (cursorData) {
      builder = builder.where((eb) =>
        eb.or([
          eb('created_at', '<', cursorData.createdAt),
          eb.and([
            eb('created_at', '=', cursorData.createdAt),
            eb('key_id', '<', cursorData.keyId),
          ]),
        ]),
      )
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)

    const items = pageRows.map((row) => ({
      key_id: row.key_id,
      status: row.status,
      env_tag: row.env_tag,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    }))

    const lastRow = pageRows[pageRows.length - 1]
    const nextCursor = hasMore && lastRow
      ? encodeCursor({ created_at: lastRow.created_at.toISOString(), key_id: lastRow.key_id })
      : null

    return { items, next_cursor: nextCursor }
  }

  async createServiceApiKey(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    input: ServiceApiKeyCreateInput = {},
  ): Promise<ServiceApiKeyCreateResult> {
    const normalizedRealm = realmId.trim()
    if (!normalizedRealm) {
      throw new ServiceApiKeyError('realm_id is required')
    }

    await this.ensureRealmExists(trx, normalizedRealm)

    const expiresAt = normalizeExpiresAt(input.expires_at)
    const keyId = await ServiceApiKeyService.createServiceApiKey(trx, normalizedRealm, { expiresAt })
    const secret = await this.getServiceApiKeySecret(trx, normalizedRealm, keyId)

    const row = await trx
      .selectFrom('service_api_keys')
      .select(['created_at', 'env_tag'])
      .where('key_id', '=', keyId)
      .executeTakeFirst()

    await this.serviceApiKeyService.loadSecrets(trx)

    return {
      key_id: keyId,
      secret: secret.secretBase64,
      env_tag: row?.env_tag ?? secret.envTag,
      created_at: row?.created_at ? row.created_at.toISOString() : new Date().toISOString(),
    }
  }

  async getServiceApiKeySecret(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    keyId: string,
  ): Promise<{ keyId: string; secretBase64: string; envTag: string }> {
    const normalizedRealm = realmId.trim()
    if (!normalizedRealm) {
      throw new ServiceApiKeyError('realm_id is required')
    }
    const normalizedKey = keyId.trim()
    if (!normalizedKey) {
      throw new ServiceApiKeyError('key_id is required')
    }

    await this.ensureRealmExists(trx, normalizedRealm)
    await this.serviceApiKeyService.loadSecrets(trx)
    const key = this.serviceApiKeyService.getKey(normalizedKey)
    if (!key) {
      throw new ServiceApiKeyError(`Service API key not found: ${normalizedKey}`)
    }
    if (key.allowedRealms.length > 0 && !key.allowedRealms.includes(normalizedRealm)) {
      throw new ServiceApiKeyError(`Service API key is not authorized for realm: ${normalizedRealm}`)
    }
    return { keyId: normalizedKey, secretBase64: key.secretBase64, envTag: key.envTag }
  }

  async deleteServiceApiKey(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    keyId: string,
  ): Promise<void> {
    const normalizedRealm = realmId.trim()
    if (!normalizedRealm) {
      throw new ServiceApiKeyError('realm_id is required')
    }
    const normalizedKey = keyId.trim()
    if (!normalizedKey) {
      throw new ServiceApiKeyError('key_id is required')
    }

    await this.ensureRealmExists(trx, normalizedRealm)

    const existing = await trx
      .selectFrom('service_api_keys')
      .select(['key_id', 'allowed_realms'])
      .where('key_id', '=', normalizedKey)
      .executeTakeFirst()

    if (!existing) {
      throw new ServiceApiKeyError(`Service API key not found: ${normalizedKey}`)
    }
    if ((existing.allowed_realms ?? []).length > 0 && !existing.allowed_realms.includes(normalizedRealm)) {
      throw new ServiceApiKeyError(`Service API key is not authorized for realm: ${normalizedRealm}`)
    }

    await trx.deleteFrom('service_api_keys').where('key_id', '=', normalizedKey).execute()
    await this.serviceApiKeyService.loadSecrets(trx)
  }

  private async ensureRealmExists(trx: Kysely<Database> | Transaction<Database>, realmId: string): Promise<void> {
    const row = await trx
      .selectFrom('realms')
      .select(['realm_id'])
      .where('realm_id', '=', realmId)
      .executeTakeFirst()
    if (!row) {
      throw new ServiceApiKeyError(`Realm not found: ${realmId}`)
    }
  }
}
