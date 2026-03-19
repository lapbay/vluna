import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Transaction } from 'kysely'
import { db, REALM_ADMIN_PLACEHOLDER_ACCOUNT, setRlsSession } from '../db/index.js'
import type { Database } from '../types/database.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { SettlementService, type BudgetSettlementCandidate } from '../features/gate/services/settlement.service.js'

const DEFAULT_INTERVAL_MS = readPositiveInt(process.env.VLUNA_SETTLEMENT_SWEEP_INTERVAL_MS, 60_000)
const DEFAULT_ROLLING_GUARD_MS = readPositiveInt(process.env.VLUNA_SETTLEMENT_ROLLING_GUARD_MS, 2 * 60_000)
const DEFAULT_ROLLING_LIMIT = readPositiveInt(process.env.VLUNA_SETTLEMENT_ROLLING_LIMIT, 250)
const DEFAULT_ROLLING_MAX_ITERATIONS = readPositiveInt(process.env.VLUNA_SETTLEMENT_ROLLING_MAX_ITERATIONS, 5)
const DEFAULT_ROLLING_ACCOUNT_LIMIT = readPositiveInt(process.env.VLUNA_SETTLEMENT_ROLLING_ACCOUNT_LIMIT, 50)
const DEFAULT_BUDGET_IDLE_MS = readPositiveInt(process.env.VLUNA_SETTLEMENT_BUDGET_IDLE_MS, 10 * 60_000)
const DEFAULT_BUDGET_BATCH_LIMIT = readPositiveInt(process.env.VLUNA_SETTLEMENT_BUDGET_BATCH_LIMIT, 200)
const DEFAULT_BUDGET_MAX_ITERATIONS = readPositiveInt(process.env.VLUNA_SETTLEMENT_BUDGET_MAX_ITERATIONS, 5)
const DEFAULT_BUDGETS_PER_RUN = readPositiveInt(process.env.VLUNA_SETTLEMENT_BUDGETS_PER_RUN, 20)
const DEFAULT_BUDGET_CANDIDATE_LIMIT = readPositiveInt(process.env.VLUNA_SETTLEMENT_BUDGET_CANDIDATE_LIMIT, 200)

type BudgetStatus = 'active' | 'closing' | 'closed' | 'expired' | 'canceled'

@Injectable()
export class SettlementSweepTask implements PeriodicTaskDefinition {
  readonly name = 'settlement-sweep'
  readonly intervalMs = DEFAULT_INTERVAL_MS
  readonly runOnStart = false

  private readonly logger = new Logger(SettlementSweepTask.name)

  constructor(
    @Inject(SettlementService) private readonly settlementService: SettlementService,
  ) {}

  async run(): Promise<void> {
    const dbHandle = db()
    const now = new Date()

    const rollingStats = await this.runRollingSweeps(dbHandle, now)
    const budgetStats = await this.runBudgetSweeps(dbHandle, now)

    if (rollingStats.claimed === 0 && budgetStats.claimed === 0) {
      this.logger.debug('Settlement sweep had no pending work')
      return
    }

    const summary: string[] = []
    if (rollingStats.claimed > 0) {
      summary.push(`rolling claimed=${rollingStats.claimed} settled=${rollingStats.settled}`)
    }
    if (budgetStats.claimed > 0) {
      summary.push(`budgets processed=${budgetStats.processed} claimed=${budgetStats.claimed} settled=${budgetStats.settled}`)
    }
    this.logger.log(`Settlement sweep completed (${summary.join('; ')})`)
  }

  private async runRollingSweeps(
    dbHandle: ReturnType<typeof db>,
    now: Date,
  ): Promise<{ claimed: number; settled: number }> {
    const guardThreshold = new Date(now.getTime() - DEFAULT_ROLLING_GUARD_MS)
    const realms = await this.listActiveRealms(dbHandle)
    let claimed = 0
    let settled = 0

    for (const realmId of realms) {
      const candidates = await this.withRealmAdminTransaction(dbHandle, realmId, REALM_ADMIN_PLACEHOLDER_ACCOUNT, (trx) =>
        this.settlementService.listRollingSettlementCandidates(trx, {
          realmId,
          guardThreshold,
          limit: DEFAULT_ROLLING_ACCOUNT_LIMIT,
        }),
      )

      for (const candidate of candidates) {
        for (let i = 0; i < DEFAULT_ROLLING_MAX_ITERATIONS; i += 1) {
          const result = await this.withRealmAdminTransaction(
            dbHandle,
            candidate.realmId,
            candidate.billingAccountId,
            (trx) =>
              this.settlementService.processRollingBatch(trx, {
                guardDurationMs: DEFAULT_ROLLING_GUARD_MS,
                limit: DEFAULT_ROLLING_LIMIT,
                now: new Date(now),
              }),
          )
          claimed += result.claimedCount
          settled += result.settledCount

          if (result.errors.length > 0) {
            const summary = result.errors.map((err) => `${err.billingAccountId}:${err.reason}`).join(', ')
            this.logger.error(`Rolling settlement failed for ${candidate.billingAccountId}: ${summary}`)
            break
          }

          if (result.claimedCount < DEFAULT_ROLLING_LIMIT) {
            break
          }
        }
      }
    }

    return { claimed, settled }
  }

