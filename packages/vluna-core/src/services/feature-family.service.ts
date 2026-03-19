import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../types/database.js'

const FALLBACK_CODE = 'auto.registry'

function normalizeCode(input: string | undefined | null): string | null {
  const code = (input ?? '').trim()
  if (!code) return null
  return code
}

export async function ensureFeatureFamilyForAutoRegistration(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
  featureFamilyCode?: string | null,
): Promise<string> {
  const normalizedCode = normalizeCode(featureFamilyCode)
  if (!normalizedCode) {
    return ensureFallbackFeatureFamily(trx, realmId)
  }

  const existing = await trx
    .selectFrom('feature_families')
    .select(['feature_family_id'])
    .where('realm_id', '=', realmId)
    .where('feature_family_code', '=', normalizedCode)
    .limit(1)
    .executeTakeFirst()
  if (existing?.feature_family_id) {
    await trx
      .updateTable('feature_families')
      .set({
        is_fallback: false,
        entitlement_required: false,
        active: true,
        metadata: { auto: true, source: 'authorize' },
      })
      .where('feature_family_id', '=', existing.feature_family_id)
      .executeTakeFirst()
    return String(existing.feature_family_id)
  }

  const inserted = await trx
    .insertInto('feature_families')
    .values({
      realm_id: realmId,
      feature_family_code: normalizedCode,
      is_fallback: false,
      name: normalizedCode,
      description: 'Auto-registered feature_family',
      active: true,
      entitlement_required: false,
      metadata: { auto: true, source: 'authorize' },
    })
    .returning('feature_family_id')
    .onConflict((oc) =>
      oc.columns(['realm_id', 'feature_family_code']).doUpdateSet({
        is_fallback: false,
        entitlement_required: false,
        active: true,
        metadata: { auto: true, source: 'authorize' },
        updated_at: new Date(),
      }),
    )
    .executeTakeFirstOrThrow()

  return String(inserted.feature_family_id)
}

export async function ensureFallbackFeatureFamily(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<string> {
  // Prefer existing fallback marker.
  const existingFallback = await trx
    .selectFrom('feature_families')
    .select(['feature_family_id'])
    .where('realm_id', '=', realmId)
    .where('is_fallback', '=', true)
    .executeTakeFirst()
  if (existingFallback?.feature_family_id) {
    return String(existingFallback.feature_family_id)
  }

  // Reuse a feature_family with the canonical code, upgrading it to fallback.
  const existingByCode = await trx
    .selectFrom('feature_families')
    .select(['feature_family_id'])
    .where('realm_id', '=', realmId)
    .where('feature_family_code', '=', FALLBACK_CODE)
    .executeTakeFirst()

  if (existingByCode?.feature_family_id) {
    await trx
      .updateTable('feature_families')
      .set({
        is_fallback: true,
        entitlement_required: false,
        active: true,
        metadata: { auto: true, fallback: true },
      })
      .where('feature_family_id', '=', existingByCode.feature_family_id)
      .executeTakeFirst()
    return String(existingByCode.feature_family_id)
  }

  // Create a fresh fallback feature_family.
  const inserted = await trx
    .insertInto('feature_families')
    .values({
      realm_id: realmId,
      feature_family_code: FALLBACK_CODE,
      is_fallback: true,
      name: 'Auto registry fallback',
      description: 'Fallback feature_family used for auto-registered features',
      active: true,
      entitlement_required: false,
      metadata: { auto: true, fallback: true },
    })
    .returning('feature_family_id')
    .executeTakeFirstOrThrow()

  return String(inserted.feature_family_id)
}

export function fallbackFeatureFamilyCode(): string {
  return FALLBACK_CODE
}
