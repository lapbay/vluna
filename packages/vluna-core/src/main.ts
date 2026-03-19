import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapApp } from './platform/bootstrap.js'
import { createAppModuleFromProcessArgv } from './modules/app.module.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const firstExisting = (candidates: Array<string | undefined>) =>
  candidates.filter(Boolean).find((p) => fs.existsSync(p as string))
const findUp = (start: string, parts: string[]) => {
  let dir = start
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, ...parts)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
const migrationCandidates = [
  firstExisting([
    new URL('./migrations/base', import.meta.url).pathname,
    findUp(here, ['packages', 'vluna-core', 'migrations', 'base']),
  ]),
]
const migrationDirs = migrationCandidates.filter((p): p is string => Boolean(p))

bootstrapApp(createAppModuleFromProcessArgv(), { migrationDirs }).catch((err) => {
  console.error('Fatal bootstrap error', err)
  process.exit(1)
})
