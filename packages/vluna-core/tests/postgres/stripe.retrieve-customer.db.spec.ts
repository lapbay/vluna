import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import type Stripe from 'stripe'
import { db, setRlsSession, withDatabaseConnection } from '../../src/db/index.js'
import { StripePaymentProvider } from '../../src/providers/stripe/provider.js'
import type { RealmConfigService, RealmStripeRuntime } from '../../src/security/realm-config.service.js'
import type { ProviderOpContext } from '../../src/providers/payment/PaymentProvider.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/provider_customers.sql')
const realmId = 'realm-test'
const billingAccountId = 'ba-test'

function makeCtx(): ProviderOpContext {
  return { traceId: 'trace-1', realmId, db: db() }
}

describe('StripePaymentProvider.retrieveCustomer (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping retrieveCustomer:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    if (stop) await stop()
  })

  beforeEach(async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })
        await trx.deleteFrom('provider_customers').execute()
      }),
    )
  })

  const mockStripe = () => {
    const created = { id: 'cus_new' } as Stripe.Customer
    return {
      customers: {
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as Stripe
  }

  const makeProvider = (client: Stripe) => {
    const runtime: RealmStripeRuntime = {
      realmId,
      env: 'test',
      client,
      config: { mode: 'test', apiKey: 'sk_test', webhookSecrets: {}, publicWebhookBaseUrl: 'http://localhost' },
    }
    const realms = { getStripeRuntime: async () => runtime } as unknown as RealmConfigService
    return new StripePaymentProvider(realms)
  }

  it('reuses existing provider customer without Stripe call', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })
        await trx
          .insertInto('provider_customers')
          .values({
            billing_account_id: billingAccountId,
            provider: 'stripe',
            provider_customer_id: 'cus_existing',
          })
          .execute()

        const client = mockStripe()
        const provider = makeProvider(client)
        const id = await provider.retrieveCustomer({ ...makeCtx(), db: trx }, { billingAccountId })
        expect(id).toBe('cus_existing')
        expect((client.customers.create as unknown as Mock).mock.calls.length).toBe(0)
      }),
    )
  })

  it('creates customer and upserts mapping when missing', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })
        const client = mockStripe()
        const provider = makeProvider(client)
        const id = await provider.retrieveCustomer({ ...makeCtx(), db: trx }, { billingAccountId })
        expect(id).toBe('cus_new')
        expect((client.customers.create as unknown as Mock).mock.calls.length).toBe(1)

        const row = await trx
          .selectFrom('provider_customers')
          .select(['provider_customer_id'])
          .where('billing_account_id', '=', billingAccountId)
          .where('provider', '=', 'stripe')
          .executeTakeFirst()
        expect(row?.provider_customer_id).toBe('cus_new')
      }),
    )
  })
})
