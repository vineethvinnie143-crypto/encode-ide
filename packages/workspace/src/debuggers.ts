/**
 * The debuggers eNCode starts for Python, Go, C, C++ and Rust (ADR 0144), and the programs around them: the Python a
 * folder runs on, the Go that builds for Delve, the compilers a single file is built with. Each is a separate program.
 * eNCode installs debugpy and Delve into its own tools folder when the person says yes, with the same steps as a
 * language server (ADR 0083): debugpy as the one wheel PyPI publishes for every computer, checked against a sha256
 * pinned here, and Delve with `go install` at a pinned version. lldb-dap comes with LLVM, which is too large to fetch
 * for a debugger, so it is found where LLVM's installers put it.
 *
 * Every program is started by its whole path, never looked up in the folder (`searchPath`), and every question asked
 * of one (its version) runs briefly, isolated from the folder where the program allows it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installedDir, runtimeLaunch, versionAtLeast, type Installable } from '@encode/lsp'
import { envKey, envValue, searchDirectories, searchPath } from '@encode/tools'
import { dllImports } from './dll-imports'

/** Why a run cannot start, in words for the person; `install` names what eNCode can install to fix it. */
export class RunProblem extends Error {
  override name = 'RunProblem'
  constructor(
    message: string,
    readonly install?: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- what eNCode installs

const DEBUGPY_VERSION = '1.8.22'
const DEBUGPY_WHEEL = `debugpy-${DEBUGPY_VERSION}-py2.py3-none-any.whl`
/** debugpy 1.8.22 asks for Python 3.10 or newer. */
const DEBUGPY_PYTHON: [number, number] = [3, 10]
/** One wheel for every computer: debugpy is Python, with the few native parts of each system inside. */
const DEBUGPY_ASSET = { name: DEBUGPY_WHEEL, archive: 'zip', bin: 'debugpy/adapter/__main__.py' } as const
const EVERY_COMPUTER = ['win32-x64', 'win32-arm64', 'win32-ia32', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

export const DEBUGPY: Installable = {
  id: 'debugpy',
  label: 'Python',
  what: "debugpy, Python's debugger",
  role: 'debugger',
  install: 'python -m pip install debugpy',
  installer: {
    kind: 'download',
    from: 'PyPI (files.pythonhosted.org)',
    release: {
      version: DEBUGPY_VERSION,
      base: 'https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/',
      sha256: { [DEBUGPY_WHEEL]: 'a9e9d3550e15ca479c59333e90845029190531f0cacfedab3b815a57bd913947' },
    },
    assets: Object.fromEntries(EVERY_COMPUTER.map((key) => [key, DEBUGPY_ASSET])),
    args: [],
    needs: 'Python 3.10 or newer, which runs it',
  },
}

const DELVE_VERSION = '1.27.2'
/** Delve 1.27 builds and reads programs of Go 1.25 and newer. */
const DELVE_GO = '1.25'

export const DELVE: Installable = {
  id: 'delve',
  label: 'Go',
  what: "Delve, Go's debugger",
  role: 'debugger',
  install: `go install github.com/go-delve/delve/cmd/dlv@v${DELVE_VERSION}`,
  installer: { kind: 'toolchain', program: 'go', args: ['install', `github.com/go-delve/delve/cmd/dlv@v${DELVE_VERSION}`], env: { GOBIN: '{dir}' }, version: DELVE_VERSION, needs: 'Go', bin: 'dlv', runtime: 'go', runtimeAtLeast: DELVE_GO },
}

/** The debuggers eNCode installs itself. */
export const DEBUGGERS: readonly Installable[] = [DEBUGPY, DELVE]

// ---------------------------------------------------------------- asking programs

/** What finding a program needs to know. */
export interface FindContext {
  /** The folder, as a real path. */
  root: string
  platform: NodeJS.Platform
  /** The environment runs start with. */
  env: Record<string, string>
  /** eNCode's tools folder, where it installs debuggers. */
  tools?: string
  /** For tests: a program's answer to a question, or null when it gave none. */
  ask?(file: string, args: string[], options: { env: Record<string, string>; cwd: string }): Promise<string | null>
}

const ASK_MS = 15_000
const MAX_ANSWER = 64 * 1024

/** What a program prints for a question (`--version`), or null when it fails, says nothing, or takes too long. */
function ask(context: FindContext, file: string, args: string[], cwd = context.root): Promise<string | null> {
  if (context.ask) return context.ask(file, args, { env: context.env, cwd })
  return new Promise((resolve) => {
    execFile(file, args, { env: context.env, cwd, timeout: ASK_MS, windowsHide: true, maxBuffer: MAX_ANSWER, shell: false }, (error, stdout) => {
      const text = String(stdout).trim()
      resolve(error || !text ? null : text)
    })
  })
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name)
const api = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A program a configuration names: a path (in the folder when not whole), or a name on the PATH. */
function named(program: string, context: FindContext): string | null {
  if (/[\\/]/.test(program)) {
    const file = api(context.platform).resolve(context.root, program)
    return isFile(file) ? file : null
  }
  return searchPath(program, context.env, context.platform)
}

/** The first of `names` on the PATH, then the first of `places` that is there. */
function firstOf(names: string[], places: string[], context: FindContext): string | null {
  for (const name of names) {
    const found = searchPath(name, context.env, context.platform)
    if (found) return found
  }
  return places.find(isFile) ?? null
}

/** Folders named `<prefix><number>` in `dir`, the highest number first (`/usr/lib/llvm-18`). */
function numbered(dir: string, prefix: string): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .map((entry) => ({ entry, number: entry.startsWith(prefix) ? Number(entry.slice(prefix.length)) : NaN }))
    .filter((item) => Number.isInteger(item.number))
    .sort((a, b) => b.number - a.number)
    .map((item) => path.join(dir, item.entry))
}

const programFiles = (context: FindContext) => envValue(context.env, 'ProgramFiles', 'win32') ?? 'C:\\Program Files'
const home = (context: FindContext) => envValue(context.env, context.platform === 'win32' ? 'USERPROFILE' : 'HOME', context.platform) ?? os.homedir()

// ---------------------------------------------------------------- Python

export interface PythonFound {
  file: string
  version: [number, number]
}

/** Isolated (`-I`): nothing of the folder or of PYTHON* variables is imported while it answers. */
const PYTHON_QUESTION = ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2]); print(sys.executable)']

