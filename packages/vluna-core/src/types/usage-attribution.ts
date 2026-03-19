import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database.js'

export type UsageAttributionEntitlement = {
  assignmentId?: string | null
  planId?: string | null
  planCode?: string | null
  planKind?: string | null
}

export type UsageAttributionInput = {
  ratingId: string
  realmId: string
  billingAccountId: string
  featureCode: string
  ratedAt: Date
  entitlement?: UsageAttributionEntitlement | null
}

export interface UsageAttributionWriter {
  write(
    trx: Kysely<Database> | Transaction<Database>,
    input: UsageAttributionInput,
  ): Promise<void>
}

export const USAGE_ATTRIBUTION_WRITER = 'USAGE_ATTRIBUTION_WRITER'
