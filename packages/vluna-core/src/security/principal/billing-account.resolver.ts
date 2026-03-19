import { HttpException } from '@nestjs/common'
import { db, pool, setRlsSession } from '../../db/index.js'
import {
  ensureBillingPlanAssignment,
  ensureBillingPlanGrantsEnrollmentSynced,
  issueGrantsForAccount,
  refreshBillingAccountState,
} from '../../services/billing-plan.service.js'

export interface BillingAccountResolution {
  realmId: string
  billingAccountId: string
  billingPrincipalId?: string
  currentBundleId?: string | null
  metadata?: Record<string, unknown>
}

export interface BillingAccountParams {
  realmId: string
  principalId: string
  autoCreate?: boolean
  ctx?: { billingAccountId?: string; billingAccount?: BillingAccountResolution } & Record<string, unknown>
}


const AUTOCREATE_ENABLED = (() => {
  const flag = (process.env.VLUNA_NO_AUTOCREATE_BILLING_ACCOUNT || '').toLowerCase()
  if (flag === 'true' || flag === '1') return false
  return true
})()

export async function ensureBillingAccount(params: BillingAccountParams): Promise<BillingAccountResolution | null> {
  const realmId = params.realmId.trim()
  const principalId = params.principalId.trim()
  if (!realmId) throw new HttpException('missing_realm', 400)
  if (!principalId) throw new HttpException('missing_principal', 401)

  const sql = `
    select billing_account_id, realm_id, billing_principal_id, current_bundle_id, metadata
    from billing_accounts
    where realm_id = $1
      and billing_principal_id = $2
  limit 1
  ` as const

  const out = await pool.query(sql, [realmId, principalId])
  const row = out?.rows?.[0]
  if (row?.billing_account_id) {
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId: String(row.billing_account_id),
      billingPrincipalId: String(row.billing_principal_id),
      currentBundleId: row.current_bundle_id ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }

  const shouldAutocreate = params.autoCreate ?? AUTOCREATE_ENABLED
  if (!shouldAutocreate) {
    return null
  }

  const upsertSql = `
    insert into billing_accounts (realm_id, billing_principal_id)
    values ($1, $2)
    on conflict (realm_id, billing_principal_id)
    do update set billing_principal_id = excluded.billing_principal_id
    returning billing_account_id, realm_id, billing_principal_id, current_bundle_id, metadata
  ` as const
  const upserted = await pool.query(upsertSql, [realmId, principalId])
  const createdRow = upserted?.rows?.[0]
  if (createdRow?.billing_account_id) {
    const billingAccountId = String(createdRow.billing_account_id)
    await pool.query(
      `
      insert into billing_account_billing_details (billing_account_id)
      values ($1)
      on conflict (billing_account_id) do nothing
      `,
      [billingAccountId],
    )
    await seedDefaultBillingPlanAssignment(realmId, billingAccountId)
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId,
      billingPrincipalId: String(createdRow.billing_principal_id),
      currentBundleId: createdRow.current_bundle_id ?? null,
      metadata: (createdRow.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }

  // Fallback (should not happen): re-read to avoid returning null on concurrent race
  const reread = await pool.query(sql, [realmId, principalId])
  const existing = reread?.rows?.[0]
  if (existing?.billing_account_id) {
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId: String(existing.billing_account_id),
      billingPrincipalId: String(existing.billing_principal_id),
      currentBundleId: existing.current_bundle_id ?? null,
      metadata: (existing.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }
  return null
}

async function seedDefaultBillingPlanAssignment(realmId: string, billingAccountId: string): Promise<void> {
  const kdb = db()
  await kdb.transaction().execute(async (trx) => {
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const realmRow = await trx.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
    const realmMetadata = (realmRow?.metadata ?? {}) as Record<string, unknown>
    const defaultPlanId = typeof realmMetadata.default_plan_id === 'string' ? realmMetadata.default_plan_id : null

    const plan = defaultPlanId
      ? await trx
          .selectFrom('billing_plans')
          .select(['plan_id'])
          .where('realm_id', '=', realmId)
          .where('plan_id', '=', defaultPlanId)
          .where('active', '=', true)
          .executeTakeFirst()
      : await trx
          .selectFrom('billing_plans')
          .select(['plan_id'])
          .where('realm_id', '=', realmId)
          .where('plan_code', '=', 'default_billing_plan')
          .where('active', '=', true)
          .executeTakeFirst()

    if (!plan?.plan_id) {
      // No default plan defined; skip silently.
      return
    }

    await ensureBillingPlanAssignment(trx, {
      billingAccountId,
      planId: String(plan.plan_id),
      sourceKind: 'signup.default',
      sourceRef: defaultPlanId ? 'default_plan_id' : 'default_billing_plan',
      windowStart: new Date(),
      windowEnd: null,
      status: 'active',
      metadata: { reason: 'account_signup' },
    })

    await ensureBillingPlanGrantsEnrollmentSynced(trx, billingAccountId)
    await refreshBillingAccountState(trx, billingAccountId)
    await issueGrantsForAccount(trx, billingAccountId)
  })
}
