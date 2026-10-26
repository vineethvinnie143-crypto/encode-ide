/**
 * Python, Go, C, C++ and Rust in a folder's debugger (ADR 0144): the configurations, which debugger and program each
 * finds and what it says when one is missing (with stand-in programs that are never run), and whole runs through the
 * real debuggers, skipped where they are not installed.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { searchPath } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { WorkspaceConfig } from './config'
import { FolderDebugger, type DebugState } from './debug'
import { debugConfigs, planRun, RunProblem, type RunContext, type RunPlan } from './debug-configs'
import { DEBUGGERS, findLldbDap } from './debuggers'
import { nodeWorkspaceFs } from './fs'
import { ServerInstalls } from './installs'
import { trustFolder } from './report'

const json = (value: unknown) => JSON.stringify(value)
const windows = process.platform === 'win32'
const exe = (name: string) => (windows ? `${name}.exe` : name)
const MARKER = 'encode-install.json'
const PYTHON = searchPath('python3', process.env) ?? searchPath('python', process.env)
const PYTHON_ON_PATH = !!PYTHON

async function folder(files: Record<string, string> = {}) {
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace())
  const config = new WorkspaceConfig({ root, home })
  await config.refresh()
  return { root, home, config }
}

/** Stand-ins for programs, on a PATH of their own: found as the real ones are, and never run. */
async function standIns(names: string[]): Promise<{ bin: string; env: Record<string, string>; file(name: string): string }> {
  const bin = await fs.realpath(await tempWorkspace())
  for (const name of names) await fs.writeFile(path.join(bin, exe(name)), '')
  const home = await fs.realpath(await tempWorkspace())
  return { bin, env: { PATH: bin, ...(windows ? { PATHEXT: '.EXE', USERPROFILE: home, ProgramFiles: home } : { HOME: home }) }, file: (name) => path.join(bin, exe(name)) }
}

/** What each stand-in answers, by its file and its first argument. */
function answers(table: Record<string, string | null>): RunContext['ask'] {
  return async (file, args) => {
    const key = `${path.basename(file).replace(/\.exe$/i, '')} ${args.includes('-c') ? args[args.indexOf('-c') + 1]!.slice(0, 14) : args.join(' ')}`
    return table[key] ?? null
  }
}

const PYTHON_VERSION = 'import sys; pr'
const PYTHON_DEBUGPY = 'import debugpy'

/** A debugger in eNCode's tools folder, as an install leaves it. */
async function installed(tools: string, id: string, version: string, files: string[], runtime?: { id: string; version: string }) {
  const dir = path.join(tools, id, version)
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), '')
  }
  await fs.writeFile(path.join(dir, MARKER), json({ id, version, kind: 'toolchain', ...(runtime ? { runtime } : {}) }))
  return dir
}

const dap = (plan: RunPlan) => {
  assert.equal(plan.kind, 'dap')
  return (plan as Extract<RunPlan, { kind: 'dap' }>).dap
}

async function problem(run: Promise<unknown>): Promise<RunProblem> {
  try {
    await run
  } catch (error) {
    if (error instanceof RunProblem) return error
    throw error
  }
  throw new Error('it ran')
}

