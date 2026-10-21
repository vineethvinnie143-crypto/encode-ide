import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Provided by the Electron runtime; everything else is bundled. */
const external = ['electron']

export async function buildMain({ production = true } = {}) {
  return await esbuild({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'electron/main.ts'), path.join(root, 'electron/preload.ts')],
    outdir: path.join(root, 'dist/electron'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: production ? false : 'inline',
    external,
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    },
    logLevel: 'info',
  })
}

const mainOnly = process.argv.includes('--main-only')

async function main() {
  if (!mainOnly) {
    console.log('[build] renderer (vite)')
    await viteBuild({ configFile: path.join(root, 'vite.config.ts') })
  }
  console.log('[build] electron main + preload (esbuild)')
  await buildMain({ production: true })
  console.log('[build] done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
