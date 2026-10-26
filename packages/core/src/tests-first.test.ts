/**
 * Tests first on bigger work in a project with tests (ADR 0097), through the loop.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { UserMessage } from '@encode/providers'
import { CheckLedger, type ProjectCheck, type ProjectChecks } from './checks'
import { loopHarness, type Harness } from './testing'

const TEST: ProjectCheck = { command: 'pnpm test', kind: 'test', source: 'package.json' }
const TYPECHECK: ProjectCheck = { command: 'pnpm run typecheck', kind: 'typecheck', source: 'package.json' }
const checksOf = (list: ProjectCheck[]): ProjectChecks => ({ list: async () => list, ledger: new CheckLedger() })
const todos = (count: number) => ({ calls: [{ name: 'TodoWrite', input: { todos: Array.from({ length: count }, (_, index) => ({ content: `Step ${index + 1}`, activeForm: `Doing step ${index + 1}`, status: index ? 'pending' : 'in_progress' })) } }] })

function told(h: Harness): string[] {
  return h.conversation
    .messages()
    .filter((message): message is UserMessage => message.role === 'user')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' && block.text.includes('Write the tests first') ? [block.text] : [])))
}

describe('tests first on bigger work', () => {
  it('tells the agent once, when a task list of three steps starts in a project with tests and the person asked for tests', async () => {
    const request = 'add export to csv, with filters, paging and tests'
    const h = await loopHarness({ script: [todos(3), todos(4), { text: 'Done.' }], services: { checks: checksOf([TYPECHECK, TEST]) }, requests: () => [request] })
    await h.run(request)
    const [text] = told(h)
    assert.equal(told(h).length, 1, 'once a request')
    assert.match(text, /^<system-reminder>\nThis is bigger work, and the project has tests \(`pnpm test`\)\. Write the tests first:\n- add or change tests/)
    assert.match(text, /Leave out a part that cannot be tested, and say so in your reply\.\n<\/system-reminder>$/)
  })

  it('tells it when the person approves a plan', async () => {
    const h = await loopHarness({ script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Add the parser.\n2. Wire it.' } }] }, { text: 'Done.' }], services: { checks: checksOf([TEST]) } })
    await h.run('plan the parser', 'plan')
    assert.equal(told(h).length, 1)
  })

  it('stays quiet for small work, a project without tests, a request that already wrote tests, Ask mode, and with checks off', async () => {
    const small = await loopHarness({ script: [todos(2), { text: 'Done.' }], services: { checks: checksOf([TEST]) } })
    await small.run('rename it')
    const untested = await loopHarness({ script: [todos(5), { text: 'Done.' }], services: { checks: checksOf([TYPECHECK]) } })
    await untested.run('big change')
    const written = await loopHarness({
      scriptFor: (root) => [{ calls: [{ name: 'Write', input: { file_path: path.join(root, 'src', 'csv.test.ts'), content: 'test\n' } }] }, todos(3), { text: 'Done.' }],
      services: { checks: checksOf([TEST]) },
    })
    await written.run('add export to csv, tests first')
    const asking = await loopHarness({ script: [todos(3), { text: 'Done.' }], services: { checks: checksOf([TEST]) } })
    await asking.run('how would you do it?', 'ask')
    const off = await loopHarness({ script: [todos(3), { text: 'Done.' }], services: { checks: checksOf([TEST]) }, settings: { checkGate: 'off' } })
    await off.run('big change')
    assert.deepEqual([small, untested, written, asking, off].map((h) => told(h).length), [0, 0, 0, 0, 0])
  })

  it('stays quiet for a task list when the person did not ask for tests, and for a plan when they ruled tests out (ADR 0139)', async () => {
    const listed = await loopHarness({ script: [todos(4), { text: 'Done.' }], services: { checks: checksOf([TEST]) }, requests: () => ['add export to csv'] })
    await listed.run('add export to csv')
    const request = 'The cart tests fail. Plan a fix of the code, not the tests.'
    const planned = await loopHarness({
      script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Fix the total.' } }] }, { text: 'Done.' }],
      services: { checks: checksOf([TEST]) },
      requests: () => [request],
    })
    await planned.run(request, 'plan')
    assert.deepEqual([listed, planned].map((h) => told(h).length), [0, 0])
  })
})
