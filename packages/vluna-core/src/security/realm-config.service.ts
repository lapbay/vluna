import { Inject, Injectable, Optional } from '@nestjs/common'
import Stripe from 'stripe'
import type { PaymentProvider } from '../providers/payment/PaymentProvider.js'
import { createStripePaymentProvider } from '../features/billing/payment-provider.factory.js'
import { db } from '../db/index.js'
import { createStripeClient, type StripeEnv } from '../providers/stripe/client.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface RealmIssuerConfig {
  issuer: string
  audiences: string[]
  jwks_uri?: string
}

export interface RealmAuthClientsConfig {
  m2m?: { clientId: string; clientSecret?: string; resource?: string }
  web?: { clientId: string; clientSecret?: string }
}

export interface RealmAuthWebhookConfig {
  provider?: string
  signingKey?: string
  headerName?: string
}

export interface RealmAuthProfile {
  issuers: RealmIssuerConfig[]
  scopeClaim?: string
  issuerRoot?: string
  clients?: RealmAuthClientsConfig
  webhook?: RealmAuthWebhookConfig
}

export interface RealmStripeConfig {
  mode: StripeEnv
  apiKey: string
  webhookSecrets: {
    catalog?: string
  }
  publicWebhookBaseUrl?: string
}

export interface RealmStripeRuntime {
  realmId: string
  env: StripeEnv
  client: Stripe
  config: RealmStripeConfig
}

export interface RealmConfigOverride {
  getAuthProfile?: (realmId?: string | null) => Promise<RealmAuthProfile | null | undefined>
  getStripeConfig?: (realmId?: string | null) => Promise<RealmStripeConfig | null | undefined>
}

export const REALM_CONFIG_OVERRIDE = Symbol('REALM_CONFIG_OVERRIDE')

export interface RealmCurrencyOverride {
  currency: string
  xusdRate: number
}

export type RealmAccessAllowlistItem = string

type RealmClientsMetadata = {
  m2m?: { client_id?: string; client_secret?: string; resource?: string }
  web?: { client_id?: string; client_secret?: string }
}

type RealmWebhookMetadata = {
  provider?: string
  signing_key?: string
  signingKey?: string
  header_name?: string
  headerName?: string
}

type RealmStripeWebhookData =
  | string
  | {
      secret?: string
      test?: string
      live?: string
    }

interface RealmStripeMetadata {
  mode?: string
  env?: string
  api_key?: string
  apiKey?: string
  test_api_key?: string
  live_api_key?: string
  api_keys?: Partial<Record<StripeEnv, string>>
  apiKeys?: Partial<Record<StripeEnv, string>>
  webhook?: { catalog?: RealmStripeWebhookData }
  webhooks?: Array<{
    name?: string
    secret?: string
    test?: string
    live?: string
    url?: string
  }>
  public_webhook_base_url?: string
  publicWebhookBaseUrl?: string
}
type NormalizedWebhook = { name: string; secret?: string; test?: string; live?: string; url?: string }

type RealmMetadata = {
  auth?: {
    issuers?: Array<{ issuer?: string; audiences?: string[]; jwks_uri?: string }>
    scope_claim?: string
    scopeClaim?: string
    issuer_root?: string
    issuerRoot?: string
    clients?: RealmClientsMetadata
    webhook?: RealmWebhookMetadata
  }
  payments?: {
    provider?: string
    stripe?: RealmStripeMetadata
  }
  currencies?: Array<{
    currency?: string
    xusd_rate?: number
    xusdRate?: number
  }>
}

@Injectable()
export class RealmConfigService {
  private metadataCache = new Map<string, RealmMetadata | null>()
  private authCache = new Map<string, RealmAuthProfile | null>()
  private statusCache = new Map<string, RealmRowStatus | null>()
  private stripeRuntimeCache = new Map<string, RealmStripeRuntime>()
  private providerCache = new Map<string, PaymentProvider>()

  constructor(@Optional() @Inject(REALM_CONFIG_OVERRIDE) private readonly override?: RealmConfigOverride) {}

  async getBillingDefaultsPeriod(realmId?: string | null): Promise<Record<string, unknown> | null> {
    const metadata = await this.loadMetadata(realmId)
    if (!isRecord(metadata)) return null
    const billingDefaults = (metadata as Record<string, unknown>).billing_defaults ?? (metadata as Record<string, unknown>).billingDefaults
    if (!isRecord(billingDefaults)) return null
    const period = billingDefaults.period
    return isRecord(period) ? period : null
  }