  private async runBudgetSweeps(
    dbHandle: ReturnType<typeof db>,
    now: Date,
  ): Promise<{ processed: number; claimed: number; settled: number }> {
    const idleCutoff = new Date(now.getTime() - DEFAULT_BUDGET_IDLE_MS)
    const realms = await this.listActiveRealms(dbHandle)
    const closingStatuses: Set<BudgetStatus> = new Set(['closing', 'closed', 'expired', 'canceled'])

    let processed = 0
    let claimed = 0
    let settled = 0

    for (const realmId of realms) {
      const candidates = await this.withRealmAdminTransaction(dbHandle, realmId, REALM_ADMIN_PLACEHOLDER_ACCOUNT, (trx) =>
        this.settlementService.listBudgetSettlementCandidates(trx, {
          realmId,
          limit: DEFAULT_BUDGET_CANDIDATE_LIMIT,
          requireOnLedger: true,
        }),
      )

      const jobs = this.buildBudgetJobs(candidates, idleCutoff, closingStatuses).slice(0, DEFAULT_BUDGETS_PER_RUN)
      for (const job of jobs) {
        const result = await this.processBudgetJob(dbHandle, job, now)
        processed += 1
        claimed += result.claimed
        settled += result.settled
      }
    }

    return { processed, claimed, settled }
  }

  private buildBudgetJobs(
    candidates: BudgetSettlementCandidate[],
    idleCutoff: Date,
    closingStatuses: Set<BudgetStatus>,
  ): Array<{
    candidate: BudgetSettlementCandidate
    committedBefore: Date
    allowedStatuses: BudgetStatus[]
    engine: string
  }> {
    const jobs: Array<{
      candidate: BudgetSettlementCandidate
      committedBefore: Date
      allowedStatuses: BudgetStatus[]
      engine: string
    }> = []

    for (const candidate of candidates) {
      if (candidate.pendingOnLedgerCount <= 0) continue

      if (closingStatuses.has(candidate.status)) {
        const cutoff = candidate.closedAt ?? candidate.lastCommitAt ?? idleCutoff
        jobs.push({
          candidate,
          committedBefore: cutoff,
          allowedStatuses: Array.from(closingStatuses),
          engine: 'budget_exhausted',
        })
        continue
      }

      if (candidate.status === 'active') {
        const last = candidate.lastCommitAt ?? candidate.closedAt ?? candidate.oldestCommitAt ?? new Date(0)
        if (last <= idleCutoff) {
          jobs.push({
            candidate,
            committedBefore: idleCutoff,
            allowedStatuses: ['active', 'closing', 'closed'],
            engine: 'budget_idle',
          })
        }
      }
    }

    return jobs
  }

  private async processBudgetJob(
    dbHandle: ReturnType<typeof db>,
    job: { candidate: BudgetSettlementCandidate; committedBefore: Date; allowedStatuses: BudgetStatus[]; engine: string },
    now: Date,
  ): Promise<{ claimed: number; settled: number }> {
    let claimed = 0
    let settled = 0

    for (let i = 0; i < DEFAULT_BUDGET_MAX_ITERATIONS; i += 1) {
      const result = await this.withRealmAdminTransaction(
        dbHandle,
        job.candidate.realmId,
        job.candidate.billingAccountId,
        (trx) =>
          this.settlementService.processBudgetBatch(trx, {
            budgetId: job.candidate.budgetId,
            committedBefore: job.committedBefore,
            allowedStatuses: job.allowedStatuses,
            limit: DEFAULT_BUDGET_BATCH_LIMIT,
            engine: job.engine,
            scopeKey: `budget:${job.candidate.budgetId}`,
            now: new Date(now),
          }),
      )

      if (result.errors.length > 0) {
        const summary = result.errors.map((err) => `${err.billingAccountId}:${err.reason}`).join(', ')
        this.logger.error(`Budget settlement failed for ${job.candidate.budgetId}: ${summary}`)
        break
      }

      claimed += result.claimedCount
      settled += result.settledCount

      if (result.claimedCount < DEFAULT_BUDGET_BATCH_LIMIT) {
        break
      }
    }

    return { claimed, settled }
  }

  private async listActiveRealms(dbHandle: ReturnType<typeof db>): Promise<string[]> {
    const rows = await dbHandle
      .selectFrom('realms')
      .select(['realm_id'])
      .where('status', '=', 'active')
      .execute()

    if (rows.length > 0) {
      return rows.map((row) => String(row.realm_id))
    }

    return []
  }

  private async withRealmAdminTransaction<T>(
    dbHandle: ReturnType<typeof db>,
    realmId: string,
    billingAccountId: string,
    fn: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return dbHandle.transaction().execute(async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })
      return fn(trx)
    })
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}