describe('configurations of other languages', () => {
  it('lists Python, Go, C and Rust configurations, and says what is wrong with one', async () => {
    const { root } = await folder({
      '.encode/debug.json': json({
        configurations: [
          { name: 'App', type: 'python', program: '${folder}/app.py', args: ['--fast'] },
          { name: 'Module', type: 'debugpy', module: 'pkg.main' },
          { name: 'Server', type: 'python', request: 'attach' },
          { name: 'Go', type: 'go', program: './cmd/api' },
          { name: 'Go tests', type: 'go', mode: 'test' },
          { name: 'Native', type: 'lldb', program: 'build/app' },
          { name: 'Rust', type: 'rust', bin: 'cli' },
          { name: 'No program', type: 'lldb' },
          { name: 'Both', type: 'python', program: 'a.py', module: 'a' },
          { name: 'Attach to Go', type: 'go', request: 'attach' },
          { name: 'Script', type: 'go', npmScript: 'dev' },
          { name: 'Flags', type: 'go', buildFlags: ['-tags dev'] },
        ],
      }),
    })
    const { configs } = await debugConfigs(root)
    assert.deepEqual(
      configs.slice(0, 12).map((config) => [config.name, config.kind, config.detail, config.problem ?? '']),
      [
        ['App', 'launch', 'python ${folder}/app.py --fast', ''],
        ['Module', 'launch', 'python -m pkg.main', ''],
        ['Server', 'attach', 'debugpy at 127.0.0.1:5678', ''],
        ['Go', 'launch', 'dlv debug ./cmd/api', ''],
        ['Go tests', 'launch', 'dlv test .', ''],
        ['Native', 'launch', 'lldb-dap build/app', ''],
        ['Rust', 'launch', 'cargo build --bin cli', ''],
        ['No program', 'launch', '.encode/debug.json', 'Name the program to debug ("program"): the executable your build makes.'],
        ['Both', 'launch', '.encode/debug.json', 'Name the script to run ("program") or a module ("module", run as python -m), one of them.'],
        ['Attach to Go', 'launch', '.encode/debug.json', 'eNCode attaches to Node.js and Python programs; start this one with "request": "launch".'],
        ['Script', 'launch', '.encode/debug.json', '"npmScript" and "runtime" are for Node.js configurations.'],
        ['Flags', 'launch', '.encode/debug.json', '"buildFlags" must be words without spaces: give each flag on its own.'],
      ],
    )
  })

  it("reads the README's example without a problem", async () => {
    // The tests run from a copy inside the repository, so the README is the nearest one up.
    let dir = path.dirname(fileURLToPath(import.meta.url))
    while (!existsSync(path.join(dir, 'README.md')) || !existsSync(path.join(dir, 'pnpm-workspace.yaml'))) dir = path.dirname(dir)
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8')
    // A block in a list, so indented.
    const found = /\n( *)```json\n(\1\{\n\1  "configurations"[\s\S]*?)\n\1```/.exec(readme)
    assert.ok(found, 'the example in the README')
    const example = found[2]!.split('\n').map((line) => line.slice(found[1]!.length)).join('\n')
    const { root } = await folder({ '.encode/debug.json': example })
    const { configs, problem: wrong } = await debugConfigs(root)
    assert.equal(wrong, undefined)
    assert.deepEqual(
      configs.filter((config) => config.id.startsWith('own:')).map((config) => [config.name, config.detail, config.problem ?? '']),
      [
        ['API', 'node src/server.ts', ''],
        ['Worker', 'python -m app.worker --once', ''],
        ['Tests', 'dlv test ./store', ''],
        ['Importer', 'cargo build --bin importer', ''],
        ['Engine', 'lldb-dap build/engine', ''],
      ],
    )
  })

  it('says which files it debugs', async () => {
    const { root } = await folder({ 'notes.txt': 'hi\n' })
    const found = await problem(planRun('file', { root, platform: process.platform, env: process.env, file: path.join(root, 'notes.txt') }))
    assert.equal(found.message, 'eNCode debugs JavaScript, TypeScript, Python, Go, Rust, C and C++ files, and notes.txt is none of them.')
  })
})

