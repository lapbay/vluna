export type RuntimeArgs = {
  // Periodic task selection
  // - If both are undefined: run zero tasks.
  // - If tasksInclude is provided: run include - exclude.
  // - If only tasksExclude is provided: run all - exclude.
  tasksInclude?: string[]
  tasksExclude?: string[]
}

export const RUNTIME_ARGS = Symbol('RUNTIME_ARGS')

function parseCommaList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  return trimmed
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function readFlagValue(argv: string[], name: string): { provided: boolean; value: string } {
  const eqPrefix = `--${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === `--${name}`) {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) {
        return { provided: true, value: '' }
      }
      return { provided: true, value: next }
    }
    if (token.startsWith(eqPrefix)) {
      return { provided: true, value: token.slice(eqPrefix.length) }
    }
  }
  return { provided: false, value: '' }
}

export function parseRuntimeArgsFromArgv(argv: string[]): RuntimeArgs {
  const include = readFlagValue(argv, 'tasks-include')
  const exclude = readFlagValue(argv, 'tasks-exclude')

  const out: RuntimeArgs = {}
  if (include.provided) out.tasksInclude = parseCommaList(include.value)
  if (exclude.provided) out.tasksExclude = parseCommaList(exclude.value)
  return out
}

