import type { RuntimeArgs } from '../platform/runtime-args.js'

export function selectPeriodicTasksByName<T extends { name: string }>(allTasks: T[], args: RuntimeArgs): T[] {
  const knownNames = new Set(allTasks.map((t) => t.name))

  for (const name of args.tasksInclude ?? []) {
    if (!knownNames.has(name)) {
      throw new Error(`Unknown task name in --tasks-include: ${name}`)
    }
  }
  for (const name of args.tasksExclude ?? []) {
    if (!knownNames.has(name)) {
      throw new Error(`Unknown task name in --tasks-exclude: ${name}`)
    }
  }

  const includeProvided = args.tasksInclude !== undefined
  const excludeProvided = args.tasksExclude !== undefined
  if (!includeProvided && !excludeProvided) {
    return []
  }

  const includeSet = includeProvided ? new Set(args.tasksInclude) : null
  const excludeSet = excludeProvided ? new Set(args.tasksExclude) : null

  const selected = includeProvided ? allTasks.filter((t) => includeSet?.has(t.name)) : allTasks.slice()
  if (!excludeProvided || (args.tasksExclude?.length ?? 0) === 0) {
    return selected
  }
  return selected.filter((t) => !excludeSet?.has(t.name))
}

