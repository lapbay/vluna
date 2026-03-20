import { describe, it, expect } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/types/database.js'
import { createRealm, DEFAULT_BUNDLE_KEY, BASE_POLICY_NAME } from '../../src/services/realm.service.js'

type RealmRow = {
  realm_id: string
  name: string
  status: 'active' | 'suspended' | 'deleted'
  metadata: Record<string, unknown>
}

type GrantProgramRow = {
  realm_id: string
  program_code: string
  name: string
  active: boolean
  cadence: string
  issue_anchor: string
  amount_xusd: string
  window_kind: string
  window_default_seconds: number
  priority: number
  on_ledger: boolean
  issuance_mode: string
  periodic_accounting: boolean
  accrual_mode: string | null
  metadata: Record<string, unknown>
}

type GatePolicyRow = {
  realm_id: string
  bundle_id: string
  name: string
  feature_code: string
  kind: 'quota' | 'rate'
  unit: string
  window_sec: number
  limit_count: number | null
  limit_minor: number | null
  status: 'default' | 'assignable' | 'ceiling' | 'disabled'
  enforcement_mode: 'optimistic' | 'reserve'
  metadata: Record<string, unknown>
}

type GatePolicyBundleRow = {
  bundle_id: string
  realm_id: string
  bundle_key: string
  name: string | null
  status: 'active' | 'disabled'
  metadata: Record<string, unknown>
}

type FeatureFamilyRow = {
  feature_family_id: string
  realm_id: string
  feature_family_code: string
  is_fallback: boolean
  name: string
  description: string
  active: boolean
  entitlement_required: boolean
  metadata: Record<string, unknown>
}

type ServiceApiKeyRow = {
  key_id: string
  status: string
  allowed_realms: string[]
  allowed_accounts: string[]
  scopes: string[]
  kdf_alg: string
  kdf_salt: unknown
  kdf_version: number
  env_tag: string
  expires_at: Date | null
  last_used_at: Date | null
}

type SelectResult = {
  select: () => SelectResult
  where: (c: string, op: string, v: unknown) => SelectResult
  limit: (_n: number) => SelectResult
  executeTakeFirst: () => unknown
  executeTakeFirstOrThrow: () => unknown
  execute: () => unknown[]
}
type InsertResult = {
  values: (row: Record<string, unknown>) => InsertResult
  onConflict: (_fn: unknown) => InsertResult
  returning: (_col: string) => InsertResult
  executeTakeFirst: () => Promise<unknown>
  executeTakeFirstOrThrow: () => Promise<unknown>
}
type UpdateResult = {
  set: (row: Record<string, unknown>) => UpdateResult
  where: (c: string, op: string, v: unknown) => UpdateResult
  executeTakeFirst: () => Promise<unknown>
}

type FakeDbShape = {
  realms: RealmRow[]
  grantPrograms: GrantProgramRow[]
  gatePolicies: GatePolicyRow[]
  gatePolicyBundles: GatePolicyBundleRow[]
  feature_families: FeatureFamilyRow[]
  serviceApiKeys: ServiceApiKeyRow[]
  selectFrom: (table: string) => SelectResult
  insertInto: (table: string) => InsertResult
  updateTable: (table: string) => UpdateResult
  transaction: () => { execute: (cb: (t: unknown) => unknown) => unknown }
}