describe('Python', () => {
  it("takes the folder's virtual environment first, and eNCode's debugpy when installed", async () => {
    const programs = await standIns(['python3', 'python'])
    const { root } = await folder({ 'app.py': 'print(1)\n', '.venv/pyvenv.cfg': 'home = x\n' })
    const venvPython = path.join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python')
    await fs.mkdir(path.dirname(venvPython), { recursive: true })
    await fs.writeFile(venvPython, '')
    const tools = await fs.realpath(await tempWorkspace())
    const dir = await installed(tools, 'debugpy', '1.8.22', ['debugpy/adapter/__main__.py'])
    const ask = answers({ [`python ${PYTHON_VERSION}`]: `3.12\n${venvPython}` })
    const plan = await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'app.py'), tools, ask })
    const run = dap(plan)
    assert.equal(plan.detail, 'python app.py')
    assert.deepEqual([run.profile, run.request, run.adapter.file, run.adapter.args, run.adapter.transport], ['debugpy', 'launch', venvPython, [path.join(dir, 'debugpy', 'adapter')], 'stdio'])
    assert.deepEqual([run.arguments.program, run.arguments.python, run.arguments.justMyCode, run.arguments.cwd], [path.join(root, 'app.py'), venvPython, true, root])
  })

  it("uses the Python's own debugpy, else offers eNCode's, and says when the Python is too old for it", async () => {
    const programs = await standIns(['python3', 'python'])
    const { root } = await folder({ 'app.py': 'print(1)\n' })
    const file = path.join(root, 'app.py')
    const python = programs.file(windows ? 'python' : 'python3')
    const at = (table: Record<string, string | null>) => ({ root, platform: process.platform, env: programs.env, file, ask: answers(table) })
    const own = dap(await planRun('file', at({ [`${windows ? 'python' : 'python3'} ${PYTHON_VERSION}`]: `3.12\n${python}`, [`${windows ? 'python' : 'python3'} ${PYTHON_DEBUGPY}`]: '1.8.5' })))
    assert.deepEqual(own.adapter.args, ['-m', 'debugpy.adapter'])
    const missing = await problem(planRun('file', at({ [`${windows ? 'python' : 'python3'} ${PYTHON_VERSION}`]: `3.12\n${python}` })))
    assert.equal(missing.install, 'debugpy')
    assert.match(missing.message, /^Debugging Python needs debugpy, Python's debugger\. eNCode can install it/)
    const old = await problem(planRun('file', at({ [`${windows ? 'python' : 'python3'} ${PYTHON_VERSION}`]: `3.9\n${python}` })))
    assert.equal(old.install, undefined)
    assert.match(old.message, /needs Python 3\.10 or newer, and this Python is 3\.9/)
    const none = await problem(planRun('file', { ...at({}), env: { PATH: path.join(root, 'nothing') } }))
    assert.match(none.message, /^Python was not found\./)
  })

  it('attaches only on this machine, to debugpy at its port', async () => {
    const programs = await standIns(['python3', 'python'])
    const python = programs.file(windows ? 'python' : 'python3')
    const { root } = await folder({ '.encode/debug.json': json({ configurations: [{ name: 'Server', type: 'python', request: 'attach', port: 5690, justMyCode: false }, { name: 'Far', type: 'python', request: 'attach', host: '192.168.1.4' }] }) })
    const tools = await fs.realpath(await tempWorkspace())
    await installed(tools, 'debugpy', '1.8.22', ['debugpy/adapter/__main__.py'])
    const ask = answers({ [`${windows ? 'python' : 'python3'} ${PYTHON_VERSION}`]: `3.13\n${python}` })
    const run = dap(await planRun('own:0', { root, platform: process.platform, env: programs.env, tools, ask }))
    assert.deepEqual([run.request, run.arguments.connect, run.arguments.justMyCode], ['attach', { host: '127.0.0.1', port: 5690 }, false])
    assert.match((await problem(planRun('own:1', { root, platform: process.platform, env: programs.env, tools, ask }))).message, /only to a program on this machine/)
  })
})

describe('Go', () => {
  it("builds a module's package, runs a test file's tests, and puts the program in the run's folder", async () => {
    const programs = await standIns(['go', 'dlv'])
    const { root } = await folder({ 'go.mod': 'module cart\n\ngo 1.24\n', 'cmd/api/main.go': 'package main\n', 'cart_test.go': 'package main\n' })
    const ask = answers({ 'go env GOVERSION': 'go1.26.2' })
    const plan = await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'cmd', 'api', 'main.go'), ask })
    const run = dap(plan)
    assert.equal(plan.detail, 'dlv debug cmd/api')
    assert.deepEqual([run.profile, run.adapter.file, run.adapter.args, run.adapter.transport, run.arguments.mode, run.arguments.program], ['delve', programs.file('dlv'), ['dap', '--client-addr={clientAddr}'], 'dial', 'debug', path.join(root, 'cmd', 'api')])
    const runDir = path.join(root, 'nowhere')
    assert.deepEqual(await run.prepare!({ runDir, print: () => undefined, signal: new AbortController().signal }), { output: path.join(runDir, exe('program')) })
    const test = dap(await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'cart_test.go'), ask }))
    assert.deepEqual([test.arguments.mode, test.arguments.program], ['test', root])
  })

  it("asks for a Go Delve can read, and offers Delve with eNCode's own Go", async () => {
    const programs = await standIns(['go', 'dlv'])
    const { root } = await folder({ 'go.mod': 'module cart\n\ngo 1.22\n', 'main.go': 'package main\n' })
    const file = path.join(root, 'main.go')
    const old = await problem(planRun('file', { root, platform: process.platform, env: programs.env, file, ask: answers({ 'go env GOVERSION': 'go1.24.7' }) }))
    assert.equal(old.install, 'delve')
    assert.match(old.message, /^Delve needs Go 1\.25 or newer to build the program, and the Go on this computer is go1\.24\.7/)
    // A module that asks for a newer Go gets it from the go command itself.
    await fs.writeFile(path.join(root, 'go.mod'), 'module cart\n\ngo 1.24\n\ntoolchain go1.26.1\n')
    assert.ok(dap(await planRun('file', { root, platform: process.platform, env: programs.env, file, ask: answers({ 'go env GOVERSION': 'go1.24.7' }) })))
  })

  it("runs eNCode's Delve with the Go it was built with, and offers to install Delve when there is none", async () => {
    const programs = await standIns(['go'])
    const { root } = await folder({ 'main.go': 'package main\n' })
    const file = path.join(root, 'main.go')
    const tools = await fs.realpath(await tempWorkspace())
    const missing = await problem(planRun('file', { root, platform: process.platform, env: programs.env, file, tools, ask: answers({ 'go env GOVERSION': 'go1.26.2' }) }))
    assert.equal(missing.install, 'delve')
    const dlv = await installed(tools, 'delve', '1.27.2', [exe('dlv')], { id: 'go', version: '1.27.3' })
    const gone = await problem(planRun('file', { root, platform: process.platform, env: programs.env, file, tools, ask: answers({ 'go env GOVERSION': 'go1.26.2' }) }))
    assert.match(gone.message, /eNCode's own copy of Go, which is no longer there/)
    const goRoot = await installed(path.join(tools, 'runtimes'), 'go', '1.27.3', [windows ? 'bin/go.exe' : 'bin/go'])
    const run = dap(await planRun('file', { root, platform: process.platform, env: programs.env, file, tools, ask: answers({}) }))
    assert.equal(run.adapter.file, path.join(dlv, exe('dlv')))
    const pathKey = Object.keys(run.adapter.env).find((key) => key.toUpperCase() === 'PATH')!
    assert.equal(run.adapter.env.GOROOT, goRoot)
    assert.ok(run.adapter.env[pathKey]!.startsWith(path.join(goRoot, 'bin')), run.adapter.env[pathKey])
    // A lone file, outside a module, is built alone.
    assert.equal(run.arguments.program, file)
  })
})

