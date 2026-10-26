/**
 * Runs through a language's own debugger (ADR 0144), against the real ones: debugpy for Python, Delve for Go and
 * lldb-dap for C and Rust. Each part runs where its debugger is: on PATH, or named by ENCODE_TEST_DEBUGPY (a folder
 * with debugpy in it), ENCODE_TEST_DLV or ENCODE_TEST_LLDB_DAP; a part whose debugger is missing is skipped, and says
 * so.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { searchPath } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { DapSession, type DapPlan } from './dap-session'
import type { Breakpoint, ExceptionFilters, OutputLine, SessionView, ThreadView, VariableView } from './types'

const sessions: DapSession[] = []
after(async () => {
  await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)))
})

const TIMEOUT = 60_000

interface Run {
  session: DapSession
  output: OutputLine[]
  until(test: (view: SessionView) => boolean, what: string): Promise<SessionView>
  text(): string
}

function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/^NODE_(OPTIONS|TEST_CONTEXT)$/.test(key)) env[key] = value
  return env
}

function run(plan: DapPlan, breakpoints: Record<string, Breakpoint[]>, exceptions: ExceptionFilters = { uncaught: true, all: false }, root?: string): Run {
  const output: OutputLine[] = []
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const session = new DapSession({
    id: 's1',
    name: 'test',
    plan,
    breakpoints: () => new Map(Object.entries(breakpoints)),
    exceptions,
    ...(root ? { isOwn: (file: string) => !path.relative(root, file).startsWith('..') } : {}),
    onChange: wake,
    onOutput: (lines) => {
      output.push(...lines)
      wake()
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

/** The thread that stopped: lldb-dap and Delve pause every thread, and the first listed may be any of them. */
const paused = (view: SessionView): ThreadView | undefined => {
  const stopped = view.threads.filter((thread) => thread.state === 'paused' && thread.frames?.length)
  return stopped.find((thread) => thread.reason !== 'pause') ?? stopped[0]
}
const bp = (line: number, extra: Partial<Breakpoint> = {}): Breakpoint => ({ id: `bp${line}`, line, enabled: true, ...extra })
const named = (list: VariableView[], name: string) => list.find((item) => item.name === name)

async function localsOf(r: Run, thread: ThreadView): Promise<VariableView[]> {
  const scopes = await r.session.scopes(thread.frames![0]!.id)
  assert.ok(scopes.length, 'the frame has scopes')
  return r.session.variables(scopes[0]!.ref)
}

// ---------------------------------------------------------------- Python

function python(): string | null {
  return searchPath('python3', process.env) ?? searchPath('python', process.env)
}

