/**
 * Installing a language server with one click, after the person has read what will happen (ADR 0083). Each server
 * comes one of three ways, and every byte is checked before anything is unpacked:
 *
 * - **npm**: every package the server needs, at the version and sha512 pinned in `npm-locks.ts`, downloaded from the
 *   npm registry and unpacked by eNCode itself. npm is never run, no package's scripts run, and the server runs on
 *   eNCode's own Node.js, so Node.js need not be installed.
 * - **download**: one archive from the project's own releases, checked against a sha256 pinned here, or, for a
 *   release on GitHub, the sha256 GitHub publishes for the file (a release without one is refused).
 * - **toolchain**: the language's own installer (`go install`, `dotnet tool install`, `rustup component add`) with
 *   fixed arguments, for people who have that toolchain.
 *
 * What is installed goes in eNCode's tools folder, `<tools>/<server>/<version>`, written to a folder of its own first
 * and moved into place only when complete, so a server is either all there or not there.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ArchiveRefused, readTar, readZip, writeFiles, type ArchiveFile } from './archive'
import type { Installable, ServerSpec } from './catalog'
import type { LaunchPlan } from './discover'
import { NPM_LOCKS } from './npm-locks'

export interface NpmFile {
  /** Where it goes: `node_modules/a` or `node_modules/a/node_modules/b`. */
  path: string
  version: string
  url: string
  /** `sha512-<base64>`. */
  integrity: string
  /** Of the archive, in bytes. */
  size: number
  optional?: boolean
  os?: string[]
  cpu?: string[]
}

export interface NpmLock {
  /** What was asked for, by name, at exact versions. */
  packages: Record<string, string>
  files: NpmFile[]
}

export interface DownloadAsset {
  /** The file's name in the release (`clangd-windows-{version}.zip`): `{version}` is the release's. */
  name: string
  archive: 'zip' | 'tar'
  /** The server's program inside, relative (`bin/lua-language-server.exe`); `{version}` as above. */
  bin: string
  /** Leading folders taken off every path. */
  strip?: number
}

export type ServerInstall =
  | {
      kind: 'npm'
      /** Its key in `NPM_LOCKS`, or the lock itself. */
      lock: string | NpmLock
      /** The script to start, inside `node_modules`. */
      script: string
      args: string[]
    }
  | {
      kind: 'download'
      /** For people: `github.com/LuaLS/lua-language-server`. */
      from: string
      /** Where the release is found. A pinned one names its version and each file's sha256. */
      release: { github: string } | { version: string; base: string; sha256: Record<string, string> }
      /** By `platform-arch` (`win32-x64`). */
      assets: Partial<Record<string, DownloadAsset>>
      args: string[]
      /** What it needs on the computer, for people: "Java 21 or newer". */
      needs?: string
      /** How to start it from its folder, when it is not just its program. */
      launch?(dir: string, context: LaunchContext): Omit<LaunchPlan, 'found'> | { missing: string }
    }
  | {
      /**
       * Not a server: packages from npm (pinned as the npm servers are) that `build` turns into files a server reads,
       * such as FiveM's natives as Lua definitions (ADR 0084). Nothing from them is run.
       */
      kind: 'library'
      lock: string | NpmLock
      /** Writes what the server reads into the install folder, from the packages unpacked under its `node_modules`. */
      build(dir: string): void
      /** What `build` writes, for people: "Lua definitions of FiveM's natives". */
      produces: string
    }
  | {
      kind: 'toolchain'
      program: string
      /** `{dir}` is the folder it installs into. */
      args: string[]
      version: string
      /** Environment for the installer; `{dir}` as above. */
      env?: Record<string, string>
      /** For people: "Go". */
      needs: string
      /** The program it leaves in `{dir}`, or none when the toolchain keeps it on the PATH itself (rustup). */
      bin?: string
    }

