import { describe, it, expect, vi } from 'vitest'
import type { Transaction } from 'kysely'
import type Stripe from 'stripe'
import type { Database } from '../../../src/types/database.js'
import { processGateProvisioning } from '../../../src/services/billing-purchase.service.js'

vi.mock('../../../src/db/index.js', () => ({
  setRlsSession: vi.fn().mockResolvedValue(undefined),
}))

type BundleRow = { bundle_id: string; realm_id: string; bundle_key: string; status: 'active' | 'disabled' }
type AccountRow = { billing_account_id: string; realm_id: string; current_bundle_id: string | null }

function makeSelect(
  rows: Array<Record<string, unknown>>,
): {
  select: (_cols?: unknown) => unknown
  innerJoin: (_table: string, _col1: string, _col2: string) => unknown
  orderBy: (_col: string, _dir?: unknown) => unknown
  where: (col: string, op: string, val: unknown) => unknown
  execute: () => unknown[]
  executeTakeFirst: () => unknown | undefined
} {
  const filters: Array<(row: Record<string, unknown>) => boolean> = []
  const getVal = (row: Record<string, unknown>, column: string): unknown => {
    const key = column.includes('.') ? column.split('.')[1] : column
    return row[key]
  }
  const where = (column: string, op: string, value: unknown) => {
    filters.push((row) => {
      const val = getVal(row, column)
      if (op === 'in') return Array.isArray(value) && value.includes(val)
      return val === value
    })
    return builder
  }
  const applyFilters = () => rows.filter((r) => filters.every((fn) => fn(r)))
  const builder = {
    select() {
      return this
    },
    innerJoin() {
      return this
    },
    orderBy() {
      return this
    },
    where,
    execute() {
      return applyFilters()
    },
    executeTakeFirst() {
      const filtered = applyFilters()
      return filtered.length > 0 ? filtered[0] : undefined
    },
  }
  return builder
}

function makeFakeTrx(initialBundles: BundleRow[]): Transaction<Database> & {
  bundles: BundleRow[]
  accounts: AccountRow[]
} {
  const bundles = [...initialBundles]
  const accounts: AccountRow[] = [{ billing_account_id: 'acct1', realm_id: 'realm1', current_bundle_id: null }]

  const baseTrx = {
    selectFrom(table: string) {
      if (table === 'gate_policy_bundles') return makeSelect(bundles)
      if (table === 'billing_accounts') return makeSelect(accounts)
      return makeSelect([])
    },
    updateTable(table: string) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(column: string, _op: string, value: unknown) {
              return {
                async execute() {
                  if (table === 'billing_accounts') {
                    const row = accounts.find((r) => (r as Record<string, unknown>)[column] === value)
                    if (row) {
                      Object.assign(row, values)
                    }
                  }
                },
              }
            },
          }
        },
      }
    },
    bundles,
    accounts,
  } as unknown as Transaction<Database> & { bundles: BundleRow[]; accounts: AccountRow[] }

  // Wrap with transaction().execute to satisfy runInTransaction
  const dbLike = {
    ...baseTrx,
    transaction() {
      return {
        async execute<T>(cb: (t: Transaction<Database>) => Promise<T>) {
          return cb(baseTrx as Transaction<Database>)
        },
      }
    },
  }

  // expose selectFrom on top-level too (processGateProvisioning receives a Transaction)
  const trxLike = dbLike as unknown as Transaction<Database> & { bundles: BundleRow[]; accounts: AccountRow[] }
  return trxLike
}

const makePriceMappings = (bundleKey: string) => {
  const map = new Map<string, {
    catalog_price_id: string
    catalog_product_id: string
    provider_price_id: string
    currency: string
    metadata: Record<string, unknown>
    product_metadata: Record<string, unknown> | null
  }>()
  map.set('price_1', {
    catalog_price_id: 'cp_1',
    catalog_product_id: 'prod_1',
    provider_price_id: 'price_1',
    currency: 'usd',
    metadata: { gating: { bundle: bundleKey } },
    product_metadata: null,
  })
  return map
}

describe('processGateProvisioning bundle selection', { tags: ['unit'] }, () => {
  it('sets current_bundle_id using bundle_key', async () => {
    const trx = makeFakeTrx([{ bundle_id: 'b99', realm_id: 'realm1', bundle_key: 'catalog_price:cp_1', status: 'active' }])
    const ctx = {
      billingAccountId: 'acct1',
      realmId: 'realm1',
      priceQuantities: new Map<string, { quantity: number }>([['price_1', { quantity: 1 }]]),
      priceMappings: makePriceMappings('catalog_price:cp_1'),
      subscription: undefined,
      session: { id: 'sess_1', metadata: { realm_id: 'realm1' }, object: 'checkout.session' } as unknown as Stripe.Checkout.Session,
      idempotencyPrefix: undefined,
    }

    await processGateProvisioning(trx, ctx)

    expect(trx.accounts[0].current_bundle_id).toBe('b99')
  })

  it('falls back to default bundle when bundle_key is missing', async () => {
    const trx = makeFakeTrx([])
    const ctx = {
      billingAccountId: 'acct1',
      realmId: 'realm1',
      priceQuantities: new Map<string, { quantity: number }>([['price_1', { quantity: 1 }]]),
      priceMappings: makePriceMappings('catalog_price:cp_missing'),
      subscription: undefined,
      session: { id: 'sess_2', metadata: { realm_id: 'realm1' }, object: 'checkout.session' } as unknown as Stripe.Checkout.Session,
      idempotencyPrefix: undefined,
    }

    await processGateProvisioning(trx, ctx)
    expect(trx.accounts[0].current_bundle_id).toBeNull()
  })
})
