/**
 * The Debug tool in a session (ADR 0145): offered to the main agent where the folder has a debugger, loaded through
 * ToolSearch, asked about before every start, and kept from subagents. The debugger here is a stand-in; the tool against
 * the real one is tested in @encode/workspace (debug-agent.test.ts).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { asksForDebugger, type AgentDebugger, type AgentDebugRun } from '@encode/tools'
import { SUBAGENT_EXCLUDED } from './subagents'
import { closeHarnesses, sessionHarness } from './testing'

after(closeHarnesses)

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A debugger whose runs stop at once where the first breakpoint is. */
function standIn(): AgentDebugger & { starts: Parameters<AgentDebugger['start']>[0][] } {
  const runs: AgentDebugRun[] = []
  const starts: Parameters<AgentDebugger['start']>[0][] = []
  return {
    starts,
    configs: async () => [{ id: 'file', name: 'Current file', detail: 'The file open in the editor' }],
    start: async (request) => {
      starts.push(request)
      const at = request.breakpoints[0]!
      runs.push({ id: `r${runs.length + 1}`, name: 'cart.js', detail: 'node cart.js', mine: true, state: 'paused', stops: 1, threads: [{ id: 1, name: 'main', state: 'paused', reason: 'breakpoint', frames: [{ id: 7, name: 'lineTotal', file: at.file, line: at.line }] }] })
      return { ok: true, run: runs.at(-1)!.id }
    },
    runs: async () => runs,
    wait: async (id) => runs.find((run) => run.id === id) ?? null,
    act: async () => ({ ok: true }),
    setBreakpoints: async () => ({ ok: true }),
    statuses: () => [],
    scopes: async () => [{ name: 'Local', ref: 1, expensive: false }],
    variables: async () => [{ name: 'total', value: '29' }],
    evaluate: async () => ({ ok: true, value: '4' }),
    printed: () => ({ lines: [{ category: 'stdout', text: 'Checking out 2 items\n' }], dropped: 0 }),
  }
}

const tools = (request: { payload: { tools: { name: string }[] } }) => request.payload.tools.map((tool) => tool.name)

describe('the Debug tool in a session (ADR 0145)', () => {
  it('is loaded through ToolSearch, asks before a start with what it runs, and reports the stop once approved', async () => {
    const debug = standIn()
    const h = await sessionHarness({
      files: { 'cart.js': 'const a = 1\nconsole.log(a)\n' },
      env: { debug },
      scriptFor: (root) => [
        { calls: [{ name: 'ToolSearch', input: { query: 'select:Debug' } }] },
        { calls: [{ name: 'Debug', input: { action: 'start', file: 'cart.js', breakpoints: [{ file: path.join(root, 'cart.js'), line: 2 }] } }] },
        { text: 'done' },
      ],
    })
    const running = h.session.start({ text: 'why is the total wrong?', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.equal(request.tool, 'Debug')
    assert.equal(request.title, 'Debug cart.js')
    assert.equal(request.detail, '1 breakpoint: cart.js:2')
    assert.match(request.reason ?? '', /^Debugging cart\.js runs it outside the sandbox, with your environment, as your own terminal would\./)
    assert.equal(request.grantable, true)
    assert.equal(request.always, undefined)
    assert.equal(debug.starts.length, 0, 'nothing runs before the person says yes')
    h.session.resolveApproval(request.id, true)
    assert.equal((await running).kind, 'done')

    const [first, second, third] = h.client.requests
    assert.ok(!tools(first!).includes('Debug'), 'it waits for ToolSearch')
    assert.match(first!.payload.tools.find((tool) => tool.name === 'ToolSearch')?.description ?? '', /Debug/)
    assert.ok(tools(second!).includes('Debug'))
    assert.deepEqual(debug.starts[0]!.breakpoints, [{ file: path.join(h.root, 'cart.js'), line: 2 }])
    assert.deepEqual(debug.starts[0]!.exceptions, { uncaught: true, all: false })
    const result = JSON.stringify(third!.payload.messages.at(-1))
    assert.match(result, /Run r1 \(node cart\.js\) paused at cart\.js:2 in lineTotal: breakpoint\./)
    assert.match(result, /total = 29/)
    assert.match(result, /Checking out 2 items/)
  })

  it('is listed from the start of a request that asks for the debugger, and stays for the session (ADR 0148)', async () => {
    const h = await sessionHarness({ env: { debug: standIn() }, script: (_request, step) => ({ text: `answer ${step}` }) })
    const asks = ['why is the total wrong?', 'Use the debugger to find out why the total is wrong.', 'thanks', 'rename it', 'and the tests', 'done?']
    for (const text of asks) await h.session.start({ text, mode: 'code' })
    const main = h.client.requests.filter((request) => request.role === 'main')
    assert.equal(main.length, asks.length)
    assert.ok(!tools(main[0]!).includes('Debug'), 'a request that does not ask for it waits for ToolSearch')
    // DeepSeek V4.1 Flash, asked to use the debugger, never searched for it and fixed the bug by reading (ADR 0148).
    for (const request of main.slice(1)) assert.ok(tools(request).includes('Debug'), 'listed once asked for, past the last three requests, so the list holds')
  })

  it('reads a request as asking for the debugger only by words that do (ADR 0148)', () => {
    for (const text of ['Use the debugger to find the record that is read wrong', 'Debug why the total is 0', 'set a breakpoint at line 7', 'step through buildMenu', 'can you debug this?', 'Debugging the crash, please']) {
      assert.ok(asksForDebugger(text), text)
    }
    for (const text of ['add debug logging to the server', 'turn off DEBUG mode', 'why is the total wrong?', 'the debug build fails', 'remove the debug flag']) {
      assert.ok(!asksForDebugger(text), text)
    }
  })

  it('is refused under Read Only, and runs nothing', async () => {
    const debug = standIn()
    const h = await sessionHarness({
      env: { debug },
      settings: { policy: 'read-only' },
      script: [{ calls: [{ name: 'ToolSearch', input: { query: 'select:Debug' } }] }, { calls: [{ name: 'Debug', input: { action: 'start', file: 'cart.js' } }] }, { text: 'done' }],
    })
    await h.session.start({ text: 'debug it', mode: 'code' })
    assert.equal(debug.starts.length, 0)
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /Read Only, so eNCode does not run the folder's code/)
  })

  it('is not offered where the folder has no debugger, nor to subagents', async () => {
    const h = await sessionHarness({ script: [{ calls: [{ name: 'ToolSearch', input: { query: 'select:Debug' } }] }, { text: 'done' }] })
    await h.session.start({ text: 'debug it', mode: 'code' })
    assert.ok(!tools(h.client.requests.at(-1)!).includes('Debug'))
    assert.ok(SUBAGENT_EXCLUDED.includes('Debug'))
  })
})