/** The interpreters to try, in order: the configuration's, the folder's own environment, the active one, the PATH's. */
function pythonCandidates(context: FindContext, configured?: string): { file: string; args: string[] }[] {
  const windows = context.platform === 'win32'
  const join = api(context.platform).join
  const inEnv = (dir: string) => (windows ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python'))
  const list: { file: string; args: string[] }[] = []
  if (configured) {
    const file = named(configured, context)
    if (!file) throw new RunProblem(`The Python this configuration names, ${configured}, was not found.`)
    return [{ file, args: [] }]
  }
  for (const dir of ['.venv', 'venv', 'env']) {
    const where = join(context.root, dir)
    if (isFile(join(where, 'pyvenv.cfg'))) list.push({ file: inEnv(where), args: [] })
  }
  const active = envValue(context.env, 'VIRTUAL_ENV', context.platform)
  if (active) list.push({ file: inEnv(active), args: [] })
  const conda = envValue(context.env, 'CONDA_PREFIX', context.platform)
  if (conda) list.push({ file: windows ? join(conda, 'python.exe') : join(conda, 'bin', 'python'), args: [] })
  for (const name of windows ? ['python', 'python3'] : ['python3', 'python']) {
    const found = searchPath(name, context.env, context.platform)
    if (found) list.push({ file: found, args: [] })
  }
  // The launcher of python.org's installer, which knows where each Python is.
  const launcher = windows ? searchPath('py', context.env, context.platform) : null
  if (launcher) list.push({ file: launcher, args: ['-3'] })
  return list
}

/**
 * The Python a run uses: the one it names, else the folder's virtual environment (.venv, venv, env), the active one,
 * then the PATH's. Each is asked its version; one that does not answer (the Microsoft Store's stand-in) is passed by.
 */
export async function findPython(context: FindContext, configured?: string): Promise<PythonFound> {
  const tried = new Set<string>()
  for (const candidate of pythonCandidates(context, configured)) {
    const key = `${candidate.file}\0${candidate.args.join(' ')}`
    if (tried.has(key) || !isFile(candidate.file)) continue
    tried.add(key)
    const answer = await ask(context, candidate.file, [...candidate.args, ...PYTHON_QUESTION])
    const [version, executable] = answer?.split(/\r?\n/).map((line) => line.trim()) ?? []
    const match = version ? /^(\d+)\.(\d+)$/.exec(version) : null
    if (!match || !executable || !isFile(executable)) continue
    return { file: executable, version: [Number(match[1]), Number(match[2])] }
  }
  if (configured) throw new RunProblem(`The Python this configuration names, ${configured}, did not start.`)
  throw new RunProblem(
    context.platform === 'win32'
      ? 'Python was not found. Install Python 3.10 or newer from python.org (tick "Add python.exe to PATH"), or make a virtual environment in the folder (.venv), then start this again.'
      : 'Python was not found. Install Python 3.10 or newer, or make a virtual environment in the folder (.venv), then start this again.',
  )
}

const atLeast = (version: [number, number], minimum: [number, number]) => version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1])

