/**
 * The scan of a request's changes, the Reviewer's reading of them and of a plan, through the loop (ADR 0096).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { AgentShell } from '@encode/tools'
import type { UserMessage } from '@encode/providers'
import { CheckLedger, type ProjectCheck, type ProjectChecks } from './checks'
import type { ChangedText } from './diff-scan'
import { COMPLETION_SYSTEM, PLAN_SYSTEM } from './review'
import { loopHarness, stubShell, type Harness } from './testing'

const TEST: ProjectCheck = { command: 'npm test', kind: 'test', source: 'package.json' }

function checksOf(list: ProjectCheck[]): ProjectChecks {
  return { list: async () => list, ledger: new CheckLedger() }
}

/** A shell whose every command passes. */
const passing = (root: string): AgentShell => ({
  ...stubShell(root),
  run: async () => ({ output: 'ok', exitCode: 0, timedOut: false, interrupted: false, cwd: root }),
})

function reminders(h: Harness): string[] {
  return h.conversation
    .messages()
    .filter((message): message is UserMessage => message.role === 'user')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' && block.text.startsWith('<system-reminder>') ? [block.text] : [])))
}

const notices = (h: Harness) => h.surface.settled.filter((entry) => entry.kind === 'notice').map((entry) => entry.text ?? '')
const write = (root: string, name: string, content: string) => ({ calls: [{ name: 'Write', input: { file_path: path.join(root, name), content } }] })
const userText = (h: Harness, index: number) => {
  const message = h.client.requests[index].payload.messages.at(-1)!
  return message.content.map((block) => ('text' in block ? block.text : '')).join('')
}

const DEPOSIT = "RegisterNetEvent('bank:deposit', function(amount)\n  xPlayer.addMoney(amount)\nend)\n"
const STATS_BEFORE = 'export const x = 1\n'
const STATS = 'export const x = 1\nexport function mean(v: number[]) {\n  return sum(v) / v.length\n}\n'
const stats: ChangedText = { path: 'src/stats.ts', before: STATS_BEFORE, after: STATS }

describe('the scan before the agent finishes', () => {
  it('sends the agent back once with what the added lines get wrong', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'server/main.lua', DEPOSIT), { text: 'Added the deposit event.' }, { text: 'The server now checks the amount.' }],
      services: { checks: checksOf([]), changes: async () => [{ path: 'server/main.lua', before: null, after: DEPOSIT }] },
    })
    const end = await h.run('add a deposit event')
    assert.deepEqual(end, { kind: 'done', reply: 'The server now checks the amount.' }, 'once a request')
    const [sent] = reminders(h)
    assert.match(sent, /eNCode's scan of the lines your changes added found what is often a security bug:\n- `server\/main\.lua:2` `xPlayer\.addMoney\(amount\)`: It takes `amount` from the client's `bank:deposit` event/)
    assert.equal(reminders(h).length, 1)
    assert.ok(notices(h).some((text) => /scan found what is often a security bug/.test(text)))
  })

  it('does not run for a request that changed no file, nor with checks turned off', async () => {
    let asked = 0
    const changes = async () => (asked++, [{ path: 'server/main.lua', before: null, after: DEPOSIT }])
    const quiet = await loopHarness({ script: [{ text: 'Nothing to change.' }], services: { checks: checksOf([]), changes } })
    await quiet.run('look')
    assert.equal(asked, 0, 'nothing was written, so nothing is read')
    const off = await loopHarness({
      scriptFor: (root) => [write(root, 'server/main.lua', DEPOSIT), { text: 'Done.' }],
      services: { checks: checksOf([]), changes },
      settings: { checkGate: 'off' },
    })
    assert.deepEqual(await off.run('go'), { kind: 'done', reply: 'Done.' })
    assert.deepEqual(reminders(off), [])
  })

  it('holds a model that finishes with attempt_completion to the same', async () => {
    const h = await loopHarness({
      completion: true,
      scriptFor: (root) => [
        write(root, 'server/main.lua', DEPOSIT),
        { calls: [{ name: 'attempt_completion', input: { result: 'Added the deposit event.' } }] },
        { calls: [{ name: 'attempt_completion', input: { result: 'The server now checks the amount.' } }] },
      ],
      services: { checks: checksOf([]), changes: async () => [{ path: 'server/main.lua', before: null, after: DEPOSIT }] },
    })
    const end = await h.run('add a deposit event')
    assert.deepEqual(end, { kind: 'stopped', summary: 'The server now checks the amount.' })
    assert.equal(reminders(h).length, 1)
    assert.match(reminders(h)[0], /scan of the lines your changes added/)
  })
})

