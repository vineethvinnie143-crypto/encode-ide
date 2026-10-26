/**
 * The ways a folder can be debugged (ADR 0143), and what each one starts: the folder's own `.encode/debug.json`, the
 * file open in the editor, each script of the folder's package.json, and a program already listening on the
 * inspector's port. A run is worked out here, not started: what program runs, with what arguments, where, and with
 * what environment.
 *
 * Node.js is the one on PATH, as a terminal would run it, or eNCode's own when none is installed. TypeScript runs
 * through the project's tsx when it has one, else through Node.js's own type stripping when it is new enough. A
 * package script runs as npm runs it, through the shell with the package's `node_modules/.bin` on PATH, so it is the
 * same for npm, pnpm and yarn projects and needs none of them.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isScriptFile, isTypeScriptFile } from '@encode/debug'
import { shimScript } from '@encode/lsp'
import { batchCommand, envKey, searchPath, windowsSystemProgram } from '@encode/tools'

export const DEBUG_FILE = '.encode/debug.json'
const MAX_FILE_BYTES = 256 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024
const MAX_CONFIGS = 50
const MAX_SCRIPTS = 40
const MAX_ARGS = 200
const MAX_ARG_CHARS = 8_000
const MAX_ENV = 200
const DEFAULT_PORT = 9229
const VERSION_TIMEOUT_MS = 5_000
const DETAIL_CHARS = 160

/** A way to debug the folder, as the panel lists it. */
export interface DebugConfigView {
  /** `own:<index>`, `file`, `script:<name>`, `attach`. */
  id: string
  name: string
  kind: 'launch' | 'attach'
  /** What it runs, in a line: "node src/index.ts", "next dev", "127.0.0.1:9229". */
  detail: string
  /** It debugs the file open in the editor. */
  file?: true
  /** It cannot run as written, and why. */
  problem?: string
}

export interface DebugConfigs {
  configs: DebugConfigView[]
  /** What is wrong with `.encode/debug.json` as a whole. */
  problem?: string
}

/** A run worked out: a program to start, or one to attach to. */
export type RunPlan =
  | { kind: 'launch'; name: string; file: string; args: string[]; cwd: string; env: Record<string, string>; verbatim?: true; detail: string }
  | { kind: 'attach'; name: string; host: string; port: number; detail: string }

/** Why a run cannot start, in words for the person. */
export class RunProblem extends Error {
  override name = 'RunProblem'
}

/** What working out a run needs to know. */
export interface RunContext {
  /** The folder, as a real path. */
  root: string
  platform: NodeJS.Platform
  /** The environment runs start from. */
  env: Record<string, string | undefined>
  /** The file open in the editor, as a whole path. */
  file?: string
  /** eNCode's own Node.js, for when none is installed. */
  node?: { file: string; env?: Record<string, string> }
  /** For tests: the version of a Node.js, `[major, minor]`, or null when it does not say. */
  nodeVersion?(file: string, env: Record<string, string>): Promise<[number, number] | null>
}

/** One configuration of `.encode/debug.json`, read. */
interface OwnConfig {
  name: string
  request: 'launch' | 'attach'
  program?: string
  npmScript?: string
  args: string[]
  cwd?: string
  env: Record<string, string | null>
  runtime?: string
  runtimeArgs: string[]
  port: number
  host: string
}

type OwnEntry = OwnConfig | { name: string; problem: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS || !value.every((item) => typeof item === 'string' && item.length <= MAX_ARG_CHARS)) {
    throw new RunProblem(`${what} must be a list of at most ${MAX_ARGS} words.`)
  }
  return value as string[]
}

/** The program a configuration attaches to must be on this machine: the inspector lets anyone who reaches it run code. */
const LOOPBACK = new Map([
  ['localhost', '127.0.0.1'],
  ['127.0.0.1', '127.0.0.1'],
  ['::1', '::1'],
  ['[::1]', '::1'],
])