/** A folder with debugpy in it: the one named, else the one this Python has. */
function debugpyRoot(py: string | null): string | null {
  const named = process.env.ENCODE_TEST_DEBUGPY
  if (named) return existsSync(path.join(named, 'debugpy', 'adapter')) ? named : null
  if (!py) return null
  try {
    return path.dirname(path.dirname(execFileSync(py, ['-c', 'import debugpy; print(debugpy.__file__)'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()))
  } catch {
    return null
  }
}

const PY = python()
const DEBUGPY = debugpyRoot(PY)

function pythonPlan(dir: string, program: string, extra: Record<string, unknown> = {}): DapPlan {
  return {
    kind: 'dap',
    profile: 'debugpy',
    adapter: { file: PY!, args: [path.join(DEBUGPY!, 'debugpy', 'adapter')], cwd: dir, env: environment(), transport: 'stdio' },
    request: 'launch',
    arguments: { type: 'python', program, cwd: dir, env: {}, python: PY, console: 'internalConsole', redirectOutput: true, justMyCode: true, showReturnValue: true, subProcess: false, stopOnEntry: false, ...extra },
    runDir: path.join(dir, '.run'),
  }
}

const CART_PY = `def line_total(item):
    total = item["price"] * item["qty"]
    return total


items = [{"name": "Coffee beans", "price": 14.5, "qty": 2}, {"name": "Oat milk", "price": 3.2, "qty": 4}]
subtotal = 0
for item in items:
    subtotal += line_total(item)
big = list(range(250))
print("subtotal", round(subtotal, 2))
`

describe('a debug run of Python through debugpy', { skip: !PY || !DEBUGPY ? 'no Python with debugpy here' : false }, () => {
  it('stops at a breakpoint, shows values, steps, evaluates, prints a log point and runs to the end', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.py': CART_PY })
    const file = path.join(dir, 'cart.py')
    const breakpoints = { [file]: [bp(2), bp(9, { logMessage: 'subtotal is {subtotal}' })] }
    const r = run(pythonPlan(dir, file), breakpoints, undefined, dir)
    await r.session.start()
    let view = await r.until((v) => !!paused(v), 'the breakpoint')
    let thread = paused(view)!
    assert.equal(thread.reason, 'breakpoint')
    const top = thread.frames![0]!
    assert.equal(top.name, 'line_total')
    assert.equal(top.source?.path, file)
    assert.equal(top.line, 2)
    assert.deepEqual(r.session.statuses(file).map((status) => [status.id, status.verified]), [['bp2', true], ['bp9', true]])

    const locals = await localsOf(r, thread)
    const item = named(locals, 'item')
    assert.ok(item?.ref, `item has its fields: ${JSON.stringify(locals)}`)
    const fields = await r.session.variables(item.ref)
    assert.match(named(fields, "'name'")?.value ?? '', /Coffee beans/)

    assert.deepEqual(await r.session.evaluate('item["qty"] * 2', { frameId: top.id, context: 'repl' }), { ok: true, value: '4', type: 'int' })
    const hover = await r.session.evaluate('item', { frameId: top.id, context: 'hover' })
    assert.ok(hover.ok && /Coffee beans/.test(hover.value))
    assert.equal((await r.session.evaluate('len(items)', { frameId: top.id, context: 'hover' })).ok, false)

    await r.session.step('over')
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 3, 'the next line')
    assert.equal(named(await localsOf(r, paused(view)!), 'total')?.value, '29.0')

    await r.session.resume()
    view = await r.until((v) => paused(v)?.reason === 'breakpoint' && paused(v)?.frames?.[0]?.line === 2, 'the second hit')
    thread = paused(view)!
    assert.match(named(await r.session.variables(named(await localsOf(r, thread), 'item')!.ref!), "'name'")?.value ?? '', /Oat milk/)

    await r.session.setBreakpoints(file, breakpoints[file]!.filter((item) => item.id !== 'bp2'))
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    const printed = r.text()
    assert.match(printed, /subtotal is 0/)
    assert.match(printed, /subtotal is 29\.0/)
    assert.match(printed, /subtotal 41\.8/)
    assert.equal(r.session.view().exitCode, 0)
    assert.match(printed, /The program exited with code 0\./)
    await r.session.settled
  })

  it('stops only when its condition holds, or on the hits its count names', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.py': CART_PY })
    const file = path.join(dir, 'cart.py')
    for (const extra of [{ condition: 'item["name"] == "Oat milk"' }, { hitCondition: '2' }, { hitCondition: '>= 2' }]) {
      const r = run(pythonPlan(dir, file), { [file]: [bp(2, extra)] })
      await r.session.start()
      const view = await r.until((v) => !!paused(v), `the stop for ${JSON.stringify(extra)}`)
      const item = named(await localsOf(r, paused(view)!), 'item')!
      assert.match(named(await r.session.variables(item.ref!), "'name'")?.value ?? '', /Oat milk/, JSON.stringify(extra))
      await r.session.stop()
      assert.equal(r.session.ended, true)
      await r.session.settled
    }
  })

  it('stops for an exception nothing catches, and says what it was', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'boom.py': 'def divide(a, b):\n    return a / b\n\n\nprint(divide(1, 0))\n' })
    const file = path.join(dir, 'boom.py')
    const r = run(pythonPlan(dir, file), {})
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the exception')
    const thread = paused(view)!
    assert.equal(thread.reason, 'exception')
    assert.match(thread.exception ?? '', /ZeroDivisionError/)
    assert.equal(thread.frames![0]!.name, 'divide')
    await r.session.stop()
    assert.match(r.text(), /The program was stopped\./)
  })

  it('shows a long list as debugpy groups it: the first hundred, then the rest behind one more value', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.py': CART_PY + 'print(len(big))\n' })
    const file = path.join(dir, 'cart.py')
    const r = run(pythonPlan(dir, file), { [file]: [bp(12)] })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint')
    const big = named(await localsOf(r, paused(view)!), 'big')
    assert.ok(big?.ref)
    const children = await r.session.variables(big.ref)
    assert.equal(named(children, '000')?.value, '0')
    assert.equal(named(children, '099')?.value, '99')
    assert.equal(named(children, 'len()')?.value, '250')
    const more = named(children, 'more')
    assert.ok(more?.ref)
    const rest = await r.session.variables(more.ref)
    assert.equal(named(rest, '249')?.value, '249')
    await r.session.stop()
  })
})

// ---------------------------------------------------------------- Go

const DLV = process.env.ENCODE_TEST_DLV ?? searchPath('dlv', process.env)
const GO = searchPath('go', process.env)
/** Delve debugs what a Go of its own age or a little older builds: ENCODE_TEST_GOTOOLCHAIN names a newer one. */
const GO_TOOLCHAIN = process.env.ENCODE_TEST_GOTOOLCHAIN

