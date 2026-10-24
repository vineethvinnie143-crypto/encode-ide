/**
 * What the Reviewer is given and what eNCode takes from its answer (ADR 0096); the loop's part is review-gate.test.ts.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelClient } from '@encode/providers'
import { changeInput, completionPrompt, completionReminder, numberedChange, parseCompletion, parseGaps, planReminder, reviewWanted } from './review'

describe('the change the Reviewer reads', () => {
  it('numbers a new file, an edit and a deleted file by the lines they have, with no line after the last newline', () => {
    assert.equal(numberedChange(null, 'a\nb\nc\n'), '@@ -0,0 +1,3 @@\n+1 | a\n+2 | b\n+3 | c')
    assert.equal(numberedChange('a\nb\n', 'a\nB\n'), '@@ -1,2 +1,2 @@\n 1 | a\n-2 | b\n+2 | B')
    assert.equal(numberedChange('a\r\nb\r\n', null), '@@ -1,2 +0,0 @@\n-1 | a\n-2 | b')
    assert.equal(numberedChange('', null), '')
    assert.equal(numberedChange('same\n', 'same\n'), '')
  })

  it('hides keys and cuts long lines', () => {
    const key = ['sk', 'or', 'v1', 'f3a9c1d27b6e48a0b5c9d3e1f7a2b4c6d8e0f1a3b5c7d9e2'].join('-')
    const text = numberedChange(null, `const apiKey = '${key}'\n${'x'.repeat(1_000)}\n`)
    assert.ok(!text.includes(key.slice(12)), 'the key is not sent')
    assert.ok(text.split('\n')[2].length < 420, 'a long line is cut')
  })

  it('names lock files and files it cannot show, and counts those past the budget', () => {
    const input = changeInput(
      [
        { path: 'pnpm-lock.yaml', before: 'a\n', after: 'b\n' },
        { path: 'logo.png', before: '', after: null, note: 'binary file: not shown' },
        { path: 'src/a.ts', before: null, after: 'export const a = 1\n' },
        { path: 'src/big.ts', before: null, after: `${'y'.repeat(300)}\n`.repeat(10) },
      ],
      200,
    )
    assert.deepEqual(
      input.files.map((file) => [file.path, file.change, file.text.startsWith('(') ? file.text : 'lines']),
      [
        ['pnpm-lock.yaml', 'modified', '(generated or lock file: not reviewed)'],
        ['logo.png', 'deleted', '(binary file: not shown)'],
        ['src/a.ts', 'added', 'lines'],
      ],
    )
    assert.equal(input.left, 1)
  })

  it('fences the requests, the reply, the checks and the scan as data', () => {
    const prompt = completionPrompt(
      {
        requests: ['first', 'second', 'third', 'Add an average'],
        reply: 'Added it.',
        input: changeInput([{ path: 'src/a.ts', before: null, after: 'x\n' }]),
        checks: "The project's checks after the agent's last change: `npm test` passed.",
        scan: [{ rule: 'eval', file: 'src/a.ts', line: 1, code: 'eval(x)', message: 'runs text as code' }],
      },
      'abc123',
    )
    assert.match(prompt, /<requests-abc123>\n1\. second\n2\. third\n3\. Add an average\n<\/requests-abc123>/)
    assert.match(prompt, /<reply-abc123>\nAdded it\.\n<\/reply-abc123>/)
    assert.match(prompt, /`npm test` passed\./)
    assert.match(prompt, /eNCode's scan of the added lines noted:\n- `src\/a\.ts:1`/)
    assert.match(prompt, /<file path="src\/a\.ts" change="added">\n@@ -0,0 \+1,1 @@\n\+1 \| x/)
  })
})

describe("the Reviewer's answer", () => {
  const answer = (value: unknown) => `Here it is.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

  it('keeps findings on the files it was given and at most five untested cases, each on one line', () => {
    const review = parseCompletion(
      answer({
        summary: 'Mostly right.',
        findings: [
          { file: 'src/a.ts', line: 2, priority: 'P1', title: 'Divides by zero', body: 'Return early.' },
          { file: 'src/other.ts', line: 1, priority: 'P0', title: 'Not in the change', body: '' },
        ],
        untested: ['an empty list', 'zero\n\u0007and more', 3, 'a', 'b', 'c', 'd'],
      }),
      ['src/a.ts'],
    )
    assert.deepEqual(review.findings.map((finding) => `${finding.priority} ${finding.path}:${finding.line}`), ['P1 src/a.ts:2'])
    assert.deepEqual(review.untested, ['an empty list', 'zero and more', 'a', 'b', 'c'])
    assert.throws(() => parseCompletion('I could not review this.', ['src/a.ts']))
  })

  it('sends back P0 and P1 with the P2s beside them, and the untested cases only where the project has tests', () => {
    const finding = (priority: 'P0' | 'P1' | 'P2' | 'P3', line: number) => ({ path: 'src/a.ts', side: 'new' as const, line, priority, title: `${priority} title`, body: 'Body.' })
    assert.equal(completionReminder({ summary: '', findings: [finding('P2', 1), finding('P3', 2)], untested: [] }, { tests: true }), null)
    assert.equal(completionReminder({ summary: '', findings: [], untested: ['an empty list'] }, { tests: false }), null)
    const text = completionReminder({ summary: '', findings: [finding('P1', 3), finding('P2', 4), finding('P3', 5)], untested: ['an empty list'] }, { tests: true })
    assert.equal(
      text,
      [
        'The Reviewer read your changes before the person sees them. It saw only the change, so read the code before you act on what it says.',
        'It found:',
        '- P1 `src/a.ts:3`: P1 title. Body.',
        'Also worth a look:',
        '- P2 `src/a.ts:4`: P2 title. Body.',
        'No test covers these cases. Add tests for them to the project’s tests, and run them:',
        '- an empty list',
        'Fix what holds up, then finish. If a finding is wrong, say why in your reply.',
      ].join('\n'),
    )
  })

  it("reads a plan's gaps, and nothing from an answer without them", () => {
    assert.deepEqual(parseGaps(answer({ gaps: ['No check for an empty cart', 7, '', 'b', 'c', 'd', 'e', 'f'] })), ['No check for an empty cart', 'b', 'c', 'd', 'e'])
    assert.deepEqual(parseGaps('{"gaps": []}'), [])
    assert.equal(parseGaps('The plan looks fine.'), undefined)
    assert.match(planReminder(['No check for an empty cart']), /^Before the person sees your plan, the Reviewer read it and found gaps:\n- No check for an empty cart\nRevise the plan/)
  })
})

describe('whether the Reviewer reads the work', () => {
  const client = (main: string, reviewer: string, fails = false) =>
    ({
      budget: async (role: string) => {
        if (fails) throw new Error('no model')
        return { model: role === 'reviewer' ? reviewer : main }
      },
    }) as unknown as ModelClient

  it('asks for a model that needs the full guide, or a Review role with a model of its own, unless set', async () => {
    assert.equal(await reviewWanted('auto', client('deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-chat-v3.1'), {}), true)
    assert.equal(await reviewWanted(undefined, client('anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5'), {}), false)
    assert.equal(await reviewWanted('auto', client('anthropic/claude-sonnet-4.5', 'openai/gpt-5'), {}), true)
    assert.equal(await reviewWanted('on', client('anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5'), {}), true)
    assert.equal(await reviewWanted('off', client('deepseek/deepseek-chat-v3.1', 'openai/gpt-5'), {}), false)
    assert.equal(await reviewWanted('auto', client('', '', true), {}), false)
  })
})
