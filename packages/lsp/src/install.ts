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
 *   fixed arguments. When the computer has no new enough toolchain, eNCode fetches one into its own folder first
 *   (`runtimes.ts`, ADR 0114), or takes the server's own build instead (rust-analyzer without rustup).
 *
 * What is installed goes in eNCode's tools folder, `<tools>/<server>/<version>`, and a toolchain in
 * `<tools>/runtimes/<toolchain>/<version>`, each written to a folder of its own first and moved into place only when
 * complete, so it is either all there or not there.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ArchiveRefused, readGzip, readTar, readZip, unpackZip, writeFiles, type ArchiveFile } from './archive'
import type { Installable, ServerSpec } from './catalog'
import type { LaunchPlan } from './discover'
import { NPM_LOCKS } from './npm-locks'
import { RUNTIMES, type Runtime, type RuntimeDownload, type RuntimeId } from './runtimes'

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
  /** `gz`: the program alone, gzipped (rust-analyzer for Linux and macOS). */
  archive: 'zip' | 'tar' | 'gz'
  /** The server's program inside, relative (`bin/lua-language-server.exe`); `{version}` as above. */
  bin: string
  /** Leading folders taken off every path. */
  strip?: number
}

export interface DownloadInstall {
  kind: 'download'
  /** For people: `github.com/LuaLS/lua-language-server`. */
  from: string
  /** Where the release is found. A pinned one names its version and each file's sha256. */
  release: { github: string } | { version: string; base: string; sha256: Record<string, string> }
  /** By `platform-arch` (`win32-x64`). */
  assets: Partial<Record<string, DownloadAsset>>
  args: string[]
  /** What else it needs, for people: "cargo to read a whole Cargo project, which comes with Rust". */
  needs?: string
  /** The toolchain it runs on, which eNCode fetches when the computer has none new enough (ADR 0114). */
  runtime?: RuntimeId
  /** How to start it from its folder, when it is not just its program. */
  launch?(dir: string, context: LaunchContext): Omit<LaunchPlan, 'found'> | { missing: string }
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
  | DownloadInstall
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
      /** The toolchain eNCode fetches into its own folder when the computer has none new enough (ADR 0114). */
      runtime?: RuntimeId
      /** The server's own build, taken when the toolchain is not on the computer (rust-analyzer without rustup). */
      otherwise?: DownloadInstall
      /** Added to the environment the installed program starts with. */
      launchEnv?: Record<string, string>
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
  /** eNCode's own copy of the toolchain a server runs on (its Java), when eNCode fetched one. */
  runtime?: { program: string; env: Record<string, string> }
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

/** Hosts a download may come from or be sent on to, and where on each. */
const HOSTS = new Map([
  ['registry.npmjs.org', '/'],
  ['github.com', '/'],
  ['api.github.com', '/'],
  ['objects.githubusercontent.com', '/'],
  ['release-assets.githubusercontent.com', '/'],
  ['download.eclipse.org', '/'],
  // The toolchains (ADR 0114): Microsoft's .NET builds and release list, Adoptium's list of Java builds (which are on
  // GitHub), and the Go module proxy, which sends its files on to its own storage.
  ['builds.dotnet.microsoft.com', '/dotnet/'],
  ['api.adoptium.net', '/v3/'],
  ['proxy.golang.org', '/golang.org/toolchain/'],
  ['storage.googleapis.com', '/proxy-golang-org-prod/'],
])
const MAX_DOWNLOAD = 400 * 1024 * 1024
const MAX_UNPACKED = 1024 * 1024 * 1024
const MAX_FILES = 40_000
const MAX_JSON = 16 * 1024 * 1024
const MARKER = 'encode-install.json'
/** Under the tools folder: one folder per toolchain eNCode fetched. */
const RUNTIMES_DIR = 'runtimes'
/** How long a toolchain is given to say its version. */
const CHECK_MS = 20_000
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

/** Only `https`, to a host on the list, at a path that host is used for. */
function allowed(address: URL): boolean {
  const prefix = HOSTS.get(address.hostname)
  return address.protocol === 'https:' && prefix !== undefined && address.pathname.startsWith(prefix)
}

/** Asks for a URL from an allowed host, following redirects only to allowed hosts; the answer is OK and not over `max`. */
async function request(context: InstallContext, url: string, max: number, options: { accept?: string; method?: 'GET' | 'HEAD' } = {}): Promise<{ response: Response; name: string }> {
  let address = url
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(address)
    if (!allowed(parsed)) fail(`eNCode does not download from ${parsed.protocol === 'https:' ? parsed.hostname : address}.`)
    let response: Response
    try {
      response = await context.fetch(address, { method: options.method ?? 'GET', redirect: 'manual', signal: context.signal ?? null, headers: { 'user-agent': 'eNCode', ...(options.accept ? { accept: options.accept } : {}) } })
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
    const name = path.posix.basename(parsed.pathname)
    if (!response.ok) fail(`${parsed.hostname} answered ${response.status} for ${name}.`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > max) fail(`${name} is larger than eNCode expects (${megabytes(declared)}).`)
    return { response, name }
  }
  return fail('Too many redirects.')
}

/** Reads an answer's body a piece at a time, up to `max` bytes. */
async function receive(context: InstallContext, url: string, max: number, take: (chunk: Buffer) => void | Promise<void>, accept?: string): Promise<void> {
  const { response, name } = await request(context, url, max, accept ? { accept } : {})
  if (!response.body) return
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      fail(`${name} is larger than eNCode expects.`)
    }
    await take(Buffer.from(value))
  }
}

