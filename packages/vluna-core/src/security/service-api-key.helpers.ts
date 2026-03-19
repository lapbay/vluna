import { createHmac, hkdfSync } from 'node:crypto'
import type { Selectable } from 'kysely'
import type { Database } from '../types/database.js'

export type SupportedKdfAlgorithm = 'HMAC-SHA256' | 'HKDF-SHA256'

export type ServiceApiKeyRow = Selectable<Database['service_api_keys']>

export interface DerivedServiceApiKey {
  keyId: string
  status: string
  allowedRealms: string[]
  allowedAccounts: string[]
  scopes: string[]
  kdfAlgorithm: SupportedKdfAlgorithm
  kdfVersion: number
  envTag: string
  createdAt: Date
  expiresAt: Date | null
  lastUsedAt: Date | null
  secret: Buffer
  secretBase64: string
  secretHex: string
}

export class ServiceApiKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceApiKeyError'
  }
}

export function parseMasterKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new ServiceApiKeyError('BILLING_MASTER_KEY is required to derive service_api_keys secrets')
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new ServiceApiKeyError('BILLING_MASTER_KEY must not be empty')
  }

  // Hex encoding
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex')
  }

  // Base64 encoding (len multiple of 4, limited charset)
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0) {
    try {
      const decoded = Buffer.from(trimmed, 'base64')
      if (decoded.length > 0) return decoded
    } catch {}
  }

  return Buffer.from(trimmed, 'utf8')
}

export function deriveSecret(params: {
  algorithm: SupportedKdfAlgorithm
  masterKey: Buffer
  salt: Buffer
  keyId: string
  envTag: string
  kdfVersion: number
  length?: number
}): Buffer {
  const length = params.length ?? 32
  if (length <= 0) {
    throw new ServiceApiKeyError('Secret length must be positive')
  }
  const info = buildInfo(params.keyId, params.envTag, params.kdfVersion)
  switch (params.algorithm) {
    case 'HKDF-SHA256': {
      const derived = hkdfSync('sha256', params.masterKey, params.salt, info, length)
      return Buffer.isBuffer(derived) ? derived : Buffer.from(derived)
    }
    case 'HMAC-SHA256': {
      const hmac = createHmac('sha256', params.masterKey)
      hmac.update(params.salt)
      hmac.update(info)
      return hmac.digest().subarray(0, length)
    }
    default:
      throw new ServiceApiKeyError(`Unsupported kdf algorithm: ${params.algorithm}`)
  }
}

export function buildInfo(keyId: string, envTag: string, kdfVersion: number): Buffer {
  const versionText = String(kdfVersion ?? '')
  const parts = [
    'tapray/billing-svc-key',
    keyId ?? '',
    envTag ?? '',
    versionText,
  ]
  const buffers: Buffer[] = []
  for (const part of parts) {
    buffers.push(Buffer.from(part, 'utf8'))
    buffers.push(Buffer.from([0x00]))
  }
  return Buffer.concat(buffers)
}

export function coerceStringArray(input: string[] | null | undefined): string[] {
  if (!input) return []
  return input.filter((value) => typeof value === 'string' && value.length > 0)
}
