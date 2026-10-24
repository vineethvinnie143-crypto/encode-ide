/**
 * eNCode's command line from a checkout (ADR 0108): bundles apps/cli and runs it, as the Windows build's
 * `encode.cmd` runs the bundle the app ships.
 *
 *   node scripts/encode.mjs --model demo                       the prompt, with a scripted agent, offline
 *   OPENROUTER_API_KEY=... node scripts/encode.mjs -m openrouter:<id> "fix the failing test"
 *   git diff | node scripts/encode.mjs -p -m anthropic:<id> "review this"
 *
 * `node scripts/encode.mjs --help` lists the rest. Behind a proxy (HTTPS_PROXY set), run with NODE_USE_ENV_PROXY=1:
 * Node's fetch ignores the proxy otherwise.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-cli-'))
const bundle = path.join(dir, 'encode.mjs')
try {
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'apps/cli/src/bin.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: bundle,
    // The Windows sandbox helper's C# sources are embedded in the bundle as text, as in the app.
    loader: { '.cs': 'text', '.manifest': 'text' },
    logLevel: 'silent',
  })
} catch (error) {
  for (const message of error.errors ?? []) console.error(`${message.location ? `${message.location.file}:${message.location.line}: ` : ''}${message.text}`)
  if (!error.errors) console.error(error)
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(2)
}
// bin.ts runs on import; the bundle is in memory once it has loaded.
await import(pathToFileURL(bundle).href).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
