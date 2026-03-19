import { Injectable } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import { okEnvelope, errEnvelope } from '../../../common/envelope.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import type { JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import {
  listRealmPrices,
  listRealmProducts,
  listPricesForProducts,
  listProductFeatureFamilies,
  listPriceFeatureFamilies,
  type PriceRow,
  type FeatureFamilyRow,
} from '../../../repositories/catalog.repository.js'
import type { Database } from '../../../types/database.js'
import { parseUuidId } from '../../../utils/util.js'

type ListProductsQuery = QueryParams<BillingOps, 'listCatalogProducts'>
type ListProducts200 = JsonResponse<BillingOps, 'listCatalogProducts', 200>
type ListPricesQuery = QueryParams<BillingOps, 'listCatalogPrices'>
type ListPrices200 = JsonResponse<BillingOps, 'listCatalogPrices', 200>

type CatalogProductWithExpansions = BillingComponents['schemas']['CatalogProduct'] & {
  prices?: BillingComponents['schemas']['CatalogPrice'][]
}

type SubscriptionState = BillingComponents['schemas']['SubscriptionState']
type SubscriptionStateMap = Map<string, SubscriptionState>

@Injectable()
export class CatalogApiService {
  async listCatalogProducts(input: {
    realmId: string
    billingAccountId?: string
    db?: Kysely<Database> | Transaction<Database>
    query: ListProductsQuery
  }): Promise<ListProducts200> {
    const realmId = input.realmId || ''
    const billingAccountId = input.billingAccountId || ''
    const q = input.query
    const limit = Number(q?.limit ?? 50)
    const cursor = q?.cursor
    const kind = q?.kind
    const currency = q?.currency
    const expandRaw = q?.expand
    const expandValues = Array.isArray(expandRaw)
      ? expandRaw
      : typeof expandRaw === 'string'
        ? [expandRaw]
        : []
    const expandSet = new Set<string>(expandValues as string[])
    const includePriceSubscriptionState = expandSet.has('prices.subscription_state')
    const includePrices = expandSet.has('prices') || includePriceSubscriptionState
    const includeDefaultPrice = includePrices || expandSet.has('default_price')
    const includeSubscriptionState = expandSet.has('subscription_state')
    const includeFeatureFamilies = expandSet.has('feature_families')
    const kindFilter = kind && kind !== 'all' ? (kind as 'subscription' | 'credit') : undefined

    try {
      const trx = input.db
      if (!trx) return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListProducts200

      const { items, nextCursor, hasMore } = await listRealmProducts(trx, {
        realmId,
        kind: kindFilter,
        currency,
        limit,
        cursorId: parseUuidId(cursor ?? null),
      })

      const productIds = items.map((i) => i.catalog_product_id)
      const needPriceMap = includePrices || includeDefaultPrice || includeSubscriptionState || includePriceSubscriptionState
      const priceMap = needPriceMap
        ? await listPricesForProducts(trx, { realmId, productIds, currency })
        : undefined
      const featureFamilyMap = includeFeatureFamilies ? await listProductFeatureFamilies(trx, { realmId, productIds }) : undefined

      const allPriceRows: PriceRow[] = priceMap
        ? Array.from(priceMap.values()).reduce<PriceRow[]>((acc, rows) => acc.concat(rows), [])
        : []
      const priceFeatureFamilyMap =
        includeFeatureFamilies && allPriceRows.length > 0
          ? await listPriceFeatureFamilies(trx, {
              realmId,
              priceIds: allPriceRows.map((row) => String(row.catalog_price_id)),
            })
          : undefined

      const subscriptionStateMap = needPriceMap && billingAccountId && allPriceRows.length > 0
        ? await buildSubscriptionStateMap(
            trx,
            billingAccountId,
            allPriceRows.map((row) => String(row.catalog_price_id)),
          )
        : undefined

      const data: CatalogProductWithExpansions[] = items.map((p) => {
        const base: CatalogProductWithExpansions = {
          catalog_product_id: String(p.catalog_product_id),
          provider: p.provider,
          kind: p.kind,
          status: p.status,
          display_priority: Number(p.display_priority ?? 100),
          name: p.name,
          default_currency: p.default_currency,
          presentation_config:
            p.presentation_config && typeof p.presentation_config === 'object' && !Array.isArray(p.presentation_config)
              ? (p.presentation_config as Record<string, unknown>)
              : {},
        }

        const priceRows = priceMap?.get(p.catalog_product_id) ?? []
        const priceStateById = buildPriceStateLookup(priceRows, subscriptionStateMap)

        if (includePrices) {
          base.prices = priceRows.map((row) =>
            mapPriceRow(
              row,
              priceStateById.get(String(row.catalog_price_id)),
              priceFeatureFamilyMap?.get(String(row.catalog_price_id)),
            ),
          )
        }

        if (includeDefaultPrice) {
          const def = priceRows[0]
          base.default_price = def
            ? mapPriceRow(
                def,
                priceStateById.get(String(def.catalog_price_id)),
                priceFeatureFamilyMap?.get(String(def.catalog_price_id)),
              )
            : null
        }

        if (includeFeatureFamilies) {
          const caps = featureFamilyMap?.get(p.catalog_product_id) ?? []
          if (caps.length > 0) {
            base.feature_families = caps.map(mapFeatureFamilyRow)
          } else {
            base.feature_families = []
          }
        }

        if (includeSubscriptionState) {
          const productState = pickProductSubscriptionState(priceRows, priceStateById)
          if (productState) base.subscription_state = productState
        }

        return base
      })

      return okEnvelope<BillingComponents['schemas']['CatalogProduct'][]>(
        data as BillingComponents['schemas']['CatalogProduct'][],
        { meta: { next_cursor: nextCursor, has_more: hasMore, limit } },
      ) as ListProducts200
    } catch (e) {
      return errEnvelope('SERVER.UNEXPECTED', { message: (e as Error)?.message || 'unexpected' }) as unknown as ListProducts200
    }
  }