// Minimal in-memory stub sufficient for createRealm; typed surface keeps eslint happy.
function makeFakeDb(): FakeDbShape {
  const realms: RealmRow[] = []
  const grantPrograms: GrantProgramRow[] = []
  const gatePolicies: GatePolicyRow[] = []
  const gatePolicyBundles: GatePolicyBundleRow[] = []
  const feature_families: FeatureFamilyRow[] = []
  const serviceApiKeys: ServiceApiKeyRow[] = []
  let bundleSeq = 1
  let feature_familySeq = 1

  const selectFrom = (table: string): SelectResult => {
    let where: { column: string; value: unknown } | undefined
    return {
      select() {
        return this
      },
      where(column: string, _op: string, value: unknown) {
        where = { column, value }
        return this
      },
      limit(_n: number) {
        return this
      },
      executeTakeFirst() {
        let rows: Array<RealmRow | GrantProgramRow | GatePolicyRow | GatePolicyBundleRow | FeatureFamilyRow | ServiceApiKeyRow> = []
        if (table === 'realms') {
          rows = realms
        } else if (table === 'grant_programs') {
          rows = grantPrograms
        } else if (table === 'gate_policies') {
          rows = gatePolicies
        } else if (table === 'gate_policy_bundles') {
          rows = gatePolicyBundles
        } else if (table === 'feature_families') {
          rows = feature_families
        } else if (table === 'service_api_keys') {
          rows = serviceApiKeys
        }
        const match = where ? rows.find((r) => (r as Record<string, unknown>)[where!.column] === where!.value) : rows[0]
        return match ? { ...match } : undefined
      },
      executeTakeFirstOrThrow() {
        const result = this.executeTakeFirst()
        if (!result) throw new Error('not found')
        return result
      },
      execute() {
        let rows: Array<RealmRow | GrantProgramRow | GatePolicyRow | GatePolicyBundleRow | FeatureFamilyRow | ServiceApiKeyRow> = []
        if (table === 'realms') {
          rows = realms
        } else if (table === 'grant_programs') {
          rows = grantPrograms
        } else if (table === 'gate_policies') {
          rows = gatePolicies
        } else if (table === 'gate_policy_bundles') {
          rows = gatePolicyBundles
        } else if (table === 'feature_families') {
          rows = feature_families
        } else if (table === 'service_api_keys') {
          rows = serviceApiKeys
        }
        return rows.map((r) => ({ ...r }))
      },
    }
  }

  const insertInto = (table: string): InsertResult => {
    let row: Record<string, unknown> | undefined
    let wantsReturning = false
    let returningCol: string | undefined
    return {
      values(rowInput: Record<string, unknown>) {
        row = rowInput
        return this
      },
      onConflict(_fn: unknown) {
        return this
      },
      returning(col: string) {
        wantsReturning = true
        returningCol = col
        return this
      },
      async executeTakeFirst() {
        const payload = { ...(row ?? {}) }
        if (table === 'realms') {
          const idx = realms.findIndex((r) => r.realm_id === (row as RealmRow).realm_id)
          if (idx >= 0) {
            realms[idx] = { ...realms[idx], ...(payload as RealmRow) }
            return realms[idx]
          }
          realms.push(payload as RealmRow)
          return realms[realms.length - 1]
        }

        if (table === 'grant_programs') {
          const idx = grantPrograms.findIndex(
            (r) => r.realm_id === (row as GrantProgramRow).realm_id && r.program_code === (row as GrantProgramRow).program_code,
          )
          if (idx >= 0) {
            grantPrograms[idx] = { ...grantPrograms[idx], ...(payload as GrantProgramRow) }
            return grantPrograms[idx]
          }
          grantPrograms.push(payload as GrantProgramRow)
          return grantPrograms[grantPrograms.length - 1]
        }

        if (table === 'gate_policies') {
          const idx = gatePolicies.findIndex(
            (r) => r.realm_id === (row as GatePolicyRow).realm_id && r.name === (row as GatePolicyRow).name,
          )
          if (idx >= 0) {
            gatePolicies[idx] = { ...gatePolicies[idx], ...(payload as GatePolicyRow) }
            return gatePolicies[idx]
          }
          gatePolicies.push(payload as GatePolicyRow)
          return gatePolicies[gatePolicies.length - 1]
        }

        if (table === 'gate_policy_bundles') {
          const incoming = payload as GatePolicyBundleRow
          const idx = gatePolicyBundles.findIndex(
            (r) => r.realm_id === incoming.realm_id && r.bundle_key === incoming.bundle_key,
          )
          if (idx >= 0) {
            gatePolicyBundles[idx] = { ...gatePolicyBundles[idx], ...incoming }
            return gatePolicyBundles[idx]
          }
          gatePolicyBundles.push({
            ...incoming,
            bundle_id: incoming.bundle_id || String(bundleSeq++),
          })
          return gatePolicyBundles[gatePolicyBundles.length - 1]
        }

        if (table === 'feature_families') {
          const incoming = payload as FeatureFamilyRow
          const idx = feature_families.findIndex(
            (r) => r.realm_id === incoming.realm_id && r.feature_family_code === incoming.feature_family_code,
          )
          if (idx >= 0) {
            feature_families[idx] = { ...feature_families[idx], ...incoming }
            return wantsReturning && returningCol
              ? { [returningCol]: (feature_families[idx] as Record<string, unknown>)[returningCol] }
              : feature_families[idx]
          }
          const record: FeatureFamilyRow = {
            feature_family_id: incoming.feature_family_id || String(feature_familySeq++),
            realm_id: incoming.realm_id,
            feature_family_code: incoming.feature_family_code,
            is_fallback: (incoming as FeatureFamilyRow).is_fallback ?? false,
            name: incoming.name,
            description: incoming.description,
            active: (incoming as FeatureFamilyRow).active ?? true,
            entitlement_required: (incoming as FeatureFamilyRow).entitlement_required ?? false,
            metadata: (incoming as FeatureFamilyRow).metadata ?? {},
          }
          feature_families.push(record)
          return wantsReturning && returningCol ? { [returningCol]: (record as Record<string, unknown>)[returningCol] } : record
        }

        if (table === 'service_api_keys') {
          const incoming = payload as ServiceApiKeyRow
          const idx = serviceApiKeys.findIndex((r) => r.key_id === incoming.key_id)
          if (idx >= 0) {
            serviceApiKeys[idx] = { ...serviceApiKeys[idx], ...incoming }
            return serviceApiKeys[idx]
          }
          serviceApiKeys.push(incoming)
          return serviceApiKeys[serviceApiKeys.length - 1]
        }

        return payload
      },
      async executeTakeFirstOrThrow() {
        const res = await this.executeTakeFirst()
        if (!res) throw new Error('not found')
        return res
      },
    }
  }

  const updateTable = (table: string): UpdateResult => {
    let update: Record<string, unknown> | undefined
    let where: { column: string; value: unknown } | undefined
    return {
      set(updateInput: Record<string, unknown>) {
        update = updateInput
        return this
      },
      where(column: string, _op: string, value: unknown) {
        where = { column, value }
        return this
      },
      async executeTakeFirst() {
        if (table === 'realms') {
          const idx = realms.findIndex((r) => (where ? (r as Record<string, unknown>)[where.column] === where.value : false))
          if (idx >= 0) {
            realms[idx] = { ...realms[idx], ...(update ?? {}) } as RealmRow
            return { ...realms[idx] }
          }
          return undefined
        }
        if (table === 'grant_programs') {
          const idx = grantPrograms.findIndex((r) =>
            where ? (r as Record<string, unknown>)[where.column] === where.value : false,
          )
          if (idx >= 0) {
            grantPrograms[idx] = { ...grantPrograms[idx], ...(update ?? {}) } as GrantProgramRow
            return { ...grantPrograms[idx] }
          }
        }
        if (table === 'feature_families') {
          const idxCap = feature_families.findIndex((r) =>
            where ? (r as Record<string, unknown>)[where.column] === where.value : false,
          )
          if (idxCap >= 0) {
            feature_families[idxCap] = { ...feature_families[idxCap], ...(update ?? {}) } as FeatureFamilyRow
            return { ...feature_families[idxCap] }
          }
        }
        return undefined
      },
    }
  }

  const transaction = () => ({
    execute: (cb: (t: unknown) => unknown) => cb(fakeDb),
  })

  const fakeDb = {
    realms,
    grantPrograms,
    gatePolicies,
    gatePolicyBundles,
    feature_families,
    serviceApiKeys,
    selectFrom,
    insertInto,
    updateTable,
    transaction,
  }
  return fakeDb
}

