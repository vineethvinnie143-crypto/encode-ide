/**
 * Reads a report a tester saved with Help > Report editor issue (ADR 0088), replays its trace with every editor
 * invariant checked after every step, and says what it finds. With --keep, the trace is also saved to
 * packages/editor/test/traces/issue-<name>.json, where the regression suite replays it from then on: keep it once
 * the bug it shows is fixed, so it stays fixed.
 *
 *   node scripts/editor-issue.mjs report.json
 *   node scripts/editor-issue.mjs report.json --keep tab-after-paste
 *
 * The report is read as data: only the fields of a trace are taken from it, checked as the app checks them.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'packages', 'editor', 'test', 'traces')

const args = process.argv.slice(2)
const keepAt = args.indexOf('--keep')
const keep = keepAt >= 0 ? args[keepAt + 1] : null
const file = args.find((arg, index) => !arg.startsWith('--') && (keepAt < 0 || index !== keepAt + 1))
if (!file || (keepAt >= 0 && !keep)) {
  console.error('Usage: node scripts/editor-issue.mjs <report.json> [--keep <name>]')
  process.exit(2)
}
if (keep !== null && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(keep)) {
  console.error('The name for --keep is lower-case letters, digits and dashes, up to 60 characters.')
  process.exit(2)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-issue-'))
const bundle = path.join(dir, 'issue.mjs')
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { EDITOR_ISSUE_KIND, readTrace } from './apps/desktop/shared/editor-issue'",
      "export { replayTrace } from './packages/editor/src/trace'",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
})
const { EDITOR_ISSUE_KIND, readTrace, replayTrace } = await import(pathToFileURL(bundle).href)
fs.rmSync(dir, { recursive: true, force: true })

let report
try {
  report = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
} catch (error) {
  console.error(`${file} is not a report: ${error.message}`)
  process.exit(1)
}
if (report?.kind !== EDITOR_ISSUE_KIND || report.version !== 1) {
  console.error(`${file} is not a report of an editor issue (kind ${JSON.stringify(report?.kind)}).`)
  process.exit(1)
}
const trace = readTrace(report.trace)
if (!trace) {
  console.error(`${file}: its trace is not one the editor writes, so it is not replayed.`)
  process.exit(1)
}

// Plain facts only, each on one line. Nothing from the report reaches the terminal as it is: a control character
// (an escape sequence that moves the cursor or sets the title) or a direction control would change what is shown.
const plain = (value, most = 200) =>
  String(value ?? '?')
    .slice(0, most)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, '?')
const quoted = (value) => JSON.stringify(plain(value, 4000))
const fact = (name, value) => console.log(`${name.padEnd(12)}${value}`)
fact('Build', plain(report.build))
fact('System', plain(report.system))
fact('File', `${plain(report.extension || '(no extension)', 20)}, ${plain(report.language, 40)}, ${Number(report.lines) || '?'} lines${report.scrambled ? ', words replaced' : ''}`)
fact('Recorded', `${trace.steps.length} ${trace.steps.length === 1 ? 'step' : 'steps'}${report.recorded?.trimmed ? ' (the newest only)' : ''}`)
fact('They said', quoted(report.description ?? ''))
const reported = Array.isArray(report.problems) ? report.problems.slice(0, 20) : []
fact('They found', reported.length ? reported.map((problem) => `step ${Number(problem?.step) || '?'}: ${quoted(problem?.problem)}`).join('; ') : 'nothing')

const { problems } = replayTrace(trace, { history: true })
fact('Replay here', problems.length ? `${problems.length} problem(s)` : 'every step holds')
for (const problem of problems.slice(0, 20)) console.log(`  step ${problem.step}: ${problem.problem}`)
if (problems.length) process.exitCode = 1

if (keep) {
  const kept = { ...trace, name: `issue-${keep}` }
  // Non-ASCII written as escapes, as edit-traces.mjs writes them.
  const json = JSON.stringify(kept, null, 1).replace(/[^\x00-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const target = path.join(out, `issue-${keep}.json`)
  if (fs.existsSync(target)) {
    console.error(`${path.relative(root, target)} exists already; pick another name.`)
    process.exit(1)
  }
  fs.writeFileSync(target, `${json}\n`)
  console.log(`Kept as ${path.relative(root, target)}${problems.length ? ': the regression suite fails on it until the bug is fixed' : ''}.`)
}