/**
 * How debugpy's adapter starts on a Python: eNCode's own copy when it is installed and the Python is new enough for
 * it, else the debugpy installed in that Python (1.6 or newer). Without either, eNCode offers to install its copy.
 */
export async function findDebugpy(python: PythonFound, context: FindContext): Promise<{ file: string; args: string[]; where: string }> {
  const ours = context.tools ? installedDir(DEBUGPY, context.tools) : null
  const adapter = ours ? path.join(ours.dir, 'debugpy', 'adapter') : null
  // Started by its path: Python puts the adapter's folder first on sys.path, and the adapter puts its own package there.
  if (adapter && isFile(path.join(adapter, '__main__.py')) && atLeast(python.version, DEBUGPY_PYTHON)) return { file: python.file, args: [adapter], where: `debugpy ${ours!.version}, in eNCode's folder` }
  const own = await ask(context, python.file, ['-I', '-c', 'import debugpy; print(debugpy.__version__)'])
  const version = own ? /^(\d+)\.(\d+)/.exec(own) : null
  if (version && atLeast([Number(version[1]), Number(version[2])], [1, 6])) return { file: python.file, args: ['-m', 'debugpy.adapter'], where: `debugpy ${own}, in ${python.file}` }
  const shown = python.version.join('.')
  if (!atLeast(python.version, DEBUGPY_PYTHON)) {
    throw new RunProblem(`Debugging Python needs debugpy, which needs Python ${DEBUGPY_PYTHON.join('.')} or newer, and this Python is ${shown} (${python.file}). Use a newer Python, or install debugpy into this one: "${python.file}" -m pip install debugpy`)
  }
  throw new RunProblem("Debugging Python needs debugpy, Python's debugger. eNCode can install it into its own folder; nothing else on this computer changes.", DEBUGPY.id)
}

// ---------------------------------------------------------------- Go

export interface GoFound {
  /** What Delve is started with besides the run's environment: eNCode's Go first on the PATH, when it builds. */
  env: Record<string, string>
  /** For people: "go1.26.2 (C:\Program Files\Go\bin\go.exe)". */
  label: string
}