function goPlan(dir: string, extra: Record<string, unknown> = {}): DapPlan {
  return {
    kind: 'dap',
    profile: 'delve',
    adapter: { file: DLV!, args: ['dap', '--client-addr={clientAddr}', ...(process.env.ENCODE_TEST_DLV_LOG ? ['--log', '--log-output=dap,debugger', `--log-dest=${process.env.ENCODE_TEST_DLV_LOG}`] : [])], cwd: dir, env: { ...environment(), ...(GO_TOOLCHAIN ? { GOTOOLCHAIN: GO_TOOLCHAIN } : {}) }, transport: 'dial' },
    request: 'launch',
    arguments: { mode: 'debug', program: dir, cwd: dir, args: [], env: {}, outputMode: 'remote', hideSystemGoroutines: true, stopOnEntry: false, ...extra },
    runDir: path.join(dir, '.run'),
  }
}

const CART_GO = `package main

import "fmt"

type Item struct {
	Name  string
	Price float64
	Qty   int
}

func lineTotal(item Item) float64 {
	total := item.Price * float64(item.Qty)
	return total
}

func main() {
	items := []Item{{"Coffee beans", 14.5, 2}, {"Oat milk", 3.2, 4}}
	subtotal := 0.0
	for _, item := range items {
		subtotal += lineTotal(item)
	}
	big := make([]int, 250)
	for i := range big {
		big[i] = i
	}
	fmt.Println("subtotal", subtotal, len(big))
}
`

describe('a debug run of Go through Delve', { skip: !DLV || !GO ? 'no Delve and Go here' : false }, () => {
  it('builds, stops at a breakpoint, shows values, steps, groups a long slice, prints a log point and runs to the end', { timeout: 180_000 }, async () => {
    const dir = await tempWorkspace({ 'go.mod': 'module cart\n\ngo 1.21\n', 'main.go': CART_GO })
    const file = path.join(dir, 'main.go')
    const breakpoints = { [file]: [bp(12), bp(20, { logMessage: 'subtotal is {subtotal}' })] }
    const r = run(goPlan(dir), breakpoints, undefined, dir)
    await r.session.start()
    let view = await r.until((v) => !!paused(v), 'the breakpoint')
    let thread = paused(view)!
    assert.equal(thread.reason, 'breakpoint')
    const top = thread.frames![0]!
    assert.equal(top.name, 'main.lineTotal')
    assert.equal(top.source?.path, file)
    assert.equal(top.line, 12)
    assert.ok(thread.frames!.some((frame) => frame.skipped), 'the runtime frames are dimmed')

    const item = named(await localsOf(r, thread), 'item')
    assert.ok(item?.ref)
    assert.match(named(await r.session.variables(item.ref), 'Name')?.value ?? '', /Coffee beans/)
    const doubled = await r.session.evaluate('item.Qty * 2', { frameId: top.id, context: 'repl' })
    assert.ok(doubled.ok && doubled.value === '4', JSON.stringify(doubled))

    await r.session.step('over')
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 13, 'the next line')
    assert.equal(named(await localsOf(r, paused(view)!), 'total')?.value, '29')

    await r.session.setBreakpoints(file, [bp(20, { logMessage: 'subtotal is {subtotal}' }), bp(26)])
    await r.session.resume()
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 26, 'the last line')
    const big = named(await localsOf(r, paused(view)!), 'big')
    assert.ok(big?.ref)
    const groups = (await r.session.variables(big.ref)).filter((child) => child.kind === 'chunk')
    assert.deepEqual(groups.map((group) => group.name), ['[0 … 99]', '[100 … 199]', '[200 … 249]'])
    const last = await r.session.variables(groups[2]!.ref!)
    assert.equal(last.length, 50)
    assert.equal(last.at(-1)?.value, '249')

    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    const printed = r.text()
    assert.match(printed, /subtotal is 0/)
    assert.match(printed, /subtotal 41\.8 250/)
    assert.match(printed, /The program exited with code 0\./)
    await r.session.settled
  })

  it('stops on the hits its count names, and when its condition holds', { timeout: 180_000 }, async () => {
    const dir = await tempWorkspace({ 'go.mod': 'module cart\n\ngo 1.21\n', 'main.go': CART_GO })
    const file = path.join(dir, 'main.go')
    for (const extra of [{ hitCondition: '2' }, { hitCondition: '== 2' }, { condition: 'item.Qty == 4' }]) {
      const r = run(goPlan(dir), { [file]: [bp(12, extra)] })
      await r.session.start()
      const view = await r.until((v) => !!paused(v), `the stop for ${JSON.stringify(extra)}`)
      const item = named(await localsOf(r, paused(view)!), 'item')!
      assert.match(named(await r.session.variables(item.ref!), 'Name')?.value ?? '', /Oat milk/, JSON.stringify(extra))
      await r.session.stop()
      await r.session.settled
    }
  })

  it('stops for a panic when asked to, and lets it end the program when not', { timeout: 180_000 }, async () => {
    const source = 'package main\n\nfunc main() {\n\tvar list []int\n\t_ = list[3]\n}\n'
    const dir = await tempWorkspace({ 'go.mod': 'module boom\n\ngo 1.21\n', 'main.go': source })
    const r = run(goPlan(dir), {})
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the panic')
    assert.equal(paused(view)!.reason, 'exception')
    assert.match(paused(view)!.exception ?? '', /index out of range/)
    await r.session.stop()
    await r.session.settled

    const quiet = run(goPlan(dir), {}, { uncaught: false, all: false })
    await quiet.session.start()
    await quiet.until((v) => v.state === 'ended', 'the end')
    assert.match(quiet.text(), /index out of range/)
    assert.notEqual(quiet.session.view().exitCode, 0)
  })
})


