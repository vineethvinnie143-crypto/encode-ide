/**
 * Runs through a language's own debugger (ADR 0144), against the real ones: debugpy for Python, Delve for Go and
 * lldb-dap for C and Rust. Each part runs where its debugger is: on PATH, or named by ENCODE_TEST_DEBUGPY (a folder
 * with debugpy in it), ENCODE_TEST_DLV or ENCODE_TEST_LLDB_DAP; a part whose debugger is missing is skipped, and says
 * so.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
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

const paused = (view: SessionView): ThreadView | undefined => view.threads.find((thread) => thread.state === 'paused' && thread.frames?.length)
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

function lldbPlan(dir: string, program: string, extra: Partial<DapPlan> = {}): DapPlan {
  return {
    kind: 'dap',
    profile: 'lldb',
    adapter: { file: LLDB!, args: [], cwd: dir, env: environment(), transport: 'stdio' },
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
    const etc = path.join(execFileSync(RUSTC!, ['--print', 'sysroot'], { encoding: 'utf8' }).trim(), 'lib', 'rustlib', 'etc')
    const initCommands = [`command script import "${path.join(etc, 'lldb_lookup.py')}"`, `command source -s 0 "${path.join(etc, 'lldb_commands')}"`]
    const plan = (args: string[]) => lldbPlan(dir, program, { rust: true, arguments: { program, args, cwd: dir, env: [], stopOnEntry: false, initCommands } })

    const r = run(plan([]), { [file]: [bp(2)] }, undefined, dir)
    await r.session.start()
    const view = await r.until((v) => !!paused(v), 'the breakpoint')
    const thread = paused(view)!
    assert.match(thread.frames![0]!.name, /line_total/)
    const name = named(await localsOf(r, thread), 'name')
    assert.match(name?.value ?? '', /"Coffee beans"/, JSON.stringify(name))
    // line_total runs twice: without its breakpoint, the program runs to its end.
    await r.session.setBreakpoints(file, [])
    await r.session.resume()
    await r.until((v) => v.state === 'ended', 'the end')
    assert.match(r.text(), /subtotal 41\.8/)
    await r.session.settled

    const boom = run(plan(['boom']), {}, undefined, dir)
    await boom.session.start()
    const crashed = await boom.until((v) => !!paused(v), 'the panic')
    assert.equal(paused(crashed)!.reason, 'exception')
    assert.match(paused(crashed)!.exception ?? '', /panicked/)
    await boom.session.stop()
    await boom.session.settled
  })
})