/** The newest Go a go.mod asks for, by its `go` and `toolchain` lines, from the program's folder up to the root. */
function goModWants(from: string, context: FindContext): string | null {
  const join = api(context.platform)
  for (let dir = from; ; dir = join.dirname(dir)) {
    let text: string | null = null
    try {
      text = fs.readFileSync(join.join(dir, 'go.mod'), 'utf8').slice(0, 64 * 1024)
    } catch {
      /* not here */
    }
    if (text !== null) {
      const versions = [...text.matchAll(/^\s*(?:go\s+|toolchain\s+go)(\d+\.\d+(?:\.\d+)?)\s*$/gm)].map((match) => match[1]!)
      return versions.sort((a, b) => (versionAtLeast(a, b.split('.').map(Number)) ? -1 : 1))[0] ?? null
    }
    const back = join.relative(context.root, dir)
    if (!back || back.startsWith('..') || join.dirname(dir) === dir) return null
  }
}

/**
 * The Go that builds the program for Delve, which takes Go 1.25 or newer: the PATH's when it is new enough, or when
 * the folder's go.mod asks for a new enough one (the go command fetches that itself); else eNCode's own copy of Go.
 */
export async function findGo(context: FindContext, program: string, ourDelve: { runtime?: boolean } | null): Promise<GoFound> {
  const own = context.tools ? runtimeLaunch('go', context.tools, context.platform, context.env) : undefined
  // A Delve eNCode built with its own Go runs with it.
  if (ourDelve?.runtime && own) return { env: own.env, label: `go${own.version}, eNCode's copy` }
  const system = searchPath('go', context.env, context.platform)
  if (system) {
    const answer = await ask(context, system, ['env', 'GOVERSION'], context.tools && fs.existsSync(context.tools) ? context.tools : context.root)
    const local = answer?.split(/\r?\n/)[0]?.trim() ?? ''
    const wanted = goModWants(isFile(program) ? api(context.platform).dirname(program) : program, context)
    if (/^go\d/.test(local) && (versionAtLeast(local, DELVE_GO.split('.').map(Number)) || (wanted && versionAtLeast(wanted, DELVE_GO.split('.').map(Number))))) return { env: {}, label: `${local} (${system})` }
    if (own) return { env: own.env, label: `go${own.version}, eNCode's copy` }
    throw new RunProblem(
      `Delve needs Go ${DELVE_GO} or newer to build the program, and the Go on this computer is ${local || 'older'} (${system}). Install a newer Go from https://go.dev/dl/, or let eNCode install Delve with its own copy of Go, for debugging alone.`,
      DELVE.id,
    )
  }
  if (own) return { env: own.env, label: `go${own.version}, eNCode's copy` }
  throw new RunProblem("Debugging Go needs Go and Delve, Go's debugger, and Go is not on this computer. eNCode can install Delve with its own copy of Go, for debugging alone; nothing else on this computer changes.", DELVE.id)
}

/** Delve: the person's own (PATH, GOBIN, GOPATH's bin, ~/go/bin), which matches their Go, else eNCode's copy. */
export function findDelve(context: FindContext): { file: string; ours: { runtime: boolean } | null } {
  const join = api(context.platform).join
  const gobin = envValue(context.env, 'GOBIN', context.platform)
  const gopath = envValue(context.env, 'GOPATH', context.platform)?.split(context.platform === 'win32' ? ';' : ':')[0]
  const places = [gobin, gopath && join(gopath, 'bin'), join(home(context), 'go', 'bin')].filter((dir): dir is string => !!dir).map((dir) => join(dir, exe('dlv', context.platform)))
  const theirs = firstOf(['dlv'], places, context)
  if (theirs) return { file: theirs, ours: null }
  const ours = context.tools ? installedDir(DELVE, context.tools) : null
  const file = ours ? path.join(ours.dir, exe('dlv', context.platform)) : null
  if (ours && file && isFile(file)) {
    if (ours.runtime && !runtimeLaunch('go', context.tools!, context.platform, context.env)) throw new RunProblem("Delve was installed with eNCode's own copy of Go, which is no longer there. Install it again.", DELVE.id)
    return { file, ours: { runtime: !!ours.runtime } }
  }
  throw new RunProblem("Debugging Go needs Delve, Go's debugger. eNCode can install it into its own folder with go install; nothing else on this computer changes.", DELVE.id)
}