  async getRealmAccessAllowlist(realmId?: string | null): Promise<RealmAccessAllowlistItem[]> {
    const metadata = await this.loadMetadata(realmId)
    if (!isRecord(metadata)) return []
    const input =
      (metadata as Record<string, unknown>).realm_access_allowlist ??
      (metadata as Record<string, unknown>).realmAccessAllowlist
    if (!Array.isArray(input)) return []
    return Array.from(
      new Set(
        input
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      ),
    )
  }

  async getAuthProfile(realmId?: string | null): Promise<RealmAuthProfile | null> {
    if (this.override?.getAuthProfile) {
      const overridden = await this.override.getAuthProfile(realmId)
      if (overridden !== undefined) return overridden ?? null
    }
    const metadata = await this.loadMetadata(realmId)
    const cacheKey = this.normalizeRealmId(realmId)
    if (cacheKey && this.authCache.has(cacheKey)) {
      return this.authCache.get(cacheKey) ?? null
    }
    const profile = this.parseAuthMetadata(metadata)
    if (cacheKey) this.authCache.set(cacheKey, profile ?? null)
    return profile ?? null
  }

  async getRealmStatus(realmId?: string | null): Promise<RealmRowStatus> {
    const normalizedRealm = this.normalizeRealmId(realmId)
    if (!normalizedRealm) {
      throw new Error('realm_id_missing')
    }
    if (this.statusCache.has(normalizedRealm)) {
      const cached = this.statusCache.get(normalizedRealm)
      if (!cached) {
        throw Object.assign(new Error('realm_not_found'), { code: 'realm_not_found' })
      }
      return cached
    }
    await this.loadMetadata(normalizedRealm)
    const cached = this.statusCache.get(normalizedRealm)
    if (!cached) {
      throw Object.assign(new Error('realm_not_found'), { code: 'realm_not_found' })
    }
    return cached
  }

  async getStripeConfig(realmId?: string | null): Promise<RealmStripeConfig> {
    if (this.override?.getStripeConfig) {
      const overridden = await this.override.getStripeConfig(realmId)
      if (overridden !== undefined) {
        if (overridden) return overridden
        throw Object.assign(new Error('stripe_config_missing'), { code: 'stripe_config_missing' })
      }
    }
    const metadata = await this.loadMetadata(realmId)
    const config = this.parseStripeMetadata(metadata?.payments?.stripe)
    if (!config) {
      throw Object.assign(new Error('stripe_config_missing'), { code: 'stripe_config_missing' })
    }
    return config
  }

  async getCurrencyOverrides(realmId?: string | null): Promise<RealmCurrencyOverride[]> {
    const metadata = await this.loadMetadata(realmId)
    return this.parseCurrencyOverrides(metadata)
  }

  async getStripeRuntime(realmId?: string | null): Promise<RealmStripeRuntime> {
    const normalizedRealm = this.normalizeRealmId(realmId)
    if (!normalizedRealm) {
      throw new Error('realm_id_missing')
    }
    const config = await this.getStripeConfig(normalizedRealm)
    const cacheKey = `${normalizedRealm}:${config.mode}`
    const cached = this.stripeRuntimeCache.get(cacheKey)
    if (cached) {
      return cached
    }
    const client = createStripeClient({ env: config.mode, apiKey: config.apiKey })
    const runtime: RealmStripeRuntime = { realmId: normalizedRealm, env: config.mode, client, config }
    this.stripeRuntimeCache.set(cacheKey, runtime)
    return runtime
  }

  async getPaymentProvider(realmId?: string | null): Promise<PaymentProvider> {
    const normalizedRealm = this.normalizeRealmId(realmId)
    if (!normalizedRealm) {
      throw new Error('realm_id_missing')
    }
    const cached = this.providerCache.get(normalizedRealm)
    if (cached) return cached

    const metadata = await this.loadMetadata(normalizedRealm)
    const providerIdRaw = metadata?.payments?.provider
    const providerId = typeof providerIdRaw === 'string' ? providerIdRaw.trim().toLowerCase() : 'stripe'

    let provider: PaymentProvider | null = null
    if (!providerId || providerId === 'stripe') {
      provider = createStripePaymentProvider(this)
    } else {
      throw new Error(`payment_provider_unsupported:${providerId}`)
    }

    this.providerCache.set(normalizedRealm, provider)
    return provider
  }

