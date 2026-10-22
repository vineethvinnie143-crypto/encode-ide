import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import path from 'node:path'
import { buildStamp, mainBuildOptions, root } from './main-build.mjs'

export async function buildMain({ production = true } = {}) {
  return await esbuild(mainBuildOptions({ production }))
}

const mainOnly = process.argv.includes('--main-only')

async function main() {
  if (!mainOnly) {
    console.log('[build] renderer (vite)')
    await viteBuild({ configFile: path.join(root, 'vite.config.ts') })
  }
  console.log('[build] electron main, preload and agent host (esbuild)')
  await buildMain({ production: true })
  const stamp = buildStamp()
  console.log(`[build] done: eNCode ${stamp.version} (${stamp.channel}) ${stamp.commit ? stamp.commit.slice(0, 7) : 'no commit'}${stamp.dirty ? ' + local changes' : ''}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
