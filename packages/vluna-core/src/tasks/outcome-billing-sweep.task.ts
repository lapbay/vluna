import { Inject, Injectable, Logger } from '@nestjs/common'
import { db, REALM_ADMIN_PLACEHOLDER_ACCOUNT, setRlsSession } from '../db/index.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { EventToRatingsService } from '../features/billing/services/event-to-ratings.service.js'

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

type OutcomeBillingMode = 'event' | 'aggregate'

const MODE: OutcomeBillingMode = 'aggregate' as OutcomeBillingMode

const DEFAULT_INTERVAL_MS =
  MODE === 'aggregate'
    ? readPositiveInt(process.env.VLUNA_OUTCOME_BILLING_AGGREGATION_SWEEP_INTERVAL_MS, 10_000)
    : readPositiveInt(process.env.VLUNA_OUTCOME_BILLING_SWEEP_INTERVAL_MS, 2_000)

const DEFAULT_BATCH_LIMIT = readPositiveInt(process.env.VLUNA_OUTCOME_BILLING_SWEEP_BATCH_LIMIT, 100)

@Injectable()
export class OutcomeBillingSweepTask implements PeriodicTaskDefinition {
  readonly name = 'outcome-billing-sweep'
  readonly intervalMs = DEFAULT_INTERVAL_MS
  readonly runOnStart = false

  private readonly logger = new Logger(OutcomeBillingSweepTask.name)

  constructor(
    @Inject(EventToRatingsService) private readonly eventToRatingsService: EventToRatingsService,
  ) {}

  async run(): Promise<void> {
    const dbHandle = db()
    const realms = await dbHandle
      .selectFrom('realms')
      .select(['realm_id'])
      .where('status', '=', 'active')
      .orderBy('realm_id', 'asc')
      .execute()

    if (MODE === 'aggregate') {
      let groupsConsidered = 0
      let ratingsEmitted = 0
      let linksInserted = 0

      for (const row of realms) {
        const realmId = String(row.realm_id)
        const stats = await dbHandle.transaction().execute(async (trx) => {
          await setRlsSession(trx, {
            realmId,
            billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT,
            isRealmAdmin: true,
          })
          return this.eventToRatingsService.aggregateOutcomeEventsForRealm(trx, { realmId })
        })

        groupsConsidered += stats.groupsConsidered
        ratingsEmitted += stats.ratingsEmitted
        linksInserted += stats.linksInserted
      }

      if (groupsConsidered === 0) {
        this.logger.debug('Outcome billing sweep (mode=aggregate) had no eligible groups')
        return
      }

      this.logger.log(
        `Outcome billing sweep completed (mode=aggregate groups=${groupsConsidered} ratings=${ratingsEmitted} links=${linksInserted})`,
      )
      return
    }

    let attempted = 0
    let processed = 0
    let failed = 0
    let skipped = 0

    for (const row of realms) {
      const realmId = String(row.realm_id)
      const stats = await dbHandle.transaction().execute(async (trx) => {
        await setRlsSession(trx, {
          realmId,
          billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT,
          isRealmAdmin: true,
        })
        return this.eventToRatingsService.processNextBatch(
          trx,
          { realmId, billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT },
          { limit: DEFAULT_BATCH_LIMIT, lockOwner: `outcome-billing-sweep:${realmId}`, asRealmAdmin: true },
        )
      })

      attempted += stats.attempted
      processed += stats.processed
      failed += stats.failed
      skipped += stats.skipped
    }

    if (attempted === 0) {
      this.logger.debug('Outcome billing sweep (mode=event) had no pending work')
      return
    }

    this.logger.log(`Outcome billing sweep completed (mode=event attempted=${attempted} processed=${processed} failed=${failed} skipped=${skipped})`)
  }
}