export interface LaunchContext {
  platform: NodeJS.Platform
  arch: string
  /** The Node.js that runs npm-installed servers: eNCode's own, as Node. */
  node: { file: string; env?: Record<string, string> }
  which(name: string): string | null
  /** A folder of its own for a server's caches (jdtls keeps an index per project). */
  cacheDir: string
  root: string
  /** The environment servers and installers run with: the agent's, without secrets. */
  env: Record<string, string>
}

export interface InstallContext extends LaunchContext {
  /** `<tools>`: one folder per server under it. */
  toolsDir: string
  fetch: typeof fetch
  /**
   * Runs a toolchain's installer; the default starts it without a shell. `cwd` is the new, empty install folder, so
   * no project file (go.mod, global.json, rust-toolchain.toml) changes what is installed or which toolchain runs.
   */
  run?(program: string, args: string[], options: { env: Record<string, string>; cwd: string; signal?: AbortSignal }): Promise<{ code: number | null; output: string }>
  signal?: AbortSignal
  onProgress?(done: number, total: number): void
}

export interface InstallPlan {
  id: string
  label: string
  /** What is installed, for a title: "YAML's language server", "FiveM's natives for Lua". */
  what: string
  version: string
  /** What happens, in a few plain sentences, for the person to read before saying yes. */
  steps: string[]
  /** About how much is downloaded, in bytes, when known. */
  bytes?: number
  /** Where it is kept. */
  dir: string
}

/** Hosts a download may come from or be sent on to. */
const HOSTS = new Set(['registry.npmjs.org', 'github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'download.eclipse.org'])
const MAX_DOWNLOAD = 400 * 1024 * 1024
const MAX_UNPACKED = 1024 * 1024 * 1024
const MAX_FILES = 40_000
const MARKER = 'encode-install.json'
/** `node_modules/a`, `node_modules/@scope/a`, `node_modules/a/node_modules/b`. */
const NPM_PLACE = /^node_modules\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+(\/node_modules\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i
const RELEASE_TTL_MS = 10 * 60_000

export class InstallFailed extends Error {}

function fail(reason: string): never {
  throw new InstallFailed(reason)
}

export function platformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

function megabytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// ------------------------------------------------------------------------------------------------------------ fetching

/** Fetches a URL from an allowed host, following redirects only to allowed hosts, up to `max` bytes. */
async function download(context: InstallContext, url: string, max: number, onBytes?: (bytes: number) => void, accept?: string): Promise<Buffer> {
  let address = url
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(address)
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname)) fail(`eNCode does not download from ${parsed.protocol === 'https:' ? parsed.hostname : address}.`)
    let response: Response
    try {
      response = await context.fetch(address, { redirect: 'manual', signal: context.signal ?? null, headers: { 'user-agent': 'eNCode', ...(accept ? { accept } : {}) } })
    } catch (error) {
      if (context.signal?.aborted) throw error
      const cause = error instanceof Error ? ((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error)
      fail(`eNCode could not reach ${parsed.hostname} (${cause}). Check the connection, or a proxy it needs, and try again.`)
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location')
      if (!next) fail(`${parsed.hostname} sent eNCode elsewhere without saying where.`)
      address = new URL(next, address).toString()
      continue
    }
    if (!response.ok) fail(`${parsed.hostname} answered ${response.status} for ${path.posix.basename(parsed.pathname)}.`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > max) fail(`${path.posix.basename(parsed.pathname)} is larger than eNCode expects (${megabytes(declared)}).`)
    if (!response.body) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    let total = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => undefined)
        fail(`${path.posix.basename(parsed.pathname)} is larger than eNCode expects.`)
      }
      chunks.push(Buffer.from(value))
      onBytes?.(value.byteLength)
    }
    return Buffer.concat(chunks)
  }
  return fail('Too many redirects.')
}

interface GithubRelease {
  version: string
  assets: { name: string; size: number; url: string; sha256: string | null }[]
}

const releases = new Map<string, { at: number; release: GithubRelease }>()

