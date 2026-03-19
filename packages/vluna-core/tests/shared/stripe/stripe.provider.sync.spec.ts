import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import { StripePaymentProvider } from '../../../src/providers/stripe/provider.js'
import type { ProviderOpContext } from '../../../src/providers/payment/PaymentProvider.js'
import type { RealmConfigService, RealmStripeRuntime } from '../../../src/security/realm-config.service.js'
import type { Database } from '../../../src/types/database.js'
import type { Kysely, Selectable } from 'kysely'

function makeCtx(): ProviderOpContext {
  return { traceId: 'abcd'.repeat(8), realmId: 'realm_X', db: fakeDb() }
}

function fakeDb(seed?: {
  products?: Selectable<Database['catalog_products']>[]
  prices?: Selectable<Database['catalog_prices']>[]
  groups?: Selectable<Database['subscription_groups']>[]
  realms?: Array<{ metadata: Record<string, unknown> }>
}): Kysely<Database> {
  const products: Selectable<Database['catalog_products']>[] = seed?.products ?? [
    {
      realm_id: 'realm_X',
      catalog_product_id: 'p1',
      product_code: 'pro',
      provider: 'stripe',
      provider_product_id: '',
      kind: 'subscription',
      status: 'active',
      display_priority: 100,
      presentation_config: {},
      name: 'Pro',
      default_currency: 'USD',
      metadata: {},
      created_at: new Date(),
    },
  ]
  const prices: Selectable<Database['catalog_prices']>[] = seed?.prices ?? [
    {
      realm_id: 'realm_X',
      catalog_price_id: 'pr1',
      catalog_product_id: 'p1',
      price_code: 'pro-month',
      provider_price_id: '',
      status: 'active',
      currency: 'USD',
      unit_amount: 500,
      recurring_interval: 'month',
      recurring_count: 1,
      display_priority: 1,
      metadata: null,
      subscription_group_id: null,
      subscription_group_key: null,
      created_at: new Date(),
    },
  ]
  const groups: Selectable<Database['subscription_groups']>[] = seed?.groups ?? []
  const realms = seed?.realms ?? [{ metadata: { payments: { stripe: { webhooks: [{ name: 'catalog' }] } } } }]

  let productSeq = 100
  let priceSeq = 200
  let groupSeq = 300

  const filterRows = (table: string, wheres: Array<{ col: string; op: string; val: unknown }>) => {
    let rows: unknown[] = []
    if (table === 'catalog_products') rows = products
    if (table === 'catalog_prices') rows = prices
    if (table === 'subscription_groups') rows = groups
    if (table === 'realms') rows = realms
    for (const w of wheres) {
      rows = rows.filter((r) => {
        const cur = (r as Record<string, unknown>)[w.col]
        if (w.op === '=') return String(cur) === String(w.val)
        if (w.op === 'in' && Array.isArray(w.val)) return (w.val as unknown[]).some((v) => String(v) === String(cur))
        return true
      })
    }
    return rows
  }

  return {
    selectFrom: (table: string) => {
      const wheres: Array<{ col: string; op: string; val: unknown }> = []
      const builder = {
        selectAll: () => ({
          where: (col: string, op: string, val: unknown) => {
            wheres.push({ col, op, val })
            return builder.selectAll()
          },
          execute: async () => filterRows(table, wheres),
        }),
        select: (_cols: string[]) => ({
          where: (col: string, op: string, val: unknown) => {
            wheres.push({ col, op, val })
            return {
              executeTakeFirst: async () => filterRows(table, wheres)[0],
            }
          },
        }),
      }
      return builder as unknown
    },
    insertInto: (table: string) => {
      let values: Record<string, unknown> = {}
      let returningCols: string[] = []
      const api = {
        values: (v: Record<string, unknown>) => {
          values = v
          return api
        },
        returning: (cols: string[]) => {
          returningCols = cols
          return api
        },
        executeTakeFirstOrThrow: async () => {
          if (table === 'catalog_products') {
            const id = String(productSeq++)
            products.push({ ...(values as unknown as Selectable<Database['catalog_products']>), catalog_product_id: id })
            return returningCols.includes('catalog_product_id') ? { catalog_product_id: id } : {}
          }
          if (table === 'catalog_prices') {
            const id = String(priceSeq++)
            prices.push({ ...(values as unknown as Selectable<Database['catalog_prices']>), catalog_price_id: id })
            return returningCols.includes('catalog_price_id') ? { catalog_price_id: id } : {}
          }
          if (table === 'subscription_groups') {
            const id = String(groupSeq++)
            groups.push({ ...(values as unknown as Selectable<Database['subscription_groups']>), subscription_group_id: id })
            return returningCols.includes('subscription_group_id') ? { subscription_group_id: id } : {}
          }
          return {}
        },
        execute: async () => {},
      }
      return api as unknown
    },
    updateTable: (table: string) => {
      let patch: Record<string, unknown> = {}
      let whereCol = ''
      let whereVal: unknown
      const api = {
        set: (p: Record<string, unknown>) => {
          patch = p
          return api
        },
        where: (col: string, _op: string, val: unknown) => {
          whereCol = col
          whereVal = val
          return {
            execute: async () => {
              const rows = filterRows(table, [{ col: whereCol, op: '=', val: whereVal }])
              for (const row of rows) Object.assign(row as Record<string, unknown>, patch)
            },
          }
        },
      }
      return api as unknown
    },
  } as unknown as Kysely<Database>
}