function readOwn(raw: unknown, index: number): OwnEntry {
  const fallback = `Configuration ${index + 1}`
  if (!isRecord(raw)) return { name: fallback, problem: 'It is not a configuration: write it as an object.' }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : fallback
  try {
    if (raw.name !== undefined && typeof raw.name !== 'string') throw new RunProblem('Its name must be text.')
    if (raw.type !== undefined && raw.type !== 'node' && raw.type !== 'pwa-node') throw new RunProblem(`eNCode debugs Node.js programs ("type": "node"); "${String(raw.type)}" is not one yet.`)
    const request = raw.request ?? 'launch'
    if (request !== 'launch' && request !== 'attach') throw new RunProblem('"request" is "launch" (start the program) or "attach" (to one already running).')
    const text = (key: string): string | undefined => {
      const value = raw[key]
      if (value === undefined) return undefined
      if (typeof value !== 'string' || !value.trim() || value.length > MAX_ARG_CHARS) throw new RunProblem(`"${key}" must be text.`)
      return value
    }
    const env: Record<string, string | null> = {}
    if (raw.env !== undefined) {
      if (!isRecord(raw.env) || Object.keys(raw.env).length > MAX_ENV) throw new RunProblem(`"env" must name at most ${MAX_ENV} variables, each with text or null.`)
      for (const [key, value] of Object.entries(raw.env)) {
        if (!key || /[=\0]/.test(key) || (value !== null && (typeof value !== 'string' || value.length > MAX_ARG_CHARS))) throw new RunProblem(`"env" cannot set "${key}" that way: give it text, or null to leave it out.`)
        env[key] = value
      }
    }
    const program = text('program')
    const npmScript = text('npmScript')
    if (request === 'launch' && (program === undefined) === (npmScript === undefined)) throw new RunProblem('Name the program to run ("program") or a script of package.json ("npmScript"), one of them.')
    const port = raw.port === undefined ? DEFAULT_PORT : raw.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new RunProblem('"port" must be a port number.')
    const asked = raw.host === undefined ? '127.0.0.1' : typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : ''
    const host = LOOPBACK.get(asked)
    if (!host) throw new RunProblem('eNCode attaches only to a program on this machine ("host": "localhost").')
    const cwd = text('cwd')
    const runtime = text('runtime')
    return {
      name,
      request,
      ...(program !== undefined ? { program } : {}),
      ...(npmScript !== undefined ? { npmScript } : {}),
      args: strings(raw.args, '"args"'),
      ...(cwd !== undefined ? { cwd } : {}),
      env,
      ...(runtime !== undefined ? { runtime } : {}),
      runtimeArgs: strings(raw.runtimeArgs, '"runtimeArgs"'),
      port,
      host,
    }
  } catch (error) {
    if (error instanceof RunProblem) return { name, problem: error.message }
    throw error
  }
}

