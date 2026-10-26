/**
 * eNCode's benchmark (ADR 0092): fixed tasks the agent runs on the real agent host, with checks that say whether it
 * did them, and what it spent doing them.
 *
 *   node scripts/bench.mjs list
 *   node scripts/bench.mjs run --reference                       proves the tasks with their reference runs, no model
 *   OPENROUTER_API_KEY=... node scripts/bench.mjs run --model openrouter:qwen/qwen3-coder --repeat 3
 *   OPENROUTER_API_KEY=... node scripts/bench.mjs run --model @free
 *   node scripts/bench.mjs run --base-url http://localhost:11434/v1 --model qwen2.5-coder
 *   node scripts/bench.mjs show bench-results/<report>.json
 *   node scripts/bench.mjs compare before.json after.json --fail-on-regression
 *
 * Run options: --only <id,id>, --tag <tag>, --repeat <n>, --out <file>, --tasks <folder>, --keep, --sandbox,
 * --timeout <seconds>. Reports go to bench-results/ unless --out says otherwise.
 *
 * Keys come from the environment only (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ENCODE_BENCH_API_KEY
 * for --base-url); they are never printed, never reach the agent's commands, and are taken out of every report.
 * Behind a proxy (HTTPS_PROXY set), run with NODE_USE_ENV_PROXY=1: Node's fetch ignores the proxy otherwise.
 *
 * Ctrl+C once ends the bench after the run in progress, which is checked as any run is; twice stops that run too.
 *
 * A task's checks are programs (node, python or lua scripts): run only tasks you trust.
 * Exit status: 0 when every run passed, 1 when one failed, 2 when the bench could not run.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-bench-cli-'))
const bundle = path.join(dir, 'bench.mjs')
try {
  await build({
    absWorkingDir: root,
    stdin: { contents: "export { main } from './packages/bench/src/cli'\n", resolveDir: root, loader: 'ts' },
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
  process.exit(2)
}
const { main } = await import(pathToFileURL(bundle).href)
fs.rmSync(dir, { recursive: true, force: true })

// Ctrl+C once: no run starts after the one in progress, which goes on to its checks. Twice: that run is stopped too.
// Either way the report keeps what finished; a third leaves at once, without it (ADR 0149).
const finish = new AbortController()
const stop = new AbortController()
let interrupts = 0
process.on('SIGINT', () => {
  interrupts++
  if (interrupts === 1) {
    console.log('\nStopping after the run in progress, which goes on to its checks; Ctrl+C again stops it now. The report keeps what finished.')
    finish.abort()
  } else if (interrupts === 2) {
    console.log('\nStopping the run in progress; the report keeps what finished.')
    stop.abort()
  } else process.exit(130)
})
process.exitCode = await main(process.argv.slice(2), { root, env: process.env, print: (text) => console.log(text), signal: stop.signal, finish: finish.signal })
