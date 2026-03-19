import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import { createHash } from 'node:crypto'
import type { Database } from '../../../types/database.js'

type Db = Kysely<Database> | Transaction<Database>

export type ReconciliationScanParams = {
  realmId?: string
  billingAccountId?: string
  limit?: number
  dryRun?: boolean
}

export type ReconciliationScanResult = {
  ok: true
  scannedSnapshots: number
  producedFindings: number
  upsertedFindings: number
}

type JsonObject = Record<string, unknown>
type ReconciliationFindingUpsert = {
  billing_account_id: string
  kind: 'usage_mismatch' | 'status_mismatch' | 'invoice_total_mismatch'
  status: 'pending'
  fingerprint: string
  diff: JsonObject
  provider_state_snapshot_id: string
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number' || t === 'boolean') return JSON.stringify(value)
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!isPlainObject(value)) return JSON.stringify(String(value))
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b))
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
  return `{${entries.join(',')}}`
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function readString(obj: unknown, key: string): string | undefined {
  if (!isPlainObject(obj)) return undefined
  const v = obj[key]
  if (typeof v === 'string' && v.trim()) return v
  return undefined
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return undefined
}

function buildFingerprintInput(params: {
  type: 'internal' | 'external'
  kind: string
  subject: JsonObject
  provider: { name: string; entity_kind: string; entity_id: string }
  delta: JsonObject
}): JsonObject {
  return {
    type: params.type,
    kind: params.kind,
    subject: params.subject,
    provider: params.provider,
    delta: params.delta,
  }
}

function computeFingerprint(params: {
  type: 'internal' | 'external'
  kind: string
  subject: JsonObject
  provider: { name: string; entity_kind: string; entity_id: string }
  delta: JsonObject
}): string {
  const canonical = stableStringify(buildFingerprintInput(params))
  return `sha256:${sha256Hex(canonical)}`
}

function clampLimit(raw: unknown, fallback = 500, max = 5000): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

type SubscriptionStatusMismatchRow = {
  billing_account_id: string
  provider: string
  entity_kind: string
  entity_id: string
  snapshot_id: string
  fetched_at: Date
  json: unknown
  subscription_id: string
  local_status: string
  local_updated_at: Date | null
}

async function scanSubscriptionStatusMismatches(trx: Db, params: Required<Pick<ReconciliationScanParams, 'limit'>> & ReconciliationScanParams): Promise<{
  scannedSnapshots: number
  findings: ReconciliationFindingUpsert[]
}> {
  let query = trx
    .selectFrom('provider_state_snapshots as pss')
    .innerJoin('provider_subscription_links as psl', (join) =>
      join.onRef('psl.provider', '=', 'pss.provider').onRef('psl.external_subscription_id', '=', 'pss.entity_id'),
    )
    .innerJoin('subscriptions as s', 's.subscription_id', 'psl.subscription_id')
    .select([
      'pss.billing_account_id',
      'pss.provider',
      'pss.entity_kind',
      'pss.entity_id',
      'pss.snapshot_id',
      'pss.fetched_at',
      'pss.json',
      's.subscription_id',
      's.status as local_status',
      's.updated_at as local_updated_at',
    ])
    .where('pss.entity_kind', '=', 'subscription')
    .where('pss.provider', '=', 'stripe')
    .orderBy('pss.fetched_at', 'desc')
    .limit(params.limit)

  if (params.billingAccountId) {
    query = query.where('pss.billing_account_id', '=', params.billingAccountId.trim())
  }

  if (params.realmId) {
    query = query
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'pss.billing_account_id')
      .where('ba.realm_id', '=', params.realmId.trim())
  }

  const rows = (await query.execute()) as unknown as SubscriptionStatusMismatchRow[]

  const findings: ReconciliationFindingUpsert[] = []

  for (const row of rows) {
    const providerStatus = readString(row.json, 'status') || readString(row.json, 'subscription_status')
    if (!providerStatus) continue
    const localStatus = String(row.local_status || '')
    if (!localStatus) continue
    if (providerStatus === localStatus) continue

    const subject: JsonObject = {
      billing_account_id: row.billing_account_id,
      entity_kind: 'subscription',
      entity_id: row.entity_id,
    }

    const delta: JsonObject = { status_changed: true }
    const fingerprint = computeFingerprint({
      type: 'external',
      kind: 'status_mismatch',
      subject,
      provider: { name: row.provider, entity_kind: 'subscription', entity_id: row.entity_id },
      delta,
    })

    const diff: JsonObject = {
      schema_version: 'recon.finding.v1',
      type: 'external',
      kind: 'status_mismatch',
      subject,
      evidence: {
        provider: {
          name: row.provider,
          entity_kind: 'subscription',
          entity_id: row.entity_id,
          snapshot_id: row.snapshot_id,
          fetched_at: toIso(row.fetched_at),
        },
        local: {
          source: 'db',
          as_of: new Date().toISOString(),
          ids: [row.subscription_id],
        },
        rules: {},
      },
      comparison: {
        expected: { local_status: localStatus, local_updated_at: toIso(row.local_updated_at) },
        actual: { provider_status: providerStatus },
        delta,
      },
      impact: {
        severity: 'warn',
        count: 1,
        notes: ['provider vs local subscription status mismatch'],
      },
      suggested_actions: [
        { type: 'refetch_provider_snapshot', params: { provider: row.provider, entity_kind: 'subscription', entity_id: row.entity_id }, reason: 'confirm provider state' },
        { type: 'resync_local_mirror', params: { entity_kind: 'subscription', entity_id: row.entity_id }, reason: 'local mirror drift' },
      ],
      fingerprint,
    }

    findings.push({
      billing_account_id: row.billing_account_id,
      kind: 'status_mismatch',
      status: 'pending',
      fingerprint,
      diff,
      provider_state_snapshot_id: row.snapshot_id,
    })
  }

  return { scannedSnapshots: rows.length, findings }
}

async function upsertFindings(trx: Db, findings: ReconciliationFindingUpsert[]): Promise<number> {
  if (findings.length === 0) return 0
  const now = new Date()

  await trx
    .insertInto('reconciliations')
    .values(
      findings.map((f) => ({
        billing_account_id: f.billing_account_id,
        kind: f.kind,
        status: f.status,
        fingerprint: f.fingerprint,
        diff: f.diff,
        provider_state_snapshot_id: f.provider_state_snapshot_id,
        created_at: now,
        resolved_at: null,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['billing_account_id', 'kind', 'fingerprint']).doUpdateSet({
        status: sql`'pending'`,
        diff: sql`excluded.diff`,
        provider_state_snapshot_id: sql`excluded.provider_state_snapshot_id`,
        resolved_at: sql`null`,
      }),
    )
    .execute()

  return findings.length
}

export async function scanAndUpsertReconciliations(trx: Db, params: ReconciliationScanParams): Promise<ReconciliationScanResult> {
  const limit = clampLimit(params.limit)

  const { scannedSnapshots, findings } = await scanSubscriptionStatusMismatches(trx, { ...params, limit })
  const producedFindings = findings.length

  if (params.dryRun) {
    return { ok: true, scannedSnapshots, producedFindings, upsertedFindings: 0 }
  }

  const upsertedFindings = await upsertFindings(trx, findings)
  return { ok: true, scannedSnapshots, producedFindings, upsertedFindings }
}
