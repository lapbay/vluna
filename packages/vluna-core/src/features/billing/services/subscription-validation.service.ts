import { type Kysely } from 'kysely'
import type { Database } from '../../../types/database.js'

type CheckoutItem = {
  catalogPriceId?: string
}

export type SubscriptionValidationResult =
  | { allow: true }
  | {
      allow: false
      reason: 'conflict'
      conflicts: Array<{
        subscriptionId: string
        status: string
        subscriptionGroupId: string
        groupKey?: string
        externalId?: string
      }>
    }

export class SubscriptionValidationService {
  static async checkConflicts(
    db: Kysely<Database>,
    billingAccountId: string,
    items: CheckoutItem[],
  ): Promise<SubscriptionValidationResult> {
    const catalogPriceIds = items
      .map((item) => item.catalogPriceId)
      .filter((id): id is string => Boolean(id))

    if (catalogPriceIds.length === 0) return { allow: true }

    const groups = await db
      .selectFrom('catalog_prices as cp')
      .innerJoin('subscription_groups as csg', 'csg.subscription_group_id', 'cp.subscription_group_id')
      .select([
        'cp.catalog_price_id as catalog_price_id',
        'cp.subscription_group_id as subscription_group_id',
        'csg.group_key as group_key',
        'csg.is_stackable as is_stackable',
      ])
      .where('cp.catalog_price_id', 'in', catalogPriceIds)
      .execute()

    if (groups.length === 0) return { allow: true }

    const groupById = new Map<string, { groupKey?: string; isStackable: boolean }>()
    for (const row of groups) {
      if (!row.subscription_group_id) continue
      groupById.set(String(row.subscription_group_id), {
        groupKey: row.group_key || undefined,
        isStackable: Boolean(row.is_stackable),
      })
    }

    const nonStackableGroupIds = Array.from(groupById.entries())
      .filter(([, value]) => !value.isStackable)
      .map(([key]) => key)

    if (nonStackableGroupIds.length === 0) return { allow: true }

    const activeStatuses = ['trialing', 'active', 'past_due']

    const existing = await db
      .selectFrom('subscriptions as cs')
      .leftJoin('provider_subscription_links as psl', 'psl.subscription_id', 'cs.subscription_id')
      .select([
        'cs.subscription_id as cs_id',
        'cs.subscription_group_id as subscription_group_id',
        'cs.status as status',
        'psl.external_subscription_id as external_id',
      ])
      .where('cs.billing_account_id', '=', billingAccountId)
      .where('cs.subscription_group_id', 'in', nonStackableGroupIds)
      .where('cs.status', 'in', activeStatuses)
      .execute()

    if (existing.length === 0) return { allow: true }

    const conflicts = existing
      .map((row) => ({
        subscriptionId: String(row.cs_id),
        status: row.status,
        subscriptionGroupId: row.subscription_group_id,
        groupKey: groupById.get(row.subscription_group_id)?.groupKey,
        externalId: row.external_id || undefined,
      }))
      .filter((conflict) => Boolean(conflict.subscriptionGroupId))

    if (conflicts.length === 0) return { allow: true }

    return { allow: false, reason: 'conflict', conflicts }
  }
}
