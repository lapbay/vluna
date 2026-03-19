import { Injectable, Logger } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import type { Database } from '../types/database.js'
import type { Kysely, Transaction } from 'kysely'
import {
  coerceStringArray,
  deriveSecret,
  DerivedServiceApiKey,
  parseMasterKey,
  ServiceApiKeyError,
  ServiceApiKeyRow,
  SupportedKdfAlgorithm,
} from './service-api-key.helpers.js'
import { getServiceApiKeyRegistry, setServiceApiKeyRegistry } from './service-api-key.store.js'

export interface RealmTokenSecret {
  secret: Buffer
  keyId: string
  version: number
}

export const DEFAULT_SERVICE_API_KEY_PREFIX = 'pk-'

function randomAlphaNumericString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  if (length <= 0) return ''
  const out: string[] = []
  while (out.length < length) {
    const bytes = randomBytes(Math.max(8, length))
    for (const b of bytes) {
      // Rejection sampling to avoid modulo bias.
      // 62 * 4 = 248 is the largest multiple of 62 < 256.
      if (b >= 248) continue
      out.push(alphabet[b % 62])
      if (out.length === length) break
    }
  }
  return out.join('')
}

function createServiceApiKeyId(): string {
  return `${DEFAULT_SERVICE_API_KEY_PREFIX}${randomAlphaNumericString(16)}`
}

@Injectable()
export class ServiceApiKeyService {
  private readonly logger = new Logger(ServiceApiKeyService.name)
  private readonly length = 32
  private masterKey: Buffer | null = null
  private cache: Map<string, DerivedServiceApiKey> = new Map()
  private realmSecretCache: Map<string, RealmTokenSecret> = new Map()

  constructor() {
    try {
      this.masterKey = parseMasterKey(process.env.BILLING_MASTER_KEY)
    } catch (error) {
      if (error instanceof ServiceApiKeyError) {
        this.logger.warn(error.message)
      } else {
        this.logger.warn('Failed to parse BILLING_MASTER_KEY at startup')
      }
    }
  }

  async loadSecrets(trx?: Kysely<Database>): Promise<ReadonlyMap<string, DerivedServiceApiKey>> {
    const database = trx ?? db()
    const masterKey = this.ensureMasterKey()
    const rows = await database.selectFrom('service_api_keys').selectAll().execute()
    const next = new Map<string, DerivedServiceApiKey>()

    for (const row of rows) {
      try {
        const derived = this.deriveForRow(row, masterKey)
        next.set(derived.keyId, derived)
      } catch (error) {
        this.logger.error(`Failed to derive secret for service API key ${row.key_id}`, error instanceof Error ? error.stack : String(error))
        throw error
      }
    }

    this.cache = next
    setServiceApiKeyRegistry(next)
    this.logger.log(`Loaded ${next.size} service API key${next.size === 1 ? '' : 's'} into memory`)
    return getServiceApiKeyRegistry()
  }

  getRegistry(): ReadonlyMap<string, DerivedServiceApiKey> {
    if (this.cache.size === 0) {
      return getServiceApiKeyRegistry()
    }
    return this.cache
  }

  getKey(keyId: string): DerivedServiceApiKey | undefined {
    return this.getRegistry().get(keyId)
  }

  getPlatformTokenSecret(realmId: string, options?: { flavor?: 'plt' | 'apt'; version?: number }): RealmTokenSecret {
    const normalized = realmId.trim()
    if (!normalized) {
      throw new ServiceApiKeyError('realm_id is required to derive token secret')
    }
    const flavor = options?.flavor === 'apt' ? 'apt' : 'plt'
    const version = options?.version ?? Number(process.env.VLUNA_PLATFORM_TOKEN_VERSION || '1')
    const cacheKey = `${flavor}:v${version}:realm:${normalized}`
    const cached = this.realmSecretCache.get(cacheKey)
    if (cached) return cached
    const masterKey = this.ensureMasterKey()
    const salt = createHash('sha256').update(`${flavor === 'apt' ? 'vluna' : 'platform'}-token:${normalized}:v${version}`).digest()
    const secret = deriveSecret({
      algorithm: 'HKDF-SHA256',
      masterKey,
      salt,
      keyId: cacheKey,
      envTag: process.env.NODE_ENV || 'local',
      kdfVersion: version,
      length: this.length,
    })
    const entry: RealmTokenSecret = { secret, keyId: cacheKey, version }
    this.realmSecretCache.set(cacheKey, entry)
    return entry
  }

  static async createServiceApiKey(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    options: { expiresAt?: Date | null } = {},
  ): Promise<string> {
    const normalizedRealm = realmId.trim()
    if (!normalizedRealm) {
      throw new ServiceApiKeyError('realm_id is required to create a service API key')
    }
    const expiresAt = options.expiresAt ?? null

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const keyId = createServiceApiKeyId()
      await trx
        .insertInto('service_api_keys')
        .values({
          key_id: keyId,
          status: 'active',
          allowed_realms: [normalizedRealm],
          allowed_accounts: [],
          scopes: [],
          kdf_alg: 'HKDF-SHA256',
          kdf_salt: randomBytes(32),
          kdf_version: 1,
          env_tag: process.env.NODE_ENV || 'local',
          expires_at: expiresAt,
          last_used_at: null,
        })
        .onConflict((oc) => oc.column('key_id').doNothing())
        .executeTakeFirst()

      const created = await trx
        .selectFrom('service_api_keys')
        .select(['key_id', 'allowed_realms'])
        .where('key_id', '=', keyId)
        .executeTakeFirst()
      if (created && created.allowed_realms.includes(normalizedRealm)) {
        return keyId
      }
    }

    throw new ServiceApiKeyError('Failed to create service API key after multiple attempts')
  }

  private ensureMasterKey(): Buffer {
    if (!this.masterKey) {
      this.masterKey = parseMasterKey(process.env.BILLING_MASTER_KEY)
    }
    return this.masterKey
  }

  private deriveForRow(row: ServiceApiKeyRow, masterKey: Buffer): DerivedServiceApiKey {
    if (!Buffer.isBuffer(row.kdf_salt)) {
      throw new ServiceApiKeyError(`service_api_keys.kdf_salt must be a bytea for key ${row.key_id}`)
    }

    const algorithm = normalizeAlgorithm(row.kdf_alg)
    const secret = deriveSecret({
      algorithm,
      masterKey,
      salt: row.kdf_salt,
      keyId: row.key_id,
      envTag: row.env_tag,
      kdfVersion: row.kdf_version,
      length: this.length,
    })

    return {
      keyId: row.key_id,
      status: row.status,
      allowedRealms: coerceStringArray(row.allowed_realms),
      allowedAccounts: coerceStringArray(row.allowed_accounts),
      scopes: coerceStringArray(row.scopes),
      kdfAlgorithm: algorithm,
      kdfVersion: row.kdf_version,
      envTag: row.env_tag,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null,
      lastUsedAt: row.last_used_at ?? null,
      secret,
      secretBase64: secret.toString('base64'),
      secretHex: secret.toString('hex'),
    }
  }
}

function normalizeAlgorithm(value: ServiceApiKeyRow['kdf_alg']): SupportedKdfAlgorithm {
  const normalized = (value || '').toUpperCase()
  if (normalized === 'HMAC-SHA256' || normalized === 'HKDF-SHA256') {
    return normalized
  }
  throw new ServiceApiKeyError(`Unsupported service_api_keys.kdf_alg: ${value}`)
}