  clearCache(realmId?: string): void {
    if (realmId) {
      const normalized = this.normalizeRealmId(realmId)
      if (!normalized) return
      this.metadataCache.delete(normalized)
      this.authCache.delete(normalized)
      this.statusCache.delete(normalized)
      this.providerCache.delete(normalized)
      for (const key of this.stripeRuntimeCache.keys()) {
        if (key.startsWith(`${normalized}:`)) this.stripeRuntimeCache.delete(key)
      }
      return
    }
    this.metadataCache.clear()
    this.authCache.clear()
    this.statusCache.clear()
    this.providerCache.clear()
    this.stripeRuntimeCache.clear()
  }

  private normalizeRealmId(realmId?: string | null): string | null {
    const value = (realmId || '').trim()
    return value.length > 0 ? value : null
  }

  private async loadMetadata(realmId?: string | null): Promise<RealmMetadata | null> {
    const normalizedRealm = this.normalizeRealmId(realmId)
    if (!normalizedRealm) {
      throw new Error('realm_id_missing')
    }
    if (this.metadataCache.has(normalizedRealm)) {
      return this.metadataCache.get(normalizedRealm) ?? null
    }
    const row = await db()
      .selectFrom('realms')
      .select(['metadata', 'status'])
      .where('realm_id', '=', normalizedRealm)
      .executeTakeFirst()
    if (!row) {
      this.metadataCache.set(normalizedRealm, null)
      this.statusCache.set(normalizedRealm, null)
      throw Object.assign(new Error('realm_not_found'), { code: 'realm_not_found' })
    }
    const metadata = (row.metadata ?? null) as RealmMetadata | null
    const status = (row.status ?? 'active') as RealmRowStatus
    this.metadataCache.set(normalizedRealm, metadata)
    this.statusCache.set(normalizedRealm, status)
    return metadata
  }

  private parseAuthMetadata(metadata?: RealmMetadata | null): RealmAuthProfile | null {
    if (!metadata || typeof metadata !== 'object') return null
    const authMeta = metadata.auth || {}
    const issuers = authMeta.issuers
    if (!Array.isArray(issuers) || issuers.length === 0) return null
    const parsed: RealmIssuerConfig[] = []
    for (const entry of issuers) {
      const issuer = String(entry?.issuer || '').trim()
      if (!issuer) continue
      const audiences = Array.isArray(entry?.audiences)
        ? entry.audiences.map((aud) => String(aud || '').trim()).filter((aud) => aud.length > 0)
        : []
      if (audiences.length === 0) continue
      const jwks_uri = entry?.jwks_uri ? String(entry.jwks_uri).trim() || undefined : undefined
      parsed.push({ issuer: this.normalizeIssuer(issuer), audiences, jwks_uri })
    }
    if (parsed.length === 0) return null
    const scopeClaimRaw = authMeta.scope_claim ?? authMeta.scopeClaim
    const scopeClaim = typeof scopeClaimRaw === 'string' ? scopeClaimRaw.trim() : undefined
    const issuerRootRaw = authMeta.issuer_root ?? authMeta.issuerRoot
    const issuerRoot = typeof issuerRootRaw === 'string' ? issuerRootRaw.trim().replace(/\/$/, '') : undefined
    const clients = this.parseClients(authMeta.clients)
    const webhook = this.parseWebhook(authMeta.webhook)
    return { issuers: parsed, scopeClaim: scopeClaim || undefined, issuerRoot, clients, webhook }
  }

  private parseClients(input?: RealmClientsMetadata): RealmAuthClientsConfig | undefined {
    if (!input || typeof input !== 'object') return undefined
    const clients: RealmAuthClientsConfig = {}
    const m2m = input.m2m
    if (m2m) {
      const clientId = String(m2m.client_id || '').trim()
      const clientSecret = typeof m2m.client_secret === 'string' ? m2m.client_secret : undefined
      const resource = typeof m2m.resource === 'string' ? m2m.resource : undefined
      if (clientId) clients.m2m = { clientId, clientSecret, resource }
    }
    const web = input.web
    if (web) {
      const clientId = String(web.client_id || '').trim()
      const clientSecret = typeof web.client_secret === 'string' ? web.client_secret : undefined
      if (clientId) clients.web = { clientId, clientSecret }
    }
    return Object.keys(clients).length > 0 ? clients : undefined
  }

  private parseWebhook(input?: RealmWebhookMetadata): RealmAuthWebhookConfig | undefined {
    if (!input || typeof input !== 'object') return undefined
    const provider = String(input.provider || '').trim() || undefined
    const signingKeyRaw = input.signing_key ?? input.signingKey
    const signingKey = typeof signingKeyRaw === 'string' ? signingKeyRaw : undefined
    const headerRaw = input.header_name ?? input.headerName
    const headerName = typeof headerRaw === 'string' ? headerRaw : undefined
    if (!provider && !signingKey && !headerName) return undefined
    return { provider, signingKey, headerName }
  }