/** Fetches a URL from an allowed host, following redirects only to allowed hosts, up to `max` bytes. */
async function download(context: InstallContext, url: string, max: number, onBytes?: (bytes: number) => void, accept?: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  await receive(
    context,
    url,
    max,
    (chunk) => {
      chunks.push(chunk)
      onBytes?.(chunk.byteLength)
    },
    accept,
  )
  return Buffer.concat(chunks)
}

/** Downloads into `file`, which must not exist, hashing as it goes: a toolchain of hundreds of megabytes is never all in memory. */
async function downloadToFile(context: InstallContext, url: string, max: number, file: string, algorithm: 'sha256' | 'sha512', onBytes?: (bytes: number) => void): Promise<string> {
  const hash = createHash(algorithm)
  const handle = await fs.promises.open(file, 'wx')
  try {
    await receive(context, url, max, async (chunk) => {
      hash.update(chunk)
      await handle.write(chunk)
      onBytes?.(chunk.byteLength)
    })
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** How large a file is, asked of its host without downloading it; undefined when the host does not say. */
async function sizeOf(context: InstallContext, url: string, max: number): Promise<number | undefined> {
  try {
    const { response } = await request(context, url, max, { method: 'HEAD' })
    const size = Number(response.headers.get('content-length') ?? 0)
    return size > 0 ? size : undefined
  } catch {
    return undefined
  }
}

/** A JSON answer from an allowed host: a list of releases. */
async function json(context: InstallContext, url: string): Promise<unknown> {
  const body = await download(context, url, MAX_JSON, undefined, 'application/json')
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return fail(`The answer from ${new URL(url).hostname} could not be read.`)
  }
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
  if (install.kind === 'download') return planDownload(spec, install, context)
  const runtime = install.runtime ? RUNTIMES[install.runtime] : undefined
  if (runtime) {
    const chain = await toolchainFor(runtime, context)
    if (chain.kind === 'none') return { unavailable: lacking(spec, chain) }
    return planToolchain(spec, install, base, chain, context)
  }
  const program = context.which(install.program)
  if (program) return planToolchain(spec, install, base, { kind: 'system', program }, context)
  if (install.otherwise) return planDownload(spec, install.otherwise, context, `${install.needs} is not on this computer (${install.program} was not found on the PATH), so eNCode takes the server's own build.`)
  return { unavailable: `Installing ${installName(spec)} needs ${install.needs}, which is not on this computer (${install.program} was not found on the PATH). Install it, then try again.` }
}

type ToolchainInstall = Extract<ServerInstall, { kind: 'toolchain' }>

async function planDownload(spec: Installable, install: DownloadInstall, context: InstallContext, lead?: string): Promise<InstallPlan | { unavailable: string }> {
  const resolved = await resolveDownload(spec, install, context).catch((error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) }))
  if ('unavailable' in resolved) return resolved
  const there = installedDir(spec, context.toolsDir)?.version === resolved.version
  const check = 'github' in install.release ? 'the checksum GitHub publishes for it' : 'the checksum eNCode was built with'
  const steps = lead ? [lead] : []
  // A pinned release says no size: its host is asked.
  const size = there ? 0 : resolved.size || ((await sizeOf(context, resolved.url, MAX_DOWNLOAD)) ?? 0)
  let bytes = size
  steps.push(
    there
      ? `${installName(spec)} ${resolved.version} is already in eNCode's folder, so it is not downloaded again.`
      : `Downloads ${resolved.name} (${'github' in install.release ? 'the newest release, ' : ''}version ${resolved.version}${size ? `, ${megabytes(size)}` : ''}) from ${install.from} and checks it against ${check}.`,
  )
  let fetched: Runtime | undefined
  if (install.runtime) {
    const runtime = RUNTIMES[install.runtime]
    const chain = await toolchainFor(runtime, context, true)
    if (chain.kind === 'fetch') {
      const size = chain.download.size ?? (await sizeOf(context, chain.download.url, runtime.limits.maxDownload))
      steps.push(`${fetchStep(chain.download, runtime, size)} The server runs on it.`)
      bytes += size ?? 0
      fetched = runtime
    } else if (chain.kind === 'ours') steps.push(`It runs on eNCode's own copy of ${runtime.label} (${chain.version}).`)
    else if (chain.kind === 'system') steps.push(`It runs on the ${runtime.label} on this computer (${chain.program}).`)
    else steps.push(`It needs ${runtime.label} ${runtime.minimum} or newer to run, and ${chain.older}. ${chain.why} Get it from ${runtime.site}.`)
  } else if (install.needs) steps.push(`It needs ${install.needs}.`)
  steps.push(keepStep(spec, fetched))
  return { id: spec.id, label: spec.label, what: installName(spec), version: resolved.version, ...(bytes ? { bytes } : {}), dir: path.join(context.toolsDir, spec.id, resolved.version), steps }
}

