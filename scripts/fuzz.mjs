/**
 * Fuzzing: the unit tests' property checks run for longer, on fresh seeds. Every `check` in the repository is a
 * fuzz target; with ENCODE_FUZZ_MS set, each keeps making cases until that much time has passed, and a failure is
 * made smaller and reported with the seed that replays it (see packages/testkit).
 *
 *   node scripts/fuzz.mjs                          every property for 30 s each
 *   node scripts/fuzz.mjs --seconds 300 editor     the editor's properties for 5 minutes each
 *   node scripts/fuzz.mjs --seconds 60 text permissions/src/bash
 *
 * Test files run side by side, the checks in one file one after another. At the end, each property's case count,
 * and the failures with their seeds.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let seconds = 30
const filters = []
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--seconds') seconds = Number(args[++index])
  else filters.push(args[index])
}
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('--seconds takes a number of seconds above 0')
  process.exit(2)
}

const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-fuzz-')), 'report.jsonl')
const started = Date.now()
const child = spawn(process.execPath, [path.join(root, 'scripts', 'test.mjs'), ...filters], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ENCODE_FUZZ_MS: String(Math.round(seconds * 1000)), ENCODE_FUZZ_REPORT: report },
})
child.on('exit', (code, signal) => {
  let rows = []
  try {
    rows = fs.readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    // No property ran.
  }
  fs.rmSync(path.dirname(report), { recursive: true, force: true })
  const total = rows.reduce((sum, row) => sum + row.cases, 0)
  console.log(`\nFuzzed ${rows.length} properties for ${seconds} s each, ${total.toLocaleString('en')} cases in ${((Date.now() - started) / 60000).toFixed(1)} min:`)
  for (const row of rows.sort((a, b) => a.site.localeCompare(b.site))) {
    console.log(`  ${row.failed ? 'FAIL' : 'ok  '} ${row.site.padEnd(58)} ${String(row.cases.toLocaleString('en')).padStart(12)} cases${row.failed ? `  seed ${row.seed}` : ''}`)
  }
  const failed = rows.filter((row) => row.failed)
  if (failed.length) {
    console.log(`\n${failed.length} failed. Replay one with: ENCODE_PROPERTY_SEED=<seed> ENCODE_FUZZ_MS=${Math.round(seconds * 1000)} node scripts/test.mjs <its file>`)
    for (const row of failed) console.log(`  ${row.site}: ${row.input}`)
  }
  process.exit(code ?? (signal ? 1 : 0))
})
