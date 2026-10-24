/**
 * Help for smaller models and a stronger model after two setbacks (ADR 0100): the rules, and through the loop.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { Message, ModelBudget, ModelRole, UserMessage } from '@encode/providers'
import type { AgentShell } from '@encode/tools'
import { CheckLedger } from './checks'
import { helpsSmaller, saidWhatChanges, Setbacks, SMALLER_MODEL_PART, SMALLER_MODEL_TEXT, strongerPrompt, THINK_FIRST } from './smaller'
import { loopHarness, stubShell, type Harness } from './testing'

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })
const said = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
const PLAN = 'I will change src/a.ts: the parser returns null for an empty line instead of throwing. Then I run the tests.'

/** Every tool result the model was sent, in order. */
function results(h: Harness): string[] {
  return h.conversation
    .messages()
    .filter((message): message is UserMessage => message.role === 'user')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'tool-result' ? [block.content.map((part) => (part.type === 'text' ? part.text : '')).join('')] : [])))
}

/** The text of every reminder the model was sent. */
function reminders(h: Harness): string[] {
  return h.conversation
    .messages()
    .filter((message): message is UserMessage => message.role === 'user')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' && block.text.startsWith('<system-reminder>') ? [block.text] : [])))
}

describe('help for smaller models', () => {
  it('is for every model but the strong ones, unless the person turned it off', () => {
    assert.ok(helpsSmaller(undefined, 'deepseek/deepseek-chat'))
    assert.ok(helpsSmaller('auto', 'qwen/qwen3-coder'))
    assert.ok(!helpsSmaller('auto', 'anthropic/claude-sonnet-4.5'))
    assert.ok(!helpsSmaller('auto', 'gpt-5'))
    assert.ok(!helpsSmaller('off', 'deepseek/deepseek-chat'))
    assert.match(SMALLER_MODEL_TEXT, /^[\x20-\x7e\n]+$/, 'plain ASCII')
    assert.ok(SMALLER_MODEL_TEXT.length < 700, `${SMALLER_MODEL_TEXT.length} characters on every step of a smaller model`)
  })

  it('counts a plan said in the reply, or reasoning, since the request began', () => {
    assert.ok(!saidWhatChanges([user('fix it'), said('On it.')]))
    assert.ok(saidWhatChanges([user('fix it'), said(PLAN)]))
    assert.ok(!saidWhatChanges([user('first'), said(PLAN), user('now fix the other one'), said('Sure.')]), 'only the current request counts')
    assert.ok(saidWhatChanges([user('fix it'), { role: 'assistant', content: [{ type: 'thinking', text: 'The parser throws on an empty line; returning null there and testing it should do.' }] }]))
    assert.ok(saidWhatChanges([user('fix it'), { role: 'assistant', content: [{ type: 'thinking', text: '', details: [{ type: 'reasoning.encrypted', data: 'xyz' }] }] }]), 'encrypted reasoning')
    assert.ok(saidWhatChanges([user('fix it'), { role: 'assistant', content: [{ type: 'redacted-thinking', data: 'xyz' }] }]))
  })

  it('counts setbacks: a send-back, the same call failing twice, a second failed change to one file', () => {
    const setbacks = new Setbacks()
    setbacks.call('Edit', { file_path: '/p/a.ts', old_string: 'x' }, 'No match.')
    assert.equal(setbacks.count, 0)
    setbacks.call('Edit', { file_path: '/p/a.ts', old_string: 'x' }, 'No match.')
    assert.equal(setbacks.count, 1, 'the same call, the same error')
    setbacks.call('Edit', { file_path: '/p/a.ts', old_string: 'x' }, 'No match.')
    assert.equal(setbacks.count, 1, 'counted once')
    setbacks.call('Edit', { file_path: '/p/b.ts', old_string: 'y' }, 'No match.')
    setbacks.call('Edit', { file_path: '/p/b.ts', old_string: 'z' }, 'Not unique.')
    assert.equal(setbacks.count, 2, 'two failed changes to one file')
    setbacks.call('Bash', { command: 'pnpm test' }, '1 failing')
    setbacks.call('Bash', { command: 'pnpm test' }, undefined)
    setbacks.call('Bash', { command: 'pnpm test' }, '1 failing')
    assert.equal(setbacks.count, 2, 'a call that worked in between starts again')
    setbacks.sentBack('checks')
    assert.deepEqual(setbacks.reasons, ['the same `Edit` call failed twice', '`Edit` failed twice on b.ts', "the project's checks failed after its changes"])
    setbacks.clear()
    assert.equal(setbacks.count, 0)
  })

  it('asks with what the stronger model costs next to the one in use', () => {
    const to: ModelBudget = { model: 'anthropic/claude-sonnet-4.5', contextWindow: 1_000_000, maxOutputTokens: 64_000, price: { input: 3, output: 15 }, free: false }
    const prompt = strongerPrompt({ from: 'deepseek/deepseek-chat', to, role: 'planner', reasons: ["the project's checks failed after its changes", 'the same `Edit` call failed twice'], price: { input: 0.28, output: 0.42 } })
    assert.equal(prompt.title, 'Let claude-sonnet-4.5 take over this request?')
    assert.equal(
      prompt.detail,
      "deepseek-chat ran into trouble twice in this request: the project's checks failed after its changes; and the same `Edit` call failed twice. claude-sonnet-4.5, the model of your Plan role, would do the rest of it. The next request goes back to deepseek-chat. It costs $3.00 per million tokens read and $15.00 written, against $0.28 and $0.42 for deepseek-chat.",
    )
    assert.match(strongerPrompt({ from: 'm', to: { ...to, price: undefined }, role: 'reviewer', reasons: [] }).detail, /your Review role.*It may cost more per token\.$/)
  })
})