async function planToolchain(spec: Installable, install: ToolchainInstall, base: string, chain: Exclude<Toolchain, { kind: 'none' }>, context: InstallContext): Promise<InstallPlan> {
  const dir = path.join(base, install.version)
  const command = [install.program, ...install.args.map((arg) => fill(arg, { dir }))].join(' ')
  const steps: string[] = []
  let bytes: number | undefined
  if (chain.kind === 'fetch') {
    bytes = chain.download.size ?? (await sizeOf(context, chain.download.url, chain.runtime.limits.maxDownload))
    steps.push(fetchStep(chain.download, chain.runtime, bytes), `Runs ${command}, with that copy.`)
  } else if (chain.kind === 'ours') steps.push(`Runs ${command}, with eNCode's own copy of ${chain.runtime.label} (${chain.version}).`)
  else steps.push(`Runs ${command}, with ${install.needs} from ${chain.program}.`)
  if (!install.bin) steps.push(`It adds the server to your ${install.needs} installation, where eNCode finds it.`)
  else steps.push(chain.kind === 'fetch' ? keepStep(spec, chain.runtime) : `Keeps the server in eNCode's own folder (${dir}).`)
  return { id: spec.id, label: spec.label, what: installName(spec), version: install.version, ...(bytes ? { bytes } : {}), dir, steps }
}

function fetchStep(download: RuntimeDownload, runtime: Runtime, size: number | undefined): string {
  return `Downloads ${runtime.label} ${download.version}${size ? ` (${megabytes(size)})` : ''} from ${download.from} and checks it against ${download.check}.`
}

function keepStep(spec: Installable, fetched?: Runtime): string {
  if (!fetched) return "Keeps it in eNCode's own folder, named below. Nothing else on this computer changes."
  return `Keeps both in eNCode's own folder. Nothing is installed for the whole computer, no administrator is asked for, and the PATH stays as it is: this copy of ${fetched.label} is for the language server alone. To build ${spec.label} programs yourself, install ${fetched.whole} from ${fetched.site}.`
}

