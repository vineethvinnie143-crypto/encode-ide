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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleCli } from './cli-bundle.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-cli-'))
const bundle = path.join(dir, 'encode.mjs')
if (!(await bundleCli(bundle))) {
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(2)
}
// bin.ts runs on import; the bundle is in memory once it has loaded.
await import(pathToFileURL(bundle).href).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