// ---------------------------------------------------------------- LLVM: lldb-dap and the compilers

const LLDB_MISSING = {
  win32: 'install LLVM 18 or newer (winget install LLVM.LLVM, or the installer at https://github.com/llvm/llvm-project/releases)',
  darwin: "install Xcode's command line tools (xcode-select --install) or LLVM (brew install llvm)",
  other: "install your system's lldb package (lldb-dap comes with LLVM 18 or newer)",
}

/** lldb-dap (lldb-vscode before LLVM 18), on the PATH or where LLVM's installers put it. */
export function findLldbDap(context: FindContext): string {
  const join = api(context.platform).join
  const places: string[] = []
  if (context.platform === 'win32') places.push(join(programFiles(context), 'LLVM', 'bin', 'lldb-dap.exe'))
  else if (context.platform === 'darwin') {
    places.push('/opt/homebrew/opt/llvm/bin/lldb-dap', '/usr/local/opt/llvm/bin/lldb-dap', '/Library/Developer/CommandLineTools/usr/bin/lldb-dap', '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap')
  } else {
    places.push(...numbered('/usr/lib', 'llvm-').flatMap((dir) => [join(dir, 'bin', 'lldb-dap'), join(dir, 'bin', 'lldb-vscode')]))
    places.push(...numbered('/usr/lib/llvm', '').map((dir) => join(dir, 'bin', 'lldb-dap')))
  }
  // Debian and Ubuntu name it for its version: lldb-dap-18.
  const versioned = context.platform === 'linux' ? numbered('/usr/bin', 'lldb-dap-').filter(isFile) : []
  const found = firstOf(['lldb-dap', 'lldb-vscode'], [...versioned, ...places], context)
  if (found) return found
  const how = context.platform === 'win32' ? LLDB_MISSING.win32 : context.platform === 'darwin' ? LLDB_MISSING.darwin : LLDB_MISSING.other
  throw new RunProblem(`Debugging C, C++ and Rust needs lldb-dap, which comes with LLVM. To get it, ${how}, then start this again.`)
}

/** The Python LLVM's lldb-dap needs on Windows, and the folder it is in when Windows would not find it there itself. */
export interface LldbPython {
  /** As liblldb.dll names it: python311.dll. */
  dll: string
  /** 3.11 */
  version: string
  /** A folder to add to the end of lldb-dap's PATH, or null when Windows finds the library as things are. */
  add: string | null
}

const PYTHON_DLL = /^python3(\d{1,2})\.dll$/i

/**
 * LLVM's Windows releases build lldb with Python and link it to one Python's library (python311.dll), which Windows
 * must find when lldb-dap starts or it ends at once, saying nothing. The library is named by what liblldb.dll imports;
 * where it is: next to lldb-dap, on the PATH, where python.org's installer puts that version, or where the py launcher
 * says it is. A folder found any other way than the PATH goes on the end of lldb-dap's PATH, after everything already
 * there. Null when lldb-dap needs no Python; a RunProblem, before anything starts, when it needs one that is missing.
 */