describe('the Reviewer before the agent finishes', () => {
  const finding = { file: 'src/stats.ts', line: 3, priority: 'P1', title: 'Divides by zero for an empty list', body: 'Return 0 when v is empty.' }

  it('reads the request, the reply and the change, and sends back what holds up the work', async () => {
    const answer = JSON.stringify({ summary: 'Mostly right.', findings: [finding, { file: 'src/stats.ts', line: 2, priority: 'P3', title: 'Name it average', body: '' }], untested: ['an empty list'] })
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: answer }, { text: 'Fixed the empty list.' }],
      services: { changes: async () => [stats] },
      settings: { review: 'on' },
      requests: () => ['add a mean function'],
    })
    const end = await h.run('add a mean function')
    assert.deepEqual(end, { kind: 'done', reply: 'Fixed the empty list.' })
    const call = h.client.requests[2]
    assert.deepEqual([call.role, call.tool, call.payload.tools.length, call.payload.system[0].text], ['reviewer', 'CompletionReview', 0, COMPLETION_SYSTEM])
    const prompt = userText(h, 2)
    assert.match(prompt, /1\. add a mean function/)
    assert.match(prompt, /<reply-[0-9a-f]+>\nAdded mean\(\)\.\n<\/reply-/)
    assert.match(prompt, /\+3 \| {3}return sum\(v\) \/ v\.length/)
    const [sent] = reminders(h)
    assert.match(sent, /^<system-reminder>\nThe Reviewer read your changes before the person sees them\./)
    assert.match(sent, /- P1 `src\/stats\.ts:3`: Divides by zero for an empty list\. Return 0 when v is empty\./)
    assert.doesNotMatch(sent, /average|No test covers/, 'P3 stays out, and the project has no tests to add to')
    assert.ok(notices(h).includes("The Reviewer found a problem in the agent's changes, so it goes on to fix it."))
    assert.equal(h.client.requests.length, 4, 'once a request')
    assert.equal(h.surface.usages.length, 4, "the Reviewer's call counts toward the request")
  })

  it('asks for tests of the cases none covers when the person asked for tests, the project has tests and the request added none', async () => {
    const answer = JSON.stringify({ summary: 'Right.', findings: [], untested: ['an empty list', 'negative numbers'] })
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: answer }, write(root, 'test/stats.test.ts', 'test()\n'), { text: 'Added tests for both cases.' }],
      shell: passing,
      services: { checks: checksOf([TEST]), changes: async () => [stats] },
      settings: { review: 'on' },
      requests: () => ['add a mean function, with tests'],
    })
    assert.deepEqual(await h.run('add a mean function, with tests'), { kind: 'done', reply: 'Added tests for both cases.' })
    const sent = reminders(h).find((text) => text.includes('Reviewer'))!
    assert.match(sent, /No test covers these cases\. Add tests for them to the project’s tests, and run them:\n- an empty list\n- negative numbers/)
    assert.match(userText(h, 2), /The project's checks after the agent's last change: `npm test` passed\./)
    assert.ok(notices(h).includes('The Reviewer listed cases no test covers, so the agent adds tests for them.'))
  })

  it('asks only for a check of those cases when the person did not ask for tests (ADR 0139)', async () => {
    const answer = JSON.stringify({ summary: 'Right.', findings: [], untested: ['an empty list'] })
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: answer }, { text: 'mean([]) returns 0.' }],
      shell: passing,
      services: { checks: checksOf([TEST]), changes: async () => [stats] },
      settings: { review: 'on' },
      requests: () => ['add a mean function'],
    })
    assert.deepEqual(await h.run('add a mean function'), { kind: 'done', reply: 'mean([]) returns 0.' })
    const sent = reminders(h).find((text) => text.includes('Reviewer'))!
    assert.match(sent, /Check that your change handles each one: read the code, or run it on the case once\. The person did not ask for tests, so add or change none/)
    assert.ok(notices(h).includes('The Reviewer listed cases no test covers, so the agent checks that its change handles them.'))
  })

  it('lets the work through when it finds nothing, and says so', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: '```json\n{"summary": "Fine.", "findings": [], "untested": []}\n```' }],
      services: { changes: async () => [stats] },
      settings: { review: 'on' },
    })
    assert.deepEqual(await h.run('go'), { kind: 'done', reply: 'Added mean().' })
    assert.ok(notices(h).includes('The Reviewer read the changes and found no problem.'))
  })

  it('tells the person when it cannot answer, and lets the work through', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { outcome: { kind: 'paused', reason: 'rate-limit', message: 'The provider is rate limiting you.' } }],
      services: { changes: async () => [stats] },
      settings: { review: 'on' },
    })
    assert.deepEqual(await h.run('go'), { kind: 'done', reply: 'Added mean().' })
    assert.ok(notices(h).includes('The Reviewer could not read the changes: the provider is rate limiting you.'))
    const unread = await loopHarness({
      scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: 'Looks good to me!' }],
      services: { changes: async () => [stats] },
      settings: { review: 'on' },
    })
    assert.deepEqual(await unread.run('go'), { kind: 'done', reply: 'Added mean().' })
    assert.ok(notices(unread).includes("The Reviewer's answer about the changes could not be read."))
  })

  it('on auto, reads the work of a model that needs the full guide, not of a strong one', async () => {
    const run = async (model: string) => {
      const h = await loopHarness({
        scriptFor: (root) => [write(root, 'src/stats.ts', STATS), { text: 'Added mean().' }, { text: '{"findings": []}' }],
        services: { changes: async () => [stats] },
        settings: { review: 'auto' },
        client: { model },
      })
      await h.run('go')
      return h.client.requests.length
    }
    assert.equal(await run('deepseek/deepseek-chat-v3.1'), 3)
    assert.equal(await run('anthropic/claude-sonnet-4.5'), 2)
  })
})