describe('C, C++ and Rust', () => {
  it('builds one file with clang into the run, and debugs it with lldb-dap', async () => {
    const programs = await standIns(['lldb-dap', 'clang', 'clang++'])
    const { root } = await folder({ 'main.c': 'int main(void) { return 0; }\n', 'app.cpp': 'int main() {}\n' })
    const plan = await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'main.c') })
    const run = dap(plan)
    assert.equal(plan.detail, 'clang -g main.c')
    assert.deepEqual([run.profile, run.adapter.file, run.arguments.program, typeof run.prepare, run.rust], ['lldb', programs.file('lldb-dap'), undefined, 'function', undefined])
    assert.equal((await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'app.cpp') })).detail, 'clang++ -g app.cpp')
  })

  it('builds Rust with cargo in a Cargo project and with rustc alone, and says what is missing', async () => {
    const programs = await standIns(['lldb-dap', 'cargo', 'rustc'])
    const { root } = await folder({ 'Cargo.toml': '[package]\nname = "cart"\n', 'src/main.rs': 'fn main() {}\n', 'tools/one.rs': 'fn main() {}\n' })
    const cargo = await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'src', 'main.rs'), ask: answers({ 'rustc --print sysroot': null }) })
    assert.deepEqual([cargo.detail, dap(cargo).rust], ['cargo build, src/main.rs', true])
    await fs.rm(path.join(root, 'Cargo.toml'))
    const alone = await planRun('file', { root, platform: process.platform, env: programs.env, file: path.join(root, 'tools', 'one.rs'), ask: answers({}) })
    assert.equal(alone.detail, 'rustc -g tools/one.rs')
    const noRust = await standIns(['lldb-dap'])
    assert.match((await problem(planRun('file', { root, platform: process.platform, env: noRust.env, file: path.join(root, 'tools', 'one.rs') }))).message, /needs rustc, which comes with Rust/)
  })

  it('finds lldb-dap on the PATH first, and says how to get LLVM when there is none', async (t) => {
    const programs = await standIns(['lldb-dap'])
    const context = { root: programs.bin, platform: process.platform, env: programs.env }
    assert.equal(findLldbDap(context), programs.file('lldb-dap'))
    const empty = { ...context, env: { ...programs.env, PATH: path.join(programs.bin, 'nothing') } }
    let found: string | null = null
    try {
      found = findLldbDap(empty)
    } catch (error) {
      assert.match(String(error), /Debugging C, C\+\+ and Rust needs lldb-dap, which comes with LLVM\. To get it, /)
    }
    if (found) t.diagnostic(`this computer has its own lldb-dap: ${found}`)
  })
})