/** A file's text when it is there and not larger than `max`; null when it is missing. */
async function smallText(file: string, max: number): Promise<string | null> {
  let stats
  try {
    stats = await fs.stat(file)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  if (stats.size > max) throw new RunProblem(`${path.basename(file)} is larger than ${Math.round(max / 1024)} KB.`)
  return fs.readFile(file, 'utf8')
}

/** The configurations of `.encode/debug.json`; none when there is no such file. */
async function ownConfigs(root: string): Promise<{ entries: OwnEntry[]; problem?: string }> {
  let text: string | null
  try {
    text = await smallText(path.join(root, ...DEBUG_FILE.split('/')), MAX_FILE_BYTES)
  } catch (error) {
    return { entries: [], problem: error instanceof Error ? error.message : String(error) }
  }
  if (text === null) return { entries: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { entries: [], problem: `${DEBUG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const list = isRecord(raw) ? raw.configurations : undefined
  if (!Array.isArray(list)) return { entries: [], problem: `${DEBUG_FILE} has no "configurations" list.` }
  const entries = list.slice(0, MAX_CONFIGS).map((item, index) => readOwn(item, index))
  return { entries, ...(list.length > MAX_CONFIGS ? { problem: `Only the first ${MAX_CONFIGS} configurations of ${DEBUG_FILE} are read.` } : {}) }
}

interface PackageJson {
  file: string
  name?: string
  version?: string
  scripts: [string, string][]
}

async function packageJson(dir: string): Promise<PackageJson | null> {
  const file = path.join(dir, 'package.json')
  const text = await smallText(file, MAX_PACKAGE_BYTES).catch(() => null)
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const scripts = isRecord(raw.scripts) ? Object.entries(raw.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1].trim()) : []
  return { file, ...(typeof raw.name === 'string' ? { name: raw.name } : {}), ...(typeof raw.version === 'string' ? { version: raw.version } : {}), scripts }
}

const clip = (text: string) => (text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text)

/** Every way the folder can be debugged: its own configurations first, then the editor's file, its scripts, a port. */
export async function debugConfigs(root: string): Promise<DebugConfigs> {
  const own = await ownConfigs(root)
  const configs: DebugConfigView[] = own.entries.map((entry, index) => {
    const base = { id: `own:${index}`, name: entry.name }
    if ('problem' in entry) return { ...base, kind: 'launch', detail: DEBUG_FILE, problem: entry.problem }
    if (entry.request === 'attach') return { ...base, kind: 'attach', detail: `${entry.host}:${entry.port}` }
    const what = entry.npmScript !== undefined ? `script ${entry.npmScript}` : `${entry.runtime ?? 'node'} ${entry.program}`
    return { ...base, kind: 'launch', detail: clip([what, ...entry.args].join(' ')) }
  })
  configs.push({ id: 'file', name: 'Current file', kind: 'launch', detail: 'The file open in the editor, with Node.js', file: true })
  const pkg = await packageJson(root)
  for (const [name, line] of pkg?.scripts.slice(0, MAX_SCRIPTS) ?? []) configs.push({ id: `script:${name}`, name: `Script: ${name}`, kind: 'launch', detail: clip(line) })
  configs.push({ id: 'attach', name: `Attach to port ${DEFAULT_PORT}`, kind: 'attach', detail: `127.0.0.1:${DEFAULT_PORT}` })
  return { configs, ...(own.problem ? { problem: own.problem } : {}) }
}

// ---------------------------------------------------------------- variables

const FILE_VARIABLES = new Set(['file', 'relativeFile', 'fileDirname', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname'])

/** `${folder}`, `${file}`, `${env:NAME}` and the rest in a configuration's text, filled in. */
export function substitute(text: string, context: Pick<RunContext, 'root' | 'file' | 'env' | 'platform'>): string {
  const api = context.platform === 'win32' ? path.win32 : path.posix
  return text.replace(/\$\{([^}]*)\}/g, (_, name: string) => {
    if (name === 'folder' || name === 'workspaceFolder' || name === 'workspaceRoot') return context.root
    if (name === 'pathSeparator') return api.sep
    if (name.startsWith('env:')) return context.env[envKey(context.env, name.slice(4), context.platform)] ?? ''
    if (FILE_VARIABLES.has(name)) {
      const file = context.file
      if (!file) throw new RunProblem(`\${${name}} names the file open in the editor: open the file first.`)
      switch (name) {
        case 'file':
          return file
        case 'relativeFile':
          return api.relative(context.root, file)
        case 'fileDirname':
          return api.dirname(file)
        case 'fileBasename':
          return api.basename(file)
        case 'fileExtname':
          return api.extname(file)
        default:
          return api.basename(file, api.extname(file))
      }
    }
    throw new RunProblem(`\${${name}} is not a variable eNCode knows. It knows \${folder}, \${file}, \${fileDirname}, \${relativeFile} and \${env:NAME}.`)
  })
}

// ---------------------------------------------------------------- programs

interface NodeProgram {
  file: string
  /** What it needs set to run as Node.js (eNCode's own: ELECTRON_RUN_AS_NODE). */
  env: Record<string, string>
  own: boolean
}

/** Node.js on PATH, or eNCode's own. */
function findNode(context: RunContext): NodeProgram | null {
  const found = searchPath('node', context.env, context.platform)
  if (found) return { file: found, env: {}, own: false }
  return context.node ? { file: context.node.file, env: context.node.env ?? {}, own: true } : null
}

const versions = new Map<string, Promise<[number, number] | null>>()

/** `node --version`, once a program. */
function nodeVersion(file: string, env: Record<string, string>): Promise<[number, number] | null> {
  let known = versions.get(file)
  if (!known) {
    known = new Promise((resolve) => {
      execFile(file, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        const match = /^v(\d+)\.(\d+)/.exec(String(stdout).trim())
        resolve(error || !match ? null : [Number(match[1]), Number(match[2])])
      })
    })
    versions.set(file, known)
    // A program that could not say is asked again next time: it may have been updated, or the machine was busy.
    void known.then((version) => {
      if (!version) versions.delete(file)
    })
  }
  return known
}

/** How Node.js `[major, minor]` runs TypeScript itself: by default (22.18, 23.6), behind a flag (22.6), or not. */
export function typeStripping(version: [number, number]): 'default' | 'flag' | null {
  const [major, minor] = version
  if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) return 'default'
  if (major === 23 || (major === 22 && minor >= 6)) return 'flag'
  return null
}

/** Folders from `from` up to `root`, `from` first; only `root` when `from` is outside it. */
function foldersUp(from: string, root: string, platform: NodeJS.Platform): string[] {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(root, from)
  if (relative.startsWith('..') || api.isAbsolute(relative)) return [root]
  const folders: string[] = []
  for (let dir = from; ; dir = api.dirname(dir)) {
    folders.push(dir)
    if (api.relative(root, dir) === '' || api.dirname(dir) === dir) break
  }
  return folders
}

/** The command of the project's tsx, from the nearest node_modules up to the folder; null when it has none. */
async function projectTsx(from: string, root: string, platform: NodeJS.Platform): Promise<string | null> {
  for (const dir of foldersUp(from, root, platform)) {
    const pkgDir = path.join(dir, 'node_modules', 'tsx')
    const text = await smallText(path.join(pkgDir, 'package.json'), MAX_PACKAGE_BYTES).catch(() => null)
    if (text === null) continue
    let bin: unknown
    try {
      bin = (JSON.parse(text) as { bin?: unknown }).bin
    } catch {
      continue
    }
    const entry = typeof bin === 'string' ? bin : isRecord(bin) && typeof bin.tsx === 'string' ? bin.tsx : null
    if (!entry) continue
    const cli = path.resolve(pkgDir, entry)
    // The command must be the package's own file.
    if (path.relative(pkgDir, cli).startsWith('..')) continue
    if (await fs.stat(cli).then((stats) => stats.isFile()).catch(() => false)) return cli
  }
  return null
}

/** A loader among Node.js's own arguments: it turns TypeScript into JavaScript itself (tsx, ts-node). */
const LOADER_FLAG = /^(--import|--loader|--experimental-loader|-r|--require)(=|$)/

/** The environment a run starts with: the person's, without eNCode's own, and the configuration's on top. */
function runEnvironment(context: RunContext, node: NodeProgram | null, extra: Record<string, string | null> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(context.env)) {
    if (typeof value !== 'string') continue
    // eNCode's own Node.js runs as Node.js only with this set; a program of the person's that starts Electron must not inherit it.
    if (/^(ELECTRON_RUN_AS_NODE|ENCODE_DEBUG_DIR)$/i.test(key)) continue
    env[key] = value
  }
  if (node?.own) Object.assign(env, node.env)
  for (const [key, value] of Object.entries(extra)) {
    const name = envKey(env, key, context.platform)
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

const display = (file: string, root: string) => {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file
}

/** Node.js running `program` (JavaScript, or TypeScript the way this machine can run it), with its arguments. */
async function nodeRun(program: string, args: string[], runtimeArgs: string[], context: RunContext, node: NodeProgram): Promise<{ args: string[]; how: string }> {
  const shown = display(program, context.root)
  if (isScriptFile(program) || (isTypeScriptFile(program) && runtimeArgs.some((arg) => LOADER_FLAG.test(arg)))) return { args: [...runtimeArgs, program, ...args], how: `node ${shown}` }
  if (!isTypeScriptFile(program)) throw new RunProblem(`${path.basename(program)} is not a JavaScript or TypeScript file, so Node.js cannot run it.`)
  const tsx = await projectTsx(path.dirname(program), context.root, context.platform)
  if (tsx) return { args: [...runtimeArgs, tsx, program, ...args], how: `tsx ${shown}` }
  if (/\.tsx$/i.test(program)) throw new RunProblem(`Node.js cannot run .tsx files itself. Add tsx to the project (npm install --save-dev tsx), and eNCode runs ${path.basename(program)} with it.`)
  const version = await (context.nodeVersion ?? nodeVersion)(node.file, runEnvironment(context, node))
  const stripping = version ? typeStripping(version) : null
  if (stripping === 'default') return { args: [...runtimeArgs, program, ...args], how: `node ${shown}` }
  if (stripping === 'flag') return { args: ['--experimental-strip-types', ...runtimeArgs, program, ...args], how: `node --experimental-strip-types ${shown}` }
  const which = version ? `Node.js ${version.join('.')}` : 'This Node.js'
  throw new RunProblem(`${which} cannot run TypeScript itself. Add tsx to the project (npm install --save-dev tsx), or install Node.js 22.18 or later.`)
}

/** A path a configuration names: as written when whole, else in the folder. */
function inFolder(file: string, root: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  return api.resolve(root, file)
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then((stats) => stats.isFile()).catch(() => false)
}

async function isFolder(file: string): Promise<boolean> {
  return fs.stat(file).then((stats) => stats.isDirectory()).catch(() => false)
}

/** A word as /bin/sh reads it back. */
const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

/** A package script, run as npm runs it: through the shell, with the package's node_modules/.bin first on PATH. */
async function scriptRun(name: string, args: string[], cwd: string, context: RunContext, extra: Record<string, string | null>): Promise<Extract<RunPlan, { kind: 'launch' }>> {
  const pkg = await packageJson(cwd)
  const line = pkg?.scripts.find(([script]) => script === name)?.[1]
  if (!pkg || line === undefined) throw new RunProblem(`package.json${pkg ? '' : ` in ${display(cwd, context.root) || 'the folder'}`} has no script named "${name}".`)
  const node = findNode(context)
  if (!node || node.own) throw new RunProblem("Node.js is not installed, and a package's scripts need it. Install Node.js, then start this again.")
  const env = runEnvironment(context, node, extra)
  const pathKey = envKey(env, 'PATH', context.platform)
  const bins = foldersUp(cwd, context.root, context.platform).map((dir) => path.join(dir, 'node_modules', '.bin'))
  env[pathKey] = [...bins, env[pathKey] ?? ''].filter(Boolean).join(context.platform === 'win32' ? ';' : ':')
  Object.assign(env, {
    npm_lifecycle_event: name,
    npm_lifecycle_script: line,
    npm_package_json: pkg.file,
    npm_node_execpath: node.file,
    INIT_CWD: cwd,
    ...(pkg.name ? { npm_package_name: pkg.name } : {}),
    ...(pkg.version ? { npm_package_version: pkg.version } : {}),
  })
  if (context.platform === 'win32') {
    const unsafe = args.find((arg) => !/^[\w\-+=.,:/\\@~]+$/.test(arg))
    if (unsafe !== undefined) throw new RunProblem(`cmd.exe would read the argument ${JSON.stringify(unsafe)} as something else: leave it out, or put it in the script.`)
    const command = [line, ...args].join(' ')
    return { kind: 'launch', name, file: windowsSystemProgram('cmd.exe'), args: ['/d', '/s', '/c', `"${command}"`], cwd, env, verbatim: true, detail: clip(command) }
  }
  const command = [line, ...args.map(shellWord)].join(' ')
  return { kind: 'launch', name, file: '/bin/sh', args: ['-c', command], cwd, env, detail: clip(command) }
}

/** The program a configuration's `runtime` names, as a way to start it: through Node.js when it is a Node.js script. */
async function runtimeProgram(runtime: string, cwd: string, context: RunContext, node: NodeProgram | null): Promise<{ file: string; prefix: string[]; batch?: true }> {
  const windows = context.platform === 'win32'
  let found: string | null = null
  if (/[\\/]/.test(runtime)) found = inFolder(runtime, context.root, context.platform)
  else {
    const names = windows ? [`${runtime}.cmd`, `${runtime}.exe`, runtime] : [runtime]
    for (const dir of foldersUp(cwd, context.root, context.platform).map((folder) => path.join(folder, 'node_modules', '.bin'))) {
      for (const candidate of names) if (!found && (await isFile(path.join(dir, candidate)))) found = path.join(dir, candidate)
    }
    found ??= searchPath(runtime, context.env, context.platform)
  }
  if (!found || !(await isFile(found))) throw new RunProblem(`"${runtime}" was not found in the project's node_modules/.bin or on PATH.`)
  const script = async (file: string) => {
    if (/\.[cm]?js$/i.test(file)) return file
    const head = await fs.readFile(file, 'utf8').then((text) => text.slice(0, 200)).catch(() => '')
    return /^#!.*\bnode\b/.test(head) ? file : null
  }
  if (windows && /\.(cmd|bat)$/i.test(found)) {
    const js = shimScript(found, await fs.readFile(found, 'utf8').catch(() => ''))
    if (js) {
      if (!node) throw new RunProblem(`${runtime} is a Node.js program, and Node.js is not installed.`)
      return { file: node.file, prefix: [js] }
    }
    return { file: found, prefix: [], batch: true }
  }
  const js = await script(await fs.realpath(found).catch(() => found))
  if (js) {
    if (!node) throw new RunProblem(`${runtime} is a Node.js program, and Node.js is not installed.`)
    return { file: node.file, prefix: [js] }
  }
  return { file: found, prefix: [] }
}

/** What a configuration of the folder starts, worked out; a RunProblem says why it cannot. */
export async function planRun(id: string, context: RunContext): Promise<RunPlan> {
  const { root, platform } = context
  if (id === 'attach') return { kind: 'attach', name: `Attach to port ${DEFAULT_PORT}`, host: '127.0.0.1', port: DEFAULT_PORT, detail: `127.0.0.1:${DEFAULT_PORT}` }
  if (id === 'file') {
    const file = context.file
    if (!file) throw new RunProblem('Open the JavaScript or TypeScript file to debug in the editor first.')
    const node = findNode(context)
    if (!node) throw new RunProblem('Node.js was not found. Install it, then start this again.')
    if (!(await isFile(file))) throw new RunProblem(`${path.basename(file)} is not saved yet: save it first.`)
    const run = await nodeRun(file, [], [], context, node)
    return { kind: 'launch', name: path.basename(file), file: node.file, args: run.args, cwd: root, env: runEnvironment(context, node), detail: run.how }
  }
  if (id.startsWith('script:')) {
    const name = id.slice('script:'.length)
    return { ...(await scriptRun(name, [], root, context, {})), name: `Script: ${name}` }
  }
  const own = /^own:(\d+)$/.exec(id)
  if (!own) throw new RunProblem('That way of debugging is not one this folder has.')
  const { entries, problem } = await ownConfigs(root)
  const entry = entries[Number(own[1])]
  if (!entry) throw new RunProblem(problem ?? `${DEBUG_FILE} has changed: choose the configuration again.`)
  if ('problem' in entry) throw new RunProblem(`${entry.name}: ${entry.problem}`)
  if (entry.request === 'attach') return { kind: 'attach', name: entry.name, host: entry.host, port: entry.port, detail: `${entry.host}:${entry.port}` }
  const fill = (text: string) => substitute(text, context)
  const cwd = inFolder(entry.cwd ? fill(entry.cwd) : root, root, platform)
  if (!(await isFolder(cwd))) throw new RunProblem(`${entry.name}: the folder it runs in, ${display(cwd, root)}, does not exist.`)
  const args = entry.args.map(fill)
  const runtimeArgs = entry.runtimeArgs.map(fill)
  const extra = Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, value === null ? null : fill(value)]))
  if (entry.npmScript !== undefined) return { ...(await scriptRun(fill(entry.npmScript), args, cwd, context, extra)), name: entry.name }
  const program = inFolder(fill(entry.program!), root, platform)
  if (!(await isFile(program))) throw new RunProblem(`${entry.name}: ${display(program, root)} does not exist.`)
  const node = findNode(context)
  if (!entry.runtime || entry.runtime === 'node') {
    if (!node) throw new RunProblem('Node.js was not found. Install it, then start this again.')
    const run = await nodeRun(program, args, runtimeArgs, context, node)
    return { kind: 'launch', name: entry.name, file: node.file, args: run.args, cwd, env: runEnvironment(context, node, extra), detail: clip([run.how, ...args].join(' ')) }
  }
  const runtime = await runtimeProgram(fill(entry.runtime), cwd, context, node)
  const runArgs = [...runtime.prefix, ...runtimeArgs, program, ...args]
  const env = runEnvironment(context, runtime.prefix.length ? node : null, extra)
  const detail = clip([entry.runtime, display(program, root), ...args].join(' '))
  if (runtime.batch) {
    const batch = batchCommand(runtime.file, runArgs)
    if (!batch.ok) throw new RunProblem(`${entry.name}: ${batch.reason}.`)
    return { kind: 'launch', name: entry.name, file: batch.file, args: batch.args, cwd, env, verbatim: true, detail }
  }
  return { kind: 'launch', name: entry.name, file: runtime.file, args: runArgs, cwd, env, detail }
}
