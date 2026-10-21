import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { Message, ToolResultBlock, UserMessage } from '@encode/providers'
import { textBlock, userText } from '@encode/providers'
import type { Tool, ToolKind } from '@encode/tools'
import { isPaired, NOT_RUN } from './compaction'
import { CONTINUE_AFTER_LENGTH } from './prompt'
import { loopHarness, type Harness } from './testing'
import { AgentAbortedError } from './types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The tool results the user messages of a conversation carry, as text. */
function resultsOf(messages: readonly Message[]): { id: string; text: string; error: boolean }[] {
  const out: { id: string; text: string; error: boolean }[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        out.push({ id: block.toolUseId, text: block.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n'), error: Boolean(block.isError) })
      }
    }
  }
  return out
}

function lastResults(h: Harness): ToolResultBlock[] {
  const last = h.conversation.messages().at(-1) as UserMessage
  return last.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
}

describe('a turn', () => {
  it('ends with a reply when the model calls no tool, and shows it', async () => {
    const h = await loopHarness({ script: [{ text: 'Hello there.' }] })
    assert.deepEqual(await h.run('hi'), { kind: 'done', reply: 'Hello there.' })
    assert.equal(h.conversation.messages().length, 2)
    assert.deepEqual(h.surface.settled.map((entry) => [entry.kind, entry.text, entry.streaming]), [['assistant', 'Hello there.', false]])
    assert.equal(h.surface.usages.length, 1)
    assert.equal(h.surface.statuses[0], 'thinking')
  })

  it('runs a tool, feeds the result back and carries on until the model is done', async () => {
    const h = await loopHarness({
      files: { 'a.txt': 'alpha\nbeta\n' },
      scriptFor: (root) => [{ text: 'Reading it.', calls: [{ name: 'Read', input: { file_path: path.join(root, 'a.txt') } }] }, { text: 'It starts with alpha.' }],
    })
    const end = await h.run('what is in a.txt?')
    assert.deepEqual(end, { kind: 'done', reply: 'It starts with alpha.' })
    assert.deepEqual(h.surface.tools().map((tool) => [tool.name, tool.state]), [['Read', 'done']])
    const [result] = resultsOf(h.conversation.messages())
    assert.match(result.text, /1\talpha\n\s+2\tbeta/)
    assert.ok(isPaired(h.conversation.messages()))
    assert.equal(h.client.requests.length, 2)
    assert.equal(h.client.requests[1].payload.messages.length, 3, 'the second request carries the call and its result')
  })

  it('stops after the step limit and leaves a valid conversation', async () => {
    const h = await loopHarness({ script: [{ calls: [{ name: 'Glob', input: { pattern: '*' } }] }], maxSteps: 3 })
    assert.deepEqual(await h.run('loop'), { kind: 'max-steps', steps: 3 })
    assert.ok(isPaired(h.conversation.messages()))
    assert.equal(h.client.requests.length, 3)
  })

  it('reports a pause when no model can run', async () => {
    const h = await loopHarness({ script: [{ outcome: { kind: 'paused', reason: 'quota', message: 'Out of credit.' } }] })
    assert.deepEqual(await h.run('go'), { kind: 'paused', reason: 'quota', message: 'Out of credit.' })
  })

  it('asks again after an empty reply, and gives up after a few', async () => {
    const recovered = await loopHarness({ script: [{}, { text: 'fine' }] })
    assert.deepEqual(await recovered.run('go'), { kind: 'done', reply: 'fine' })
    const hopeless = await loopHarness({ script: [{}] })
    const end = await hopeless.run('go')
    assert.equal(end.kind, 'failed')
    assert.match(end.kind === 'failed' ? end.message : '', /empty response/)
  })

  it('continues a reply the output limit cut off', async () => {
    const h = await loopHarness({ script: [{ text: 'The first half', finish: 'length' }, { text: ' and the rest.' }] })
    assert.deepEqual(await h.run('write'), { kind: 'done', reply: ' and the rest.' })
    const texts = h.conversation.messages().map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    assert.equal(texts[2], CONTINUE_AFTER_LENGTH)
  })

  it('ends on a tool that says so, answering the calls it skipped', async () => {
    const h = await loopHarness({
      completion: true,
      script: [{ calls: [{ name: 'attempt_completion', input: { result: 'All done.' } }, { name: 'Glob', input: { pattern: '*' } }] }],
    })
    assert.deepEqual(await h.run('finish'), { kind: 'stopped', summary: 'All done.' })
    const results = lastResults(h)
    assert.equal(results.length, 2)
    assert.equal((results[1].content[0] as { text: string }).text, NOT_RUN)
    assert.deepEqual(h.surface.settled.filter((entry) => entry.kind === 'assistant').map((entry) => entry.text), ['All done.'])
  })
})