describe('the debuggers eNCode installs', () => {
  it('names each with its pinned version, and debugpy with its checksum', () => {
    const [debugpy, delve] = DEBUGGERS
    assert.deepEqual([debugpy!.id, debugpy!.installer!.kind, delve!.id, delve!.installer!.kind], ['debugpy', 'download', 'delve', 'toolchain'])
    const release = debugpy!.installer!.kind === 'download' ? debugpy!.installer!.release : null
    assert.ok(release && 'sha256' in release && /^[0-9a-f]{64}$/.test(Object.values(release.sha256)[0]!))
    assert.ok(delve!.installer!.kind === 'toolchain' && delve!.installer!.args.join(' ') === 'install github.com/go-delve/delve/cmd/dlv@v1.27.2' && delve!.installer!.runtimeAtLeast === '1.25')
  })
})

// ---------------------------------------------------------------- installing them

const WHEEL_SIZE = 5_374_857

/** eNCode's installs, with a fetch of the test's own and how a toolchain's version is asked faked. */
async function debuggerInstalls(options: { fetch?: typeof fetch; goVersion?: string | null; env?: Record<string, string> } = {}) {
  const tools = await fs.realpath(await tempWorkspace())
  const cache = await fs.realpath(await tempWorkspace())
  const installs = new ServerInstalls({
    tools: { dir: tools, cacheDir: cache, node: { file: process.execPath }, ...(options.fetch ? { fetch: options.fetch } : {}) },
    platform: process.platform,
    ...(options.env ? { env: options.env } : {}),
    rediscover: async () => {
      throw new Error('no language server waits for a debugger')
    },
    ...(options.goVersion !== undefined ? { run: async () => ({ code: options.goVersion ? 0 : 1, output: options.goVersion ?? '' }) } : {}),
  })
  return { tools, installs }
}

