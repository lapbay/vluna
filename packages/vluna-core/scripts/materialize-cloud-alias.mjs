#!/usr/bin/env node
// Make @cloud a real package inside a deploy output.
import fs from 'node:fs/promises'
import path from 'node:path'

const outDir = process.argv[2]

if (!outDir) {
  console.error('Usage: materialize-cloud-alias <deploy-output-dir>')
  process.exit(1)
}

const distCloud = path.join(outDir, 'dist', 'cloud')
const aliasDir = path.join(outDir, 'node_modules', '@cloud')

const pkgJson = {
  name: '@cloud',
  type: 'module',
  exports: {
    './auth/*': './auth/*.js',
    './contracts/*': './contracts/*.js',
    './events/*': './events/*.js',
    './features/*': './features/*.js',
    './modules/*': './modules/*.js',
  },
}

async function main() {
  const stat = await fs.stat(distCloud).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    console.error(`dist/cloud not found in ${outDir}`)
    process.exit(1)
  }
  await fs.rm(aliasDir, { recursive: true, force: true })
  await fs.mkdir(aliasDir, { recursive: true })
  await fs.cp(distCloud, aliasDir, { recursive: true })
  await fs.writeFile(path.join(aliasDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8')
  console.log(`[cloud-alias] materialized @cloud under ${aliasDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