describe('tool calls', () => {
  it('answer calls that are unknown, invalid, cut off or not offered in the mode', async () => {
    const h = await loopHarness({
      script: [
        {
          calls: [
            { name: 'Nope', input: {} },
            { name: 'Read', input: {} },
            { name: 'Glob', input: {}, invalid: { raw: '{"pattern":', error: 'The arguments are not valid JSON (Unexpected end).' } },
            { name: 'Write', input: { file_path: '/x', content: 'y' } },
          ],
        },
        { text: 'ok' },
      ],
    })
    await h.run('try things', 'plan')
    const results = resultsOf(h.conversation.messages())
    assert.match(results[0].text, /There is no tool called Nope\. Available tools: /)
    assert.match(results[1].text, /Invalid input for Read: /)
    assert.equal(results[2].text, 'Not run: The arguments are not valid JSON (Unexpected end). Call Glob again with its arguments as one JSON object.')
    assert.equal(results[3].text, 'Write is not available in plan mode.')
    assert.ok(results.every((result) => result.error))
    assert.deepEqual(h.surface.tools().map((tool) => tool.state), ['error', 'error', 'error', 'error'])
  })

  it('run calls that only read together, and everything else in order', async () => {
    const log: string[] = []
    const probe = (name: string, kind: ToolKind, readOnly: boolean, delay: number): Tool => ({
      definition: { name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      kind,
      readOnly,
      modes: ['code'],
      access: () => ({ type: 'none' }),
      describe: () => ({ title: name }),
      async run() {
        log.push(`start ${name}`)
        await sleep(delay)
        log.push(`end ${name}`)
        return { ok: true, content: name }
      },
    })
    const h = await loopHarness({
      extraTools: [probe('ReadA', 'read', true, 40), probe('ReadB', 'read', true, 10), probe('Change', 'write', false, 5), probe('ReadC', 'read', true, 5)],
      script: [{ calls: ['ReadA', 'ReadB', 'Change', 'ReadC'].map((name) => ({ name, input: {} })) }, { text: 'done' }],
    })
    await h.run('go')
    assert.deepEqual(log.slice(0, 2).sort(), ['start ReadA', 'start ReadB'])
    assert.deepEqual(log.slice(2, 4).sort(), ['end ReadA', 'end ReadB'], 'both reads finish before the change starts')
    assert.deepEqual(log.slice(4), ['start Change', 'end Change', 'start ReadC', 'end ReadC'])
    assert.deepEqual(resultsOf(h.conversation.messages()).map((result) => result.text), ['ReadA', 'ReadB', 'Change', 'ReadC'], 'results keep the order of the calls')
  })

  it('report changed files relative to the workspace', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [{ calls: [{ name: 'Write', input: { file_path: path.join(root, 'src', 'new.ts'), content: 'export {}\n' } }] }, { text: 'done' }],
    })
    await h.run('make a file')
    assert.deepEqual(h.surface.changes, ['src/new.ts'])
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'new.ts'), 'utf8'), 'export {}\n')
  })

  it('publish todos, ask questions and move to code mode when a plan is approved', async () => {
    const h = await loopHarness({
      scriptFor: (root) => [
        { calls: [{ name: 'TodoWrite', input: { todos: [{ content: 'Do it', activeForm: 'Doing it', status: 'in_progress' }] } }] },
        { calls: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } }] },
        { calls: [{ name: 'ExitPlanMode', input: { plan: '1. write the file' } }] },
        { calls: [{ name: 'Write', input: { file_path: path.join(root, 'planned.txt'), content: 'ok' } }] },
        { text: 'done' },
      ],
    })
    h.surface.answer = () => 'B'
    assert.deepEqual(await h.run('plan then do', 'plan'), { kind: 'done', reply: 'done' })
    assert.equal(h.surface.todos[0].content, 'Do it')
    assert.equal(h.surface.questions[0].question, 'Which?')
    assert.deepEqual(h.surface.plans, ['1. write the file'])
    assert.equal(await fs.readFile(path.join(h.root, 'planned.txt'), 'utf8'), 'ok', 'the approved plan switched the turn to code mode')
  })

  it('stop the turn when the plan is left for the user to answer later', async () => {
    const h = await loopHarness({ script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. think' } }] }] })
    h.surface.verdict = { approved: false, deferred: true }
    assert.deepEqual(await h.run('plan', 'plan'), { kind: 'stopped', summary: 'Plan proposed.' })
  })
})