/** A fetch that answers every URL with these bytes, and keeps what it was asked. */
function serving(bytes: Uint8Array, asked: string[] = []): typeof fetch {
  return async (input, init) => {
    asked.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response(init?.method === 'HEAD' ? null : bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
  }
}

describe('installing debugpy and Delve', () => {
  it("says what installing debugpy does: PyPI's one wheel, checked against its sha256", async () => {
    const asked: string[] = []
    const { tools, installs } = await debuggerInstalls({ fetch: serving(new Uint8Array(WHEEL_SIZE), asked) })
    const plan = await installs.plan('debugpy', tools)
    assert.ok('steps' in plan, JSON.stringify(plan))
    assert.equal(plan.what, "debugpy, Python's debugger")
    assert.deepEqual([plan.version, plan.bytes, plan.dir], ['1.8.22', WHEEL_SIZE, path.join(tools, 'debugpy', '1.8.22')])
    assert.deepEqual(plan.steps, [
      'Downloads debugpy-1.8.22-py2.py3-none-any.whl (version 1.8.22, 5.1 MB) from PyPI (files.pythonhosted.org) and checks it against the checksum eNCode was built with.',
      'It needs Python 3.10 or newer, which runs it.',
      "Keeps it in eNCode's own folder, named below. Nothing else on this computer changes.",
    ])
    assert.deepEqual(asked, ['HEAD https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/debugpy-1.8.22-py2.py3-none-any.whl'])
  })

  it('refuses a download that is not the wheel it pinned', async () => {
    const { tools, installs } = await debuggerInstalls({ fetch: serving(new Uint8Array(1_000)) })
    assert.deepEqual(await installs.install('debugpy', tools), { ok: false, reason: 'debugpy-1.8.22-py2.py3-none-any.whl does not match its checksum, so it was not installed.' })
    assert.deepEqual(await fs.readdir(path.join(tools, 'debugpy')), [])
  })

  it("installs Delve with the computer's Go when it is 1.25 or newer, else with eNCode's own", async () => {
    const env = { ...(await standIns(['go'])).env }
    const newer = await debuggerInstalls({ goVersion: 'go1.26.2', env })
    const plan = await newer.installs.plan('delve', newer.tools)
    assert.ok('steps' in plan, JSON.stringify(plan))
    assert.equal(plan.what, "Delve, Go's debugger")
    assert.match(plan.steps[0]!, /^Runs go install github\.com\/go-delve\/delve\/cmd\/dlv@v1\.27\.2, with Go from /)
    assert.equal(plan.steps.at(-1), `Keeps the debugger in eNCode's own folder (${path.join(newer.tools, 'delve', '1.27.2')}).`)
    const older = await debuggerInstalls({ goVersion: 'go1.24.7', env })
    const fetched = await older.installs.plan('delve', older.tools)
    assert.ok('steps' in fetched, JSON.stringify(fetched))
    assert.match(fetched.steps[0]!, /^Downloads Go 1\.27\.3 \(\d+\.\d MB\) from the Go module proxy/)
    assert.match(fetched.steps.at(-1)!, /this copy of Go is for the debugger alone\. To build Go programs yourself, install Go from https:\/\/go\.dev\/dl\/\.$/)
  })
})

const WHEEL = process.env.ENCODE_TEST_DEBUGPY_WHEEL
const INSTALLS = process.env.ENCODE_TEST_INSTALLS === '1'
/** The internet, or a server on it, not there: the test cannot say anything about eNCode, and CI does not hang on it. */
const OFFLINE = /could not reach|answered 5\d\d|dial tcp|i\/o timeout|TLS handshake|connection (reset|refused)|no such host/i

describe('debugpy installed by eNCode', { skip: !PYTHON_ON_PATH || (!WHEEL && !INSTALLS) ? 'no Python, and neither ENCODE_TEST_DEBUGPY_WHEEL nor ENCODE_TEST_INSTALLS' : false }, () => {
  it('downloads the pinned wheel, unpacks it, and a Python file is debugged with it', { timeout: 180_000 }, async (t) => {
    const { tools, installs } = await debuggerInstalls(WHEEL ? { fetch: serving(await fs.readFile(WHEEL)) } : {})
    const result = await installs.install('debugpy', tools)
    if (!result.ok && OFFLINE.test(result.reason)) return t.skip(`PyPI could not be reached: ${result.reason}`)
    assert.ok(result.ok, JSON.stringify(result))
    const { debug, output } = await debuggerFor({ 'hello.py': 'name = "cart"\nprint("hello", name)\n' }, { tools })
    await debug.setBreakpoints('hello.py', [{ id: 'b1', line: 2, enabled: true }])
    // An older Python than debugpy takes is told so; nothing is run.
    const python = await planRun('file', { root: debug.root, platform: process.platform, env: environment(), file: path.join(debug.root, 'hello.py'), tools }).catch((error: unknown) => error)
    if (python instanceof RunProblem && /needs Python 3\.10 or newer/.test(python.message)) return
    const paused = await pausedAt(debug, 'hello.py')
    assert.deepEqual([paused.top.line, paused.locals.find((item) => item.name === 'name')?.value], [2, "'cart'"])
    await debug.act(paused.run, { kind: 'continue' })
    await until(debug, (now) => now.runs[0]?.state === 'ended', 'the end')
    assert.ok(output.includes('hello cart'), output.join('\n'))
  })
})

describe('Delve installed by eNCode', { skip: !INSTALLS ? 'ENCODE_TEST_INSTALLS is not set' : false }, () => {
  it("installs Delve with go install (and Go, when the computer's is older), and a Go module is debugged with it", { timeout: 600_000 }, async (t) => {
    const env = environment()
    const { tools, installs } = await debuggerInstalls({ env })
    const result = await installs.install('delve', tools)
    if (!result.ok && OFFLINE.test(result.reason)) return t.skip(`Go's servers could not be reached: ${result.reason}`)
    assert.ok(result.ok, JSON.stringify(result))
    const main = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tname := "cart"\n\tfmt.Println("hello", name)\n}\n'
    // Without a Delve of the computer's own, so that eNCode's is the one found.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const others = (env[pathKey] ?? '').split(path.delimiter).filter((dir) => !existsSync(path.join(dir, exe('dlv'))))
    const { debug, output } = await debuggerFor({ 'go.mod': 'module cart\n\ngo 1.25\n', 'main.go': main }, { env: { ...env, [pathKey]: others.join(path.delimiter) }, tools })
    await debug.setBreakpoints('main.go', [{ id: 'b1', line: 7, enabled: true }])
    const paused = await pausedAt(debug, 'main.go')
    assert.equal(paused.top.line, 7)
    assert.equal(paused.locals.find((item) => item.name === 'name')?.value, '"cart"')
    await debug.act(paused.run, { kind: 'continue' })
    await until(debug, (now) => now.runs[0]?.state === 'ended', 'the end')
    assert.ok(output.includes('hello cart'), output.join('\n'))
  })
})

// ---------------------------------------------------------------- whole runs, through the real debuggers

/** Waits until the debugger's state passes `test`. */
async function until(debug: FolderDebugger, test: (state: DebugState) => boolean, what: string, ms = 120_000): Promise<DebugState> {
  const end = Date.now() + ms
  for (;;) {
    const state = await debug.state()
    if (test(state)) return state
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(state).slice(0, 2_000)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function environment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/^NODE_(OPTIONS|TEST_CONTEXT)$/.test(key)) env[key] = value
  return { ...env, ...extra }
}

