/**
 * Describes a tester build's release (ADR 0127), in CI's release job: encode-update.json, which names the build and
 * each program's size and SHA-256 for the updater in the app, and notes.md, the release's page.
 *
 *   node apps/desktop/scripts/release-manifest.mjs --dir <folder with the programs> --build <n> --commit <sha> --out <folder>
 *
 * What is new is read from git: the merges on main since the newest earlier `build-<n>` tag, or the last fifteen.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOG_FORMAT, manifestOf, notesFromLog, previousTag, releaseBody, releaseFile } from './release-notes.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[release] ${message}`)
  process.exit(1)
}

const options = {}
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 2) {
  const name = argv[index]?.replace(/^--/, '')
  if (!name || argv[index + 1] === undefined) fail(`expected --name value pairs, got ${JSON.stringify(argv)}`)
  options[name] = argv[index + 1]
}
const build = Number(options.build)
const commit = String(options.commit ?? '').toLowerCase()
if (!options.dir || !options.out || !Number.isSafeInteger(build) || build < 1 || !/^[0-9a-f]{40}$/.test(commit)) {
  fail('usage: release-manifest.mjs --dir <folder> --build <n> --commit <40 hex> --out <folder>')
}

const named = (pattern) => {
  const found = fs.readdirSync(options.dir).filter((name) => pattern.test(name))
  if (found.length !== 1) fail(`expected one ${pattern} in ${options.dir}, found ${JSON.stringify(found)}`)
  return found[0]
}
const program = (name) => releaseFile(name, fs.readFileSync(path.join(options.dir, name)))

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const since = previousTag(git('tag', '--list', 'build-*').split('\n'), build)
const log = since ? git('log', '--first-parent', `--format=${LOG_FORMAT}`, `${since}..${commit}`) : git('log', '--first-parent', '-n', '15', `--format=${LOG_FORMAT}`, commit)

const manifest = manifestOf({
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  build,
  commit,
  publishedAt: new Date().toISOString(),
  notes: notesFromLog(log),
  installer: program(named(/-setup\.exe$/)),
  portable: program(named(/-portable\.exe$/)),
})

fs.mkdirSync(options.out, { recursive: true })
fs.writeFileSync(path.join(options.out, 'encode-update.json'), `${JSON.stringify(manifest, null, 2)}\n`)
fs.writeFileSync(path.join(options.out, 'notes.md'), releaseBody(manifest))
console.log(`[release] build ${build}, ${manifest.notes.length} changes since ${since ?? 'the last fifteen merges'}`)
console.log(`[release] ${manifest.installer.name} ${manifest.installer.size} bytes, sha256 ${manifest.installer.sha256}`)
console.log(`[release] ${manifest.portable.name} ${manifest.portable.size} bytes, sha256 ${manifest.portable.sha256}`)
