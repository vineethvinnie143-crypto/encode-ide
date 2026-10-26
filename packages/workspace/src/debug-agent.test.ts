/**
 * The agent's Debug tool (ADR 0145) against the folder's real debugger: runs of its own with breakpoints of their own,
 * stop reports, stepping and values, the person's runs read but not driven unasked, and its runs ended with its session.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { debugTool, searchPath, type DebugInput, type ToolOutcome } from '@encode/tools'
import { tempWorkspace, testContext, textOf } from '@encode/tools/testing'
import { WorkspaceConfig } from './config'
import { DEBUG_UNTRUSTED, FolderDebugger, type AgentDebugView, type DebugState } from './debug'
import { findLldbDap } from './debuggers'
import { nodeWorkspaceFs } from './fs'
import { trustFolder } from './report'

const CART = [
  'const items = [',
  "  { name: 'Coffee beans', price: 14.5, qty: 2 },",
  "  { name: 'Oat milk', price: 3.25, qty: 4 },",
  ']',
  'function lineTotal(item) {',
  '  const total = item.price * item.qty',
  '  return Math.round(total * 100) / 100',
  '}',
  'let sum = 0',
  "console.log('Checking out', items.length, 'items')",
  'for (const item of items) sum += lineTotal(item)',
  "console.log('Total', sum)",
  '',
].join('\n')

function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/^NODE_(OPTIONS|TEST_CONTEXT)$/.test(key)) env[key] = value
  return env
}

const open: FolderDebugger[] = []
// A run a failed test left behind is stopped, so the test's process can end.
after(() => Promise.all(open.map((debug) => debug.close())))

async function setup(files: Record<string, string>, options: { trusted?: boolean; tools?: string; env?: Record<string, string>; scratch?: string } = {}) {
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace())
  const config = new WorkspaceConfig({ root, home })
  await config.refresh()
  if (options.trusted !== false) await trustFolder(config)
  const debug = new FolderDebugger(config, nodeWorkspaceFs, { runDir: path.join(home, 'runs'), env: options.env ?? environment(), ...(options.tools ? { tools: options.tools } : {}) })
  open.push(debug)
  const view = debug.forAgent('session-1', options.scratch)
  let call = 0
  const tool = async (input: DebugInput, agent: AgentDebugView = view): Promise<ToolOutcome & { text: string }> => {
    const ctx = testContext(root, { debug: agent, toolUseId: `call-${++call}` })
    const problem = debugTool.check?.(input)
    if (problem) return { ok: false, content: problem, text: problem }
    const outcome = await debugTool.run(input, ctx)
    return { ...outcome, text: textOf(outcome.content) }
  }
  const access = (input: DebugInput, agent: AgentDebugView = view) => debugTool.access(input, testContext(root, { debug: agent }))
  return { root, home, config, debug, view, tool, access }
}

async function until(debug: FolderDebugger, test: (state: DebugState) => boolean, what: string, ms = 60_000): Promise<DebugState> {
  const end = Date.now() + ms
  for (;;) {
    const state = await debug.state()
    if (test(state)) return state
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(state).slice(0, 2_000)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe("the agent's Debug tool (ADR 0145)", () => {
  it('stops at its own breakpoint and reports the place, the stack, the values and what was printed; then steps, evaluates and ends', { timeout: 120_000 }, async () => {
    const { debug, tool } = await setup({ 'cart.js': CART })
    // The person's breakpoint is theirs: the agent's run does not stop at it.
    assert.deepEqual(await debug.setBreakpoints('cart.js', [{ id: 'p1', line: 11, enabled: true }]), { ok: true })

    const started = await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: 'cart.js', line: 7 }] })
    assert.ok(started.ok, started.text)
    const lines = started.text.split('\n')
    assert.match(lines[0]!, /^Run r1 \(node cart\.js\) paused at cart\.js:7 in lineTotal: breakpoint\.$/)
    assert.ok(lines.includes('  → 7    return Math.round(total * 100) / 100'), started.text)
    assert.ok(lines.includes('    6    const total = item.price * item.qty'), started.text)
    assert.ok(lines.some((line) => /^  → #0 lineTotal {2}cart\.js:7$/.test(line)), started.text)
    assert.ok(lines.some((line) => /^ {4}#1 .*cart\.js:11$/.test(line)), started.text)
    assert.ok(lines.some((line) => /^ {2}total = 29\b/.test(line)), started.text)
    assert.ok(lines.some((line) => /^ {2}item = /.test(line)), started.text)
    assert.ok(lines.includes('Printed since the last report:') && lines.includes('  Checking out 2 items'), started.text)

    // The window sees the agent's run, marked as the agent's, and the person's breakpoint as not placed by it.
    const state = await debug.state()
    assert.equal(state.runs[0]?.by, 'agent')
    assert.equal(state.breakpoints['cart.js']?.[0]?.verified, undefined)

    const value = await tool({ action: 'evaluate', expression: 'item.qty * 2' })
    assert.equal(value.text, 'item.qty * 2 = 4')
    const item = await tool({ action: 'variables', name: 'item' })
    assert.ok(item.ok, item.text)
    assert.match(item.text, /^item = \{name: "Coffee beans", price: 14\.5, qty: 2\} \(Object\)$/m)
    assert.match(item.text, /^ {2}name = "Coffee beans"$/m)
    assert.match(item.text, /^ {2}price = 14\.5$/m)
    assert.equal((await tool({ action: 'variables', name: 'item.nothing' })).text, 'item has no nothing.')

    // Output is reported once: the next report has nothing printed since.
    const stepped = await tool({ action: 'step', step: 'over' })
    // V8 stops once more at the end of the return, with the value it returns.
    assert.match(stepped.text, /paused at cart\.js:7 in lineTotal: step\./)
    assert.match(stepped.text, /^ {2}Return value = 29$/m)
    assert.ok(!stepped.text.includes('Checking out'), stepped.text)

    // Back at the breakpoint for Oat milk, then without breakpoints to the end.
    const again = await tool({ action: 'continue' })
    assert.match(again.text, /paused at cart\.js:7 in lineTotal: breakpoint/)
    assert.match(again.text, /^ {2}total = 13\b/m)
    assert.equal((await tool({ action: 'breakpoints', breakpoints: [] })).text, 'Run r1 has no breakpoints now.')
    const ended = await tool({ action: 'continue' })
    assert.match(ended.text, /^Run r1 \(node cart\.js\) ended with exit code 0\./)
    assert.ok(ended.text.includes('  Total 42'), ended.text)
    // The person's breakpoint is as they left it.
    assert.deepEqual((await debug.state()).breakpoints['cart.js']?.map((item) => item.line), [11])
  })

  it('stops only when a condition holds, prints a log point, and stops at an uncaught exception', { timeout: 120_000 }, async () => {
    const { tool } = await setup({ 'cart.js': CART, 'boom.js': "function fail(n) {\n  throw new Error('no stock for ' + n)\n}\nfail(3)\n" })
    const started = await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: 'cart.js', line: 7, condition: 'item.qty > 3' }, { file: 'cart.js', line: 6, logMessage: 'pricing {item.name}' }] })
    assert.match(started.text, /paused at cart\.js:7/)
    assert.match(started.text, /^ {2}total = 13\b/m)
    assert.ok(started.text.includes('  pricing Coffee beans') && started.text.includes('  pricing Oat milk'), started.text)
    assert.match((await tool({ action: 'stop' })).text, /^Run r1 \(node cart\.js\) ended/)

    const crash = await tool({ action: 'start', file: 'boom.js' })
    assert.match(crash.text, /paused at boom\.js:2 in fail: exception\./)
    assert.match(crash.text, /^Exception: Error: no stock for 3$/m)
    assert.ok(!crash.text.includes('    at '), crash.text)
    assert.match(crash.text, /^ {2}n = 3$/m)
    await tool({ action: 'stop' })
  })

  it('says what stops an ES module that throws as it loads, which V8 counts as caught by the loader', { timeout: 120_000 }, async () => {
    const { tool } = await setup({ 'package.json': '{ "type": "module" }\n', 'menu.js': "import { build } from './build.js'\nbuild([{ id: 'a', parent: 'b' }])\n", 'build.js': 'export function build(pages) {\n  const byId = new Map()\n  for (const page of pages) byId.get(page.parent).children.push(page)\n}\n' })
    const through = await tool({ action: 'start', file: 'menu.js' })
    assert.match(through.text, /^Run r1 \(node menu\.js\) ended with exit code 1\./)
    assert.ok(through.text.includes("TypeError: Cannot read properties of undefined (reading 'children')"), through.text)
    assert.ok(through.text.includes('Start again with stopOn "all" to stop where it is thrown.'), through.text)
    const stopped = await tool({ action: 'start', file: 'menu.js', stopOn: 'all' })
    assert.match(stopped.text, /paused at build\.js:3 in build: exception\./)
    // The loop's variable and the function's together: the loop's block alone would show only page.
    assert.match(stopped.text, /^Values \(Block, Local, frame #0\):$/m)
    assert.match(stopped.text, /^ {2}page = \{id: "a", parent: "b"\}/m)
    assert.match(stopped.text, /^ {2}byId = Map\(0\)/m)
    assert.match(stopped.text, /^ {2}pages = /m)
    await tool({ action: 'stop' })
    // A run that ended well, or one asked to stop on every exception, has nothing to add.
    const plain = await tool({ action: 'start', file: 'menu.js', stopOn: 'none' })
    assert.ok(!plain.text.includes('stopOn "all"'), plain.text)
  })

  it('waits, reports a run that has not stopped, pauses it where it is and stops it', { timeout: 120_000 }, async () => {
    const { tool } = await setup({ 'spin.js': "let n = 0\nsetInterval(() => {\n  n++\n}, 5)\nconsole.log('spinning')\n" })
    const started = await tool({ action: 'start', file: 'spin.js', wait: 1 })
    assert.match(started.text, /^Run r1 \(node spin\.js\) is running after 1 s: it has not stopped\. Call continue to wait longer/)
    assert.ok(started.text.includes('  spinning'), started.text)
    const paused = await tool({ action: 'pause' })
    assert.match(paused.text, /^Run r1 \(node spin\.js\) paused at /)
    assert.equal((await tool({ action: 'step', run: 'r9' })).text, 'There is no run r9. The runs are r1.')
    const stopped = await tool({ action: 'stop' })
    assert.match(stopped.text, /^Run r1 \(node spin\.js\) ended/)
  })

  it("reads the person's run freely, asks before driving it, and never changes its breakpoints", { timeout: 120_000 }, async () => {
    const { debug, tool, access } = await setup({ 'cart.js': CART })
    await debug.setBreakpoints('cart.js', [{ id: 'p1', line: 7, enabled: true }])
    assert.deepEqual((await debug.start({ config: 'file', file: 'cart.js' })).ok, true)
    await until(debug, (state) => state.runs[0]?.state === 'paused' && !!state.runs[0].threads[0]?.frames?.length, 'the stop')

    assert.deepEqual(await access({ action: 'state' }), { type: 'none' })
    assert.deepEqual(await access({ action: 'variables', name: 'item' }), { type: 'none' })
    assert.deepEqual(await access({ action: 'continue' }), { type: 'debug', action: 'drive', what: 'r1, node cart.js', key: 'r1' })
    assert.deepEqual(await access({ action: 'evaluate', expression: 'sum = 1' }), { type: 'debug', action: 'drive', what: 'r1, node cart.js', key: 'r1' })

    const read = await tool({ action: 'variables', name: 'item' })
    assert.match(read.text, /^ {2}name = "Coffee beans"$/m)
    assert.ok(!read.text.includes('[[Prototype]]'), read.text)
    const overview = await tool({ action: 'state' })
    assert.match(overview.text, /^ {2}r1 \(the person's\): node cart\.js, paused at cart\.js:7$/m)
    assert.match(overview.text, /^ {2}"file": The file open in the editor/m)
    assert.equal((await tool({ action: 'breakpoints', breakpoints: [{ file: 'cart.js', line: 6 }] })).text, "Run r1 is the person's: its breakpoints are theirs. Start a run of your own with the breakpoints you need.")
    await debug.act('r1', { kind: 'stop' })
  })

  it("keeps each session to its own runs, and ends a session's runs with it", { timeout: 120_000 }, async () => {
    const { debug, view, tool } = await setup({ 'cart.js': CART })
    const other = debug.forAgent('session-2')
    assert.ok((await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: 'cart.js', line: 7 }] })).ok)
    assert.deepEqual((await other.runs()).map((run) => run.id), [])
    assert.equal((await tool({ action: 'continue', run: 'r1' }, other)).text, 'There is no run r1. Nothing runs: start one.')
    assert.deepEqual(await other.act('r1', { kind: 'stop' }), { ok: false, reason: 'There is no such run.' })
    assert.deepEqual((await view.runs()).map((run) => [run.id, run.mine, run.state]), [['r1', true, 'paused']])
    await view.close()
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end of the run')
  })

  it('refuses a fourth run of its own, breakpoints outside the folder, and an untrusted folder', { timeout: 120_000 }, async () => {
    const { tool } = await setup({ 'cart.js': CART })
    for (let n = 1; n <= 3; n++) assert.match((await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: 'cart.js', line: 7 }] })).text, new RegExp(`^Run r${n} .* paused`))
    const fourth = await tool({ action: 'start', file: 'cart.js' })
    assert.equal(fourth.ok, false)
    assert.match(fourth.text, /^3 runs of yours are going on \(r1: node cart\.js, r2: node cart\.js, r3: node cart\.js\)\. Stop one first\.$/)
    for (const run of ['r1', 'r2', 'r3']) await tool({ action: 'stop', run })
    const outside = await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: '../elsewhere.js', line: 1 }] })
    assert.match(outside.text, /elsewhere\.js is not in the open folder\.$/)
    assert.equal((await tool({ action: 'start', file: 'cart.js', breakpoints: [{ file: 'cart.js', line: 7, hitCondition: 'often' }] })).text, 'hitCondition "often" is not a count: give "5", "==5", ">5" or "%5".')
    assert.match((await tool({ action: 'start', config: 'Server' })).text, /^There is no configuration "Server"\. The folder runs: "Current file"/)

    const untrusted = await setup({ 'cart.js': CART }, { trusted: false })
    const refused = await untrusted.tool({ action: 'start', file: 'cart.js' })
    assert.deepEqual([refused.ok, refused.text], [false, DEBUG_UNTRUSTED])
  })

  it("runs a probe in the session's scratch folder, with breakpoints in it and in the folder, and nothing outside both (ADR 0149)", { timeout: 120_000 }, async () => {
    const scratch = await fs.realpath(await tempWorkspace())
    const price = 'function lineTotal(item) {\n  const total = item.price * item.qty\n  return Math.round(total * 100) / 100\n}\nmodule.exports = { lineTotal }\n'
    const { root, home, debug, tool } = await setup({ 'price.js': price }, { scratch })
    const probe = path.join(scratch, 'probe.js')
    await fs.writeFile(probe, `const { lineTotal } = require(${JSON.stringify(path.join(root, 'price.js'))})\nconst item = { price: 2.5, qty: 3 }\nconst got = lineTotal(item)\nconsole.log('probe', got)\n`)

    const started = await tool({ action: 'start', file: probe, breakpoints: [{ file: 'price.js', line: 3 }, { file: probe, line: 4 }] })
    assert.ok(started.ok, started.text)
    assert.match(started.text, /^Run r1 \(node .*probe\.js\) paused at price\.js:3 in lineTotal: breakpoint\.$/m)
    assert.match(started.text, /^ {2}total = 7\.5$/m)
    const next = await tool({ action: 'continue' })
    assert.match(next.text, /paused at .*probe\.js:4/)
    assert.match(next.text, /^ {2}got = 7\.5$/m)
    // The person cannot start the agent's probe again from the Debug tab: it is outside the folder.
    assert.deepEqual(await debug.act('r1', { kind: 'restart' }), { ok: false, reason: "That run's program is the agent's probe, outside the open folder: only the agent can start it again." })
    const ended = await tool({ action: 'continue' })
    assert.match(ended.text, /ended with exit code 0\./)
    assert.ok(ended.text.includes('  probe 7.5'), ended.text)

    // Outside both folders, a probe not written yet, and a breakpoint outside both.
    const elsewhere = path.join(home, 'elsewhere.js')
    await fs.writeFile(elsewhere, "console.log('elsewhere')\n")
    assert.equal((await tool({ action: 'start', file: elsewhere })).text, 'That file is in neither the open folder nor your scratch folder.')
    assert.equal((await tool({ action: 'start', file: path.join(scratch, 'later.js') })).text, `There is no ${path.join(scratch, 'later.js')}: write the probe first.`)
    assert.match((await tool({ action: 'start', file: probe, breakpoints: [{ file: elsewhere, line: 1 }] })).text, /elsewhere\.js is in neither the open folder nor your scratch folder\.$/)
    // A link in the scratch folder that leads out of it runs what it leads to, which the person was not shown.
    if (process.platform !== 'win32') {
      const link = path.join(scratch, 'link.js')
      await fs.symlink(elsewhere, link)
      assert.equal((await tool({ action: 'start', file: link })).text, `${link} leads out of your scratch folder.`)
    }
    // A session told of no scratch folder runs only the folder's files.
    assert.equal((await tool({ action: 'start', file: probe }, debug.forAgent('session-2'))).text, 'That file is not in the open folder.')
    // The person's own start never runs a file outside the folder.
    assert.deepEqual(await debug.start({ config: 'file', file: probe }), { ok: false, reason: 'That file is not in the open folder.' })
  })

  it('stops a run whose call was stopped', { timeout: 120_000 }, async () => {
    const { root, debug, view } = await setup({ 'spin.js': "setInterval(() => {}, 5)\n" })
    const control = new AbortController()
    const call = debugTool.run({ action: 'start', file: 'spin.js', wait: 60 }, testContext(root, { debug: view, signal: control.signal }))
    await until(debug, (state) => state.runs[0]?.state === 'running', 'the run')
    control.abort()
    await call.catch(() => undefined)
    await until(debug, (state) => state.runs[0]?.state === 'ended', 'the end of the run')
  })
})

const DEBUGPY = process.env.ENCODE_TEST_DEBUGPY && existsSync(path.join(process.env.ENCODE_TEST_DEBUGPY, 'debugpy', 'adapter')) ? process.env.ENCODE_TEST_DEBUGPY : null
const PYTHON = searchPath('python3', process.env) ?? searchPath('python', process.env)

function lldbDap(): string | null {
  try {
    return process.env.ENCODE_TEST_LLDB_DAP ?? findLldbDap({ root: process.cwd(), platform: process.platform, env: environment() })
  } catch {
    return null
  }
}
const LLDB = lldbDap()
const CLANG = searchPath('clang', process.env)

describe("the Debug tool with a language's own debugger (ADR 0145)", () => {
  it("stops a Python program at its breakpoint with eNCode's debugpy, evaluates and ends", { skip: !PYTHON || !DEBUGPY ? 'no Python and ENCODE_TEST_DEBUGPY here' : false, timeout: 120_000 }, async () => {
    // eNCode's tools folder with debugpy as its install leaves it.
    const tools = await fs.realpath(await tempWorkspace())
    const dir = path.join(tools, 'debugpy', '1.8.22')
    await fs.cp(DEBUGPY!, dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'encode-install.json'), JSON.stringify({ id: 'debugpy', version: '1.8.22', kind: 'download' }))
    const { tool } = await setup(
      { 'cart.py': 'items = [\n    {"name": "Coffee beans", "price": 14.5, "qty": 2},\n    {"name": "Oat milk", "price": 3.25, "qty": 4},\n]\n\ndef line_total(item):\n    total = item["price"] * item["qty"]\n    return round(total, 2)\n\nprint("Total", sum(line_total(item) for item in items))\n' },
      { tools },
    )
    const started = await tool({ action: 'start', file: 'cart.py', breakpoints: [{ file: 'cart.py', line: 8 }] })
    assert.match(started.text, /^Run r1 \(python cart\.py\) paused at cart\.py:8 in line_total: breakpoint\./)
    assert.match(started.text, /^ {2}total = 29\.0/m)
    assert.equal((await tool({ action: 'evaluate', expression: 'item["qty"] * 2' })).text, 'item["qty"] * 2 = 4')
    assert.match((await tool({ action: 'variables', name: 'item' })).text, /^ {2}'name' = 'Coffee beans'/m)
    assert.match((await tool({ action: 'step' })).text, /paused at cart\.py:10 in <genexpr>: step\./)
    await tool({ action: 'breakpoints', breakpoints: [] })
    const ended = await tool({ action: 'continue' })
    assert.match(ended.text, /ended with exit code 0\./)
    assert.ok(ended.text.includes('  Total 42.0'), ended.text)
  })

  it('builds a C file, stops it at its breakpoint with lldb-dap and steps out', { skip: !LLDB || !CLANG ? 'no lldb-dap and clang here' : false, timeout: 120_000 }, async () => {
    const env = { ...environment(), ...(process.env.ENCODE_TEST_LLDB_DAP ? { PATH: `${path.dirname(LLDB!)}${path.delimiter}${process.env.PATH ?? ''}` } : {}) }
    const { tool } = await setup({ 'cart.c': '#include <stdio.h>\n\nint total(int a, int b) {\n  int result = a + b;\n  return result;\n}\n\nint main(void) {\n  printf("total %d\\n", total(4, 5));\n  return 0;\n}\n' }, { env })
    const started = await tool({ action: 'start', file: 'cart.c', breakpoints: [{ file: 'cart.c', line: 5 }] })
    assert.match(started.text, /^Run r1 \(clang -g cart\.c\) paused at cart\.c:5 in total: breakpoint\./)
    assert.match(started.text, /^ {2}result = 9\b/m)
    assert.ok(started.text.includes('  Building cart.c with clang…'), started.text)
    assert.match((await tool({ action: 'step', step: 'out' })).text, /paused at cart\.c:9 in main: step\./)
    const ended = await tool({ action: 'continue' })
    assert.match(ended.text, /ended with exit code 0\./)
    assert.ok(ended.text.includes('  total 9'), ended.text)
  })
})