describe('approvals', () => {
  const write = (root: string, file: string) => ({ name: 'Write', input: { file_path: path.join(root, file), content: 'x' } })

  it('let edits inside the workspace through, and ask for protected folders', async () => {
    const h = await loopHarness({ scriptFor: (root) => [{ calls: [write(root, 'ok.txt'), write(root, '.git/hooks/pre-commit')] }, { text: 'done' }] })
    h.surface.decide = () => false
    await h.run('write')
    assert.equal(h.surface.approvals.length, 1)
    assert.match(h.surface.approvals[0].reason ?? '', /protected folder/)
    assert.equal(h.surface.approvals[0].title, 'Write .git/hooks/pre-commit')
    assert.equal(await fs.readFile(path.join(h.root, 'ok.txt'), 'utf8'), 'x')
    await assert.rejects(fs.stat(path.join(h.root, '.git', 'hooks', 'pre-commit')))
    const results = resultsOf(h.conversation.messages())
    assert.match(results[1].text, /The user rejected this action\. Do not retry it unchanged/)
    assert.deepEqual(h.surface.tools().map((tool) => [tool.state, tool.output]), [['done', h.surface.tools()[0].output], ['rejected', 'Rejected by user.']])
  })

  it('run a call the user approves', async () => {
    const h = await loopHarness({ scriptFor: (root) => [{ calls: [write(root, '.encode/skills/x.md')] }, { text: 'done' }] })
    await h.run('write')
    assert.equal(h.surface.approvals.length, 1)
    assert.equal(await fs.readFile(path.join(h.root, '.encode', 'skills', 'x.md'), 'utf8'), 'x')
  })

  it('refuse edits under the Read Only policy, and say why', async () => {
    const h = await loopHarness({ settings: { policy: 'read-only' }, scriptFor: (root) => [{ calls: [write(root, 'no.txt')] }, { text: 'done' }] })
    await h.run('write')
    assert.equal(h.surface.approvals.length, 0)
    assert.match(resultsOf(h.conversation.messages())[0].text, /Refused by the approval policy: The approval policy is Read Only/)
    assert.equal(h.surface.tools()[0].state, 'rejected')
  })

  it('stop the run, answering every call, when the user stops during an approval', async () => {
    const controller = new AbortController()
    const h = await loopHarness({ scriptFor: (root) => [{ calls: [write(root, '.git/config'), { name: 'Glob', input: { pattern: '*' } }] }] })
    h.surface.decide = () => {
      controller.abort()
      return false
    }
    await assert.rejects(h.run('write', 'code', controller.signal), AgentAbortedError)
    assert.ok(isPaired(h.conversation.messages()))
    assert.deepEqual(lastResults(h).map((result) => (result.content[0] as { text: string }).text), [NOT_RUN, NOT_RUN])
    assert.deepEqual(h.surface.tools().map((tool) => [tool.state, tool.output]), [['rejected', 'Stopped.']])
  })
})

describe('hooks', () => {
  it('can refuse a call, rewrite its input, or fail closed', async () => {
    const calls: string[] = []
    const h = await loopHarness({
      hooks: {
        async preToolUse(event) {
          calls.push(event.tool)
          const file = String(event.input.file_path ?? '')
          if (file.endsWith('deny.txt')) return { decision: 'deny', reason: 'no writes today' }
          if (file.endsWith('rewrite.txt')) return { input: { ...event.input, content: 'rewritten' } }
          if (file.endsWith('throws.txt')) throw new Error('hook crashed')
        },
      },
      scriptFor: (root) => [
        { calls: ['deny.txt', 'rewrite.txt', 'throws.txt'].map((file) => ({ name: 'Write', input: { file_path: path.join(root, file), content: 'original' } })) },
        { text: 'done' },
      ],
    })
    await h.run('write')
    const results = resultsOf(h.conversation.messages())
    assert.equal(results[0].text, 'A hook refused this call: no writes today')
    assert.match(results[2].text, /A preToolUse hook failed \(hook crashed\), so the call was not run\./)
    assert.equal(await fs.readFile(path.join(h.root, 'rewrite.txt'), 'utf8'), 'rewritten')
    await assert.rejects(fs.stat(path.join(h.root, 'deny.txt')))
  })

  it('can make a call ask even where the policy would allow it, and skip a question the policy would ask', async () => {
    const h = await loopHarness({
      hooks: {
        async preToolUse(event) {
          const file = String(event.input.file_path ?? '')
          if (file.endsWith('careful.txt')) return { decision: 'ask', reason: 'a hook wants a look' }
          if (file.endsWith('config')) return { decision: 'allow' }
        },
      },
      scriptFor: (root) => [{ calls: [{ name: 'Write', input: { file_path: path.join(root, 'careful.txt'), content: 'x' } }, { name: 'Write', input: { file_path: path.join(root, '.git', 'config'), content: 'x' } }] }, { text: 'done' }],
    })
    await h.run('write')
    assert.deepEqual(h.surface.approvals.map((prompt) => prompt.reason), ['a hook wants a look'])
  })

  it('add context after a call, and can send the agent back instead of letting it stop', async () => {
    let stops = 0
    const h = await loopHarness({
      hooks: {
        async postToolUse() {
          return { context: 'Remember the changelog.' }
        },
        async beforeStop(event) {
          stops++
          return event.continued ? {} : { continue: 'Run the tests first.' }
        },
      },
      script: [{ calls: [{ name: 'Glob', input: { pattern: '*' } }] }, { text: 'finished' }, { text: 'really finished' }],
    })
    assert.deepEqual(await h.run('go'), { kind: 'done', reply: 'really finished' })
    assert.equal(stops, 2)
    const messages = h.conversation.messages()
    const resultMessage = messages[2] as UserMessage
    assert.equal((resultMessage.content.at(-1) as { text: string }).text, '<system-reminder>\nRemember the changelog.\n</system-reminder>')
    assert.deepEqual((messages[4] as UserMessage).content[0], { type: 'text', text: 'Run the tests first.' })
  })

  it('can reject a result', async () => {
    const h = await loopHarness({
      hooks: { async postToolUse() { return { block: 'lint failed' } } },
      script: [{ calls: [{ name: 'Glob', input: { pattern: '*' } }] }, { text: 'done' }],
    })
    await h.run('go')
    const [result] = resultsOf(h.conversation.messages())
    assert.ok(result.error)
    assert.match(result.text, /A hook did not accept this result: lint failed/)
  })
})

