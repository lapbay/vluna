import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PERIODIC_TASKS, type PeriodicTaskDefinition } from './periodic-task.types.js'

type TaskState = {
  running: boolean
  skippedRuns: number
  lastStartedAt?: Date
  lastFinishedAt?: Date
  lastDurationMs?: number
  lastError?: unknown
}

@Injectable()
export class PeriodicTaskRunner implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(PeriodicTaskRunner.name)
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly states = new Map<string, TaskState>()

  constructor(
    @Inject(PERIODIC_TASKS) private readonly tasks: PeriodicTaskDefinition[] = [],
  ) {}

  onModuleInit(): void {
    if (!this.tasks || this.tasks.length === 0) {
      this.logger.debug('No periodic tasks registered; runner idle')
      return
    }

    for (const task of this.tasks) {
      if (!task || typeof task.run !== 'function') continue
      const interval = Number(task.intervalMs)
      if (!Number.isFinite(interval) || interval <= 0) {
        this.logger.warn(`Task "${task.name}" has invalid interval (${task.intervalMs}); skipping registration`)
        continue
      }
      this.states.set(task.name, { running: false, skippedRuns: 0 })
      if (task.runOnStart !== false) {
        void this.executeTask(task)
      } else {
        this.scheduleNext(task)
      }
    }
  }

  onModuleDestroy(): void {
    this.stopAll()
  }

  onApplicationShutdown(): void {
    this.stopAll()
  }

  private stopAll(): void {
    for (const [, timer] of this.timers.entries()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private scheduleNext(task: PeriodicTaskDefinition, delayMs?: number): void {
    const interval = delayMs ?? task.intervalMs
    if (!Number.isFinite(interval) || interval <= 0) return
    const existing = this.timers.get(task.name)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      void this.executeTask(task)
    }, interval)

    this.timers.set(task.name, timer)
  }

  private async executeTask(task: PeriodicTaskDefinition): Promise<void> {
    const state = this.states.get(task.name)
    if (!state) return
    if (state.running) {
      state.skippedRuns += 1
      this.logger.warn(`Skipping task "${task.name}" run; previous execution still in progress`)
      this.scheduleNext(task)
      return
    }

    state.running = true
    state.lastStartedAt = new Date()
    const startedAt = Date.now()

    try {
      await Promise.resolve(task.run())
      state.lastFinishedAt = new Date()
      state.lastDurationMs = Date.now() - startedAt
      state.lastError = undefined
      if (state.skippedRuns > 0) {
        this.logger.warn(`Task "${task.name}" completed after ${state.skippedRuns} skipped runs`)
        state.skippedRuns = 0
      } else {
        this.logger.debug(`Task "${task.name}" completed in ${state.lastDurationMs}ms`)
      }
    } catch (err) {
      state.lastError = err
      this.logger.error(`Task "${task.name}" failed: ${(err as Error)?.message ?? err}`)
    } finally {
      state.running = false
      this.scheduleNext(task)
    }
  }
}