// ---------------------------------------------------------------- an exception's own breakpoint

describe("a stop at an exception's function breakpoint", () => {
  interface Stop {
    /** Its frames, top first: a name, and lldb-dap's path for code without a file (`module`symbol`). */
    frames: { name: string; path?: string }[]
    /** It says which breakpoint it hit. */
    hit: boolean
  }
  // A debugger that sets the function breakpoints it is sent, then stops as told: each continue goes to the next stop,
  // and after the last the program exits with 101. It counts the continues it was sent.
  const adapter = `
    const stops = JSON.parse(process.argv[1])
    let at = 0
    let continues = 0
    let buffer = Buffer.alloc(0)
    const send = (message) => { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body) }
    const stop = () => {
      if (at >= stops.length) {
        send({ seq: 0, type: 'event', event: 'output', body: { category: 'stdout', output: 'continues ' + continues + '\\n' } })
        send({ seq: 0, type: 'event', event: 'exited', body: { exitCode: 101 } })
        send({ seq: 0, type: 'event', event: 'terminated', body: {} })
        return
      }
      send({ seq: 0, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true, ...(stops[at].hit ? { hitBreakpointIds: [40] } : {}) } })
    }
    const answer = (request) => {
      switch (request.command) {
        case 'initialize': return { supportsConfigurationDoneRequest: true, supportsFunctionBreakpoints: true }
        case 'setFunctionBreakpoints': return { breakpoints: request.arguments.breakpoints.map((item, i) => ({ id: 40 + i, verified: true })) }
        case 'threads': return { threads: [{ id: 1, name: 'main' }] }
        case 'stackTrace': return { stackFrames: stops[at].frames.map((frame, i) => ({ id: i + 1, name: frame.name, line: i ? 7 : 0, column: 0, ...(frame.path ? { source: { name: frame.name, path: frame.path } } : {}) })), totalFrames: stops[at].frames.length }
        case 'continue': return { allThreadsContinued: true }
        default: return {}
      }
    }
    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const end = buffer.indexOf('\\r\\n\\r\\n')
        if (end < 0) return
        const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1])
        if (buffer.length < end + 4 + length) return
        const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
        buffer = buffer.subarray(end + 4 + length)
        send({ seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: true, body: answer(request) })
        if (request.command === 'initialize') send({ seq: 0, type: 'event', event: 'initialized' })
        if (request.command === 'configurationDone') stop()
        if (request.command === 'continue') {
          continues++
          at++
          setTimeout(stop, 20)
        }
        if (request.command === 'disconnect') setTimeout(() => process.exit(0), 10)
      }
    })`
  const session = async (stops: Stop[], rust: DapPlan['rust']) => {
    const dir = await tempWorkspace()
    const printed: string[] = []
    const created = new DapSession({
      id: 's1',
      name: 'test',
      plan: { kind: 'dap', profile: 'lldb', adapter: { file: process.execPath, args: ['-e', adapter, JSON.stringify(stops)], cwd: dir, env: environment(), transport: 'stdio' }, request: 'launch', arguments: { program: path.join(dir, 'cart') }, runDir: path.join(dir, '.run'), rust },
      breakpoints: () => new Map(),
      exceptions: { uncaught: true, all: false },
      onChange: () => undefined,
      onOutput: (lines) => printed.push(...lines.map((line) => line.text)),
    })
    sessions.push(created)
    await created.start()
    const until = async (test: (view: SessionView) => boolean) => {
      const end = Date.now() + 5_000
      while (!test(created.view()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
      return created.view()
    }
    return { session: created, printed, until }
  }
  const stopAt = async (frame: string, hit: boolean, rust: DapPlan['rust']) => {
    const { session: created, until } = await session([{ frames: [{ name: frame }], hit }], rust)
    const thread = (await until((view) => !!view.threads[0]?.frames)).threads[0]!
    await created.stop()
    return thread
  }

  it('is the exception by the breakpoint the debugger says it hit, whatever the frame is named', async () => {
    const thread = await stopAt('a thunk of the program', true, 'msvc')
    assert.deepEqual([thread.reason, thread.exception], ['exception', 'The program panicked: its message is in the output'])
  })

  it("is the exception by the frame's function when the debugger does not say, named alone or after its DLL", async () => {
    assert.equal((await stopAt('VCRUNTIME140!_CxxThrowException', false, 'msvc')).reason, 'exception')
    assert.equal((await stopAt('std::panicking::rust_panic', false, true)).reason, 'exception')
    // A frame of the same name in another kind of program is a breakpoint like any other.
    assert.equal((await stopAt('a thunk of the program', false, 'msvc')).reason, 'breakpoint')
  })

  it("stops once for a throw that goes through the program's thunk into the runtime's DLL, and for each throw after", async () => {
    const callers = [{ name: 'panic_unwind::imp::panic' }, { name: 'cart::main' }]
    const thunk: Stop = { frames: [{ name: '_CxxThrowException', path: 'C:\\cart\\cart.exe`_CxxThrowException' }, ...callers], hit: true }
    const runtime: Stop = { frames: [{ name: '_CxxThrowException', path: 'C:\\Windows\\System32\\VCRUNTIME140.dll`_CxxThrowException' }, ...callers], hit: true }
    // Two panics from the same line, one after the other: each stops at the thunk only.
    const { session: created, printed, until } = await session([thunk, runtime, thunk, runtime], 'msvc')
    for (let panic = 0; panic < 2; panic++) {
      const view = await until((now) => !!now.threads[0]?.frames && now.threads[0].state === 'paused')
      assert.equal(view.threads[0]!.reason, 'exception')
      assert.equal(view.threads[0]!.frames![0]!.source?.path, 'C:\\cart\\cart.exe`_CxxThrowException')
      await created.resume()
      await until((now) => now.threads[0]?.state !== 'paused' || now.state === 'ended')
    }
    await until((now) => now.state === 'ended')
    assert.equal(created.view().exitCode, 101)
    // Two continues were the person's; the other two, past the runtime's stop.
    assert.ok(printed.some((line) => /continues 4/.test(line)), JSON.stringify(printed))
  })
})

// ---------------------------------------------------------------- a debugger that ends as it starts

describe('a debugger that ends as it starts', () => {
  const plan = (dir: string, file: string, args: string[]): DapPlan => ({
    kind: 'dap',
    profile: 'lldb',
    adapter: { file, args, cwd: dir, env: environment(), transport: 'stdio' },
    request: 'launch',
    arguments: { program: path.join(dir, 'cart'), args: [], cwd: dir },
    runDir: path.join(dir, '.run'),
  })
  const start = (options: Partial<ConstructorParameters<typeof DapSession>[0]> & { plan: DapPlan }) => {
    const session = new DapSession({ id: 's1', name: 'test', breakpoints: () => new Map(), exceptions: { uncaught: true, all: false }, onChange: () => undefined, onOutput: () => undefined, ...options })
    sessions.push(session)
    return session
  }
  const failure = async (session: DapSession): Promise<string> => {
    const error = await session.start().then(
      () => assert.fail('it started'),
      (error: unknown) => error as Error,
    )
    assert.equal(session.view().state, 'ended')
    assert.equal(session.view().message, error.message)
    return error.message
  }

  it('says what it exited with and what it wrote, not only that its connection closed', async () => {
    const dir = await tempWorkspace()
    const session = start({ plan: plan(dir, process.execPath, ['-e', 'process.stderr.write("error: no target\\n"); process.exit(3)']) })
    assert.equal(await failure(session), 'lldb-dap ended (code 3) before the program started.\nerror: no target')
  })

  it("says on Windows that a library it needs is missing, and for lldb-dap that it is LLVM's Python", async () => {
    const dir = await tempWorkspace()
    // Windows starts the program, then its loader ends it with STATUS_DLL_NOT_FOUND before it reads or writes anything.
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, pid: 4242, kill: () => true })
      setImmediate(() => {
        child.emit('spawn')
        setImmediate(() => {
          child.exitCode = 3221225781
          child.emit('exit', 3221225781, null)
          child.stdout.end()
          child.stdout.resume()
          child.emit('close', 3221225781, null)
        })
      })
      return child
    }) as unknown as typeof import('node:child_process').spawn
    const session = start({ plan: plan(dir, 'C:\\Program Files\\LLVM\\bin\\lldb-dap.exe', []), platform: 'win32', spawn })
    assert.equal(
      await failure(session),
      "lldb-dap ended (code 0xC0000135) before the program started. Windows could not find a library (DLL) it needs. LLVM's lldb-dap needs the Python its LLVM release was built with: install that Python, or a newer LLVM.",
    )
  })

  it('says how it ended when it goes while the program runs: its code, a crash in words, and its last lines', async () => {
    const dir = await tempWorkspace()
    // A debugger that starts the run as asked, then crashes.
    const adapter = `
      let buffer = Buffer.alloc(0)
      const send = (message) => { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body) }
      process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const end = buffer.indexOf('\\r\\n\\r\\n')
          if (end < 0) return
          const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1])
          if (buffer.length < end + 4 + length) return
          const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
          buffer = buffer.subarray(end + 4 + length)
          send({ seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: true, body: request.command === 'threads' ? { threads: [] } : request.command === 'initialize' ? { supportsConfigurationDoneRequest: true } : {} })
          if (request.command === 'initialize') send({ seq: 0, type: 'event', event: 'initialized' })
          if (request.command === 'configurationDone') setTimeout(() => { process.stderr.write('fatal: lost the target\\n'); process.exit(7) }, 100)
        }
      })`
    const session = start({ plan: plan(dir, process.execPath, ['-e', adapter]) })
    await session.start()
    const end = Date.now() + 5_000
    while (session.view().state !== 'ended' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(session.view().message, 'lldb-dap ended (code 7) while the program ran.\nfatal: lost the target')
  })

  it('names a crash on Windows by its code and in words', async () => {
    const dir = await tempWorkspace()
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, pid: 4243, kill: () => true })
      setImmediate(() => {
        child.emit('spawn')
        setImmediate(() => {
          child.exitCode = 3221225477
          child.emit('exit', 3221225477, null)
          child.stdout.end()
          child.stdout.resume()
          child.emit('close', 3221225477, null)
        })
      })
      return child
    }) as unknown as typeof import('node:child_process').spawn
    const session = start({ plan: plan(dir, 'C:\\Program Files\\LLVM\\bin\\lldb-dap.exe', []), platform: 'win32', spawn })
    assert.equal(await failure(session), 'lldb-dap ended (code 0xC0000005) before the program started. It crashed, with an access violation.')
  })
})