describe('the context window', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of the file`).join('\n')

  it('summarizes the oldest messages when the prompt outgrows the window, and goes on', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    let reads = 0
    const h = await loopHarness({
      files: { 'a.txt': lines(1000), 'b.txt': lines(1000), 'c.txt': lines(1000), 'd.txt': lines(1000) },
      client: { contextWindow: 20_000, maxOutputTokens: 1_000 },
      script: (request) => {
        if (request.role === 'summarizer') return { text: 'SUMMARY OF EARLIER WORK' }
        const next = files[reads++]
        return next ? { calls: [{ name: 'Read', input: { file_path: path.join(h.root, next) } }] } : { text: 'all read' }
      },
    })
    assert.deepEqual(await h.run('read everything'), { kind: 'done', reply: 'all read' })
    assert.ok(h.client.requests.some((request) => request.role === 'summarizer'))
    assert.ok(h.surface.notices().some((notice) => /^Compacted \d+ earlier messages? into a summary/.test(notice)))
    const first = h.conversation.messages()[0]
    assert.match(first.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'), /SUMMARY OF EARLIER WORK/)
    assert.ok(isPaired(h.conversation.messages()))
  })

  it('compacts and tries again when the provider says the prompt does not fit', async () => {
    const h = await loopHarness({
      script: (request, step) => {
        if (request.role === 'summarizer') return { text: 'SUMMARY' }
        return step === 0 ? { outcome: { kind: 'compact', window: 4_000, used: 9_000 } } : { text: 'ok' }
      },
    })
    for (let i = 0; i < 6; i++) {
      await h.conversation.add(userText(`question ${i} ${'x'.repeat(2_000)}`), { turnId: `t${i}` })
      await h.conversation.add({ role: 'assistant', content: [textBlock(`answer ${i} ${'y'.repeat(2_000)}`)] }, { turnId: `t${i}` })
    }
    assert.deepEqual(await h.run('and now?'), { kind: 'done', reply: 'ok' })
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'summarizer', 'main'])
    assert.ok(h.conversation.messages().length < 14)
    assert.ok(isPaired(h.conversation.messages()))
  })

  it('gives up when compacting cannot make the prompt fit', async () => {
    const h = await loopHarness({ script: [{ outcome: { kind: 'compact', window: 100 } }] })
    const end = await h.run('go')
    assert.equal(end.kind, 'failed')
    assert.match(end.kind === 'failed' ? end.message : '', /does not fit the model's context window/)
  })

  it('compacts on request, keeping only the latest messages, with the user\'s instructions for the summary', async () => {
    const h = await loopHarness({ script: (request) => (request.role === 'summarizer' ? { text: 'MANUAL SUMMARY' } : { text: 'ok' }) })
    for (let i = 0; i < 4; i++) {
      await h.conversation.add(userText(`question ${i}`), { turnId: `t${i}` })
      await h.conversation.add({ role: 'assistant', content: [textBlock(`answer ${i}`)] }, { turnId: `t${i}` })
    }
    const result = await h.loop.compact({ signal: new AbortController().signal, turnId: 't9', instructions: 'keep the file names' })
    assert.ok(result.removed > 0)
    const request = h.client.requests[0]
    assert.equal(request.role, 'summarizer')
    assert.match((request.payload.messages[0].content[0] as { text: string }).text, /keep the file names/)
    assert.match((h.conversation.messages()[0].content[0] as { text: string }).text, /MANUAL SUMMARY/)
  })
})
