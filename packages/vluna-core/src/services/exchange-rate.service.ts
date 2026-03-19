import { Inject, Injectable, Optional } from '@nestjs/common'
import { RealmConfigService } from '../security/realm-config.service.js'

type ExchangeRates = {
  base_currency: string
  rates: Record<string, number>
  provider: string
  fetched_at: string
}

type ExchangeRateQuery = {
  base?: string | null
  symbols?: string[] | null
  realmId?: string | null
}

type CacheEntry = {
  data: ExchangeRates
  expiresAt: number
}

const DEFAULT_BASE = 'USD'
const PROVIDER = 'frankfurter'
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const XUSD_PER_USD = 1_000_000
const SUPPORTED_PROVIDER_CURRENCIES = new Set([
  'XUSD',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'KRW',
  'INR',
  'SGD',
  'AUD',
  'CAD',
  'CHF',
  'BRL',
])

@Injectable()
export class ExchangeRateService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ExchangeRates>>()

  constructor(@Optional() @Inject(RealmConfigService) private readonly realmConfig?: RealmConfigService) {}

  async getRates(query: ExchangeRateQuery = {}): Promise<ExchangeRates> {
    const base = this.normalizeCurrency(query.base) ?? DEFAULT_BASE
    const symbols = this.normalizeSymbols(query.symbols)
    const overrides = await this.loadRealmOverrides(query.realmId)

    const data = await this.getRatesWithOverrides(base, overrides)
    const restricted = this.restrictCurrencies(data, overrides)
    const projected = symbols.length ? this.filterSymbols(restricted, symbols) : restricted
    return this.ensureXusdRate(projected)
  }

  private async getRatesWithOverrides(base: string, overrides: Map<string, number>): Promise<ExchangeRates> {
    if (!this.isSupportedCurrency(base) && !overrides.has(base)) {
      return this.getRatesWithOverrides(DEFAULT_BASE, overrides)
    }
    if (overrides.size === 0) {
      return base === 'XUSD'
        ? await this.getXusdBaseRates()
        : await this.getBaseRates(base)
    }

    if (overrides.has(base)) {
      return this.buildCustomBaseRates(base, overrides)
    }

    const data = base === 'XUSD'
      ? await this.getXusdBaseRates()
      : await this.getBaseRates(base)
    const merged = await this.mergeCustomRates(data, overrides)
    return merged
  }

  private async getBaseRates(base: string): Promise<ExchangeRates> {
    const cached = this.cache.get(base)
    const now = Date.now()
    if (cached && cached.expiresAt > now) {
      return cached.data
    }

    const inflight = this.inflight.get(base)
    if (inflight) return inflight

    const task = this.fetchRates(base)
      .finally(() => {
        this.inflight.delete(base)
      })
    this.inflight.set(base, task)
    const data = await task

    this.cache.set(base, {
      data,
      expiresAt: now + this.getTtlMs(),
    })
    return data
  }

  private async getXusdBaseRates(): Promise<ExchangeRates> {
    const usdRates = await this.getBaseRates(DEFAULT_BASE)
    const convertedRates: Record<string, number> = {}
    for (const [currency, rate] of Object.entries(usdRates.rates)) {
      if (!Number.isFinite(rate)) continue
      convertedRates[currency] = rate * XUSD_PER_USD
    }
    convertedRates['XUSD'] = 1
    return {
      base_currency: 'XUSD',
      rates: convertedRates,
      provider: usdRates.provider,
      fetched_at: usdRates.fetched_at,
    }
  }

  private async fetchRates(base: string): Promise<ExchangeRates> {
    const url = new URL('https://api.frankfurter.app/latest')
    url.searchParams.set('from', base)
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'vluna-exchange-rates',
      },
    })

    if (!response.ok) {
      throw new Error(`exchange rate provider error: ${response.status}`)
    }

    const payload = await response.json() as { base?: string; rates?: Record<string, number> }
    const providerBase = this.normalizeCurrency(payload.base) ?? base
    const rates: Record<string, number> = {}
    for (const [currency, value] of Object.entries(payload.rates ?? {})) {
      const normalized = this.normalizeCurrency(currency)
      if (!normalized) continue
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      rates[normalized] = 1 / numeric
    }

    rates[providerBase] = 1
    return {
      base_currency: providerBase,
      rates,
      provider: PROVIDER,
      fetched_at: new Date().toISOString(),
    }
  }

  private filterSymbols(data: ExchangeRates, symbols: string[]): ExchangeRates {
    const subset: Record<string, number> = {}
    for (const symbol of symbols) {
      if (symbol in data.rates) {
        subset[symbol] = data.rates[symbol]
      }
    }
    if (!(data.base_currency in subset) && data.base_currency in data.rates) {
      subset[data.base_currency] = data.rates[data.base_currency]
    }
    return { ...data, rates: subset }
  }

  private ensureXusdRate(data: ExchangeRates): ExchangeRates {
    const current = data.rates['XUSD']
    if (Number.isFinite(current) && (current as number) > 0) return data

    if (data.base_currency === 'XUSD') {
      return { ...data, rates: { ...data.rates, XUSD: 1 } }
    }

    const basePerUsd = data.base_currency === 'USD' ? 1 : data.rates['USD']
    if (!Number.isFinite(basePerUsd) || (basePerUsd as number) <= 0) return data

    return {
      ...data,
      rates: {
        ...data.rates,
        XUSD: (basePerUsd as number) / XUSD_PER_USD,
      },
    }
  }

  private normalizeCurrency(input?: string | null): string | null {
    const raw = String(input || '').trim().toUpperCase()
    if (!raw) return null
    if (!/^[A-Z0-9_-]{2,10}$/.test(raw)) return null
    return raw
  }

  private normalizeSymbols(input?: string[] | null): string[] {
    if (!Array.isArray(input)) return []
    const normalized = input
      .map((entry) => this.normalizeCurrency(entry))
      .filter((entry): entry is string => Boolean(entry))
    return Array.from(new Set(normalized))
  }

  private getTtlMs(): number {
    const raw = process.env.VLUNA_EXCHANGE_RATES_TTL_MS
    if (!raw) return DEFAULT_TTL_MS
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS
  }

  clearCache(): void {
    this.cache.clear()
    this.inflight.clear()
  }

  private async loadRealmOverrides(realmId?: string | null): Promise<Map<string, number>> {
    if (!realmId || !this.realmConfig) return new Map()
    const overrides = await this.realmConfig.getCurrencyOverrides(realmId)
    const mapped = new Map<string, number>()
    for (const override of overrides) {
      const currency = this.normalizeCurrency(override.currency)
      if (!currency || currency === 'USD' || currency === 'XUSD') continue
      const rate = Number(override.xusdRate)
      if (!Number.isFinite(rate) || rate <= 0) continue
      mapped.set(currency, rate)
    }
    return mapped
  }

  private async mergeCustomRates(data: ExchangeRates, overrides: Map<string, number>): Promise<ExchangeRates> {
    const base = data.base_currency
    const merged = { ...data.rates }

    if (base === 'XUSD') {
      for (const [currency, xusdRate] of overrides.entries()) {
        if (!Number.isFinite(xusdRate) || xusdRate <= 0) continue
        merged[currency] = xusdRate
      }
      return { ...data, rates: merged }
    }

    const usdRates = await this.getBaseRates(DEFAULT_BASE)
    const usdPerBase = usdRates.rates[base]
    if (!Number.isFinite(usdPerBase) || usdPerBase <= 0) return data
    const basePerUsd = 1 / usdPerBase

    for (const [currency, xusdRate] of overrides.entries()) {
      const usdPerCurrency = xusdRate / XUSD_PER_USD
      if (!Number.isFinite(usdPerCurrency) || usdPerCurrency <= 0) continue
      merged[currency] = usdPerCurrency * basePerUsd
    }
    return { ...data, rates: merged }
  }

  private async buildCustomBaseRates(base: string, overrides: Map<string, number>): Promise<ExchangeRates> {
    const baseRate = overrides.get(base)
    if (!baseRate) {
      return this.getBaseRates(DEFAULT_BASE)
    }
    const usdRates = await this.getBaseRates(DEFAULT_BASE)
    const usdPerBase = baseRate / XUSD_PER_USD
    if (!Number.isFinite(usdPerBase) || usdPerBase <= 0) {
      return this.getBaseRates(DEFAULT_BASE)
    }
    const basePerUsd = 1 / usdPerBase
    const merged: Record<string, number> = {}

    for (const [currency, usdPerCurrency] of Object.entries(usdRates.rates)) {
      if (!Number.isFinite(usdPerCurrency) || usdPerCurrency <= 0) continue
      merged[currency] = usdPerCurrency * basePerUsd
    }

    for (const [currency, xusdRate] of overrides.entries()) {
      const usdPerCurrency = xusdRate / XUSD_PER_USD
      if (!Number.isFinite(usdPerCurrency) || usdPerCurrency <= 0) continue
      merged[currency] = usdPerCurrency * basePerUsd
    }

    merged[base] = 1
    return {
      base_currency: base,
      rates: merged,
      provider: PROVIDER,
      fetched_at: usdRates.fetched_at,
    }
  }

  private restrictCurrencies(data: ExchangeRates, overrides: Map<string, number>): ExchangeRates {
    const filtered: Record<string, number> = {}
    for (const [currency, rate] of Object.entries(data.rates)) {
      if (!this.isSupportedCurrency(currency) && !overrides.has(currency)) continue
      filtered[currency] = rate
    }
    const base = this.isSupportedCurrency(data.base_currency) || overrides.has(data.base_currency)
      ? data.base_currency
      : DEFAULT_BASE
    if (base in data.rates) {
      filtered[base] = data.rates[base]
    }
    return { ...data, base_currency: base, rates: filtered }
  }

  private isSupportedCurrency(code: string): boolean {
    return SUPPORTED_PROVIDER_CURRENCIES.has(code)
  }
}