// ---------------------------------------------------------------- C and Rust, through lldb-dap

function lldbDap(): string | null {
  if (process.env.ENCODE_TEST_LLDB_DAP) return process.env.ENCODE_TEST_LLDB_DAP
  const found = searchPath('lldb-dap', process.env)
  if (found) return found
  // Debian and Ubuntu keep it with their LLVM.
  const llvm = existsSync('/usr/lib') ? readdirSync('/usr/lib').filter((name) => /^llvm-\d+$/.test(name)).sort((a, b) => Number(b.slice(5)) - Number(a.slice(5))) : []
  for (const dir of llvm) if (existsSync(`/usr/lib/${dir}/bin/lldb-dap`)) return `/usr/lib/${dir}/bin/lldb-dap`
  return null
}

const LLDB = lldbDap()
const CC = searchPath('clang', process.env) ?? searchPath('cc', process.env)

/**
 * On Windows, LLVM's lldb-dap loads the Python its release was built with; python.org's installs of every version go on
 * the end of its PATH, as eNCode puts the one it needs (packages/workspace, lldbPython).
 */
function lldbEnv(): Record<string, string> {
  const env = environment()
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined
  const root = local ? path.join(local, 'Programs', 'Python') : ''
  const pythons = root && existsSync(root) ? readdirSync(root).filter((name) => /^Python3\d+$/.test(name)).map((name) => path.join(root, name)) : []
  if (!pythons.length) return env
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: [env[key], ...pythons].filter(Boolean).join(';') }
}