  private parseStripeMetadata(input?: RealmStripeMetadata | null): RealmStripeConfig | null {
    if (!input || typeof input !== 'object') return null
    const mode = this.normalizeStripeMode(input.mode ?? input.env ?? 'test')
    const apiKey = this.pickStripeApiKey(input, mode)
    if (!apiKey) return null
    const publicWebhookBaseUrl = this.normalizeBaseUrl(input.public_webhook_base_url ?? input.publicWebhookBaseUrl)
    const webhookSecrets: { catalog?: string } = {}
    const webhooks = this.normalizeStripeWebhooks(input)
    const catalog = webhooks.find((w) => w.name === 'catalog') || webhooks[0]
    const catalogSecret = this.pickWebhookSecret(
      catalog ? { secret: catalog.secret, test: catalog.test, live: catalog.live } : undefined,
      mode,
    )
    if (catalogSecret) {
      webhookSecrets.catalog = catalogSecret
    }
    return { mode, apiKey, webhookSecrets, publicWebhookBaseUrl }
  }

  private pickStripeApiKey(meta: RealmStripeMetadata, mode: StripeEnv): string | null {
    const direct = meta.api_key ?? meta.apiKey
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const legacy = mode === 'live' ? meta.live_api_key : meta.test_api_key
    if (typeof legacy === 'string' && legacy.trim()) return legacy.trim()
    const viaMap = meta.api_keys ?? meta.apiKeys
    const keyed = viaMap?.[mode]
    if (typeof keyed === 'string' && keyed.trim()) return keyed.trim()
    return null
  }

  private pickWebhookSecret(data: RealmStripeWebhookData | undefined, mode: StripeEnv): string | undefined {
    if (!data) return undefined
    if (typeof data === 'string') return data.trim() || undefined
    const specific = mode === 'live' ? data.live : data.test
    if (typeof specific === 'string' && specific.trim()) return specific.trim()
    if (typeof data.secret === 'string' && data.secret.trim()) return data.secret.trim()
    return undefined
  }

  private normalizeStripeWebhooks(meta: RealmStripeMetadata): NormalizedWebhook[] {
    if (Array.isArray(meta.webhooks)) {
      return meta.webhooks
        .map((w) => ({
          name: (w?.name || '').trim() || 'default',
          secret: w?.secret,
          test: w?.test,
          live: w?.live,
          url: w?.url,
        }))
        .filter((w) => w.name.length > 0)
    }
    const legacy = meta.webhook?.catalog
    if (legacy) {
      if (typeof legacy === 'string') return [{ name: 'catalog', secret: legacy }]
      return [{ name: 'catalog', secret: legacy.secret, test: legacy.test, live: legacy.live }]
    }
    return []
  }

  private normalizeStripeMode(value?: string | null): StripeEnv {
    return String(value || 'test').toLowerCase() === 'live' ? 'live' : 'test'
  }

  private normalizeBaseUrl(value?: string | null): string | undefined {
    if (!value || typeof value !== 'string') return undefined
    const trimmed = value.trim().replace(/\/$/, '')
    return trimmed.length > 0 ? trimmed : undefined
  }

  private normalizeIssuer(value: string): string {
    return value.replace(/\/$/, '')
  }

  private parseCurrencyOverrides(metadata?: RealmMetadata | null): RealmCurrencyOverride[] {
    if (!metadata || typeof metadata !== 'object') return []
    const raw = metadata.currencies
    if (!Array.isArray(raw) || raw.length === 0) return []
    const entries: RealmCurrencyOverride[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (!isRecord(item)) continue
      const currencyRaw = typeof item.currency === 'string' ? item.currency : ''
      const currency = this.normalizeCurrencyCode(currencyRaw)
      if (!currency) continue
      const rateRaw = item.xusd_rate ?? item.xusdRate
      const rate = typeof rateRaw === 'number' ? rateRaw : Number(rateRaw)
      if (!Number.isFinite(rate) || rate <= 0) continue
      if (currency === 'USD' || currency === 'XUSD') continue
      if (seen.has(currency)) continue
      seen.add(currency)
      entries.push({ currency, xusdRate: rate })
    }
    return entries
  }

  private normalizeCurrencyCode(input?: string | null): string | null {
    const raw = String(input || '').trim().toUpperCase()
    if (!raw) return null
    if (!/^[A-Z0-9_-]{2,10}$/.test(raw)) return null
    return raw
  }
}

type RealmRowStatus = 'active' | 'suspended' | 'deleted'
