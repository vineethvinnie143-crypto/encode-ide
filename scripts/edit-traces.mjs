/**
 * Writes the editor's regression traces of real edits: for each file below, its versions in eNCode's own git
 * history, each reached from the one before by the edits a person would make (see
 * packages/editor/src/trace-history.ts), saved to packages/editor/test/traces/<name>.json. Each trace is replayed
 * once before it is written, so a trace that does not reach its own versions is never saved.
 *
 *   node scripts/edit-traces.mjs            write them all
 *   node scripts/edit-traces.mjs adr-index  only the ones whose name contains a filter
 *
 * Run it again when the history has more to give; the traces are kept in git, so CI needs no history.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'packages', 'editor', 'test', 'traces')

/** Files with a history worth replaying: prose, data, styles, workflows and code, small enough to keep. */
const SOURCES = [
  { name: 'adr-index', file: 'docs/adr/README.md', versions: 40 },
  { name: 'testing-guide', file: 'TESTING.md', versions: 28 },
  { name: 'desktop-package', file: 'apps/desktop/package.json', versions: 16, lineSeparator: '\r\n' },
  { name: 'editor-styles', file: 'packages/editor-view/src/style.css', versions: 9 },
  { name: 'ci-workflow', file: '.github/workflows/ci.yml', versions: 9 },
  { name: 'editor-commands', file: 'packages/editor/src/commands.ts', versions: 4 },
  { name: 'language-client', file: 'packages/lsp/src/client.ts', versions: 5 },
  { name: 'editor-layout-store', file: 'apps/desktop/src/stores/editor-layout.ts', versions: 5 },
]
/** A version larger than this is left out, to keep the traces small. */
const MAX_VERSION = 64 * 1024

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-traces-'))
const bundle = path.join(dir, 'make.mjs')
await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { traceFromHistory } from './packages/editor/src/trace-history'\nexport { replayTrace } from './packages/editor/src/trace'\n`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
})
const { traceFromHistory, replayTrace } = await import(pathToFileURL(bundle).href)

const filters = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
for (const source of SOURCES) {
  if (filters.length && !filters.some((filter) => source.name.includes(filter))) continue
  const commits = git('log', '--format=%H', '--reverse', '--', source.file).trim().split('\n').filter(Boolean)
  const versions = []
  for (const commit of commits) {
    let text
    try {
      text = git('show', `${commit}:${source.file}`)
    } catch {
      continue
    }
    // Files are kept with "\n" in the editor; Windows line endings are the separator, not the text.
    text = text.replace(/\r\n/g, '\n')
    if (text.length > MAX_VERSION || text === versions[versions.length - 1]) continue
    versions.push(text)
  }
  const kept = versions.slice(-source.versions)
  if (kept.length < 2) {
    console.log(`${source.name}: fewer than two versions, skipped`)
    continue
  }
  const trace = traceFromHistory(source.name, source.file, kept, { lineSeparator: source.lineSeparator })
  const { problems } = replayTrace(trace)
  if (problems.length) {
    console.error(`${source.name}: the trace does not replay: step ${problems[0].step}: ${problems[0].problem}`)
    process.exitCode = 1
    continue
  }
  // Non-ASCII written as escapes, so the file holds no character that could read differently from how it runs.
  const json = JSON.stringify(trace, null, 1).replace(/[^\x00-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  fs.writeFileSync(path.join(out, `${source.name}.json`), `${json}\n`)
  console.log(`${source.name}: ${kept.length} versions, ${trace.steps.length} steps, ${(json.length / 1024).toFixed(0)} KB`)
}
fs.rmSync(dir, { recursive: true, force: true })