function lldbPlan(dir: string, program: string, extra: Partial<DapPlan> = {}): DapPlan {
  return {
    kind: 'dap',
    profile: 'lldb',
    adapter: { file: LLDB!, args: [], cwd: dir, env: lldbEnv(), transport: 'stdio' },
    request: 'launch',
    arguments: { program, args: [], cwd: dir, env: [], stopOnEntry: false },
    runDir: path.join(dir, '.run'),
    ...extra,
  }
}

const CART_C = `#include <stdio.h>

struct item { const char *name; double price; int qty; };

double line_total(struct item item) {
    double total = item.price * item.qty;
    return total;
}

int main(void) {
    struct item items[] = {{"Coffee beans", 14.5, 2}, {"Oat milk", 3.2, 4}};
    double subtotal = 0;
    for (int i = 0; i < 2; i++) {
        subtotal += line_total(items[i]);
    }
    int big[250];
    for (int i = 0; i < 250; i++) big[i] = i;
    printf("subtotal %.1f %d\\n", subtotal, big[249]);
    return 0;
}
`

describe('a debug run of C through lldb-dap', { skip: !LLDB || !CC ? 'no lldb-dap and C compiler here' : false }, () => {
  it('stops at a breakpoint, shows values, steps, groups a long array, prints a log point and runs to the end', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.c': CART_C })
    const file = path.join(dir, 'cart.c')
    const program = path.join(dir, 'cart')
    execFileSync(CC!, ['-g', '-O0', '-o', program, file])
    const r = run(lldbPlan(dir, program), { [file]: [bp(6), bp(14, { logMessage: 'subtotal is {subtotal}' })] }, undefined, dir)
    await r.session.start()
    let view = await r.until((v) => !!paused(v), 'the breakpoint')
    const thread = paused(view)!
    assert.equal(thread.reason, 'breakpoint')
    const top = thread.frames![0]!
    assert.match(top.name, /line_total/)
    assert.equal(top.source?.path, file)
    assert.equal(top.line, 6)
    const item = named(await localsOf(r, thread), 'item')
    assert.ok(item?.ref)
    assert.match(named(await r.session.variables(item.ref), 'name')?.value ?? '', /Coffee beans/)
    const doubled = await r.session.evaluate('item.qty * 2', { frameId: top.id, context: 'repl' })
    assert.ok(doubled.ok && doubled.value === '4', JSON.stringify(doubled))

    await r.session.step('over')
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 7, 'the next line')
    assert.equal(named(await localsOf(r, paused(view)!), 'total')?.value, '29')

    await r.session.setBreakpoints(file, [bp(14, { logMessage: 'subtotal is {subtotal}' }), bp(18)])
    await r.session.resume()
    view = await r.until((v) => paused(v)?.frames?.[0]?.line === 18, 'the last lines')
    const big = named(await localsOf(r, paused(view)!), 'big')
    assert.ok(big?.ref)
    const groups = (await r.session.variables(big.ref)).filter((child) => child.kind === 'chunk')
    assert.deepEqual(groups.map((group) => group.name), ['[0 … 99]', '[100 … 199]', '[200 … 249]'])
    const last = await r.session.variables(groups[2]!.ref!)
    assert.equal(last.length, 50)
    assert.equal(last.at(-1)?.value, '249')

    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    const printed = r.text()
    assert.match(printed, /subtotal is 0/)
    assert.match(printed, /subtotal 41\.8 249/)
    assert.match(printed, /The program exited with code 0\./)
    await r.session.settled
  })

  it('counts hits from a number on, and says why it cannot count them another way', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.c': CART_C })
    const file = path.join(dir, 'cart.c')
    const program = path.join(dir, 'cart')
    execFileSync(CC!, ['-g', '-O0', '-o', program, file])
    const r = run(lldbPlan(dir, program), { [file]: [bp(6, { hitCondition: '2' }), bp(14, { id: 'odd', hitCondition: '% 2' })] })
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the second hit')
    const item = named(await localsOf(r, paused(view)!), 'item')!
    assert.match(named(await r.session.variables(item.ref!), 'name')?.value ?? '', /Oat milk/)
    const odd = r.session.statuses(file).find((status) => status.id === 'odd')
    assert.equal(odd?.verified, false)
    assert.match(odd?.message ?? '', /from a number on/)
    await r.session.stop()
  })
})