/** Why a server cannot be installed without its toolchain, and where the person gets it. */
function lacking(spec: Installable, chain: Extract<Toolchain, { kind: 'none' }>): string {
  return `Installing ${installName(spec)} needs ${chain.runtime.label} ${chain.runtime.minimum} or newer, and ${chain.older}. ${chain.why} Get it from ${chain.runtime.site}, then try again.`
}

// ---------------------------------------------------------------------------------------------------------- toolchains

/** Where the toolchain a server needs comes from (ADR 0114). */
type Toolchain =
  | { kind: 'system'; program: string }
  | { kind: 'ours'; runtime: Runtime; dir: string; version: string }
  | { kind: 'fetch'; runtime: Runtime; download: RuntimeDownload }
  | { kind: 'none'; runtime: Runtime; older: string; why: string }

/**
 * The toolchain a server gets: the computer's own when it is new enough, else the copy eNCode fetched before, else one
 * to fetch, or why there is none. With `oursFirst`, eNCode's copy comes before the computer's (the Java server runs on
 * it whenever it is there, since it is known to be new enough).
 */
async function toolchainFor(runtime: Runtime, context: InstallContext, oursFirst = false): Promise<Toolchain> {
  const ours = installedRuntime(runtime.id, context.toolsDir)
  if (ours && oursFirst) return { kind: 'ours', runtime, ...ours }
  const program = systemProgram(runtime, context)
  if (program && (await newEnough(runtime, program, context))) return { kind: 'system', program }
  if (ours) return { kind: 'ours', runtime, ...ours }
  const older = program ? `the one on this computer (${program}) is older` : 'it is not on this computer'
  try {
    const download = await runtime.resolve(platformKey(context.platform, context.arch), (url) => json(context, url))
    if (download) return { kind: 'fetch', runtime, download }
    return { kind: 'none', runtime, older, why: `eNCode cannot fetch it for this computer (${context.platform}, ${context.arch}).` }
  } catch (error) {
    if (context.signal?.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'none', runtime, older, why: `eNCode could not find one to fetch: ${reason.replace(/\.$/, '')}.` }
  }
}

/** The toolchain's program on this computer; for Java, JAVA_HOME's first, as the Java server's launcher looks. */
function systemProgram(runtime: Runtime, context: LaunchContext): string | null {
  if (runtime.id === 'java') {
    const home = context.env.JAVA_HOME
    const file = home ? path.join(home, 'bin', exe('java', context.platform)) : null
    if (file && fs.existsSync(file)) return file
  }
  return context.which(runtime.program)
}

/** Whether the program says a version the servers take. It runs briefly in eNCode's own folder, never the project. */
async function newEnough(runtime: Runtime, program: string, context: InstallContext): Promise<boolean> {
  fs.mkdirSync(context.toolsDir, { recursive: true })
  const run = context.run ?? runProgram
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(CHECK_MS)]) : AbortSignal.timeout(CHECK_MS)
  try {
    const result = await run(program, runtime.check.args, { env: { ...context.env, ...runtime.check.env }, cwd: context.toolsDir, signal })
    return runtime.check.enough(result.output)
  } catch {
    if (context.signal?.aborted) throw new InstallFailed('The install was stopped.')
    return false
  }
}

/** The copy of a toolchain eNCode fetched, and its version, or null. */
export function installedRuntime(id: RuntimeId, toolsDir: string): { dir: string; version: string } | null {
  const found = installedDir({ id }, path.join(toolsDir, RUNTIMES_DIR))
  return found && { dir: found.dir, version: found.version }
}

/** Removes eNCode's copy of a toolchain. */
export function removeRuntime(id: RuntimeId, toolsDir: string): void {
  removeInstall({ id }, path.join(toolsDir, RUNTIMES_DIR))
}

/** What a program started with eNCode's copy of a toolchain is given: its home, and its folder first on the PATH. */
function runtimeEnv(runtime: Runtime, dir: string, context: LaunchContext): Record<string, string> {
  const bin = path.dirname(path.join(dir, ...runtime.bin(context.platform).split('/')))
  const windows = context.platform === 'win32'
  // Windows names it Path; one key for it, or the child would get two.
  const key = (windows ? Object.keys(context.env).find((name) => name.toUpperCase() === 'PATH') : undefined) ?? 'PATH'
  const current = context.env[key]
  return { ...runtime.environment(runtime.home(dir, context.platform)), [key]: current ? `${bin}${windows ? ';' : ':'}${current}` : bin }
}