describe('createRealm baseline provisioning', { tags: ['unit'] }, () => {
  it('creates realm and baseline grant programs when missing', async () => {
    const db = makeFakeDb()
    await createRealm(db as unknown as Kysely<Database>, { realmId: 'r1', name: 'Realm 1' })

    expect(db.realms).toHaveLength(1)
    expect(db.realms[0].realm_id).toBe('r1')

    const grantPrograms = db.grantPrograms as GrantProgramRow[]
    const programCodes = grantPrograms.map((p) => p.program_code).sort()
    expect(programCodes).toEqual([
      'daily_xusd',
      'monthly_xusd',
      'one_time_xusd',
      'period_xusd',
      'quarterly_xusd',
      'weekly_xusd',
      'yearly_xusd',
    ])

    const oneTime = grantPrograms.find((p) => p.program_code === 'one_time_xusd')!
    expect(oneTime.window_kind).toBe('fixed')
    expect(oneTime.issuance_mode).toBe('eager')
    expect(oneTime.accrual_mode).toBe('full_at_period_start')

    expect(db.gatePolicyBundles).toHaveLength(1)
    expect(db.gatePolicyBundles[0].bundle_key).toBe(DEFAULT_BUNDLE_KEY)
    expect(db.gatePolicyBundles[0].status).toBe('active')

    expect(db.gatePolicies).toHaveLength(1)
    expect(db.gatePolicies[0].feature_code).toBe('__wildcard_feature__')
    expect(db.gatePolicies[0].limit_minor).toBe(-1)
    expect(db.gatePolicies[0].bundle_id).toBe(db.gatePolicyBundles[0].bundle_id)

    expect(db.serviceApiKeys).toHaveLength(0)
  })

  it('is idempotent and updates realm metadata', async () => {
    const db = makeFakeDb()
    await createRealm(db as unknown as Kysely<Database>, { realmId: 'r1', name: 'Realm 1' })
    await createRealm(db as unknown as Kysely<Database>, {
      realmId: 'r1',
      name: 'Realm 1b',
      status: 'suspended',
      metadata: { a: 1 },
    })

    expect(db.realms).toHaveLength(1)
    expect(db.realms[0].name).toBe('Realm 1b')
    expect(db.realms[0].status).toBe('suspended')
    expect(db.realms[0].metadata).toEqual({ a: 1 })

    const grantPrograms = db.grantPrograms as GrantProgramRow[]
    const programs = grantPrograms.filter((p) => p.realm_id === 'r1')
    expect(programs).toHaveLength(7)

    expect(db.gatePolicies).toHaveLength(1)
    expect(db.gatePolicies[0].name).toBe(BASE_POLICY_NAME)
    expect(db.gatePolicyBundles).toHaveLength(1)

    expect(db.serviceApiKeys).toHaveLength(0)
  })
})