  async listCatalogPrices(input: {
    realmId: string
    billingAccountId?: string
    db?: Kysely<Database> | Transaction<Database>
    query: ListPricesQuery
  }): Promise<ListPrices200> {
    const realmId = input.realmId || ''
    const billingAccountId = input.billingAccountId || ''
    const q = input.query
    const limit = Number(q?.limit ?? 50)
    const cursor = q?.cursor
    const currency = q?.currency
    const recurringInterval = q?.recurring_interval
    const recurringCount = typeof q?.recurring_count !== 'undefined' ? Number(q?.recurring_count) : undefined
    const productIdRaw = q?.product_id
    const expandRaw = q?.expand
    const expandValues = Array.isArray(expandRaw)
      ? (expandRaw as string[])
      : typeof expandRaw === 'string'
        ? [expandRaw]
        : []
    const includeSubscriptionState = expandValues.includes('subscription_state')
    const includeFeatureFamilies = expandValues.includes('feature_families')

    try {
      const trx = input.db
      if (!trx) return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListPrices200

      const productIdsInput = Array.isArray(productIdRaw) ? productIdRaw : [productIdRaw]
      const productIds = Array.from(
        new Set(
          productIdsInput
            .map((v) => parseUuidId(v))
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      )
      if (productIds.length === 0) {
        return errEnvelope('VALIDATION.INVALID_INPUT', { message: 'product_id is required' }) as unknown as ListPrices200
      }

      const { items, nextCursor, hasMore } = await listRealmPrices(trx, {
        realmId,
        productIds,
        currency,
        recurring_interval: recurringInterval,
        recurring_count: recurringCount,
        limit,
        cursorId: parseUuidId(cursor ?? null),
      })

      const priceIds = includeSubscriptionState ? items.map((item) => String(item.catalog_price_id)) : []
      const subscriptionStateMap = includeSubscriptionState && billingAccountId && priceIds.length > 0
        ? await buildSubscriptionStateMap(trx, billingAccountId, priceIds)
        : undefined
      const featureFamilyMap = includeFeatureFamilies
        ? await listPriceFeatureFamilies(trx, { realmId, priceIds })
        : undefined

      const data = items.map((row) =>
        mapPriceRow(
          row,
          subscriptionStateMap?.get(String(row.catalog_price_id)),
          featureFamilyMap?.get(String(row.catalog_price_id)),
        ),
      ) as BillingComponents['schemas']['CatalogPriceList']
      return okEnvelope<BillingComponents['schemas']['CatalogPriceList']>(data, {
        meta: { next_cursor: nextCursor, has_more: hasMore, limit },
      }) as ListPrices200
    } catch (e) {
      return errEnvelope('SERVER.UNEXPECTED', { message: (e as Error)?.message || 'unexpected' }) as unknown as ListPrices200
    }
  }
}

function mapFeatureFamilyRow(row: FeatureFamilyRow): BillingComponents['schemas']['FeatureFamilyRef'] {
  const base: BillingComponents['schemas']['FeatureFamilyRef'] = {
    feature_family_code: row.feature_family_code,
    name: row.name ?? row.feature_family_code,
    description: row.description ?? undefined,
    metadata: row.metadata ?? undefined,
  }
  return base
}

function mapPriceRow(
  row: PriceRow,
  subscriptionState?: SubscriptionState | undefined,
  featureFamilies?: FeatureFamilyRow[] | undefined,
): BillingComponents['schemas']['CatalogPrice'] {
  const metadata = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, never>) : null
  const base: BillingComponents['schemas']['CatalogPrice'] = {
    catalog_price_id: String(row.catalog_price_id),
    catalog_product_id: String(row.catalog_product_id),
    provider_price_id: row.provider_price_id,
    currency: row.currency,
    unit_amount: row.unit_amount,
    recurring_interval: row.recurring_interval ?? undefined,
    recurring_count: row.recurring_count ?? undefined,
    display_priority: row.display_priority ?? undefined,
    metadata: metadata ?? null,
  }
  if (subscriptionState) {
    base.subscription_state = { ...subscriptionState }
  }
  if (featureFamilies && featureFamilies.length > 0) {
    base.feature_families = featureFamilies.map(mapFeatureFamilyRow)
  }
  return base
}