/** The newest release of a GitHub project, with each file's published sha256. */
async function githubRelease(context: InstallContext, repo: string): Promise<GithubRelease> {
  const known = releases.get(repo)
  if (known && Date.now() - known.at < RELEASE_TTL_MS) return known.release
  const body = await download(context, `https://api.github.com/repos/${repo}/releases/latest`, 4 * 1024 * 1024, undefined, 'application/vnd.github+json')
  let parsed: { tag_name?: unknown; assets?: unknown }
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return fail(`GitHub's answer about ${repo} could not be read.`)
  }
  if (typeof parsed.tag_name !== 'string' || !Array.isArray(parsed.assets)) fail(`GitHub's answer about ${repo} could not be read.`)
  const assets: GithubRelease['assets'] = []
  for (const item of parsed.assets as Record<string, unknown>[]) {
    if (typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue
    const digest = typeof item.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(item.digest) ? item.digest.slice(7) : null
    assets.push({ name: item.name, size: typeof item.size === 'number' ? item.size : 0, url: item.browser_download_url, sha256: digest })
  }
  const release = { version: parsed.tag_name.replace(/^v/, ''), assets }
  releases.set(repo, { at: Date.now(), release })
  return release
}

// ------------------------------------------------------------------------------------------------------------ planning

/** "YAML's language server", or what a library says it is. */
export function installName(spec: Installable): string {
  return spec.what ?? `${spec.label}'s language server`
}

/** How a server would be installed here: the plan for the person to read, or why it cannot be. */
export async function planInstall(spec: Installable, context: InstallContext): Promise<InstallPlan | { unavailable: string }> {
  const install = spec.installer
  if (!install) return { unavailable: `eNCode cannot install ${installName(spec)} itself. To get one: ${spec.install}.` }
  const base = path.join(context.toolsDir, spec.id)
  if (install.kind === 'npm' || install.kind === 'library') {
    const lock = lockOf(install)
    if (!lock) return { unavailable: `eNCode has no list of what ${installName(spec)} needs.` }
    const files = npmFiles(lock, context)
    const bytes = files.reduce((sum, file) => sum + file.size, 0)
    const names = Object.entries(lock.packages).map(([name, version]) => `${name} ${version}`)
    const version = Object.values(lock.packages).join('+')
    return {
      id: spec.id,
      label: spec.label,
      what: installName(spec),
      version,
      bytes,
      dir: path.join(base, version),
      steps: [
        `Downloads ${names.join(' and ')} from the npm registry: ${files.length} ${files.length === 1 ? 'package' : 'packages'}, ${megabytes(bytes)}, each checked against the hash eNCode was built with.`,
        install.kind === 'library'
          ? `Writes ${install.produces} from them. Nothing in them is run.`
          : 'Runs no install scripts, and runs on eNCode\'s own copy of Node.js, so Node.js need not be installed.',
        "Keeps it in eNCode's own folder, named below. Nothing else on this computer changes.",
      ],
    }
  }
  if (install.kind === 'download') {
    const resolved = await resolveDownload(spec, install, context).catch((error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) }))
    if ('unavailable' in resolved) return resolved
    const check = 'github' in install.release ? 'the checksum GitHub publishes for it' : 'the checksum eNCode was built with'
    return {
      id: spec.id,
      label: spec.label,
      what: installName(spec),
      version: resolved.version,
      ...(resolved.size ? { bytes: resolved.size } : {}),
      dir: path.join(base, resolved.version),
      steps: [
        `Downloads ${resolved.name} (${'github' in install.release ? 'the newest release, ' : ''}version ${resolved.version}${resolved.size ? `, ${megabytes(resolved.size)}` : ''}) from ${install.from} and checks it against ${check}.`,
        "Keeps it in eNCode's own folder, named below. Nothing else on this computer changes.",
        ...(install.needs ? [`It needs ${install.needs} to run.`] : []),
      ],
    }
  }
  const program = context.which(install.program)
  if (!program) return { unavailable: `Installing ${installName(spec)} needs ${install.needs} (${install.program} was not found on the PATH). To get one: ${spec.install}.` }
  const dir = path.join(base, install.version)
  const args = install.args.map((arg) => fill(arg, { dir }))
  return {
    id: spec.id,
    label: spec.label,
    what: installName(spec),
    version: install.version,
    dir,
    steps: [
      `Runs ${[install.program, ...args].join(' ')}, with ${install.needs} from ${program}.`,
      install.bin ? `Keeps the server in eNCode's own folder (${dir}).` : `It adds the server to your ${install.needs} installation, where eNCode finds it.`,
    ],
  }
}

