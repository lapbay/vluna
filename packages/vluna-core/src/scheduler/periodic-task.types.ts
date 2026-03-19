export interface PeriodicTaskDefinition {
  readonly name: string
  readonly intervalMs: number
  readonly runOnStart?: boolean
  run(): Promise<void> | void
}

export const PERIODIC_TASKS = Symbol('PERIODIC_TASKS')
export const PERIODIC_TASKS_ALL = Symbol('PERIODIC_TASKS_ALL')