describe('think before edit', () => {
  const write = (root: string, text?: string) => ({ ...(text ? { text } : {}), calls: [{ name: 'Write', input: { file_path: path.join(root, 'src', 'a.ts'), content: 'export const a = 1\n' } }] })

  it("holds a smaller model's first change until it says what will change, once a request", async () => {
    const h = await loopHarness({
      scriptFor: (root) => [write(root), write(root, PLAN), write(root), { text: 'Done.' }],
      client: { model: 'deepseek/deepseek-chat' },
      settings: { smallerHelp: 'auto' },
    })
    await h.run('add a')
    const [first, second, third] = results(h)
    assert.equal(first, THINK_FIRST)
    assert.doesNotMatch(second, /Not run yet/)
    assert.doesNotMatch(third, /Not run yet/, 'once a request')
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'a.ts'), 'utf8'), 'export const a = 1\n')
    assert.deepEqual(h.surface.notices(), ['eNCode asked the agent to say what it will change before its first edit.'])
    assert.equal(h.surface.tools().length, 2, 'the held call shows no row of its own')
    assert.deepEqual(h.client.requests[0].payload.system.at(-1), SMALLER_MODEL_PART, 'and the help after the instructions')
  })

  it('lets the change run when the agent said what it will change first, for a strong model, and when turned off', async () => {
    const planned = await loopHarness({ scriptFor: (root) => [write(root, PLAN), { text: 'Done.' }], client: { model: 'deepseek/deepseek-chat' }, settings: { smallerHelp: 'auto' } })
    await planned.run('add a')
    const strong = await loopHarness({ scriptFor: (root) => [write(root), { text: 'Done.' }], client: { model: 'anthropic/claude-sonnet-4.5' }, settings: { smallerHelp: 'auto' } })
    await strong.run('add a')
    const off = await loopHarness({ scriptFor: (root) => [write(root), { text: 'Done.' }], client: { model: 'deepseek/deepseek-chat' }, settings: { smallerHelp: 'off' } })
    await off.run('add a')
    for (const h of [planned, strong, off]) assert.doesNotMatch(results(h)[0], /Not run yet/)
    assert.ok(!strong.client.requests[0].payload.system.includes(SMALLER_MODEL_PART))
    assert.ok(!off.client.requests[0].payload.system.includes(SMALLER_MODEL_PART))
  })

  it('holds only the change: the other calls of the step run', async () => {
    const h = await loopHarness({
      files: { 'notes.md': 'hello\n' },
      scriptFor: (root) => [{ calls: [{ name: 'Read', input: { file_path: path.join(root, 'notes.md') } }, write(root).calls[0]] }, { text: 'Done.' }],
      client: { model: 'z-ai/glm-4.6' },
      settings: { smallerHelp: 'auto' },
    })
    await h.run('read and add')
    const [read, held] = results(h)
    assert.match(read, /hello/)
    assert.equal(held, THINK_FIRST)
  })
})