function lockOf(install: { lock: string | NpmLock }): NpmLock | undefined {
  return typeof install.lock === 'string' ? NPM_LOCKS[install.lock] : install.lock
}

function npmFiles(lock: NpmLock, context: LaunchContext): NpmFile[] {
  // A platform's own package (fsevents on macOS) is left out elsewhere, as npm does.
  const os = context.platform
  const cpu = context.arch
  return lock.files.filter((file) => (!file.os || matches(file.os, os)) && (!file.cpu || matches(file.cpu, cpu)))
}

function matches(list: string[], value: string): boolean {
  const denied = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1))
  const allowed = list.filter((item) => !item.startsWith('!'))
  return !denied.includes(value) && (allowed.length === 0 || allowed.includes(value))
}

interface ResolvedDownload {
  version: string
  name: string
  url: string
  sha256: string
  size: number
  asset: DownloadAsset
}

async function resolveDownload(spec: Installable, install: Extract<ServerInstall, { kind: 'download' }>, context: InstallContext): Promise<ResolvedDownload> {
  const asset = install.assets[platformKey(context.platform, context.arch)]
  if (!asset) fail(`${install.from} has no build of ${installName(spec)} for this computer (${context.platform}, ${context.arch}).`)
  if ('github' in install.release) {
    const release = await githubRelease(context, install.release.github)
    const name = fill(asset.name, { version: release.version })
    const found = release.assets.find((item) => item.name === name)
    if (!found) fail(`The newest release of ${install.from} (${release.version}) has no ${name}.`)
    if (!found.sha256) fail(`GitHub publishes no checksum for ${name}, so eNCode does not install it. To get it yourself: ${spec.install}.`)
    return { version: release.version, name, url: found.url, sha256: found.sha256, size: found.size, asset }
  }
  const name = fill(asset.name, { version: install.release.version })
  const sha256 = install.release.sha256[name]
  if (!sha256) fail(`eNCode has no checksum for ${name}.`)
  return { version: install.release.version, name, url: `${install.release.base}${name}`, sha256, size: 0, asset }
}

// ---------------------------------------------------------------------------------------------------------- installing

