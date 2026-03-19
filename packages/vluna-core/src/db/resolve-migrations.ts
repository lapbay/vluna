import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)

type Edition = 'core' | 'community' | 'enterprise' | 'cloud'

const pkgRoot = (name: string): string | undefined => {
  try {
    const pkg = require.resolve(`${name}/package.json`)
    return path.dirname(pkg)
  } catch {
    return undefined
  }
}

const exportDir = (exportId: string): string | undefined => {
  try {
    const resolved = require.resolve(exportId)
    return path.dirname(resolved)
  } catch {
    return undefined
  }
}

const ensure = (...pathsToCheck: Array<string | undefined>): string[] =>
  pathsToCheck.flatMap((p) => (p && fs.existsSync(p) ? [path.resolve(p)] : []))

/**
 * Resolve migration directories for a given edition using package exports first,
 * falling back to package roots and common layout conventions.
 *
 * Works in both source checkout and packaged deploy bundles, independent of cwd.
 */
export function resolveMigrationDirs(_edition: Edition): string[] {
  const dirs: string[] = []

  // Core/base migrations (exported as ./migrations/base)
  dirs.push(...ensure(exportDir('@vluna/vluna-core/migrations/base')))

  const coreRoot = pkgRoot('@vluna/vluna-core')
  if (coreRoot) dirs.push(...ensure(path.join(coreRoot, 'migrations', 'base')))

  // dedupe while preserving order
  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of dirs) {
    const resolved = path.resolve(candidate)
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
    if (seen.has(real)) continue
    seen.add(real)
    unique.push(real)
  }

  return unique
}