describe('a stronger model after two setbacks', () => {
  const STRONG = 'anthropic/claude-sonnet-4.5'
  /** The same failed change twice and another to the same file, then a fix, then the answer; the Plan role has a strong model. */
  async function harness(options: { roles?: Partial<Record<ModelRole, string>>; decide?: boolean | { approved: false; note: string }; offerStronger?: 'ask' | 'off'; main?: string } = {}) {
    const main = options.main ?? 'deepseek/deepseek-chat'
    const roles: Partial<Record<ModelRole, string>> = options.roles ?? { planner: STRONG }
    const h = await loopHarness({
      files: { 'src/a.ts': 'export const a = 1\n' },
      scriptFor: (root) => {
        const file = path.join(root, 'src', 'a.ts')
        return [
          { calls: [{ name: 'Read', input: { file_path: file } }] },
          { calls: [{ name: 'Edit', input: { file_path: file, old_string: 'const b', new_string: 'const c' } }] },
          { calls: [{ name: 'Edit', input: { file_path: file, old_string: 'const b', new_string: 'const c' } }] },
          { calls: [{ name: 'Edit', input: { file_path: file, old_string: 'const d', new_string: 'const c' } }] },
          { calls: [{ name: 'Edit', input: { file_path: file, old_string: 'const a', new_string: 'const c' } }] },
          { text: 'Done.' },
        ]
      },
      client: { model: main },
      settings: { offerStronger: options.offerStronger ?? 'ask' },
    })
    const budget = h.client.budget.bind(h.client)
    h.client.budget = async (role, query) => {
      const own = roles[role]
      const base = await budget(role, query)
      if (own) return { ...base, model: own, price: { input: 3, output: 15 }, free: false }
      return role === 'main' ? { ...base, price: { input: 0.28, output: 0.42 }, free: false } : base
    }
    h.surface.decide = (prompt) => (prompt.tool === 'StrongerModel' ? (options.decide ?? true) : true)
    return h
  }

  it('asks once, and on yes the Plan role does the rest of the request, held to the gates afresh', async () => {
    const h = await harness()
    await h.run('rename a to c')
    const asked = h.surface.approvals.filter((prompt) => prompt.tool === 'StrongerModel')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].title, 'Let claude-sonnet-4.5 take over this request?')
    assert.match(asked[0].detail, /^deepseek-chat ran into trouble twice in this request: the same `Edit` call failed twice; and `Edit` failed twice on a\.ts\./)
    assert.match(asked[0].detail, /It costs \$3\.00 per million tokens read and \$15\.00 written, against \$0\.28 and \$0\.42 for deepseek-chat\.$/)
    assert.equal(asked[0].grant, 'StrongerModel', 'the person may allow it for the session')
    assert.deepEqual(
      h.client.requests.map((request) => request.role),
      ['main', 'main', 'main', 'main', 'planner', 'planner'],
      'from the step after the second setback',
    )
    assert.ok(reminders(h).some((text) => text.includes('A stronger model does the rest of this request: deepseek-chat ran into trouble twice.')))
    assert.ok(h.surface.notices().includes('claude-sonnet-4.5 does the rest of this request: deepseek-chat ran into trouble twice.'))
  })

  it('goes back to the agent’s own model for the next request', async () => {
    const h = await harness()
    await h.run('rename a to c')
    const before = h.client.requests.length
    await h.run('thanks')
    assert.equal(h.client.requests[before].role, 'main')
  })

  it('keeps going with the model in use on no, and passes on what the person said', async () => {
    const h = await harness({ decide: { approved: false, note: 'Try reading the file again.' } })
    await h.run('rename a to c')
    assert.ok(h.client.requests.every((request) => request.role === 'main'))
    assert.ok(h.surface.notices().includes('deepseek-chat keeps going with this request.'))
    assert.ok(reminders(h).some((text) => text.includes('said: Try reading the file again.')))
  })

  it('never asks when turned off, for a strong model, or with no strong model of another role', async () => {
    const off = await harness({ offerStronger: 'off' })
    await off.run('rename a to c')
    const strong = await harness({ main: 'gpt-5' })
    await strong.run('rename a to c')
    const none = await harness({ roles: { planner: 'qwen/qwen3-coder' } })
    await none.run('rename a to c')
    for (const h of [off, strong, none]) assert.equal(h.surface.approvals.filter((prompt) => prompt.tool === 'StrongerModel').length, 0)
    const reviewer = await harness({ roles: { reviewer: STRONG } })
    await reviewer.run('rename a to c')
    assert.equal(reviewer.client.requests.at(-1)?.role, 'reviewer', "the Review role's strong model when Plan has none")
  })

  it("counts the checks sending the work back, and the stronger model's work is checked again", async () => {
    const ran: string[] = []
    const failing = { output: '✖ adds (1ms)\n\nnot ok', exitCode: 1 }
    const answers = [failing, failing, { output: '✔ adds (1ms)', exitCode: 0 }]
    const shell = (root: string): AgentShell => ({
      ...stubShell(root),
      run: async (command) => {
        ran.push(command)
        const next = answers.shift() ?? { output: 'ok', exitCode: 0 }
        return { output: next.output, exitCode: next.exitCode, timedOut: false, interrupted: false, cwd: root }
      },
    })
    const write = (root: string, content: string) => ({ calls: [{ name: 'Write', input: { file_path: path.join(root, 'src', 'a.ts'), content } }] })
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'export const a = 1\n'), { text: 'Done.' }, write(root, 'export const a = 2\n'), { text: 'Done.' }, write(root, 'export const a = 3\n'), { text: 'Fixed.' }],
      shell,
      services: { checks: { list: async () => [{ command: 'npm test', kind: 'test' as const, source: 'package.json' }], ledger: new CheckLedger() } },
      client: { model: 'deepseek/deepseek-chat' },
      settings: { offerStronger: 'ask' },
    })
    const budget = h.client.budget.bind(h.client)
    h.client.budget = async (role, query) => (role === 'planner' ? { ...(await budget(role, query)), model: STRONG } : budget(role, query))
    const end = await h.run('make the sum right')
    assert.deepEqual(end, { kind: 'done', reply: 'Fixed.' })
    assert.equal(ran.length, 3, 'the checks ran after the stronger model changed the file too')
    assert.match(h.surface.approvals.find((prompt) => prompt.tool === 'StrongerModel')?.detail ?? '', /ran into trouble twice in this request: the project's checks failed after its changes, twice\./)
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'main', 'main', 'main', 'planner', 'planner'])
  })
})
