/**
 * The debugger against a real Node.js (ADR 0143): a started program and the programs it starts, a source-mapped one,
 * TypeScript whose types Node.js strips, and a program attached to by its port.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { tempWorkspace } from '@encode/tools/testing'
import { DebugSession, type LaunchPlan } from './session'
import { encodeMappings } from './sourcemap'
import type { Breakpoint, OutputLine, SessionView } from './types'

const sessions: DebugSession[] = []
after(async () => {
  await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)))
})

const TIMEOUT = 20_000

interface Run {
  session: DebugSession
  output: OutputLine[]
  /** Resolves once the view passes the test; fails after a while. */
  until(test: (view: SessionView) => boolean, what: string): Promise<SessionView>
  text(): string
}

function run(options: { plan: LaunchPlan | { kind: 'attach'; host: string; port: number }; breakpoints: Record<string, Breakpoint[]> }): Run {
  const output: OutputLine[] = []
  const waiters = new Set<() => void>()
  const session = new DebugSession({
    id: 's1',
    name: 'test',
    plan: options.plan,
    breakpoints: () => new Map(Object.entries(options.breakpoints)),
    exceptions: { uncaught: true, all: false },
    readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
    onChange: () => {
      for (const waiter of [...waiters]) waiter()
    },
    onOutput: (lines) => {
      output.push(...lines)
      for (const waiter of [...waiters]) waiter()
    },
  })
  sessions.push(session)
  return {
    session,
    output,
    text: () => output.map((line) => line.text).join('\n'),
    until: (test, what) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const view = session.view()
          if (!test(view)) return
          waiters.delete(check)
          clearTimeout(timer)
          resolve(view)
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`Timed out waiting for ${what}; the run is ${JSON.stringify(session.view())}; it printed ${JSON.stringify(output)}`))
        }, TIMEOUT)
        waiters.add(check)
        check()
      }),
  }
}

const paused = (view: SessionView) => view.threads.find((thread) => thread.state === 'paused')
const bp = (line: number, extra: Partial<Breakpoint> = {}): Breakpoint => ({ id: `bp${line}`, line, enabled: true, ...extra })

async function launchPlan(dir: string, args: string[]): Promise<LaunchPlan> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && key.toUpperCase() !== 'NODE_OPTIONS') env[key] = value
  return { kind: 'launch', file: process.execPath, args, cwd: dir, env, runDir: path.join(dir, '.run') }
}

const APP = `function add(a, b) {
  const sum = a + b
  return sum
}
let total = 0
for (let i = 0; i < 3; i++) total = add(total, i)
console.log('total', total)
`