class MockStripe {
  constructor(
    private readonly seed?: {
      products?: Stripe.Product[]
      prices?: Stripe.Price[]
      webhooks?: Stripe.WebhookEndpoint[]
    },
  ) {}

  public products: Stripe.ProductsResource = {
    list: async (_: Stripe.ProductListParams) => ({ data: this.seed?.products ?? [], has_more: false }),
    create: async (p: Stripe.ProductCreateParams) => ({ id: 'prod_1', ...p } as unknown as Stripe.Product),
    update: async (_id: string, _p: Stripe.ProductUpdateParams) => ({ id: 'prod_1' } as unknown as Stripe.Product),
  } as Stripe.ProductsResource

  public prices: Stripe.PricesResource = {
    list: async (_: Stripe.PriceListParams) => ({ data: this.seed?.prices ?? [], has_more: false }),
    create: async (p: Stripe.PriceCreateParams) => ({ id: 'price_1', ...p } as unknown as Stripe.Price),
    update: async (_id: string, _p: Stripe.PriceUpdateParams) => ({ id: 'price_1' } as unknown as Stripe.Price),
  } as Stripe.PricesResource

  public webhookEndpoints: Stripe.WebhookEndpointsResource = {
    list: async (_: Stripe.WebhookEndpointListParams) => ({ data: this.seed?.webhooks ?? [] }),
    create: async (p: Stripe.WebhookEndpointCreateParams) => ({ id: 'we_1', url: p.url } as Stripe.WebhookEndpoint),
  } as Stripe.WebhookEndpointsResource
  getApiField(field: string) { return field === 'version' ? '2024-06-20' : '' }
}