const CXX = searchPath('clang++', process.env) ?? searchPath('c++', process.env)

const CART_CPP = `#include <cstdio>
#include <stdexcept>

int line_total(int price, int qty) {
    if (qty < 0) throw std::invalid_argument("a quantity below zero");
    return price * qty;
}

int main() {
    try {
        line_total(3, -1);
    } catch (const std::exception &error) {
        std::printf("caught %s\\n", error.what());
    }
    std::printf("total %d\\n", line_total(3, 4));
    return 0;
}
`

describe('a debug run of C++ through lldb-dap', { skip: !LLDB || !CXX ? 'no lldb-dap and C++ compiler here' : false }, () => {
  it('stops for every exception when asked, a caught one too, in the function that threw it', { timeout: 120_000 }, async () => {
    const dir = await tempWorkspace({ 'cart.cpp': CART_CPP })
    const file = path.join(dir, 'cart.cpp')
    const program = path.join(dir, process.platform === 'win32' ? 'cart.exe' : 'cart')
    execFileSync(CXX!, ['-g', '-O0', '-o', program, file])
    // lldb says how the program ended (`process status`): the message, where its code is not the one it returned.
    const r = run(lldbPlan(dir, program, { arguments: { program, args: [], cwd: dir, env: [], stopOnEntry: false, exitCommands: ['process status'] } }), {}, { uncaught: true, all: true }, dir)
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the throw')
    const thread = paused(view)!
    assert.equal(thread.reason, 'exception', JSON.stringify(thread))
    assert.ok(thread.exception, JSON.stringify(thread))
    // The throw is in the runtime (__cxa_throw; _CxxThrowException on Windows): line_total is below it.
    assert.ok(thread.frames!.some((frame) => /line_total/.test(frame.name) && frame.source?.path === file), JSON.stringify(thread.frames))
    await r.session.resume()
    const ended = await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /caught a quantity below zero/)
    assert.match(r.text(), /total 12/)
    assert.equal(ended.exitCode, 0, r.text())
    await r.session.settled
  })
})