describe('a debug run of Node.js', () => {
  it('stops at a breakpoint, shows the frame and its variables, steps, evaluates and runs to the end', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({ 'app.js': APP })
    const file = path.join(dir, 'app.js')
    const r = run({ plan: await launchPlan(dir, [file]), breakpoints: { [file]: [bp(2)] } })
    await r.session.start()
    let view = await r.until((v) => !!paused(v), 'the breakpoint')
    let thread = paused(view)!
    assert.equal(thread.reason, 'breakpoint')
    const top = thread.frames![0]
    assert.equal(top.name, 'add')
    assert.equal(top.line, 2)
    assert.equal(top.source?.path, file)
    assert.deepEqual(r.session.statuses(file), [{ id: 'bp2', verified: true }])

    const scopes = await r.session.scopes(top.id)
    assert.equal(scopes[0].name, 'Local')
    const locals = await r.session.variables(scopes[0].ref)
    assert.deepEqual(
      locals.filter((variable) => variable.name === 'a' || variable.name === 'b').map((variable) => [variable.name, variable.value]),
      [
        ['a', '0'],
        ['b', '0'],
      ],
    )
    assert.deepEqual(await r.session.evaluate('a + b + 40', { frameId: top.id, context: 'repl' }), { ok: true, value: '40', type: 'number' })
    const failed = await r.session.evaluate('nope.x', { frameId: top.id, context: 'repl' })
    assert.equal(failed.ok, false)

    await r.session.step('over', thread.id)
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 3, 'the step to line 3')
    assert.equal(paused(view)!.reason, 'step')

    // The second and third calls stop too; then the program ends.
    for (let hit = 0; hit < 3; hit++) {
      const before = paused(r.session.view())!.frames![0]!.id
      await r.session.resume(paused(r.session.view())!.id)
      if (hit === 2) break
      // A new stop, not the last one still shown until Node.js says it resumed: each stop numbers its frames afresh.
      await r.until((v) => paused(v)?.frames?.[0]?.line === 2 && paused(v)!.frames![0]!.id !== before, `hit ${hit + 2}`)
    }
    view = await r.until((v) => v.state === 'ended', 'the end')
    assert.equal(view.exitCode, 0)
    assert.match(r.text(), /total 3/)
    assert.doesNotMatch(r.text(), /Debugger listening|Debugger attached/)
    await r.session.settled
    assert.equal(await fs.stat(path.join(dir, '.run')).catch(() => null), null, 'the run folder is removed')
  })

  it('keeps to a condition and a hit count, and prints a logpoint without stopping', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({ 'app.js': APP })
    const file = path.join(dir, 'app.js')
    const r = run({ plan: await launchPlan(dir, [file]), breakpoints: { [file]: [bp(2, { id: 'log', logMessage: 'adding {a} and {b}' }), bp(3, { hitCondition: '3' })] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the third hit')
    const top = paused(view)!.frames![0]
    assert.equal(top.line, 3)
    const locals = await r.session.variables((await r.session.scopes(top.id))[0].ref)
    assert.equal(locals.find((variable) => variable.name === 'sum')?.value, '3')
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /adding 0 and 0\nadding 0 and 1\nadding 1 and 2/)
  })

  it('places a breakpoint in a TypeScript file through the source map of the JavaScript that runs', { timeout: 60_000 }, async () => {
    // dist/app.js is src/app.ts compiled, two lines lower; its map says so.
    const ts = 'function double(n: number): number {\n  const out = n * 2\n  return out\n}\nconsole.log(double(21))\n'
    const js = '"use strict";\n// compiled\nfunction double(n) {\n    const out = n * 2;\n    return out;\n}\nconsole.log(double(21));\n//# sourceMappingURL=app.js.map\n'
    const mappings = encodeMappings([
      [2, 0, 0, 0, 0],
      [3, 4, 0, 1, 2],
      [4, 4, 0, 2, 2],
      [5, 0, 0, 3, 0],
      [6, 0, 0, 4, 0],
    ])
    const dir = await tempWorkspace({ 'src/app.ts': ts, 'dist/app.js': js, 'dist/app.js.map': JSON.stringify({ version: 3, sources: ['../src/app.ts'], mappings }) })
    const source = path.join(dir, 'src', 'app.ts')
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'dist', 'app.js')]), breakpoints: { [source]: [bp(2)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the mapped breakpoint')
    const top = paused(view)!.frames![0]
    assert.equal(top.source?.path, source)
    assert.equal(top.line, 2)
    assert.deepEqual(r.session.statuses(source), [{ id: 'bp2', verified: true }])
    // A step lands on the TypeScript's next line.
    await r.session.step('over')
    const stepped = await r.until((v) => paused(v)?.frames?.[0]?.line === 3, 'the mapped step')
    assert.equal(paused(stepped)!.frames![0].source?.path, source)
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /42/)
  })

  it('places a breakpoint through the map of an ES module, which V8 stops before it runs', { timeout: 60_000 }, async () => {
    const ts = 'export function triple(n: number): number {\n  const out = n * 3\n  return out\n}\n'
    const js = '// compiled\nexport function triple(n) {\n    const out = n * 3;\n    return out;\n}\n//# sourceMappingURL=lib.mjs.map\n'
    const mappings = encodeMappings([
      [1, 0, 0, 0, 0],
      [2, 4, 0, 1, 2],
      [3, 4, 0, 2, 2],
      [4, 0, 0, 3, 0],
    ])
    const dir = await tempWorkspace({
      'src/lib.ts': ts,
      'dist/lib.mjs': js,
      'dist/lib.mjs.map': JSON.stringify({ version: 3, sources: ['../src/lib.ts'], mappings }),
      'main.mjs': "import { triple } from './dist/lib.mjs'\nconsole.log(triple(5))\n",
    })
    const source = path.join(dir, 'src', 'lib.ts')
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'main.mjs')]), breakpoints: { [source]: [bp(2)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint in the ES module')
    const top = paused(view)!.frames![0]
    assert.equal(top.source?.path, source)
    assert.equal(top.line, 2)
    assert.equal(top.name, 'triple')
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /15/)
  })

  it('places a breakpoint in TypeScript a loader turns into JavaScript under the same name, as tsx does', { timeout: 60_000 }, async () => {
    // The loader compiles each .ts file two lines lower, with its map inlined, and names the module by the .ts file:
    // a breakpoint by the file's name would land two lines off.
    const loader = `const fs = require('node:fs')
const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const lines = source.split('\\n')
  // Line i of the source is line i + 2 of the code: the first segment of each line is AAAA, the rest AACA.
  const mappings = ';;' + lines.map((_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';')
  const map = { version: 3, sources: [filename], mappings }
  const code = '"use strict";\\n// compiled\\n' + source.replace(/: number/g, '') + '\\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')
  module._compile(code, filename)
}
`
    const dir = await tempWorkspace({ 'loader.cjs': loader, 'app.ts': 'function half(n: number): number {\n  const out: number = n / 2\n  return out\n}\nconsole.log(half(9))\n' })
    const file = path.join(dir, 'app.ts')
    const r = run({ plan: await launchPlan(dir, ['-r', path.join(dir, 'loader.cjs'), file]), breakpoints: { [file]: [bp(2)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint in the loaded TypeScript')
    const top = paused(view)!.frames![0]
    assert.equal(top.source?.path, file)
    assert.equal(top.line, 2)
    assert.equal(top.name, 'half')
    const locals = await r.session.variables((await r.session.scopes(top.id))[0].ref)
    assert.equal(locals.find((variable) => variable.name === 'n')?.value, '9')
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /4\.5/)
  })

  it('stops in TypeScript whose types Node.js strips itself', { timeout: 60_000, skip: !process.features.typescript && !supportsStripTypes() && 'this Node.js cannot strip types' }, async () => {
    const dir = await tempWorkspace({ 'app.ts': 'interface Box { n: number }\nfunction open(box: Box): number {\n  const inside: number = box.n\n  return inside\n}\nconsole.log(open({ n: 7 }))\n' })
    const file = path.join(dir, 'app.ts')
    const r = run({ plan: await launchPlan(dir, ['--experimental-strip-types', '--no-warnings', file]), breakpoints: { [file]: [bp(3)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint in TypeScript')
    const top = paused(view)!.frames![0]
    assert.equal(top.line, 3)
    assert.equal(top.name, 'open')
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /\b7\b/)
  })

  it('follows the Node.js programs the program starts, each a thread of the run', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({
      'parent.js': `const { spawnSync } = require('node:child_process')\nconst result = spawnSync(process.execPath, [require('node:path').join(__dirname, 'child.js')], { stdio: 'inherit' })\nconsole.log('child exited', result.status)\n`,
      'child.js': `const answer = 6 * 7\nconsole.log('the answer is', answer)\n`,
    })
    const child = path.join(dir, 'child.js')
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'parent.js')]), breakpoints: { [child]: [bp(2)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint in the child')
    assert.equal(view.threads.length, 2)
    const thread = paused(view)!
    assert.match(thread.name, /^child\.js \(\d+\)$/)
    assert.equal(thread.frames![0].source?.path, child)
    assert.deepEqual(await r.session.evaluate('answer', { threadId: thread.id, context: 'watch' }), { ok: true, value: '42', type: 'number' })
    await r.session.resume(thread.id)
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /the answer is 42\nchild exited 0/)
  })

  it('shows objects and arrays: previews, children, long arrays in groups, getters when asked', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({
      'app.js': `const user = { name: 'Ada', tags: ['a', 'b'], nested: { deep: true } }\nObject.defineProperty(user, 'shout', { get() { return this.name.toUpperCase() }, enumerable: true })\nconst many = Array.from({ length: 250 }, (_, i) => i * 2)\nconst map = new Map([['k', 1]])\ndebugger\n`,
    })
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'app.js')]), breakpoints: {} })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the debugger statement')
    const top = paused(view)!.frames![0]
    assert.equal(paused(view)!.reason, 'debugger')
    const user = await r.session.evaluate('user', { frameId: top.id, context: 'watch' })
    assert.ok(user.ok)
    assert.equal(user.ok && user.value, "{name: \"Ada\", tags: Array(2), nested: {…}, shout: (…)}")
    const children = await r.session.variables((user as { ref: number }).ref)
    assert.deepEqual(
      children.slice(0, 3).map((child) => [child.name, child.value]),
      [
        ['name', '"Ada"'],
        ['tags', '(2) ["a", "b"]'],
        ['nested', '{deep: true}'],
      ],
    )
    const shout = children.find((child) => child.name === 'shout')!
    assert.equal(shout.lazy, true)
    assert.deepEqual((await r.session.variables(shout.ref!)).map((child) => child.value), ['"ADA"'])
    assert.equal(children.at(-1)?.name, '[[Prototype]]')

    const many = await r.session.evaluate('many', { frameId: top.id, context: 'watch' })
    assert.ok(many.ok && many.value.startsWith('(250) [0, 2, 4'))
    const groups = await r.session.variables((many as { ref: number }).ref)
    assert.deepEqual(
      groups.map((group) => group.name),
      ['[0 … 99]', '[100 … 199]', '[200 … 249]', 'length'],
    )
    const last = await r.session.variables(groups[2].ref!)
    assert.equal(last.length, 50)
    assert.deepEqual([last[0].name, last[0].value], ['200', '400'])

    const map = await r.session.evaluate('map', { frameId: top.id, context: 'watch' })
    assert.equal(map.ok && map.value, 'Map(1) {"k" => 1}')
    // A hover runs nothing with a side effect.
    const hover = await r.session.evaluate('many.push(1)', { frameId: top.id, context: 'hover' })
    assert.equal(hover.ok, false)
    assert.deepEqual(await r.session.evaluate('many.length', { frameId: top.id, context: 'hover' }), { ok: true, value: '250', type: 'number' })
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
  })

  it('stops for an uncaught exception and says what it was', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({ 'app.js': `function fail() {\n  throw new Error('broken on purpose')\n}\nfail()\n` })
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'app.js')]), breakpoints: {} })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the exception')
    const thread = paused(view)!
    assert.equal(thread.reason, 'exception')
    assert.match(thread.exception ?? '', /Error: broken on purpose/)
    assert.equal(thread.frames![0].line, 2)
    await r.session.stop()
    assert.equal(r.session.view().state, 'ended')
  })

  it('stops a run, and everything it started, when asked', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({ 'app.js': `setInterval(() => console.log('tick'), 50)\n` })
    const r = run({ plan: await launchPlan(dir, [path.join(dir, 'app.js')]), breakpoints: {} })
    await r.session.start()
    await r.until((v) => v.threads.length === 1 && /tick/.test(r.text()), 'the program running')
    await r.session.stop()
    const view = await r.until((v) => v.state === 'ended', 'the end')
    assert.equal(view.state, 'ended')
  })

  it('attaches to a program by its inspector port, and leaves it running when it lets go', { timeout: 60_000 }, async () => {
    const dir = await tempWorkspace({ 'server.js': `let n = 0\nsetInterval(() => {\n  n++\n}, 20)\n` })
    const file = path.join(dir, 'server.js')
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    after(() => child.kill())
    const port = await new Promise<number>((resolve, reject) => {
      let text = ''
      child.stderr!.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)
        if (match) resolve(Number(match[1]))
      })
      child.once('exit', () => reject(new Error(`the program ended: ${text}`)))
    })
    const r = run({ plan: { kind: 'attach', host: '127.0.0.1', port }, breakpoints: { [file]: [bp(3)] } })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint in the attached program')
    assert.equal(paused(view)!.frames![0].line, 3)
    assert.equal(r.session.view().kind, 'attach')
    await r.session.stop()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(child.exitCode, null, 'it goes on running')
  })

  it('says plainly when nothing listens where it was asked to attach', { timeout: 30_000 }, async () => {
    const r = run({ plan: { kind: 'attach', host: '127.0.0.1', port: 9 }, breakpoints: {} })
    await assert.rejects(r.session.start(), /Nothing answers as a Node\.js inspector at 127\.0\.0\.1:9/)
    assert.equal(r.session.view().state, 'ended')
  })
})

function supportsStripTypes(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 6)
}