describe("the Reviewer's reading of a plan", () => {
  it('sends the gaps back to the agent before the person sees the plan, once', async () => {
    const h = await loopHarness({
      script: [
        { calls: [{ name: 'ExitPlanMode', input: { plan: '1. Add mean() to src/stats.ts.' } }] },
        { text: '{"gaps": ["It does not say what mean() returns for an empty list."]}' },
        { calls: [{ name: 'ExitPlanMode', input: { plan: '1. Add mean() to src/stats.ts; 0 for an empty list.' } }] },
        { text: 'Starting on it.' },
      ],
      settings: { review: 'on' },
      requests: () => ['plan a mean function'],
    })
    await h.run('plan a mean function', 'plan')
    assert.deepEqual(h.surface.plans, ['1. Add mean() to src/stats.ts; 0 for an empty list.'], 'the person sees only the revised plan')
    const critique = h.client.requests[1]
    assert.deepEqual([critique.role, critique.tool, critique.payload.system[0].text], ['reviewer', 'PlanCritique', PLAN_SYSTEM])
    assert.match(userText(h, 1), /<plan-[0-9a-f]+>\n1\. Add mean\(\) to src\/stats\.ts\.\n<\/plan-/)
    const result = h.client.requests[2].payload.messages.at(-1)!.content.find((block) => block.type === 'tool-result')
    assert.ok(result && result.type === 'tool-result')
    assert.match(JSON.stringify(result.content), /Before the person sees your plan, the Reviewer read it and found gaps:\\n- It does not say what mean\(\) returns for an empty list\./)
    assert.ok(notices(h).includes('The Reviewer found gaps in the plan, so the agent revises it before you see it.'))
    assert.equal(h.client.requests.length, 4)
  })

  it('lets a sound plan through, and stays out when turned off', async () => {
    const sound = await loopHarness({
      script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Do it.' } }] }, { text: '{"gaps": []}' }, { text: 'Starting.' }],
      settings: { review: 'on' },
    })
    await sound.run('plan it', 'plan')
    assert.deepEqual(sound.surface.plans, ['1. Do it.'])
    const off = await loopHarness({ script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Do it.' } }] }, { text: 'Starting.' }], settings: { review: 'off' } })
    await off.run('plan it', 'plan')
    assert.deepEqual(off.surface.plans, ['1. Do it.'])
    assert.equal(off.client.requests.length, 2)
  })
})

describe('the tests the person said to leave alone (ADR 0139)', () => {
  const cart: ChangedText = { path: 'src/cart.js', before: 'total = 0\n', after: 'total = sum\n' }
  const cartTest: ChangedText = { path: 'test/cart.test.js', before: 'expect(3)\n', after: 'expect(4)\n' }

  it('sends the agent back once to put back the test files it changed', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'test/cart.test.js', 'expect(4)\n'), { text: 'The tests pass now.' }, write(root, 'test/cart.test.js', 'expect(3)\n'), { text: 'Put the test back and fixed the sum.' }],
      services: { changes: async () => [cart, cartTest] },
      settings: { review: 'off' },
      requests: () => ['The cart tests fail. Find out why and fix the code, not the tests.'],
    })
    assert.deepEqual(await h.run('The cart tests fail. Find out why and fix the code, not the tests.'), { kind: 'done', reply: 'Put the test back and fixed the sum.' })
    const sent = reminders(h).filter((text) => text.includes('leave the tests alone'))
    assert.equal(sent.length, 1, 'once a request')
    assert.match(sent[0], /this request changed a test file: `test\/cart\.test\.js`\.\nPut each one back exactly as it was before this request/)
    assert.ok(notices(h).includes('The request said to leave the tests alone, so the agent puts back the test files it changed.'))
  })

  it('lets test changes through when the person did not rule them out, or with checks off', async () => {
    const run = async (request: string, settings: Record<string, unknown> = {}) => {
      const h = await loopHarness({
        scriptFor: (root) => [write(root, 'test/cart.test.js', 'expect(4)\n'), { text: 'Done.' }],
        services: { changes: async () => [cart, cartTest] },
        settings: { review: 'off', ...settings },
        requests: () => [request],
      })
      assert.deepEqual(await h.run(request), { kind: 'done', reply: 'Done.' }, request)
    }
    await run('The cart total is wrong; fix it and update the tests.')
    await run('Fix the cart total.')
    await run('Fix the code, not the tests.', { checkGate: 'off' })
  })
})