const open: FolderDebugger[] = []
// A run a failed test left behind is stopped, so the test's process can end.
after(() => Promise.all(open.map((debug) => debug.close())))

/** A trusted folder's debugger, with what its runs print. */
async function debuggerFor(files: Record<string, string>, options: { env?: Record<string, string>; tools?: string } = {}) {
  const { root, home, config } = await folder(files)
  await trustFolder(config)
  const output: string[] = []
  const debug = new FolderDebugger(config, nodeWorkspaceFs, { runDir: path.join(home, 'runs'), env: options.env ?? environment(), ...(options.tools ? { tools: options.tools } : {}), onOutput: (_, __, lines) => output.push(...lines.map((line) => line.text)) })
  open.push(debug)
  return { root, home, debug, output }
}

/** Starts the editor's file, waits for the first pause and gives the paused thread's top frame and its locals. */
async function pausedAt(debug: FolderDebugger, file: string) {
  const started = await debug.start({ config: 'file', file })
  assert.ok(started.ok, JSON.stringify(started))
  if (!started.ok) throw new Error('not started')
  const state = await until(debug, (now) => now.runs[0]?.threads.some((thread) => thread.state === 'paused' && !!thread.frames?.length) ?? false, `a pause in ${file}`)
  const thread = state.runs[0]!.threads.find((item) => item.state === 'paused' && item.frames?.length)!
  const top = thread.frames![0]!
  const scope = (await debug.scopes(started.run, top.id))[0]!
  const locals = await debug.variables(started.run, scope.ref)
  return { run: started.run, state, thread, top, locals }
}

const DEBUGPY_DIR = process.env.ENCODE_TEST_DEBUGPY && existsSync(path.join(process.env.ENCODE_TEST_DEBUGPY, 'debugpy', 'adapter')) ? process.env.ENCODE_TEST_DEBUGPY : null

describe('a Python file debugged', { skip: !PYTHON || !DEBUGPY_DIR ? 'no Python and ENCODE_TEST_DEBUGPY here' : false }, () => {
  it("stops at a breakpoint with eNCode's own debugpy, steps, and ends", { timeout: 120_000 }, async () => {
    // eNCode's tools folder with debugpy as its install leaves it.
    const tools = await fs.realpath(await tempWorkspace())
    const dir = path.join(tools, 'debugpy', '1.8.22')
    await fs.cp(DEBUGPY_DIR!, dir, { recursive: true })
    await fs.writeFile(path.join(dir, MARKER), json({ id: 'debugpy', version: '1.8.22', kind: 'download' }))
    const { debug, output } = await debuggerFor({ 'cart.py': 'def total(prices):\n    result = sum(prices)\n    return result\n\nprint("total", total([2, 3, 4]))\n' }, { tools })
    await debug.setBreakpoints('cart.py', [{ id: 'b1', line: 2, enabled: true }])
    const paused = await pausedAt(debug, 'cart.py')
    assert.deepEqual([paused.top.source?.rel, paused.top.line, paused.thread.reason], ['cart.py', 2, 'breakpoint'])
    assert.equal(paused.locals.find((item) => item.name === 'prices')?.value, '[2, 3, 4]')
    assert.deepEqual(await debug.evaluate(paused.run, 'prices[1] * 10', { frame: paused.top.id, context: 'repl' }), { ok: true, value: '30', type: 'int' })
    await debug.act(paused.run, { kind: 'continue' })
    const ended = await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    assert.equal(ended.runs[0]!.exitCode, 0)
    assert.ok(output.includes('total 9'), output.join('\n'))
    await debug.close()
  })
})

const DLV = process.env.ENCODE_TEST_DLV
const GO_TOOLCHAIN = process.env.ENCODE_TEST_GOTOOLCHAIN