export async function lldbPython(lldbDap: string, context: FindContext): Promise<LldbPython | null> {
  const dir = path.dirname(lldbDap)
  const imported = [path.join(dir, 'liblldb.dll'), lldbDap].flatMap((file) => dllImports(file)).find((item) => PYTHON_DLL.test(item.name))
  if (!imported) return null
  const dll = imported.name.toLowerCase()
  const version = `3.${PYTHON_DLL.exec(dll)![1]}`
  const has = (folder: string) => isFile(path.join(folder, dll))
  const system = envValue(context.env, 'SystemRoot', context.platform)
  if (has(dir) || (system && has(path.join(system, 'System32'))) || searchDirectories(context.env, context.platform).some(has)) return { dll, version, add: null }
  const local = envValue(context.env, 'LOCALAPPDATA', context.platform)
  const folder = `Python${version.replace('.', '')}`
  const places = [...(local ? [path.join(local, 'Programs', 'Python', folder), path.join(local, 'Programs', 'Python', `${folder}-arm64`)] : []), path.join(programFiles(context), folder), path.join(programFiles(context), `${folder}-arm64`)]
  let found = places.find(has) ?? null
  const launcher = found ? null : searchPath('py', context.env, context.platform)
  if (launcher) {
    const prefix = (await ask(context, launcher, [`-${version}`, '-I', '-c', 'import sys; print(sys.base_prefix)']))?.split(/\r?\n/)[0]?.trim()
    if (prefix && path.isAbsolute(prefix) && has(prefix)) found = prefix
  }
  if (found) return { dll, version, add: found }
  // Loaded only when lldb first runs Python: lldb-dap starts without it, and a Rust program shows its values plainer.
  if (imported.delayed) return null
  throw new RunProblem(`LLVM's lldb-dap needs Python ${version} (${dll}), which is not on this computer. Install Python ${version} (winget install Python.Python.${version}), then start this again.`)
}

/** `env` with `dir` on the end of its PATH. */
export function withPathTail(env: Record<string, string>, dir: string, platform: NodeJS.Platform): Record<string, string> {
  const key = envKey(env, 'PATH', platform)
  const now = env[key]
  return { ...env, [key]: now ? `${now}${platform === 'win32' ? ';' : ':'}${dir}` : dir }
}

/** A compiler for one C or C++ file: clang first, which writes what lldb reads best, then gcc and cc. */
export function findCompiler(language: 'c' | 'cpp', context: FindContext): string {
  const names = language === 'c' ? ['clang', 'gcc', 'cc'] : ['clang++', 'g++', 'c++']
  const places = context.platform === 'win32' ? [api('win32').join(programFiles(context), 'LLVM', 'bin', `${names[0]}.exe`)] : []
  const found = firstOf(names, places, context)
  if (found) return found
  const what = language === 'c' ? 'a C compiler' : 'a C++ compiler'
  throw new RunProblem(`Building the file to debug it needs ${what} (clang or gcc), and none is on the PATH. ${context.platform === 'win32' ? 'LLVM has clang and lldb-dap both: winget install LLVM.LLVM' : 'Install clang or gcc'}, then start this again.`)
}

/** cargo, or rustc, on the PATH or in Rust's own folder (CARGO_HOME, ~/.cargo). */
export function findRust(name: 'cargo' | 'rustc', context: FindContext): string {
  const join = api(context.platform).join
  const cargoHome = envValue(context.env, 'CARGO_HOME', context.platform) ?? join(home(context), '.cargo')
  const found = firstOf([name], [join(cargoHome, 'bin', exe(name, context.platform))], context)
  if (found) return found
  throw new RunProblem(`Building a Rust program to debug it needs ${name}, which comes with Rust. Install Rust from https://rustup.rs, then start this again.`)
}

/** What lldb is told first for a Rust program: Rust's own formatters, so a String or a Vec shows its contents. */
export async function rustFormatters(rustc: string, context: FindContext): Promise<string[]> {
  const sysroot = (await ask(context, rustc, ['--print', 'sysroot']))?.split(/\r?\n/)[0]?.trim()
  if (!sysroot) return []
  const etc = path.join(sysroot, 'lib', 'rustlib', 'etc')
  const lookup = path.join(etc, 'lldb_lookup.py')
  const commands = path.join(etc, 'lldb_commands')
  if (!isFile(lookup) || !isFile(commands) || /["\r\n]/.test(etc)) return []
  return [`command script import "${lookup}"`, `command source -s 0 "${commands}"`]
}