/** Installs the server; resolves with the folder it is in. Throws `InstallFailed` with a reason for people. */
export async function installServer(spec: Installable, context: InstallContext): Promise<string> {
  const install = spec.installer
  if (!install) fail(`eNCode cannot install ${installName(spec)} itself.`)
  const base = path.join(context.toolsDir, spec.id)
  fs.mkdirSync(base, { recursive: true })
  const partial = path.join(base, `.partial-${randomBytes(6).toString('hex')}`)
  try {
    let version: string
    if (install.kind === 'npm') version = await installNpm(spec, install, context, partial)
    else if (install.kind === 'library') {
      version = await installNpm(spec, install, context, partial)
      try {
        install.build(partial)
      } catch (error) {
        fail(`eNCode could not write ${install.produces}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (install.kind === 'download') version = await installDownload(spec, install, context, partial)
    else version = await installToolchain(spec, install, context, partial)
    if (install.kind === 'toolchain' && !install.bin) return ''
    fs.writeFileSync(path.join(partial, MARKER), `${JSON.stringify({ id: spec.id, version, kind: install.kind, at: new Date().toISOString() })}\n`)
    const dir = path.join(base, version)
    try {
      fs.renameSync(partial, dir)
    } catch (error) {
      // Another window installed it first: theirs is complete, since only complete folders are moved into place.
      if (!fs.existsSync(path.join(dir, MARKER))) throw error
    }
    removeOthers(base, version)
    return dir
  } catch (error) {
    if (error instanceof ArchiveRefused) throw new InstallFailed(`eNCode refused the download: ${error.message}.`)
    if (context.signal?.aborted) throw new InstallFailed('The install was stopped.')
    throw error
  } finally {
    fs.rmSync(partial, { recursive: true, force: true })
  }
}

/** Older versions are removed once a new one is in place; a folder in use stays until it is free. */
function removeOthers(base: string, keep: string): void {
  for (const entry of safeReaddir(base)) {
    if (entry === keep || entry.startsWith('.partial-')) continue
    try {
      fs.rmSync(path.join(base, entry), { recursive: true, force: true })
    } catch {
      // A server from it still runs (Windows keeps a running program's files); it goes next time.
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

async function installNpm(spec: Installable, install: { lock: string | NpmLock; script?: string }, context: InstallContext, partial: string): Promise<string> {
  const lock = lockOf(install)
  if (!lock) fail(`eNCode has no list of what ${installName(spec)} needs.`)
  const files = npmFiles(lock, context)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  let done = 0
  const unpacked: ArchiveFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!NPM_PLACE.test(file.path) || file.path.split('/').some((part) => part === '.' || part === '..')) fail(`${file.path} is not a place a package goes.`)
    if (seen.has(file.path)) fail(`${file.path} is listed twice.`)
    seen.add(file.path)
    const data = await download(context, file.url, MAX_DOWNLOAD, (bytes) => {
      done += bytes
      context.onProgress?.(done, total)
    })
    const [algorithm, expected] = [file.integrity.slice(0, 6), file.integrity.slice(7)]
    if (algorithm !== 'sha512' || createHash('sha512').update(data).digest('base64') !== expected) fail(`${file.path.split('node_modules/').pop()} ${file.version} does not match the hash eNCode was built with.`)
    for (const entry of readTar(data, { maxFiles: MAX_FILES, maxBytes: MAX_UNPACKED, strip: 1 })) {
      unpacked.push({ ...entry, path: `${file.path}/${entry.path}` })
    }
  }
  writeFiles(unpacked, partial)
  if (install.script && !fs.existsSync(path.join(partial, ...install.script.split('/')))) fail(`${install.script} is not in what was downloaded.`)
  return Object.values(lock.packages).join('+')
}

async function installDownload(spec: Installable, install: Extract<ServerInstall, { kind: 'download' }>, context: InstallContext, partial: string): Promise<string> {
  const resolved = await resolveDownload(spec, install, context)
  let done = 0
  const data = await download(context, resolved.url, MAX_DOWNLOAD, (bytes) => {
    done += bytes
    context.onProgress?.(done, resolved.size || done)
  })
  if (createHash('sha256').update(data).digest('hex') !== resolved.sha256) fail(`${resolved.name} does not match its checksum, so it was not installed.`)
  const limits = { maxFiles: MAX_FILES, maxBytes: MAX_UNPACKED, ...(resolved.asset.strip ? { strip: resolved.asset.strip } : {}) }
  let files = resolved.asset.archive === 'zip' ? readZip(data, limits) : readTar(data, limits)
  const bin = fill(resolved.asset.bin, { version: resolved.version })
  files = withoutTopFolder(files, bin)
  if (!files.some((file) => file.path === bin || file.path.startsWith(`${bin}/`))) fail(`${bin} is not in ${resolved.name}.`)
  writeFiles(files, partial)
  return resolved.version
}

/** Archives that keep everything in one folder named for the release (`clangd_19.1.2/bin/clangd`) lose that folder. */
function withoutTopFolder(files: ArchiveFile[], bin: string): ArchiveFile[] {
  if (files.some((file) => file.path === bin || file.path.startsWith(`${bin}/`))) return files
  const top = files[0]?.path.split('/')[0]
  if (!top || !files.every((file) => file.path.startsWith(`${top}/`))) return files
  return files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }))
}

async function installToolchain(spec: Installable, install: Extract<ServerInstall, { kind: 'toolchain' }>, context: InstallContext, partial: string): Promise<string> {
  const program = context.which(install.program)
  if (!program) fail(`Installing ${installName(spec)} needs ${install.needs}: ${install.program} was not found on the PATH.`)
  fs.mkdirSync(partial)
  const values = { dir: partial }
  const env = { ...context.env, ...Object.fromEntries(Object.entries(install.env ?? {}).map(([key, value]) => [key, fill(value, values)])) }
  const run = context.run ?? runProgram
  const result = await run(program, install.args.map((arg) => fill(arg, values)), { env, cwd: partial, ...(context.signal ? { signal: context.signal } : {}) })
  if (result.code !== 0) fail(`${install.program} could not install it (exit ${result.code ?? 'stopped'}): ${result.output.trim().split(/\r?\n/).slice(-3).join(' ')}`)
  if (install.bin && !fs.existsSync(path.join(partial, exe(install.bin, context.platform)))) fail(`${install.program} finished, but ${exe(install.bin, context.platform)} is not where it was asked to go.`)
  return install.version
}

function runProgram(program: string, args: string[], options: { env: Record<string, string>; cwd: string; signal?: AbortSignal }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, ...(options.signal ? { signal: options.signal } : {}) })
    let output = ''
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.once('error', (error) => reject(new InstallFailed(`${path.basename(program)} could not be started: ${error.message}`)))
    child.once('close', (code) => resolve({ code, output }))
  })
}

// ----------------------------------------------------------------------------------------------------------- launching

/** The folder eNCode installed the server in, and its version, or null. The newest complete one wins. */
export function installedDir(spec: Pick<Installable, 'id'>, toolsDir: string): { dir: string; version: string } | null {
  const base = path.join(toolsDir, spec.id)
  let best: { dir: string; version: string; at: number } | null = null
  for (const entry of safeReaddir(base)) {
    if (entry.startsWith('.')) continue
    const dir = path.join(base, entry)
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as { id?: unknown; version?: unknown }
      if (marker.id !== spec.id || typeof marker.version !== 'string') continue
      const at = fs.statSync(path.join(dir, MARKER)).mtimeMs
      if (!best || at > best.at) best = { dir, version: marker.version, at }
    } catch {
      // Not complete, or not eNCode's.
    }
  }
  return best && { dir: best.dir, version: best.version }
}

/** How to start a server eNCode installed, or null when it has not installed it. */
export function installedLaunch(spec: ServerSpec, toolsDir: string, context: LaunchContext): LaunchPlan | { missing: string } | null {
  const install = spec.installer
  if (!install || install.kind === 'library' || (install.kind === 'toolchain' && !install.bin)) return null
  const found = installedDir(spec, toolsDir)
  if (!found) return null
  const command = spec.candidates[0]?.command ?? spec.id
  const where = `eNCode's tools folder, ${found.version}`
  if (install.kind === 'npm') {
    const script = path.join(found.dir, ...install.script.split('/'))
    return { file: context.node.file, args: [script, ...install.args], found: where, command, ...(context.node.env ? { env: context.node.env } : {}) }
  }
  if (install.kind === 'download') {
    if (install.launch) {
      const plan = install.launch(found.dir, context)
      return 'missing' in plan ? plan : { ...plan, found: where }
    }
    const asset = install.assets[platformKey(context.platform, context.arch)]
    if (!asset) return null
    return { file: path.join(found.dir, ...fill(asset.bin, { version: found.version }).split('/')), args: [...install.args], found: where, command }
  }
  return { file: path.join(found.dir, exe(install.bin!, context.platform)), args: [...(spec.candidates[0]?.args ?? [])], found: where, command }
}

/** Removes what eNCode installed for the server. */
export function removeInstall(spec: Pick<Installable, 'id'>, toolsDir: string): void {
  const base = path.join(toolsDir, spec.id)
  for (const entry of safeReaddir(base)) fs.rmSync(path.join(base, entry), { recursive: true, force: true })
}
