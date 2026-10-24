import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEntry } from '@shared/types'
import { foldQuery } from '../../find/text'
import { foldedStep, stepsHold, stepText } from './StepRow'
import { logItems } from './turns'
import { logHolds } from './WorkLog'

let counter = 0
function entry(kind: ConversationEntry['kind'], patch: Partial<ConversationEntry> = {}): ConversationEntry {
  counter += 1
  return { id: `e${counter}`, kind, createdAt: counter, ...patch }
}
const tool = (name: string, input: Record<string, unknown>, extra: Partial<NonNullable<ConversationEntry['tool']>> = {}) =>
  entry('tool', { tool: { name, input, state: 'done', ...extra } })

describe("what find reads in a step's row and in its opened body", () => {
  it('reads a command in the row and again with its status and output in the body', () => {
    const text = stepText(tool('Bash', { command: 'npm test' }, { output: 'FAIL src/cache.test.ts\n2 failed' }))
    assert.equal(text.head.trim(), 'Ran npm test')
    assert.equal(text.body, 'npm test\nDone\n\n\nFAIL src/cache.test.ts\n2 failed')
  })

  it('names a step in the tense of its state', () => {
    const head = (name: string, input: Record<string, unknown>, state: NonNullable<ConversationEntry['tool']>['state']) =>
      stepText(tool(name, input, { state })).head.trim()
    assert.equal(head('Write', { file_path: 'a.ts' }, 'waiting'), 'Write a.ts')
    assert.equal(head('Write', { file_path: 'a.ts' }, 'reviewing'), 'Write a.ts')
    assert.equal(head('Write', { file_path: 'a.ts' }, 'running'), 'Writing a.ts')
    assert.equal(head('Write', { file_path: 'a.ts' }, 'done'), 'Wrote a.ts')
    assert.equal(head('Edit', { file_path: 'a.ts' }, 'rejected'), 'Edit a.ts')
    assert.equal(head('Bash', { command: 'npm test' }, 'running'), 'Running npm test')
    assert.equal(head('Bash', { command: 'npm test' }, 'error'), 'Run npm test')
    assert.equal(head('AskUserQuestion', { questions: [{ question: 'Which colour?' }] }, 'waiting'), 'Asking Which colour?')
    assert.equal(head('AskUserQuestion', { questions: [{ question: 'Which colour?' }] }, 'done'), 'Asked Which colour?')
    assert.equal(head('Task', { description: 'look around' }, 'running'), 'Subagent look around')
  })

  it('has no body for a quiet step that shows nothing when opened', () => {
    assert.deepEqual(stepText(tool('Read', { file_path: 'src/app.ts' })), { head: 'Read src/app.ts ', body: '' })
  })

  it('reads the diff lines an edit shows, and what the Reviewer said', () => {
    const edit = tool(
      'Edit',
      { file_path: 'src/cache.ts' },
      {
        diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'del', text: 'const ttl = 5' }, { type: 'add', text: 'const ttl = 60' }] }],
        review: { by: 'reviewer', verdict: 'approved', risk: 'low', reason: 'It changes a constant you named.' },
      },
    )
    const text = stepText(edit)
    assert.match(text.body, /const ttl = 5\nconst ttl = 60/)
    assert.match(text.body, /Approved by the Reviewer \(low risk\): It changes a constant you named\./)
  })

  it('reads what a step was given when it shows nothing else, and not the reason twice for a declined step', () => {
    assert.match(stepText(tool('mcp__db__query', { sql: 'select * from users' })).body, /"sql": "select \* from users"/)
    const declined = tool('Write', { file_path: 'x.txt', content: 'hello' }, { output: 'Declined: not asked for', review: { by: 'reviewer', verdict: 'declined', reason: 'Not asked for.' } })
    const body = stepText(declined).body
    assert.match(body, /Declined by the Reviewer: Not asked for\./)
    assert.doesNotMatch(body, /Declined: not asked for/)
  })

  it('compares folded text, worked out once for each version of a step', () => {
    const step = tool('Bash', { command: 'Make  BUILD' }, { output: 'OK' })
    assert.equal(foldedStep(step), foldedStep(step))
    assert.ok(foldedStep(step).head.includes(foldQuery('make build')))
    assert.ok(stepsHold([step], foldQuery('ok')))
    assert.ok(!stepsHold([step], foldQuery('missing')))
  })
})

describe('what find reads in a folded work log', () => {
  const log = [
    entry('assistant', { text: 'Checking **the cache** first.' }),
    tool('Read', { file_path: 'src/a.ts' }),
    tool('Read', { file_path: 'src/b.ts' }),
    tool('Bash', { command: 'npm run build' }, { output: 'Compiled with 1 warning' }),
    entry('error', { text: 'The model stopped early.' }),
  ]
  const holds = (query: string) => logHolds(logItems(log), foldQuery(query))

  it("finds the agent's notes as shown, the group line, each step's row and what it shows opened", () => {
    assert.ok(holds('the cache first'), 'bold does not hide the words')
    assert.ok(holds('read 2 files'), 'the line two reads fold into')
    assert.ok(holds('src/b.ts'))
    assert.ok(holds('1 WARNING'))
    assert.ok(holds('stopped early'))
    assert.ok(!holds('deploy'))
  })
})
