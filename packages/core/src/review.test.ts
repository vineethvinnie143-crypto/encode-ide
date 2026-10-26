/**
 * What the Reviewer is given and what eNCode takes from its answer (ADR 0096); the loop's part is review-gate.test.ts.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelClient } from '@encode/providers'
import { askReviewer, changeInput, completionPrompt, completionReminder, numberedChange, parseCompletion, parseGaps, planReminder, reviewWanted, testsKeptReminder, testsWanted } from './review'

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
    const text = completionReminder({ summary: '', findings: [finding('P1', 3), finding('P2', 4), finding('P3', 5)], untested: ['an empty list'] }, { tests: true, wanted: 'asked' })
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
        'Fix what holds up, within what the person asked for and ruled out, then finish. If a finding is wrong, say why in your reply.',
      ].join('\n'),
    )
  })

  it('asks for tests of the untested cases only when the person asked for tests, and otherwise a check of them', () => {
    const review = { summary: '', findings: [], untested: ['an empty list'] }
    const unsaid = completionReminder(review, { tests: true })!
    assert.match(unsaid, /No test covers these cases\. Check that your change handles each one: read the code, or run it on the case once\. The person did not ask for tests, so add or change none; name one worth adding in your reply instead:\n- an empty list/)
    assert.doesNotMatch(unsaid, /Add tests/)
    const ruledOut = completionReminder(review, { tests: true, wanted: 'ruled-out' })!
    assert.match(ruledOut, /The person said to leave the tests alone, so change no test file:\n- an empty list/)
  })

  it('reads from the requests whether the person asked for tests or ruled out changing them', () => {
    const ruledOut = [
      'The cart tests fail. Find out why and fix the code, not the tests.',
      'The "drops punctuation" test in test/slug.test.js fails. Fix slug so that it passes.',
      "Make the build green, but don't touch the tests.",
      'Fix the parser without changing any of the existing tests.',
      'Leave the unit tests as they are and fix the date bug.',
      'The tests must stay unchanged; the bug is in the code.',
      'node --test fails on the cart spec. Fix the code so the tests pass.',
    ]
    const asked = ['Add a mean function, with tests.', 'Write unit tests for the parser.', 'Add export to csv, with filters, paging and tests.', 'Fix the failing test in test/a.test.js, its expectation is out of date.', 'The login test fails because the fixture is stale. Fix the test so it passes.', 'Do it test-first.']
    const unsaid = [
      'Inventory.remove in inventory.py lets the stock go below zero. It must raise ValueError when there is not enough stock.',
      'Rename getUserName to getDisplayName everywhere in the project.',
      'Run the tests and tell me what fails.',
      'This is not a test of the system, just a question: where is the session timeout set?',
    ]
    for (const request of ruledOut) assert.equal(testsWanted([request]), 'ruled-out', request)
    for (const request of asked) assert.equal(testsWanted([request]), 'asked', request)
    for (const request of unsaid) assert.equal(testsWanted([request]), 'unsaid', request)
    assert.equal(testsWanted([]), 'unsaid')
    assert.equal(testsWanted(['Fix the code, not the tests.', 'Also handle a negative quantity.']), 'ruled-out', 'an earlier rule holds')
    assert.equal(testsWanted(['Fix the code, not the tests.', 'Now add tests for the negative case.']), 'asked', 'the latest request decides')
    assert.equal(testsWanted(['Fix the code, not the tests.', 'a', 'b', 'c']), 'unsaid', 'only the last three requests count')
  })

  it('names the test files to put back', () => {
    assert.equal(
      testsKeptReminder(['test/cart.test.js']),
      [
        'The person said to leave the tests alone, but this request changed a test file: `test/cart.test.js`.',
        'Put each one back exactly as it was before this request: undo your edits to it, and delete a test file you added.',
        'Then make the code pass the tests as they were, and run them. If you think a test itself is wrong, say why in your reply instead of changing it.',
      ].join('\n'),
    )
    assert.match(testsKeptReminder(['a', 'b', 'c', 'd', 'e', 'f', 'g']), /changed test files: `a`, `b`, `c`, `d`, `e` and 2 more\./)
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

describe('a call to the Reviewer', () => {
  it('says the Reviewer was still at work when its time ran out, apart from other failures', async () => {
    const waits: ModelClient = {
      budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }),
      complete: (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        }),
    }
    const call = { system: 's', prompt: 'p', tool: 'CompletionReview', signal: new AbortController().signal }
    assert.deepEqual(await askReviewer(waits, { ...call, timeoutMs: 20 }), { ok: false, why: 'it was still at work after 1 second', late: true })
    const fails: ModelClient = { ...waits, complete: async () => Promise.reject(new Error('The connection dropped.')) }
    assert.deepEqual(await askReviewer(fails, { ...call, timeoutMs: 4 * 60_000 }), { ok: false, why: 'The connection dropped.' })
  })
})