/** eNCode's copy of a toolchain, as a server starts with it, or undefined when there is none. */
function ownRuntime(id: RuntimeId, toolsDir: string, context: LaunchContext): { program: string; env: Record<string, string> } | undefined {
  const runtime = RUNTIMES[id]
  const found = installedRuntime(id, toolsDir)
  if (!found) return undefined
  return { program: path.join(found.dir, ...runtime.bin(context.platform).split('/')), env: runtimeEnv(runtime, found.dir, context) }
}

/** Fetches a toolchain into `<tools>/runtimes/<id>/<version>`; resolves with that folder. */
async function installRuntime(runtime: Runtime, download: RuntimeDownload, context: InstallContext): Promise<string> {
  const base = path.join(context.toolsDir, RUNTIMES_DIR, runtime.id)
  fs.mkdirSync(base, { recursive: true })
  const partial = path.join(base, `.partial-${randomBytes(6).toString('hex')}`)
  const archive = `${partial}.download`
  try {
    const total = download.size ?? (await sizeOf(context, download.url, runtime.limits.maxDownload)) ?? 0
    let done = 0
    const digest = await downloadToFile(context, download.url, runtime.limits.maxDownload, archive, download.algorithm, (bytes) => {
      done += bytes
      context.onProgress?.(done, Math.max(total, done))
    })
    if (digest !== download.digest) fail(`${download.name} does not match its checksum, so it was not installed.`)
    const limits = { maxFiles: runtime.limits.maxFiles, maxBytes: runtime.limits.maxBytes, ...(download.strip ? { strip: download.strip } : {}) }
    if (download.archive === 'zip') await unpackZip(archive, partial, limits)
    else writeFiles(readTar(await fs.promises.readFile(archive), limits), partial)
    const bin = runtime.bin(context.platform)
    if (!fs.existsSync(path.join(partial, ...bin.split('/')))) fail(`${bin} is not in ${download.name}.`)
    fs.writeFileSync(path.join(partial, MARKER), `${JSON.stringify({ id: runtime.id, version: download.version, kind: 'runtime', at: new Date().toISOString() })}\n`)
    const dir = path.join(base, download.version)
    try {
      fs.renameSync(partial, dir)
    } catch (error) {
      if (!fs.existsSync(path.join(dir, MARKER))) throw error
    }
    removeOthers(base, download.version)
    return dir
  } catch (error) {
    if (error instanceof ArchiveRefused) throw new InstallFailed(`eNCode refused ${download.name}: ${error.message}.`)
    if (context.signal?.aborted) throw new InstallFailed('The install was stopped.')
    throw error
  } finally {
    fs.rmSync(partial, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
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
  // The toolchain comes first: when the server then fails to install, the toolchain is kept for the next try.
  let chain: Toolchain | undefined
  if ((install.kind === 'toolchain' || install.kind === 'download') && install.runtime) {
    chain = await toolchainFor(RUNTIMES[install.runtime], context, install.kind === 'download')
    if (chain.kind === 'fetch') chain = { kind: 'ours', runtime: chain.runtime, dir: await installRuntime(chain.runtime, chain.download, context), version: chain.download.version }
    else if (chain.kind === 'none' && install.kind === 'toolchain') fail(lacking(spec, chain))
  }
  const chosen = install.kind === 'toolchain' && !install.runtime && install.otherwise && !context.which(install.program) ? install.otherwise : install
  let resolved: ResolvedDownload | undefined
  if (chosen.kind === 'download') {
    resolved = await resolveDownload(spec, chosen, context)
    // Already in place, as when only its toolchain was missing: it is not downloaded again.
    const there = installedDir(spec, context.toolsDir)
    if (there?.version === resolved.version) return there.dir
  }
  const base = path.join(context.toolsDir, spec.id)
  fs.mkdirSync(base, { recursive: true })
  const partial = path.join(base, `.partial-${randomBytes(6).toString('hex')}`)
  try {
    let version: string
    if (chosen.kind === 'npm') version = await installNpm(spec, chosen, context, partial)
    else if (chosen.kind === 'library') {
      version = await installNpm(spec, chosen, context, partial)
      try {
        chosen.build(partial)
      } catch (error) {
        fail(`eNCode could not write ${chosen.produces}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (chosen.kind === 'download') version = await installDownload(resolved!, context, partial)
    else version = await installToolchain(spec, chosen, context, partial, chain)
    if (chosen.kind === 'toolchain' && !chosen.bin) return ''
    // A server built with eNCode's copy of its toolchain starts with that copy (ADR 0114).
    const runtime = chosen.kind === 'toolchain' && chain?.kind === 'ours' ? { id: chain.runtime.id, version: chain.version } : undefined
    fs.writeFileSync(path.join(partial, MARKER), `${JSON.stringify({ id: spec.id, version, kind: chosen.kind, ...(runtime ? { runtime } : {}), at: new Date().toISOString() })}\n`)
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

async function installDownload(resolved: ResolvedDownload, context: InstallContext, partial: string): Promise<string> {
  let done = 0
  const data = await download(context, resolved.url, MAX_DOWNLOAD, (bytes) => {
    done += bytes
    context.onProgress?.(done, resolved.size || done)
  })
  if (createHash('sha256').update(data).digest('hex') !== resolved.sha256) fail(`${resolved.name} does not match its checksum, so it was not installed.`)
  const limits = { maxFiles: MAX_FILES, maxBytes: MAX_UNPACKED, ...(resolved.asset.strip ? { strip: resolved.asset.strip } : {}) }
  const bin = fill(resolved.asset.bin, { version: resolved.version })
  let files = resolved.asset.archive === 'zip' ? readZip(data, limits) : resolved.asset.archive === 'gz' ? readGzip(data, bin, limits) : readTar(data, limits)
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

async function installToolchain(spec: Installable, install: ToolchainInstall, context: InstallContext, partial: string, chain?: Toolchain): Promise<string> {
  let program: string
  let extra: Record<string, string> = {}
  // The caches of an installer run with eNCode's copy: removed when it is done, so the home folder gets nothing.
  let work: string | undefined
  if (chain?.kind === 'ours') {
    program = path.join(chain.dir, ...chain.runtime.bin(context.platform).split('/'))
    work = `${partial}-work`
    extra = { ...runtimeEnv(chain.runtime, chain.dir, context), ...chain.runtime.installEnvironment(work) }
  } else {
    const found = chain?.kind === 'system' ? chain.program : context.which(install.program)
    if (!found) fail(`Installing ${installName(spec)} needs ${install.needs}: ${install.program} was not found on the PATH.`)
    program = found
  }
  try {
    fs.mkdirSync(partial)
    const values = { dir: partial }
    const env = { ...context.env, ...extra, ...Object.fromEntries(Object.entries(install.env ?? {}).map(([key, value]) => [key, fill(value, values)])) }
    const run = context.run ?? runProgram
    const result = await run(program, install.args.map((arg) => fill(arg, values)), { env, cwd: partial, ...(context.signal ? { signal: context.signal } : {}) })
    if (result.code !== 0) fail(`${install.program} could not install it (exit ${result.code ?? 'stopped'}): ${result.output.trim().split(/\r?\n/).slice(-3).join(' ')}`)
    if (install.bin && !fs.existsSync(path.join(partial, exe(install.bin, context.platform)))) fail(`${install.program} finished, but ${exe(install.bin, context.platform)} is not where it was asked to go.`)
    return install.version
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
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

/** What a folder eNCode installed holds: its version, how it was installed, and the toolchain copy it was built with. */
export interface Installed {
  dir: string
  version: string
  kind?: string
  runtime?: { id: RuntimeId; version: string }
}

/** The folder eNCode installed the server in, and its version, or null. The newest complete one wins. */
export function installedDir(spec: Pick<Installable, 'id'>, toolsDir: string): Installed | null {
  const base = path.join(toolsDir, spec.id)
  let best: (Installed & { at: number }) | null = null
  for (const entry of safeReaddir(base)) {
    if (entry.startsWith('.')) continue
    const dir = path.join(base, entry)
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as { id?: unknown; version?: unknown; kind?: unknown; runtime?: { id?: unknown; version?: unknown } }
      if (marker.id !== spec.id || typeof marker.version !== 'string') continue
      const at = fs.statSync(path.join(dir, MARKER)).mtimeMs
      const runtime = marker.runtime && typeof marker.runtime.id === 'string' && Object.hasOwn(RUNTIMES, marker.runtime.id) && typeof marker.runtime.version === 'string' ? { id: marker.runtime.id as RuntimeId, version: marker.runtime.version } : undefined
      if (!best || at > best.at) best = { dir, version: marker.version, at, ...(typeof marker.kind === 'string' ? { kind: marker.kind } : {}), ...(runtime ? { runtime } : {}) }
    } catch {
      // Not complete, or not eNCode's.
    }
  }
  if (!best) return null
  const { at: _at, ...installed } = best
  return installed
}

/** The toolchain copy of eNCode's a server it installed runs on, for people: ".NET SDK 10.0.402". */
export function installedRuntimeLabel(spec: Pick<ServerSpec, 'id' | 'installer'>, toolsDir: string): string | undefined {
  const install = spec.installer
  if (!install || (install.kind !== 'toolchain' && install.kind !== 'download') || !install.runtime) return undefined
  const found = installedDir(spec, toolsDir)
  if (!found) return undefined
  const id = install.kind === 'download' ? install.runtime : found.runtime?.id
  const runtime = id ? installedRuntime(id, toolsDir) : null
  return id && runtime ? `${RUNTIMES[id].label.replace(/^the /, '')} ${runtime.version}` : undefined
}

/** How to start a server eNCode installed, or null when it has not installed it. */
export function installedLaunch(spec: ServerSpec, toolsDir: string, context: LaunchContext): LaunchPlan | { missing: string } | null {
  const declared = spec.installer
  if (!declared || declared.kind === 'library') return null
  const found = installedDir(spec, toolsDir)
  if (!found) return null
  // rust-analyzer's own build, taken where rustup was not, stands in for rustup's.
  const install = declared.kind === 'toolchain' && found.kind === 'download' && declared.otherwise ? declared.otherwise : declared
  if (install.kind === 'toolchain' && !install.bin) return null
  const command = spec.candidates[0]?.command ?? spec.id
  const where = `eNCode's tools folder, ${found.version}`
  if (install.kind === 'npm') {
    const script = path.join(found.dir, ...install.script.split('/'))
    return { file: context.node.file, args: [script, ...install.args], found: where, command, ...(context.node.env ? { env: context.node.env } : {}) }
  }
  if (install.kind === 'download') {
    if (install.launch) {
      const runtime = install.runtime ? ownRuntime(install.runtime, toolsDir, context) : undefined
      const plan = install.launch(found.dir, runtime ? { ...context, runtime } : context)
      return 'missing' in plan ? plan : { ...plan, found: where }
    }
    const asset = install.assets[platformKey(context.platform, context.arch)]
    if (!asset) return null
    return { file: path.join(found.dir, ...fill(asset.bin, { version: found.version }).split('/')), args: [...install.args], found: where, command }
  }
  let env: Record<string, string> = { ...install.launchEnv }
  if (found.runtime) {
    // Built with eNCode's copy of its toolchain, so it runs with that copy too.
    const runtime = ownRuntime(found.runtime.id, toolsDir, context)
    if (!runtime) return { missing: `${installName(spec)} was installed with eNCode's own copy of ${RUNTIMES[found.runtime.id].label}, which is no longer there. Install it again from Settings > Language servers.` }
    env = { ...env, ...runtime.env }
  }
  return { file: path.join(found.dir, exe(install.bin!, context.platform)), args: [...(spec.candidates[0]?.args ?? [])], found: where, command, ...(Object.keys(env).length ? { env } : {}) }
}

/** Removes what eNCode installed for the server. */
export function removeInstall(spec: Pick<Installable, 'id'>, toolsDir: string): void {
  const base = path.join(toolsDir, spec.id)
  for (const entry of safeReaddir(base)) fs.rmSync(path.join(base, entry), { recursive: true, force: true })
}
