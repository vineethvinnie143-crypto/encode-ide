/**
 * A folder's debugger (ADR 0143): the ways it can be run, what each starts, and runs against a real Node.js.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { tempWorkspace } from '@encode/tools/testing'
import { WorkspaceConfig } from './config'
import { DEBUG_UNTRUSTED, FolderDebugger, readBreakpoints, type DebugState } from './debug'
import { debugConfigs, planRun, RunProblem, substitute, typeStripping, type RunContext } from './debug-configs'
import { nodeWorkspaceFs } from './fs'
import { trustFolder } from './report'

const json = (value: unknown) => JSON.stringify(value)
const windows = process.platform === 'win32'

async function folder(files: Record<string, string> = {}) {
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace())
  const config = new WorkspaceConfig({ root, home })
  await config.refresh()
  return { root, home, config }
}

const context = (root: string, extra: Partial<RunContext> = {}): RunContext => ({ root, platform: process.platform, env: process.env, ...extra })

describe('the ways a folder can be debugged', () => {
  it("lists the folder's own configurations first, then the editor's file, the package's scripts and a port", async () => {
    const { root } = await folder({
      'package.json': json({ scripts: { dev: 'node server.js', test: 'node --test' } }),
      '.encode/debug.json': json({
        configurations: [
          { name: 'Server', type: 'node', request: 'launch', program: '${folder}/server.js', args: ['--port', '3000'] },
          { name: 'Dev', npmScript: 'dev' },
          { name: 'Docker', request: 'attach', port: 9230, host: 'localhost' },
          { name: 'Far away', request: 'attach', host: '10.0.0.5' },
          { name: 'Java', type: 'java', program: 'A.java' },
          { name: 'Both', program: 'a.js', npmScript: 'dev' },
        ],
      }),
    })
    const { configs, problem } = await debugConfigs(root)
    assert.equal(problem, undefined)
    assert.deepEqual(
      configs.map((config) => [config.id, config.name, config.kind, config.detail, config.problem ?? '']),
      [
        ['own:0', 'Server', 'launch', 'node ${folder}/server.js --port 3000', ''],
        ['own:1', 'Dev', 'launch', 'script dev', ''],
        ['own:2', 'Docker', 'attach', '127.0.0.1:9230', ''],
        ['own:3', 'Far away', 'launch', '.encode/debug.json', 'eNCode attaches only to a program on this machine ("host": "localhost").'],
        ['own:4', 'Java', 'launch', '.encode/debug.json', '"type" is "node", "python", "go", "lldb" (C and C++) or "rust"; "java" is not one eNCode debugs.'],
        ['own:5', 'Both', 'launch', '.encode/debug.json', 'Name the program to run ("program") or a script of package.json ("npmScript"), one of them.'],
        ['file', 'Current file', 'launch', 'The file open in the editor: JavaScript, TypeScript, Python, Go, Rust, C or C++', ''],
        ['script:dev', 'Script: dev', 'launch', 'node server.js', ''],
        ['script:test', 'Script: test', 'launch', 'node --test', ''],
        ['attach', 'Attach to port 9229', 'attach', '127.0.0.1:9229', ''],
      ],
    )
  })

  it('says what is wrong with a debug.json that does not read', async () => {
    const { root } = await folder({ '.encode/debug.json': '{ "configurations": [ ' })
    const { configs, problem } = await debugConfigs(root)
    assert.match(problem ?? '', /^\.encode\/debug\.json is not valid JSON/)
    assert.deepEqual(configs.map((config) => config.id), ['file', 'attach'])
  })

  it('fills in the variables, and names the ones it does not know', () => {
    const root = windows ? 'C:\\work\\app' : '/work/app'
    const file = windows ? 'C:\\work\\app\\src\\main.ts' : '/work/app/src/main.ts'
    const at = { root, file, env: { HOME_DIR: 'h' }, platform: process.platform }
    assert.equal(substitute('${workspaceFolder}|${relativeFile}|${fileBasenameNoExtension}|${env:HOME_DIR}|${env:NOPE}', at), `${root}|${path.join('src', 'main.ts')}|main|h|`)
    assert.throws(() => substitute('${file}', { ...at, file: undefined }), (error: unknown) => error instanceof RunProblem && /open the file first/.test(error.message))
    assert.throws(() => substitute('${command:pickProcess}', at), /is not a variable eNCode knows/)
  })

  it('knows which Node.js runs TypeScript itself', () => {
    assert.deepEqual([[20, 11], [22, 5], [22, 6], [22, 17], [22, 18], [23, 5], [23, 6], [24, 0]].map((version) => typeStripping(version as [number, number])), [null, null, 'flag', 'flag', 'default', 'flag', 'default', 'default'])
  })

  it('runs a TypeScript file with the project tsx, else as this Node.js can, else says what to install', async () => {
    const { root } = await folder({ 'src/a.ts': 'export {}\n', 'src/b.tsx': 'export {}\n', 'src/c.js': '1\n' })
    const versioned = (version: [number, number] | null) => context(root, { nodeVersion: async () => version })
    const args = async (file: string, version: [number, number] | null) => (await planRun('file', { ...versioned(version), file: path.join(root, file) })) as Extract<Awaited<ReturnType<typeof planRun>>, { kind: 'launch' }>
    assert.deepEqual((await args('src/c.js', null)).args, [path.join(root, 'src', 'c.js')])
    assert.deepEqual((await args('src/a.ts', [24, 1])).args, [path.join(root, 'src', 'a.ts')])
    assert.deepEqual((await args('src/a.ts', [22, 10])).args, ['--experimental-strip-types', path.join(root, 'src', 'a.ts')])
    await assert.rejects(args('src/a.ts', [20, 11]), /Node\.js 20\.11 cannot run TypeScript itself\. Add tsx to the project/)
    await assert.rejects(args('src/b.tsx', [24, 1]), /Node\.js cannot run \.tsx files itself/)
    await fs.mkdir(path.join(root, 'node_modules', 'tsx', 'dist'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'tsx', 'package.json'), json({ name: 'tsx', bin: { tsx: './dist/cli.mjs' } }))
    await fs.writeFile(path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '')
    const run = await args('src/b.tsx', [20, 11])
    assert.deepEqual(run.args, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'b.tsx')])
    assert.equal(run.detail, 'tsx src/b.tsx')
    await assert.rejects(planRun('file', context(root)), /Open the file to debug in the editor first/)
  })

  it("runs a package script as npm does, with the package's node_modules/.bin first on PATH", async () => {
    const { root } = await folder({ 'package.json': json({ name: 'app', version: '1.2.3', scripts: { dev: 'node server.js --watch' } }) })
    const plan = await planRun('script:dev', context(root))
    assert.equal(plan.kind, 'launch')
    if (plan.kind !== 'launch') return
    if (windows) assert.deepEqual([path.basename(plan.file).toLowerCase(), plan.args, plan.verbatim], ['cmd.exe', ['/d', '/s', '/c', '"node server.js --watch"'], true])
    else assert.deepEqual([plan.file, plan.args], ['/bin/sh', ['-c', 'node server.js --watch']])
    const pathKey = Object.keys(plan.env).find((key) => key.toUpperCase() === 'PATH')!
    assert.ok(plan.env[pathKey]!.startsWith(path.join(root, 'node_modules', '.bin')), plan.env[pathKey])
    assert.deepEqual([plan.env.npm_lifecycle_event, plan.env.npm_package_name, plan.env.npm_package_version, plan.name], ['dev', 'app', '1.2.3', 'Script: dev'])
    await assert.rejects(planRun('script:nope', context(root)), /package\.json has no script named "nope"/)
  })

  it("keeps eNCode's own Node.js setting out of what a run starts with", async () => {
    const { root } = await folder({ 'a.js': '1\n' })
    const plan = await planRun('file', context(root, { file: path.join(root, 'a.js'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' } }))
    assert.ok(plan.kind === 'launch' && plan.env.KEEP === 'yes' && !('ELECTRON_RUN_AS_NODE' in plan.env))
  })
})

describe('breakpoints from the editor', () => {
  it('reads what the editor sends, and refuses what is not a breakpoint', () => {
    assert.deepEqual(readBreakpoints([{ id: 'b1', line: 3, enabled: true, condition: ' ', hitCondition: '>= 2', logMessage: 'x={x}' }]), [{ id: 'b1', line: 3, hitCondition: '>= 2', logMessage: 'x={x}', enabled: true }])
    for (const bad of [{ id: 'b 1', line: 3, enabled: true }, { id: 'b1', line: 0, enabled: true }, { id: 'b1', line: 3 }, { id: 'b1', line: 3, enabled: true, hitCondition: 'twice' }, { id: 'b1', line: 3, enabled: true, condition: 'x'.repeat(2_001) }]) {
      assert.equal(readBreakpoints([bad]), null, JSON.stringify(bad).slice(0, 80))
    }
    assert.equal(readBreakpoints([{ id: 'b1', line: 3, enabled: true }, { id: 'b1', line: 4, enabled: true }]), null, 'one id once')
  })
})

/** Waits until the debugger's state passes `test`. */
async function until(debug: FolderDebugger, test: (state: DebugState) => boolean, what: string, ms = 20_000): Promise<DebugState> {
  const end = Date.now() + ms
  for (;;) {
    const state = await debug.state()
    if (test(state)) return state
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(state).slice(0, 1_500)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('a folder debugged', () => {
  const PROGRAM = ['const items = [1, 2, 3]', 'let total = 0', 'for (const item of items) {', '  total += item', '}', "console.log('total', total)", ''].join('\n')

  it('runs only in a trusted folder', async () => {
    const { root, config } = await folder({ 'app.js': PROGRAM, 'app.py': 'print(1)\n', 'main.go': 'package main\n\nfunc main() {}\n', 'main.c': 'int main(void) { return 0; }\n' })
    const debug = new FolderDebugger(config, nodeWorkspaceFs, {})
    // Before anything is found or built, whatever the language.
    for (const file of ['app.js', 'app.py', 'main.go', 'main.c']) assert.deepEqual(await debug.start({ config: 'file', file }), { ok: false, reason: DEBUG_UNTRUSTED }, file)
    assert.equal((await debug.state()).trusted, false)
    assert.deepEqual(await debug.start({ config: 'file', file: '../outside.js' }).then((result) => result.ok), false)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stops at a breakpoint of the file, shows where by its path in the folder, and keeps the breakpoints for next time', async () => {
    const { root, home, config } = await folder({ 'src/app.js': PROGRAM })
    await trustFolder(config)
    const stateDir = path.join(home, 'debug-state')
    const output: string[] = []
    const changes: string[] = []
    const debug = new FolderDebugger(config, nodeWorkspaceFs, { stateDir, runDir: path.join(home, 'runs'), onOutput: (_, __, lines) => output.push(...lines.map((line) => line.text)), onChange: (at) => changes.push(at) })
    assert.deepEqual(await debug.setBreakpoints('src/app.js', [{ id: 'b1', line: 4, enabled: true, condition: 'item === 2' }]), { ok: true })
    const started = await debug.start({ config: 'file', file: 'src/app.js' })
    assert.ok(started.ok, JSON.stringify(started))
    if (!started.ok) return
    const paused = await until(debug, (state) => state.runs[0]?.state === 'paused', 'the breakpoint')
    const run = paused.runs[0]!
    assert.equal(run.config, 'file')
    const top = run.threads[0]!.frames![0]!
    assert.deepEqual([top.source?.rel, top.line, run.threads[0]!.reason], ['src/app.js', 4, 'breakpoint'])
    assert.equal(paused.breakpoints['src/app.js']![0]!.verified, true)
    const item = await debug.evaluate(started.run, 'item * 10', { frame: top.id, context: 'repl' })
    assert.deepEqual(item, { ok: true, value: '20', type: 'number' })
    const scope = (await debug.scopes(started.run, top.id))[0]!
    const names = (await debug.variables(started.run, scope.ref)).map((variable) => variable.name)
    assert.ok(names.includes('item'), names.join(', '))
    assert.deepEqual(await debug.act(started.run, { kind: 'continue' }), { ok: true })
    const ended = await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    assert.equal(ended.runs[0]!.exitCode, 0)
    assert.ok(output.includes('total 6'), output.join('\n'))
    assert.ok(changes.length > 0 && changes.every((at) => at === root))
    await debug.close()
    // Kept, and read back by the next eNCode.
    const again = new FolderDebugger(config, nodeWorkspaceFs, { stateDir })
    assert.deepEqual((await again.state()).breakpoints, { 'src/app.js': [{ id: 'b1', line: 4, enabled: true, condition: 'item === 2' }] })
  })

  it('stops in a program a package script starts', async () => {
    const { home, config } = await folder({ 'package.json': json({ scripts: { start: 'node app.js' } }), 'app.js': PROGRAM })
    await trustFolder(config)
    const debug = new FolderDebugger(config, nodeWorkspaceFs, { runDir: path.join(home, 'runs') })
    await debug.setBreakpoints('app.js', [{ id: 'b1', line: 6, enabled: true }])
    const started = await debug.start({ config: 'script:start' })
    assert.ok(started.ok, JSON.stringify(started))
    if (!started.ok) return
    const paused = await until(debug, (state) => state.runs[0]?.state === 'paused', 'the breakpoint in the script')
    assert.deepEqual([paused.runs[0]!.threads[0]!.frames![0]!.source?.rel, paused.runs[0]!.threads[0]!.frames![0]!.line], ['app.js', 6])
    await debug.act(started.run, { kind: 'stop' })
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the stop')
    await debug.close()
  })

  it("debugs TypeScript run through the project's tsx, which starts it as another Node.js", async () => {
    // A tsx of the test's own: its command starts Node.js again with a loader that strips the types (here, one line of them).
    // Lines stay where they were, so its source map gives each line its own (as tsx's inline map does).
    const loader = [
      "const fs = require('fs')",
      "require.extensions['.ts'] = (module, file) => {",
      "  const source = fs.readFileSync(file, 'utf8').replace(/: number/g, '')",
      "  const lines = source.split('\\n').length",
      "  const map = { version: 3, sources: [file], mappings: ['AAAA', ...Array(lines - 1).fill('AACA')].join(';') }",
      "  module._compile(source + '\\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'), file)",
      '}',
    ].join('\n')
    const cli = [
      "import { spawn } from 'node:child_process'",
      "import path from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      "const loader = path.join(path.dirname(fileURLToPath(import.meta.url)), 'loader.cjs')",
      "const child = spawn(process.execPath, ['--require', loader, ...process.argv.slice(2)], { stdio: 'inherit' })",
      "child.on('exit', (code) => process.exit(code ?? 1))",
    ].join('\n')
    const { home, config } = await folder({
      'node_modules/tsx/package.json': json({ name: 'tsx', bin: { tsx: './dist/cli.mjs' } }),
      'node_modules/tsx/dist/cli.mjs': cli,
      'node_modules/tsx/dist/loader.cjs': loader,
      'main.ts': ['const double = (value: number) => value * 2', 'const result = double(21)', "console.log('result', result)", ''].join('\n'),
    })
    await trustFolder(config)
    const debug = new FolderDebugger(config, nodeWorkspaceFs, { runDir: path.join(home, 'runs') })
    await debug.setBreakpoints('main.ts', [{ id: 'b1', line: 3, enabled: true }])
    const started = await debug.start({ config: 'file', file: 'main.ts' })
    assert.ok(started.ok, JSON.stringify(started))
    if (!started.ok) return
    const paused = await until(debug, (state) => state.runs[0]?.state === 'paused', 'the breakpoint in main.ts')
    // Only the program is a thread: tsx's own command is left alone.
    assert.deepEqual(paused.runs[0]!.threads.map((thread) => thread.name.replace(/ \(\d+\)$/, '')), ['main.ts'])
    assert.equal(paused.runs[0]!.threads[0]!.frames![0]!.line, 3)
    await debug.act(started.run, { kind: 'continue' })
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end')
    await debug.close()
  })
})