describe('StripePaymentProvider.pushProductsAndPrices', { tags: ['unit'] }, () => {
  it('creates product and price when none exist', async () => {
    const mock = new MockStripe() as unknown as Stripe
    const runtime: RealmStripeRuntime = {
      realmId: 'realm_X',
      env: 'test',
      client: mock,
      config: { mode: 'test', apiKey: 'sk_test_123', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost:3001' },
    }
    const realms = {
      getStripeRuntime: async () => runtime,
    } as unknown as RealmConfigService
    const provider = new StripePaymentProvider(realms)
    const rpt = await provider.pushProductsAndPrices(makeCtx(), { dryRun: false })
    expect(rpt.counters.products.created).toBe(1)
    expect(rpt.counters.prices.created).toBe(1)
  })

  it('skips when remote product/price already matches', async () => {
    const remoteProd = {
      id: 'prod_existing',
      name: 'Pro',
      active: true,
      metadata: { catalog_product_id: 'p1', realm_id: 'realm_X' },
    } as unknown as Stripe.Product
    const remotePrice = {
      id: 'price_existing',
      product: 'prod_existing',
      currency: 'usd',
      unit_amount: 500,
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      metadata: { catalog_price_id: 'pr1' },
    } as unknown as Stripe.Price
    const mock = new MockStripe({ products: [remoteProd], prices: [remotePrice] }) as unknown as Stripe
    const runtime: RealmStripeRuntime = {
      realmId: 'realm_X',
      env: 'test',
      client: mock,
      config: { mode: 'test', apiKey: 'sk_test_123', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost:3001' },
    }
    const realms = { getStripeRuntime: async () => runtime } as unknown as RealmConfigService
    const provider = new StripePaymentProvider(realms)
    const rpt = await provider.pushProductsAndPrices(makeCtx(), { dryRun: false })
    expect(rpt.counters.products.created).toBe(0)
    expect(rpt.counters.products.skipped).toBeGreaterThanOrEqual(1)
    expect(rpt.counters.prices.created).toBe(0)
    expect(rpt.counters.prices.skipped).toBeGreaterThanOrEqual(1)
  })
})

describe('StripePaymentProvider.pullProductsAndPrices', { tags: ['unit'] }, () => {
  it('links seeded rows by product_code/price_code and merges metadata without removing local fields', async () => {
    const seededProducts: Selectable<Database['catalog_products']>[] = [
      {
        realm_id: 'realm_X',
        catalog_product_id: '101',
        product_code: 'prod_pro_001',
        provider: 'stripe',
        provider_product_id: 'prod_pro_001',
        kind: 'subscription',
        status: 'active',
        display_priority: 100,
        presentation_config: {},
        name: 'pro_plan',
        default_currency: 'USD',
        metadata: { local_only: true },
        created_at: new Date(),
      },
    ]
    const seededPrices: Selectable<Database['catalog_prices']>[] = [
      {
        realm_id: 'realm_X',
        catalog_price_id: '201',
        catalog_product_id: '101',
        price_code: 'price_pro_m_001',
        provider_price_id: 'price_pro_m_001',
        status: 'active',
        currency: 'USD',
        unit_amount: 999,
        recurring_interval: 'month',
        recurring_count: 1,
        display_priority: 10,
        metadata: { billing_plan_code: 'pro', grants: [{ grant_program_code: 'one_time_xusd' }] },
        subscription_group_id: null,
        subscription_group_key: 'base-plan',
        created_at: new Date(),
      },
    ]

    const remoteProd = {
      id: 'prod_live_1',
      name: 'Pro',
      active: true,
      livemode: false,
      metadata: { realm_id: 'realm_X', product_code: 'prod_pro_001' },
    } as unknown as Stripe.Product
    const remotePrice = {
      id: 'price_live_1',
      product: 'prod_live_1',
      currency: 'usd',
      unit_amount: 999,
      active: true,
      livemode: false,
      recurring: { interval: 'month', interval_count: 1 },
      metadata: { realm_id: 'realm_X', price_code: 'price_pro_m_001', billing_plan_code: 'pro_new', subscription_group_key: 'base-plan', display_priority: '15' },
    } as unknown as Stripe.Price

    const mock = new MockStripe({ products: [remoteProd], prices: [remotePrice] }) as unknown as Stripe
    const runtime: RealmStripeRuntime = {
      realmId: 'realm_X',
      env: 'test',
      client: mock,
      config: { mode: 'test', apiKey: 'sk_test_123', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost:3001' },
    }
    const realms = { getStripeRuntime: async () => runtime } as unknown as RealmConfigService
    const provider = new StripePaymentProvider(realms)
    const ctx: ProviderOpContext = { traceId: 'abcd'.repeat(8), realmId: 'realm_X', db: fakeDb({ products: seededProducts, prices: seededPrices }) }

    const rpt = await provider.syncProductsAndPrices(ctx, { dryRun: false, direction: 'pull' })
    expect(rpt.counters.products.updated).toBe(1)
    expect(rpt.counters.prices.updated).toBe(1)

    expect(seededProducts[0]!.provider_product_id).toBe('prod_live_1')
    expect(seededPrices[0]!.provider_price_id).toBe('price_live_1')
    expect(seededPrices[0]!.display_priority).toBe(15)
    const md = seededPrices[0]!.metadata as Record<string, unknown>
    expect(md['billing_plan_code']).toBe('pro_new')
    expect(md['grants']).toBeTruthy()
    expect(md['stripe']).toBeTruthy()
  })
})

describe('StripePaymentProvider.registerWebhooks', { tags: ['unit'] }, () => {
  it('returns existing webhook without creating', async () => {
    const existing = { id: 'we_existing', url: 'http://localhost/api/webhooks/stripe/realm_X', livemode: false } as Stripe.WebhookEndpoint
    const mock = new MockStripe({ webhooks: [existing] }) as unknown as Stripe
    const runtime: RealmStripeRuntime = {
      realmId: 'realm_X',
      env: 'test',
      client: mock,
      config: { mode: 'test', apiKey: 'sk_test', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost' },
    }
    const realms = { getStripeRuntime: async () => runtime } as unknown as RealmConfigService
    const provider = new StripePaymentProvider(realms)
    const res = await provider.registerWebhooks(makeCtx())
    expect(res[0]?.id).toBe('we_existing')
  })

  it('creates webhook when missing', async () => {
    const mock = new MockStripe({ webhooks: [] }) as unknown as Stripe
    const runtime: RealmStripeRuntime = {
      realmId: 'realm_X',
      env: 'test',
      client: mock,
      config: { mode: 'test', apiKey: 'sk_test', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost' },
    }
    const realms = { getStripeRuntime: async () => runtime } as unknown as RealmConfigService
    const provider = new StripePaymentProvider(realms)
    const res = await provider.registerWebhooks(makeCtx())
    expect(res[0]?.url).toContain('/api/webhooks/stripe/realm_X')
  })
})
