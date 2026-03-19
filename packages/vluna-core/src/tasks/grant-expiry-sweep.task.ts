import { Injectable, Logger } from '@nestjs/common'
import { db, setRlsSession } from '../db/index.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { closeGrants, markExpiredGrantsPendingClose } from '../services/grant-issuance.service.js'

const DEFAULT_INTERVAL_MS = (() => {
  const raw = process.env.VLUNA_GRANT_EXPIRY_SWEEP_INTERVAL_MS
  if (!raw) return 5 * 60 * 1000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5 * 60 * 1000
})()

const DEFAULT_BATCH_LIMIT = (() => {
  const raw = process.env.VLUNA_GRANT_EXPIRY_SWEEP_BATCH_LIMIT
  if (!raw) return 100
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100
})()

const MAX_ITERATIONS = 5

@Injectable()
export class GrantExpirySweepTask implements PeriodicTaskDefinition {
  readonly name = 'grant-expiry-sweep'
  readonly intervalMs = DEFAULT_INTERVAL_MS
  readonly runOnStart = false

  private readonly logger = new Logger(GrantExpirySweepTask.name)
  private readonly batchLimit = DEFAULT_BATCH_LIMIT

  async run(): Promise<void> {
    const dbHandle = db()
    const now = new Date()
    let totalMarked = 0
    let totalClosed = 0

    const realms = await dbHandle.selectFrom('realms').select('realm_id').where('status', '=', 'active').execute()
    if (realms.length === 0) {
      this.logger.debug('Grant expiry sweep had no active realms to inspect')
      return
    }

    for (const realm of realms) {
      for (let i = 0; i < MAX_ITERATIONS; i += 1) {
        const marked = await dbHandle.transaction().execute(async (trx) => {
          await setRlsSession(trx, { realmId: realm.realm_id, isRealmAdmin: true })
          return markExpiredGrantsPendingClose(trx, { now, limit: this.batchLimit, realmId: realm.realm_id })
        })
        totalMarked += marked

        const closed = await dbHandle.transaction().execute(async (trx) => {
          await setRlsSession(trx, { realmId: realm.realm_id, isRealmAdmin: true })
          return closeGrants(trx, { now, limit: this.batchLimit, realmId: realm.realm_id })
        })
        totalClosed += closed

        if (marked === 0 && closed === 0) {
          break
        }
        if (marked < this.batchLimit && closed < this.batchLimit) {
          break
        }
      }
    }

    if (totalMarked > 0 || totalClosed > 0) {
      this.logger.log(
        `Marked ${totalMarked} grants pending_close and closed ${totalClosed} grants at ${now.toISOString()}`,
      )
    }
  }
}