const CARGO = searchPath('cargo', process.env)
const RUSTC = searchPath('rustc', process.env)

const CART_RS = `fn line_total(name: &str, price: f64, qty: u32) -> f64 {
    let total = price * qty as f64;
    total
}

fn main() {
    let names: Vec<String> = vec!["Coffee beans".to_string(), "Oat milk".to_string()];
    let mut subtotal = 0.0;
    subtotal += line_total(&names[0], 14.5, 2);
    subtotal += line_total(&names[1], 3.2, 4);
    println!("subtotal {:.1}", subtotal);
    if std::env::args().any(|arg| arg == "boom") {
        let empty: Vec<u32> = Vec::new();
        println!("{}", empty[3]);
    }
}
`

describe('a debug run of Rust through lldb-dap', { skip: !LLDB || !CARGO || !RUSTC ? 'no lldb-dap and Rust here' : false }, () => {
  it("shows Rust's own values through its formatters, and stops for a panic", { timeout: 240_000 }, async () => {
    const dir = await tempWorkspace({ 'Cargo.toml': '[package]\nname = "cart"\nversion = "0.1.0"\nedition = "2021"\n', 'src/main.rs': CART_RS })
    execFileSync(CARGO!, ['build', '--quiet'], { cwd: dir, env: environment(), timeout: 200_000, stdio: 'ignore' })
    const file = path.join(dir, 'src', 'main.rs')
    const program = path.join(dir, 'target', 'debug', process.platform === 'win32' ? 'cart.exe' : 'cart')
    // As eNCode loads them (packages/workspace, rustDebugging): Rust 1.98 on has no lldb_commands, and registers its
    // formatters as lldb_lookup.py is imported.
    const etc = path.join(execFileSync(RUSTC!, ['--print', 'sysroot'], { encoding: 'utf8' }).trim(), 'lib', 'rustlib', 'etc')
    const commands = path.join(etc, 'lldb_commands')
    const initCommands = [`command script import "${path.join(etc, 'lldb_lookup.py')}"`, ...(existsSync(commands) ? [`command source -s 0 "${commands}"`] : [])]
    const rust = /^host:\s*\S+-windows-msvc\s*$/m.test(execFileSync(RUSTC!, ['-vV'], { encoding: 'utf8' })) ? ('msvc' as const) : true
    // lldb says how the program ended (`process status`): the message, where its code is not the one it returned.
    const plan = (args: string[]) => lldbPlan(dir, program, { rust, arguments: { program, args, cwd: dir, env: [], stopOnEntry: false, initCommands, exitCommands: ['process status'] } })

    const r = run(plan([]), { [file]: [bp(2)] }, undefined, dir)
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint')
    const thread = paused(view)!
    assert.match(thread.frames![0]!.name, /line_total/)
    const locals = await localsOf(r, thread)
    const name = named(locals, 'name')
    assert.match(name?.value ?? '', /"Coffee beans"/, JSON.stringify(name))
    // line_total runs twice: without its breakpoint, the program runs to its end.
    await r.session.setBreakpoints(file, [])
    await r.session.resume()
    const done = await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /subtotal 41\.8/)
    assert.equal(done.exitCode, 0, r.text())
    await r.session.settled

    const boom = run(plan(['boom']), {}, undefined, dir)
    await boom.session.start()
    const crashed = await boom.until((v) => !!paused(v), 'the panic')
    assert.equal(paused(crashed)!.reason, 'exception', JSON.stringify(paused(crashed)))
    assert.match(paused(crashed)!.exception ?? '', /panicked/)
    // One stop for the panic: going on, the program ends as a panic ends it.
    await boom.session.resume()
    const ended = await boom.until((v) => v.state === 'ended' || (!!paused(v) && paused(v)!.frames![0]!.id !== paused(crashed)!.frames![0]!.id), 'the end after the panic')
    assert.equal(ended.state, 'ended', JSON.stringify(paused(ended)))
    assert.equal(ended.exitCode, 101, boom.text())
    await boom.session.settled
  })
})
