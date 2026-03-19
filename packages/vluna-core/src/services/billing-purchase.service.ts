import { sql, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { setRlsSession } from '../db/index.js'
import {
  ensureBillingPlanAssignment,
  ensureBillingPlanGrantsEnrollmentSynced,
  refreshBillingAccountState,
  issueGrantsForAccount,
} from './billing-plan.service.js'
import { BillingPeriodService } from './billing-period.service.js'
import {
  ensureGrantAssignment,
  issueGrantForAssignment,
  normalizeGrantBindingOverride,
} from './grant-issuance.service.js'
import type { GrantBindingOverride, GrantBindingSourceKind } from './grant-issuance.service.js'

export type PriceQuantities = Map<string, { quantity: number }>

export type CatalogPriceMapping = {
  catalog_price_id: string
  catalog_product_id: string
  provider_price_id: string
  currency: string
  metadata: Record<string, unknown> | null
  product_metadata: Record<string, unknown> | null
}

export type SubscriptionSnapshotItem = {
  providerPriceId: string
  quantity: number
}

export type SubscriptionSnapshot = {
  provider: 'stripe'
  externalSubscriptionId: string
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date | null
  cancelAt: Date | null
  cancelAtPeriodEnd: boolean
  items: SubscriptionSnapshotItem[]
}

export type PurchaseSessionContext = {
  id: string
  metadata?: Record<string, unknown> | null
}

export type PurchaseEventContext = {
  provider: 'stripe'
  eventId: string
  session: PurchaseSessionContext
  idempotencyPrefix?: string | null
}

export type SubscriptionSyncResult = {
  subscriptionId: string
  subscriptionItemByCatalogId: Map<string, string>
}

type BillingProfileBindingContext = {
  billingAccountId: string
  realmId: string
  priceQuantities: PriceQuantities
  priceMappings: Map<string, CatalogPriceMapping>
  subscription: SubscriptionSnapshot
  subscriptionItemByCatalogId: Map<string, string>
}

type GrantBindingPlan = {
  override: GrantBindingOverride
  mapping: CatalogPriceMapping
  providerPriceId: string
  quantity: number
}

type GatingAssignment = {
  catalogPriceId: string
  bundle?: string
  validRangeSource: string
}

type LedgerGrantContext = {
  billingAccountId: string
  realmId: string
  priceQuantities: PriceQuantities
  priceMappings: Map<string, CatalogPriceMapping>
  subscription?: SubscriptionSnapshot | null
  event: PurchaseEventContext
}

export async function processSubscriptionPurchase(
  trx: Transaction<Database>,
  params: {
    billingAccountId: string
    realmId: string
    subscription: SubscriptionSnapshot
    priceQuantities: PriceQuantities
    priceMappings: Map<string, CatalogPriceMapping>
    event: PurchaseEventContext
  },
): Promise<void> {
  const subscriptionSync = await syncSubscriptionSnapshot(trx, {
    billingAccountId: params.billingAccountId,
    subscription: params.subscription,
    priceMappings: params.priceMappings,
    checkoutSessionId: params.event.session.id,
  })

  const handledByPlans = await processBillingPlanAssignments(trx, {
    billingAccountId: params.billingAccountId,
    realmId: params.realmId,
    priceQuantities: params.priceQuantities,
    priceMappings: params.priceMappings,
    subscription: params.subscription,
    subscriptionItemByCatalogId: subscriptionSync?.subscriptionItemByCatalogId ?? new Map(),
  })

  if (handledByPlans) {
    // Profile compiler will refresh gating/grants; skip legacy paths.
    return
  }

  await processGrants(trx, {
    billingAccountId: params.billingAccountId,
    realmId: params.realmId,
    priceQuantities: params.priceQuantities,
    priceMappings: params.priceMappings,
    subscription: params.subscription,
    event: params.event,
  })
}

export async function processOneTimePurchase(
  trx: Transaction<Database>,
  params: {
    billingAccountId: string
    realmId: string
    priceQuantities: PriceQuantities
    priceMappings: Map<string, CatalogPriceMapping>
    event: PurchaseEventContext
  },
): Promise<void> {
  await processGrants(trx, {
    billingAccountId: params.billingAccountId,
    realmId: params.realmId,
    priceQuantities: params.priceQuantities,
    priceMappings: params.priceMappings,
    subscription: null,
    event: params.event,
  })
}

export async function syncSubscriptionSnapshot(
  trx: Transaction<Database>,
  params: {
    billingAccountId: string
    subscription: SubscriptionSnapshot
    priceMappings: Map<string, CatalogPriceMapping>
    checkoutSessionId?: string | null
  },
): Promise<SubscriptionSyncResult | null> {
  const mappedItems = params.subscription.items
    .map((item) => {
      const mapping = params.priceMappings.get(item.providerPriceId)
      if (!mapping) return null
      const quantity = Number(item.quantity ?? 0)
      return {
        provider_price_id: item.providerPriceId,
        catalog_price_id: mapping.catalog_price_id,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      }
    })
    .filter(Boolean) as Array<{ provider_price_id: string; catalog_price_id: string; quantity: number }>

  if (mappedItems.length === 0) return null

  const catalogPriceIds = mappedItems.map((item) => item.catalog_price_id)

  const groupRows = await trx
    .selectFrom('catalog_prices as cp')
    .innerJoin('subscription_groups as sg', 'sg.subscription_group_id', 'cp.subscription_group_id')
    .select([
      'cp.catalog_price_id',
      'cp.subscription_group_id',
      'sg.is_stackable',
      'sg.is_exclusive',
      'sg.group_key',
      'sg.title',
    ])
    .where('cp.catalog_price_id', 'in', catalogPriceIds)
    .execute()

  if (groupRows.length === 0) return null

  const groups = Array.from(
    new Map(
      groupRows
        .filter((row) => row.subscription_group_id)
        .map((row) => {
          const sgid = String(row.subscription_group_id)
          return [sgid, { ...row, subscription_group_id: sgid }]
        }),
    ).values(),
  )
  if (groups.length !== 1) {
    throw new Error(`Provider subscription ${params.subscription.externalSubscriptionId} spans multiple subscription groups`)
  }

  const group = groups[0]
  const groupId = group.subscription_group_id
  const totalQuantity = mappedItems.reduce((acc, item) => acc + item.quantity, 0) || 1

  // Prevent concurrent inserts/updates creating multiple active/trialing subscriptions for the same
  // billing_account_id × subscription_group_id (enforced by ux_cs_one_active_per_group).
  // Stripe may emit multiple events that trigger subscription sync concurrently; serialize by group.
  await sql`select pg_advisory_xact_lock(hashtext(${params.billingAccountId}), hashtext(${groupId}))`.execute(trx)

  const policySnapshot = {
    is_stackable: Boolean(group.is_stackable),
    is_exclusive: Boolean(group.is_exclusive),
    group_key: group.group_key,
    group_title: group.title,
  }
  const metaSnapshot = {
    provider: params.subscription.provider,
    provider_subscription_id: params.subscription.externalSubscriptionId,
    checkout_session_id: params.checkoutSessionId ?? null,
    provider_prices: mappedItems.map((m) => m.provider_price_id),
    status: params.subscription.status,
  }

  const existingLink = await trx
    .selectFrom('provider_subscription_links')
    .select(['subscription_id'])
    .where('provider', '=', params.subscription.provider)
    .where('external_subscription_id', '=', params.subscription.externalSubscriptionId)
    .executeTakeFirst()

  let subscriptionId: string

  if (existingLink) {
    subscriptionId = existingLink.subscription_id
    await trx
      .updateTable('subscriptions')
      .set({
        billing_account_id: params.billingAccountId,
        subscription_group_id: groupId,
        status: params.subscription.status,
        quantity: totalQuantity,
        current_period_start: params.subscription.currentPeriodStart,
        current_period_end: params.subscription.currentPeriodEnd ?? new Date(),
        cancel_at: params.subscription.cancelAt,
        cancel_at_period_end: params.subscription.cancelAtPeriodEnd,
        policy_snapshot: policySnapshot,
        meta_snapshot: metaSnapshot,
        updated_at: new Date(),
      })
      .where('subscription_id', '=', subscriptionId)
      .execute()
  } else {
    const baseValues = {
      billing_account_id: params.billingAccountId,
      subscription_group_id: groupId,
      status: params.subscription.status,
      quantity: totalQuantity,
      current_period_start: params.subscription.currentPeriodStart,
      current_period_end: params.subscription.currentPeriodEnd ?? new Date(),
      cancel_at: params.subscription.cancelAt,
      cancel_at_period_end: params.subscription.cancelAtPeriodEnd,
      policy_snapshot: policySnapshot,
      meta_snapshot: metaSnapshot,
      updated_at: new Date(),
    }
    const existing = await trx
      .selectFrom('subscriptions')
      .select('subscription_id')
      .where('billing_account_id', '=', params.billingAccountId)
      .where('subscription_group_id', '=', group.subscription_group_id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    if (existing) {
      subscriptionId = existing.subscription_id
      await trx
        .updateTable('subscriptions')
        .set(baseValues)
        .where('subscription_id', '=', subscriptionId)
        .execute()
    } else {
      const inserted = await trx
        .insertInto('subscriptions')
        .values(baseValues)
        .returning('subscription_id')
        .executeTakeFirstOrThrow(() => new Error('Failed to insert subscription'))
      subscriptionId = inserted.subscription_id
    }

    await trx
      .insertInto('provider_subscription_links')
      .values({
        provider: params.subscription.provider,
        external_subscription_id: params.subscription.externalSubscriptionId,
        subscription_id: subscriptionId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  const inserted = await trx
    .insertInto('subscription_items')
    .values(
      mappedItems.map((item) => ({
        subscription_id: subscriptionId,
        catalog_price_id: item.catalog_price_id,
        quantity: item.quantity,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['subscription_id', 'catalog_price_id']).doUpdateSet({ quantity: sql`excluded.quantity` }),
    )
    .returning(['subscription_item_id', 'catalog_price_id'])
    .execute()

  await trx
    .deleteFrom('subscription_items')
    .where('subscription_id', '=', subscriptionId)
    .where('catalog_price_id', 'not in', mappedItems.map((item) => item.catalog_price_id))
    .execute()

  const subscriptionItemByCatalogId = new Map<string, string>()
  for (const row of inserted) {
    if (!row.catalog_price_id) continue
    subscriptionItemByCatalogId.set(String(row.catalog_price_id), String(row.subscription_item_id))
  }

  // Pre-warm billing period instance so later settlement paths don't have to create it implicitly.
  // Billing periods are canonical natural months (UTC); subscription boundaries are recorded as source_period_*.
  if (params.subscription.status === 'trialing' || params.subscription.status === 'active' || params.subscription.status === 'past_due') {
    const realmRow = await trx
      .selectFrom('billing_accounts')
      .select(['realm_id'])
      .where('billing_account_id', '=', params.billingAccountId)
      .executeTakeFirstOrThrow(() => new Error('billing account not found for subscription sync'))

    const now = new Date()
    const start = params.subscription.currentPeriodStart
    const end = params.subscription.currentPeriodEnd
    const at = (() => {
      if (!end) return now
      const endMs = end.getTime()
      const safeEndMs = endMs > 0 ? endMs - 1 : endMs
      const clamped = Math.min(now.getTime(), safeEndMs)
      return new Date(Math.max(start.getTime(), clamped))
    })()

    const svc = new BillingPeriodService()
    await svc.ensureBillingPeriodInstance(trx, {
      realmId: String(realmRow.realm_id),
      billingAccountId: params.billingAccountId,
      at,
    })
  }

  return { subscriptionId, subscriptionItemByCatalogId }
}

async function processBillingPlanAssignments(
  trx: Transaction<Database>,
  ctx: BillingProfileBindingContext,
): Promise<boolean> {
  const assignments: Array<{
    planCode: string
    providerPriceId: string
    subscriptionItemId: string | null
    windowStart: Date
    windowEnd: Date | null
    sourceRef: string
    sourceKind: Database['billing_plan_assignments']['source_kind']
  }> = []

  const windowStart = ctx.subscription.currentPeriodStart
  const windowEnd = ctx.subscription.currentPeriodEnd

  for (const [providerPriceId, mapping] of ctx.priceMappings.entries()) {
    const qty = ctx.priceQuantities.get(providerPriceId)?.quantity ?? 0
    if (qty <= 0) continue
    const planCodeRaw = (mapping.metadata as Record<string, unknown> | null)?.billing_plan_code
    const planCode = typeof planCodeRaw === 'string' ? planCodeRaw.trim() : ''
    if (!planCode) continue
    const subscriptionItemId = ctx.subscriptionItemByCatalogId.get(mapping.catalog_price_id) ?? null
    assignments.push({
      planCode,
      providerPriceId,
      subscriptionItemId,
      windowStart,
      windowEnd,
      sourceRef: `${ctx.subscription.externalSubscriptionId}:${providerPriceId}`,
      sourceKind: 'provider.subscription_item',
    })
  }

  if (assignments.length === 0) return false

  // Serialize profile compiler writes per billing account to avoid deadlocks across concurrent webhook workers.
  await sql`select pg_advisory_xact_lock(hashtext(${ctx.billingAccountId}), hashtext('billing.plan.profile'))`.execute(trx)

  await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, isRealmAdmin: true })

  const planCodes = Array.from(new Set(assignments.map((a) => a.planCode)))
  const plans = await trx
    .selectFrom('billing_plans')
    .select(['plan_id', 'plan_code'])
    .where('realm_id', '=', ctx.realmId)
    .where('active', '=', true)
    .where('plan_code', 'in', planCodes)
    .execute()
  const planIdByCode = new Map(plans.map((p) => [p.plan_code, p.plan_id]))
  for (const a of assignments) {
    const planId = planIdByCode.get(a.planCode)
    if (!planId) continue
    if (a.sourceKind === 'provider.subscription_item' && !a.subscriptionItemId) {
      console.warn('[billing.purchase] missing subscription_item_id for profile binding', {
        billingAccountId: ctx.billingAccountId,
        subscriptionId: ctx.subscription.externalSubscriptionId,
        providerPriceId: a.providerPriceId,
        planCode: a.planCode,
      })
      continue
    }
    await ensureBillingPlanAssignment(trx, {
      billingAccountId: ctx.billingAccountId,
      planId: String(planId),
      subscriptionItemId: a.subscriptionItemId,
      sourceKind: a.sourceKind,
      sourceRef: a.sourceRef,
      windowStart: a.windowStart,
      windowEnd: a.windowEnd,
      metadata: {
        provider: ctx.subscription.provider,
        provider_price_id: a.providerPriceId,
        provider_subscription_id: ctx.subscription.externalSubscriptionId,
      },
    })
  }

  await refreshBillingAccountState(trx, ctx.billingAccountId)
  await ensureBillingPlanGrantsEnrollmentSynced(trx, ctx.billingAccountId)
  await issueGrantsForAccount(trx, ctx.billingAccountId)
  return true
}

async function processGrants(trx: Transaction<Database>, ctx: LedgerGrantContext): Promise<void> {
  const realmId = ctx.realmId
  if (!realmId) return

  const plans: GrantBindingPlan[] = []
  for (const [providerPriceId, mapping] of ctx.priceMappings.entries()) {
    const quantity = ctx.priceQuantities.get(providerPriceId)?.quantity ?? 0
    if (quantity <= 0) continue

    const overrides = mergeGrantBindingOverrides(mapping)
    for (const override of overrides) {
      plans.push({
        override,
        mapping,
        providerPriceId,
        quantity,
      })
    }
  }

  if (plans.length === 0) {
    return
  }

  await setRlsSession(trx, {
    realmId,
    billingAccountId: ctx.billingAccountId,
    isRealmAdmin: true,
  })

  const uniqueProgramCodes = Array.from(new Set(plans.map((plan) => plan.override.programCode)))
  if (uniqueProgramCodes.length === 0) return

  const programs = await trx
    .selectFrom('grant_programs')
    .selectAll()
    .where('realm_id', '=', realmId)
    .where('program_code', 'in', uniqueProgramCodes)
    .where('active', '=', true)
    .execute()

  if (programs.length === 0) {
    return
  }

  const programMap = new Map(programs.map((row) => [row.program_code, row]))
  const now = new Date()

  for (const plan of plans) {
    const program = programMap.get(plan.override.programCode)
    if (!program) {
      continue
    }

    const bindingWindow = resolveBindingWindow(ctx, plan.override, now)
    const sourceKind: GrantBindingSourceKind = ctx.subscription ? 'provider.subscription' : 'provider.one_time'
    const sourceRef = buildBindingSourceRef(ctx, plan)

    const bindingMetadata: Record<string, unknown> = {
      provider: ctx.event.provider,
      provider_event_id: ctx.event.eventId,
      provider_session_id: ctx.event.session.id,
      provider_price_id: plan.mapping.provider_price_id,
      catalog_price_id: plan.mapping.catalog_price_id,
      catalog_product_id: plan.mapping.catalog_product_id,
      quantity: plan.quantity,
    }

    const assignment = await ensureGrantAssignment(trx, {
      billingAccountId: ctx.billingAccountId,
      programId: program.program_id,
      sourceKind,
      sourceRef,
      windowStart: bindingWindow.start,
      windowEnd: bindingWindow.end,
      metadata: bindingMetadata,
      decidedAt: now,
    })

    const grantMetadata: Record<string, unknown> = {
      source: `${ctx.event.provider}.checkout`,
      provider_event_id: ctx.event.eventId,
      provider_session_id: ctx.event.session.id,
      catalog_price_id: plan.mapping.catalog_price_id,
      catalog_product_id: plan.mapping.catalog_product_id,
      provider_price_id: plan.mapping.provider_price_id,
      quantity: plan.quantity,
    }

    await issueGrantForAssignment(trx, {
      realmId,
      billingAccountId: ctx.billingAccountId,
      program,
      assignment,
      override: plan.override,
      quantity: plan.quantity,
      sourceKind,
      sourceRef,
      metadata: grantMetadata,
      idempotencyKey: ctx.event.idempotencyPrefix
        ? `${ctx.event.idempotencyPrefix}:grant:${plan.override.programCode}`
        : `${ctx.event.provider}:${ctx.event.eventId}:${assignment.assignment_id}:${plan.override.programCode}`,
      now,
      allocSeq: plan.override.allocSeqOverride,
      ledgerLabels: {
        origin: `${ctx.event.provider}.checkout`,
        catalog_price_id: plan.mapping.catalog_price_id,
        provider_event_id: ctx.event.eventId,
      },
      isRealmAdmin: true,
    })
  }
}

function extractGrantBindingOverrides(metadata: Record<string, unknown> | null | undefined): GrantBindingOverride[] {
  if (!metadata || typeof metadata !== 'object') return []
  const raw = (metadata as Record<string, unknown>).grants
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const overrides: GrantBindingOverride[] = []
  for (const candidate of list) {
    const override = normalizeGrantBindingOverride(candidate)
    if (override) {
      overrides.push(override)
    }
  }
  return overrides
}

function mergeGrantBindingOverrides(mapping: CatalogPriceMapping): GrantBindingOverride[] {
  const productOverrides = extractGrantBindingOverrides(mapping.product_metadata)
  const priceOverrides = extractGrantBindingOverrides(mapping.metadata)
  if (productOverrides.length === 0) return priceOverrides
  if (priceOverrides.length === 0) return productOverrides

  const byProgram = new Map<string, GrantBindingOverride>()
  for (const override of productOverrides) {
    byProgram.set(override.programCode, override)
  }
  for (const override of priceOverrides) {
    const current = byProgram.get(override.programCode)
    if (!current) {
      byProgram.set(override.programCode, override)
      continue
    }
    const merged: GrantBindingOverride = { ...current, programCode: current.programCode }
    for (const [key, value] of Object.entries(override)) {
      if (key === 'programCode') continue
      if (value !== undefined) {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    byProgram.set(override.programCode, merged)
  }
  return Array.from(byProgram.values())
}

function resolveBindingWindow(
  ctx: LedgerGrantContext,
  override: GrantBindingOverride,
  reference: Date,
): { start: Date; end: Date | null } {
  if (ctx.subscription) {
    return { start: ctx.subscription.currentPeriodStart, end: ctx.subscription.currentPeriodEnd }
  }

  const start = reference
  let end: Date | null = null
  if (override.windowRelativeSecondsOverride && override.windowRelativeSecondsOverride > 0) {
    end = new Date(start.getTime() + override.windowRelativeSecondsOverride * 1000)
  }
  return { start, end }
}

function buildBindingSourceRef(ctx: LedgerGrantContext, plan: GrantBindingPlan): string {
  const prefix = ctx.subscription ? `${ctx.event.provider}.subscription` : `${ctx.event.provider}.checkout`
  const baseId = ctx.subscription?.externalSubscriptionId ?? ctx.event.session.id
  return `${prefix}:${baseId}:${plan.mapping.catalog_price_id}:${plan.providerPriceId}:${plan.override.programCode}`
}

export async function processGateProvisioning(
  trx: Transaction<Database>,
  ctx: {
    billingAccountId: string
    realmId: string
    priceQuantities: PriceQuantities
    priceMappings: Map<string, CatalogPriceMapping>
    subscription?: SubscriptionSnapshot | null
  },
): Promise<void> {
  const realmId = ctx.realmId
  if (!realmId) return

  const gatingAssignments: GatingAssignment[] = []

  for (const [providerPriceId, mapping] of ctx.priceMappings.entries()) {
    const quantity = ctx.priceQuantities.get(providerPriceId)?.quantity ?? 0
    if (quantity <= 0) continue
    const gatingRaw = (mapping.metadata?.gating ?? null) as Record<string, unknown> | null
    if (!gatingRaw || typeof gatingRaw !== 'object') continue

    const gating = gatingRaw as Record<string, unknown>

    const bundleOverrideRaw = (gating as Record<string, unknown>).bundle
    const bundleOverride = typeof bundleOverrideRaw === 'string' ? bundleOverrideRaw.trim() : undefined
    const bundle = bundleOverride && bundleOverride.length > 0 ? bundleOverride : undefined
    const validRangeSource = ctx.subscription ? 'subscription' : 'one_time'

    if (bundle) {
      gatingAssignments.push({
        catalogPriceId: mapping.catalog_price_id,
        bundle,
        validRangeSource,
      })
    }
  }

  if (gatingAssignments.length === 0) return

  const bundleNames = new Set<string>()
  for (const assignment of gatingAssignments) {
    if (assignment.bundle) {
      bundleNames.add(assignment.bundle.trim())
    }
  }

  if (bundleNames.size === 0) {
    return
  }

  await setRlsSession(trx, {
    realmId,
    billingAccountId: ctx.billingAccountId,
    isRealmAdmin: true,
  })

  const bundleRows = await trx
    .selectFrom('gate_policy_bundles')
    .select(['bundle_id', 'bundle_key', 'status'])
    .where('realm_id', '=', realmId)
    .where('bundle_key', 'in', Array.from(bundleNames))
    .where('status', '=', 'active')
    .execute()

  if (bundleRows.length === 0) {
    console.warn('[billing.purchase] bundle missing for gating assignment; falling back to default bundle', {
      realmId,
      billingAccountId: ctx.billingAccountId,
      bundleKeys: Array.from(bundleNames),
    })
    await refreshBillingAccountState(trx, ctx.billingAccountId)
    return
  }

  const extraCandidates = Array.from(bundleRows).map((row) => ({
    bundle_key: String(row.bundle_key),
    priority: 0,
  }))

  await refreshBillingAccountState(trx, ctx.billingAccountId, extraCandidates)
}
