/**
 * Writes packages/lsp/src/npm-locks.ts: for each language server eNCode installs from npm, every package it needs,
 * at the exact version, with the address of its archive and the sha512 the registry published for it. eNCode's
 * installer downloads exactly these and checks each against its hash; it never asks npm to resolve anything, never
 * runs a package's scripts, and needs no Node.js on the computer.
 *
 *   node scripts/server-locks.mjs            (every one)
 *   node scripts/server-locks.mjs fivem      (only those named; the others are kept as they are)
 *
 * Run it when a version below changes, read the diff, and keep the file in git.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'packages', 'lsp', 'src', 'npm-locks.ts')

/** What each server is installed from: exact versions only. */
const SERVERS = {
  typescript: { 'typescript-language-server': '6.0.2', typescript: '6.0.3' },
  python: { pyright: '1.1.414' },
  bash: { 'bash-language-server': '5.8.1' },
  yaml: { 'yaml-language-server': '2.0.0' },
  // Not a server: Cfx.re's own typings of FiveM's natives, which eNCode turns into Lua definitions (ADR 0084).
  fivem: { '@citizenfx/client': '2.0.37850-1', '@citizenfx/server': '2.0.37850-1' },
}

const only = process.argv.slice(2)
for (const id of only) if (!SERVERS[id]) throw new Error(`No server ${id} in this script`)

/** The locks in the file now, to keep those not asked for. */
function current() {
  if (!fs.existsSync(out)) return {}
  const text = fs.readFileSync(out, 'utf8')
  const start = text.indexOf('= {')
  if (start < 0) throw new Error(`${out} is not as this script writes it`)
  return new Function(`return (${text.slice(start + 2)})`)()
}

const REGISTRY = 'https://registry.npmjs.org/'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** The archive's size, after checking it against the sha512 the lock names. */
async function size(url, integrity) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== integrity) throw new Error(`${url} does not match its sha512`)
  return data.length
}

const locks = only.length ? current() : {}
for (const [id, wanted] of Object.entries(SERVERS)) {
  if (only.length && !only.includes(id)) continue
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `encode-lock-${id}-`))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `encode-${id}`, version: '0.0.0', private: true, dependencies: wanted }))
  execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', REGISTRY], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'))
  const packages = []
  for (const [where, entry] of Object.entries(lock.packages)) {
    if (!where || entry.dev || entry.link) continue
    if (!entry.resolved?.startsWith(REGISTRY) || !entry.integrity?.startsWith('sha512-')) throw new Error(`${id}: ${where} has no registry address or sha512`)
    if (entry.hasInstallScript && !entry.optional) throw new Error(`${id}: ${where} needs its install script run, which eNCode never does`)
    packages.push({
      path: where,
      version: entry.version,
      url: entry.resolved,
      integrity: entry.integrity,
      size: await size(entry.resolved, entry.integrity),
      ...(entry.optional ? { optional: true } : {}),
      ...(entry.os ? { os: entry.os } : {}),
      ...(entry.cpu ? { cpu: entry.cpu } : {}),
    })
  }
  fs.rmSync(dir, { recursive: true, force: true })
  locks[id] = { packages: wanted, files: packages }
  console.log(`${id}: ${packages.length} packages, ${(packages.reduce((sum, item) => sum + item.size, 0) / 1048576).toFixed(1)} MB`)
}

const body = Object.entries(locks)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, lock]) => `  ${id}: {\n    packages: ${JSON.stringify(lock.packages)},\n    files: [\n${lock.files.map((file) => `      ${JSON.stringify(file)},`).join('\n')}\n    ],\n  },`)
  .join('\n')
fs.writeFileSync(
  out,
  `/**
 * Written by scripts/server-locks.mjs: every package each npm-installed language server needs, pinned to its version
 * and to the sha512 the registry published for it. Not edited by hand.
 */
import type { NpmLock } from './install'

export const NPM_LOCKS: Record<string, NpmLock> = {
${body}
}
`,
)