function buildPriceStateLookup(priceRows: PriceRow[], stateMap?: SubscriptionStateMap): SubscriptionStateMap {
  const result: SubscriptionStateMap = new Map()
  if (!stateMap) return result
  for (const row of priceRows) {
    const priceId = String(row.catalog_price_id)
    const state = stateMap.get(priceId)
    if (state) {
      result.set(priceId, { ...state })
    }
  }
  return result
}

function pickProductSubscriptionState(priceRows: PriceRow[], priceStates: SubscriptionStateMap): SubscriptionState | undefined {
  let candidate: SubscriptionState | undefined
  for (const row of priceRows) {
    const state = priceStates.get(String(row.catalog_price_id))
    if (!state) continue
    if (state.has_active_subscription) {
      return { ...state }
    }
    if (!candidate) {
      candidate = { ...state }
    }
  }
  return candidate ? { ...candidate } : undefined
}

async function buildSubscriptionStateMap(
  trx: Kysely<Database> | Transaction<Database>,
  billingAccountId: string,
  priceIds: string[],
): Promise<SubscriptionStateMap | undefined> {
  const uniquePriceIds = Array.from(new Set(priceIds.filter(Boolean)))
  if (!billingAccountId || uniquePriceIds.length === 0) return undefined

  const groupRows = await trx
    .selectFrom('catalog_prices as cp')
    .innerJoin('subscription_groups as csg', 'csg.subscription_group_id', 'cp.subscription_group_id')
    .select([
      'cp.catalog_price_id as catalog_price_id',
      'cp.subscription_group_id as subscription_group_id',
      'csg.group_key as group_key',
      'csg.is_stackable as is_stackable',
    ])
    .where('cp.catalog_price_id', 'in', uniquePriceIds)
    .execute()

  if (groupRows.length === 0) return new Map()

  const groupIds = Array.from(new Set(groupRows.map((row) => row.subscription_group_id).filter((id): id is string => Boolean(id))))

  let subscriptionRows: Array<{
    subscription_id: string
    subscription_group_id: string
    status: string
    external_subscription_id: string | null
  }> = []

  if (groupIds.length > 0) {
    subscriptionRows = await trx
      .selectFrom('subscriptions as cs')
      .leftJoin('provider_subscription_links as psl', 'psl.subscription_id', 'cs.subscription_id')
      .select([
        'cs.subscription_id as subscription_id',
        'cs.subscription_group_id as subscription_group_id',
        'cs.status as status',
        'psl.external_subscription_id as external_subscription_id',
      ])
      .where('cs.billing_account_id', '=', billingAccountId)
      .where('cs.subscription_group_id', 'in', groupIds)
      .where('cs.status', 'in', ['trialing', 'active', 'past_due'])
      .orderBy('cs.updated_at', 'desc')
      .execute()
  }

  const subsByGroup = new Map<string, typeof subscriptionRows[number]>()
  for (const row of subscriptionRows) {
    if (!subsByGroup.has(row.subscription_group_id)) {
      subsByGroup.set(row.subscription_group_id, row)
    }
  }

  const stateMap: SubscriptionStateMap = new Map()
  for (const row of groupRows) {
    const groupId = String(row.subscription_group_id)
    const info = subsByGroup.get(groupId)
    const isStackable = Boolean(row.is_stackable)
    const hasActive = Boolean(info)

    let action: SubscriptionState['action'] = 'checkout'
    let eligibleForCheckout = true

    if (hasActive) {
      if (isStackable) {
        action = 'add_seats'
        eligibleForCheckout = true
      } else {
        action = 'manage_in_portal'
        eligibleForCheckout = false
      }
    }

    const state: SubscriptionState = {
      subscription_group_id: groupId,
      group_key: row.group_key || undefined,
      is_stackable: isStackable,
      has_active_subscription: hasActive,
      eligible_for_checkout: eligibleForCheckout,
      action,
    }

    if (info?.subscription_id) {
      state.subscription_id = info.subscription_id
    }

    stateMap.set(String(row.catalog_price_id), state)
  }

  return stateMap
}