describe('a Go program debugged', { skip: !DLV || !searchPath('go', process.env) ? 'no Go and ENCODE_TEST_DLV here' : false }, () => {
  it("builds the module's program into the run's folder, stops at a breakpoint and ends", { timeout: 240_000 }, async () => {
    const env = environment({ PATH: `${path.dirname(DLV!)}${path.delimiter}${process.env.PATH ?? ''}`, ...(GO_TOOLCHAIN ? { GOTOOLCHAIN: GO_TOOLCHAIN } : {}) })
    const main = 'package main\n\nimport "fmt"\n\nfunc total(prices []int) int {\n\tresult := 0\n\tfor _, price := range prices {\n\t\tresult += price\n\t}\n\treturn result\n}\n\nfunc main() {\n\tfmt.Println("total", total([]int{2, 3, 4}))\n}\n'
    const { root, debug, output } = await debuggerFor({ 'go.mod': 'module cart\n\ngo 1.25\n', 'main.go': main }, { env })
    await debug.setBreakpoints('main.go', [{ id: 'b1', line: 10, enabled: true }])
    const paused = await pausedAt(debug, 'main.go')
    assert.deepEqual([paused.top.source?.rel, paused.top.line], ['main.go', 10])
    assert.equal(paused.locals.find((item) => item.name === 'result')?.value, '9')
    await debug.act(paused.run, { kind: 'continue' })
    const ended = await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    assert.equal(ended.runs[0]!.exitCode, 0)
    assert.ok(output.includes('total 9'), output.join('\n'))
    // Delve's program was made in the run's folder, not the person's.
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('__debug_bin')), [])
    await debug.close()
  })
})

function lldbDap(): string | null {
  try {
    return process.env.ENCODE_TEST_LLDB_DAP ?? findLldbDap({ root: process.cwd(), platform: process.platform, env: environment() })
  } catch {
    return null
  }
}

const LLDB = lldbDap()
const CLANG = searchPath('clang', process.env)
const CARGO = searchPath('cargo', process.env)

describe('a C file debugged', { skip: !LLDB || !CLANG ? 'no lldb-dap and clang here' : false }, () => {
  it('builds the file with clang in the run, stops at a breakpoint and ends', { timeout: 120_000 }, async () => {
    const env = environment(process.env.ENCODE_TEST_LLDB_DAP ? { PATH: `${path.dirname(LLDB!)}${path.delimiter}${process.env.PATH ?? ''}` } : {})
    const { debug, output } = await debuggerFor({ 'cart.c': '#include <stdio.h>\n\nint total(int a, int b) {\n  int result = a + b;\n  return result;\n}\n\nint main(void) {\n  printf("total %d\\n", total(4, 5));\n  return 0;\n}\n' }, { env })
    await debug.setBreakpoints('cart.c', [{ id: 'b1', line: 5, enabled: true }])
    const paused = await pausedAt(debug, 'cart.c')
    assert.deepEqual([paused.top.source?.rel, paused.top.line], ['cart.c', 5])
    assert.equal(paused.locals.find((item) => item.name === 'result')?.value, '9')
    await debug.act(paused.run, { kind: 'continue' })
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    assert.ok(output.includes('Building cart.c with clang…'), output.join('\n'))
    assert.ok(output.includes('total 9'), output.join('\n'))
    await debug.close()
  })
})

describe('a Rust program debugged', { skip: !LLDB || !CARGO ? 'no lldb-dap and cargo here' : false }, () => {
  it('builds the program whose main file is open with cargo, and shows its values through the formatters', { timeout: 300_000 }, async () => {
    const env = environment(process.env.ENCODE_TEST_LLDB_DAP ? { PATH: `${path.dirname(LLDB!)}${path.delimiter}${process.env.PATH ?? ''}` } : {})
    const other = 'fn greet(name: &str) -> String {\n    let line = format!("hello {}", name);\n    let size = line.len();\n    println!("size {}", size);\n    line\n}\n\nfn main() {\n    println!("{}", greet("cart"));\n}\n'
    const { debug, output } = await debuggerFor({ 'Cargo.toml': '[package]\nname = "cart"\nversion = "0.1.0"\nedition = "2021"\n', 'src/main.rs': 'fn main() {}\n', 'src/bin/other.rs': other }, { env })
    // Line 3, not 4: lldb places a breakpoint on each piece of code a macro's line (println!) makes, and stops at each.
    await debug.setBreakpoints('src/bin/other.rs', [{ id: 'b1', line: 3, enabled: true }])
    const paused = await pausedAt(debug, 'src/bin/other.rs')
    assert.deepEqual([paused.top.source?.rel, paused.top.line], ['src/bin/other.rs', 3])
    assert.match(paused.locals.find((item) => item.name === 'line')?.value ?? '', /hello cart/)
    assert.deepEqual(await debug.act(paused.run, { kind: 'continue' }), { ok: true })
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    assert.ok(output.includes('Building other with cargo…'), output.join('\n'))
    assert.ok(output.includes('hello cart'), output.join('\n'))
    await debug.close()
  })
})
