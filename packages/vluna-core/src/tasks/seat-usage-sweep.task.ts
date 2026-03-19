import { Inject, Injectable, Logger } from '@nestjs/common'
import { db } from '../db/index.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { SeatBillingService } from '../features/gate/services/seat-billing.service.js'

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const DEFAULT_SWEEP_INTERVAL_MS = readPositiveInt(process.env.VLUNA_SEAT_USAGE_BILLING_SWEEP_INTERVAL_MS, 60_000)
const DEFAULT_BILLING_INTERVAL_SEC = readPositiveInt(process.env.VLUNA_SEAT_USAGE_BILLING_INTERVAL_SEC, 24 * 60 * 60)

@Injectable()
export class SeatUsageSweepTask implements PeriodicTaskDefinition {
  readonly name = 'seat-usage-sweep'
  readonly intervalMs = DEFAULT_SWEEP_INTERVAL_MS
  readonly runOnStart = false

  private readonly logger = new Logger(SeatUsageSweepTask.name)

  constructor(
    @Inject(SeatBillingService) private readonly seatBillingService: SeatBillingService,
  ) {}

  async run(): Promise<void> {
    const dbHandle = db()
    const realms = await dbHandle
      .selectFrom('realms')
      .select(['realm_id'])
      .where('status', '=', 'active')
      .orderBy('realm_id', 'asc')
      .execute()

    if (realms.length === 0) {
      this.logger.debug('Seat usage billing sweep found no active realms')
      return
    }

    const asOf = new Date()
    let accountsConsidered = 0
    let ratingsEmitted = 0
    let skipped = 0
    let failed = 0

    for (const row of realms) {
      const realmId = String(row.realm_id)
      try {
        const stats = await this.seatBillingService.emitSeatUsageSnapshots(dbHandle, {
          realmId,
          asOf,
          intervalSec: DEFAULT_BILLING_INTERVAL_SEC,
        })
        accountsConsidered += stats.accountsConsidered
        ratingsEmitted += stats.ratingsEmitted
        skipped += stats.skipped
        failed += stats.failed
      } catch (error) {
        failed += 1
        this.logger.warn(`Seat usage billing sweep failed for realm=${realmId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.logger.log(`Seat usage billing sweep completed accounts=${accountsConsidered} emitted=${ratingsEmitted} skipped=${skipped} failed=${failed}`)
  }
}
