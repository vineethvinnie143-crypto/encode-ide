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
import { CONSULT_SYSTEM, consultCost, consultOffer, helpsSmaller, recentSteps, saidWhatChanges, Setbacks, SMALLER_MODEL_PART, SMALLER_MODEL_TEXT, strongerPrompt, THINK_FIRST } from './smaller'
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
      "deepseek-chat ran into trouble again in this request: the project's checks failed after its changes; and the same `Edit` call failed twice. claude-sonnet-4.5, the model of your Plan role, would do the rest of it. The next request goes back to deepseek-chat. It costs $3.00 per million tokens read and $15.00 written, against $0.28 and $0.42 for deepseek-chat.",
    )
    assert.match(strongerPrompt({ from: 'm', to: { ...to, price: undefined }, role: 'reviewer', reasons: [] }).detail, /your Review role.*It may cost more per token\.$/)
  })

  it('offers a look at the stuck steps first, with what that one call should cost (ADR 0140)', () => {
    const to: ModelBudget = { model: 'anthropic/claude-sonnet-4.5', contextWindow: 1_000_000, maxOutputTokens: 64_000, price: { input: 3, output: 15 }, free: false }
    const reasons = ['the same `Edit` call failed twice', 'the same `Edit` call failed twice']
    const offer = consultOffer({ from: 'deepseek/deepseek-chat', to, role: 'reviewer', reasons, cost: 0.091 })
    assert.equal(offer.title, 'Ask claude-sonnet-4.5 how to get past this?')
    assert.equal(
      offer.detail,
      'deepseek-chat ran into trouble twice in this request: two `Edit` calls each failed twice. claude-sonnet-4.5, the model of your Review role, would read the last steps and say what is going wrong and how to get past it, in one call. deepseek-chat then goes on with the request. It should cost about $0.10.',
    )
    assert.match(consultOffer({ from: 'm', to, role: 'planner', reasons, cost: 0.004 }).detail, /It should cost about a cent or less\.$/)
    assert.match(consultOffer({ from: 'm', to, role: 'planner', reasons, cost: 0 }).detail, /claude-sonnet-4\.5 is free to call\.$/)
    assert.match(consultOffer({ from: 'm', to, role: 'planner', reasons }).detail, /It costs one call to that model\.$/)
    // 40,000 characters read (10,000 tokens at $3 a million) and 1,500 tokens written at $15.
    assert.equal(consultCost(to, 40_000)?.toFixed(4), '0.0525')
    assert.equal(consultCost({ ...to, free: true }, 40_000), 0)
    assert.equal(consultCost({ ...to, price: undefined }, 40_000), undefined)
  })

  it('gives it the steps of the request alone, newest kept when they do not all fit', () => {
    const call = (id: string, command: string): Message => ({ role: 'assistant', content: [{ type: 'text', text: `I run ${command}.` }, { type: 'tool-use', id, name: 'Bash', input: { command } }] })
    const result = (id: string, text: string, isError = false): Message => ({ role: 'user', content: [{ type: 'tool-result', toolUseId: id, content: [{ type: 'text', text }], isError }] })
    const messages: Message[] = [user('an earlier request'), call('0', 'ls'), result('0', 'a.ts'), user('make the tests pass'), call('1', 'npm test'), result('1', '1 failing', true), call('2', 'npm run build'), result('2', 'built')]
    assert.equal(
      recentSteps(messages),
      'Agent: I run npm test.\nCall Bash: {"command":"npm test"}\n\nFailed: 1 failing\n\nAgent: I run npm run build.\nCall Bash: {"command":"npm run build"}\n\nResult: built',
    )
    const long = recentSteps([...messages, result('3', 'x'.repeat(5_000))], 1_510)
    assert.match(long, /^\[earlier steps left out\]\n\nResult: x{1,1499}…$/)
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
  const ADVICE = 'There is no `const b` in src/a.ts: read the file, then rename `const a`.'
  type Plot = 'advice' | 'takeover' | 'declined'
  /**
   * A smaller model that sends the same failed change twice and another to the same file (two setbacks), so the Plan
   * role's strong model is asked to read the steps; with `takeover`, two more setbacks after its advice.
   */
  async function harness(options: { roles?: Partial<Record<ModelRole, string>>; decide?: boolean | { approved: false; note: string }; offerStronger?: 'ask' | 'off'; main?: string; plot?: Plot } = {}) {
    const main = options.main ?? 'deepseek/deepseek-chat'
    const roles: Partial<Record<ModelRole, string>> = options.roles ?? { planner: STRONG }
    const plot = options.plot ?? 'advice'
    const h = await loopHarness({
      files: { 'src/a.ts': 'export const a = 1\n' },
      scriptFor: (root) => {
        const file = path.join(root, 'src', 'a.ts')
        const edit = (from: string) => ({ calls: [{ name: 'Edit', input: { file_path: file, old_string: from, new_string: 'const c' } }] })
        const stuck = [edit('const e'), edit('const e'), edit('const f'), edit('const f')]
        return [
          { calls: [{ name: 'Read', input: { file_path: file } }] },
          edit('const b'),
          edit('const b'),
          edit('const d'),
          ...(plot === 'declined' ? [] : [{ text: ADVICE }]),
          ...(plot === 'advice' ? [] : stuck),
          edit('const a'),
          { text: 'Done.' },
        ]
      },
      client: { model: main },
      settings: { offerStronger: options.offerStronger ?? 'ask' },
      requests: () => ['rename a to c'],
    })
    const budget = h.client.budget.bind(h.client)
    h.client.budget = async (role, query) => {
      const own = roles[role]
      const base = await budget(role, query)
      if (own) return { ...base, model: own, price: { input: 3, output: 15 }, free: false }
      return role === 'main' ? { ...base, price: { input: 0.28, output: 0.42 }, free: false } : base
    }
    h.surface.decide = (prompt) => (prompt.tool === 'StrongerModel' || prompt.tool === 'StrongerAdvice' ? (options.decide ?? true) : true)
    return h
  }
  const asked = (h: Harness, tool: string) => h.surface.approvals.filter((prompt) => prompt.tool === tool)

  it('first asks it to read the last steps, in one call, and the agent goes on with what it says (ADR 0140)', async () => {
    const h = await harness()
    assert.deepEqual(await h.run('rename a to c'), { kind: 'done', reply: 'Done.' })
    const [offer] = asked(h, 'StrongerAdvice')
    assert.equal(asked(h, 'StrongerAdvice').length, 1)
    assert.equal(offer.title, 'Ask claude-sonnet-4.5 how to get past this?')
    assert.match(offer.detail, /^deepseek-chat ran into trouble twice in this request: the same `Edit` call failed twice; and `Edit` failed twice on a\.ts\. claude-sonnet-4\.5, the model of your Plan role, would read the last steps and say what is going wrong and how to get past it, in one call\. deepseek-chat then goes on with the request\. It should cost about \$0\.0\d\.$/)
    assert.equal(offer.grant, 'StrongerAdvice', 'the person may allow it for the session')
    assert.equal(asked(h, 'StrongerModel').length, 0, 'no take-over after advice that worked')
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'main', 'main', 'main', 'planner', 'main', 'main'])
    const look = h.client.requests[4]
    assert.deepEqual([look.tool, look.payload.tools.length, look.payload.system[0].text], ['StuckSteps', 0, CONSULT_SYSTEM])
    const prompt = JSON.stringify(look.payload.messages)
    assert.match(prompt, /1\. rename a to c/)
    assert.match(prompt, /What went wrong, as eNCode saw it: the same `Edit` call failed twice/)
    assert.match(prompt, /Call Edit: \{.*const b/)
    assert.match(prompt, /const d.*\\n\\nFailed: src\/a\.ts: old_string was not found/, 'with the results of the step it saw last')
    assert.ok(reminders(h).some((text) => text.includes(`claude-sonnet-4.5 read your last steps. It says:\n\n${ADVICE}\n\nIt saw only those steps`)))
    assert.ok(h.surface.notices().includes('claude-sonnet-4.5 read the last steps and said how to get past them; deepseek-chat goes on.'))
  })

  it('after two more setbacks, asks whether it may do the rest of the request, held to the gates afresh', async () => {
    const h = await harness({ plot: 'takeover' })
    await h.run('rename a to c')
    const [offer] = asked(h, 'StrongerModel')
    assert.equal(asked(h, 'StrongerModel').length, 1)
    assert.equal(offer.title, 'Let claude-sonnet-4.5 take over this request?')
    assert.match(offer.detail, /^deepseek-chat ran into trouble again in this request: 3 `Edit` calls each failed twice; and `Edit` failed twice on a\.ts\./)
    assert.match(offer.detail, /It costs \$3\.00 per million tokens read and \$15\.00 written, against \$0\.28 and \$0\.42 for deepseek-chat\.$/)
    assert.equal(offer.grant, 'StrongerModel')
    assert.deepEqual(
      h.client.requests.map((request) => request.role),
      ['main', 'main', 'main', 'main', 'planner', 'main', 'main', 'main', 'main', 'planner', 'planner'],
      'its look after the second setback, and the rest from the step after the fourth',
    )
    assert.ok(reminders(h).some((text) => text.includes('A stronger model does the rest of this request: deepseek-chat kept running into trouble.')))
    assert.ok(h.surface.notices().includes('claude-sonnet-4.5 does the rest of this request: deepseek-chat ran into trouble again.'))
  })

  it('goes back to the agent’s own model for the next request', async () => {
    const h = await harness({ plot: 'takeover' })
    await h.run('rename a to c')
    const before = h.client.requests.length
    await h.run('thanks')
    assert.equal(h.client.requests[before].role, 'main')
  })

  it('keeps going with the model in use on no, passes on what the person said, and offers nothing more in the request', async () => {
    const h = await harness({ plot: 'declined', decide: { approved: false, note: 'Try reading the file again.' } })
    await h.run('rename a to c')
    assert.ok(h.client.requests.every((request) => request.role === 'main'))
    assert.deepEqual([asked(h, 'StrongerAdvice').length, asked(h, 'StrongerModel').length], [1, 0])
    assert.ok(h.surface.notices().includes('deepseek-chat keeps going with this request.'))
    assert.ok(reminders(h).some((text) => text.includes('said: Try reading the file again.')))
  })

  it('never asks when turned off, for a strong model, or with no strong model of another role', async () => {
    const off = await harness({ offerStronger: 'off', plot: 'declined' })
    await off.run('rename a to c')
    const strong = await harness({ main: 'gpt-5', plot: 'declined' })
    await strong.run('rename a to c')
    const none = await harness({ roles: { planner: 'qwen/qwen3-coder' }, plot: 'declined' })
    await none.run('rename a to c')
    for (const h of [off, strong, none]) assert.equal(h.surface.approvals.filter((prompt) => prompt.tool.startsWith('Stronger')).length, 0)
    const reviewer = await harness({ roles: { reviewer: STRONG } })
    await reviewer.run('rename a to c')
    assert.ok(reviewer.client.requests.some((request) => request.role === 'reviewer' && request.tool === 'StuckSteps'), "the Review role's strong model when Plan has none")
  })

  it("counts the checks sending the work back, and the stronger model's work is checked again", async () => {
    const ran: string[] = []
    const failing = { output: '✖ adds (1ms)\n\nnot ok', exitCode: 1 }
    const answers = [failing, failing, failing, failing, { output: '✔ adds (1ms)', exitCode: 0 }]
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
      scriptFor: (root) => [
        write(root, 'export const a = 1\n'),
        { text: 'Done.' },
        write(root, 'export const a = 2\n'),
        { text: 'Done.' },
        { text: ADVICE },
        write(root, 'export const a = 3\n'),
        { text: 'Done.' },
        write(root, 'export const a = 4\n'),
        { text: 'Done.' },
        write(root, 'export const a = 5\n'),
        { text: 'Fixed.' },
      ],
      shell,
      services: { checks: { list: async () => [{ command: 'npm test', kind: 'test' as const, source: 'package.json' }], ledger: new CheckLedger() } },
      client: { model: 'deepseek/deepseek-chat' },
      settings: { offerStronger: 'ask', checkGate: 'on' },
    })
    const budget = h.client.budget.bind(h.client)
    h.client.budget = async (role, query) => (role === 'planner' ? { ...(await budget(role, query)), model: STRONG } : budget(role, query))
    const end = await h.run('make the sum right')
    assert.deepEqual(end, { kind: 'done', reply: 'Fixed.' })
    assert.equal(ran.length, 5, 'the checks ran after the stronger model changed the file too')
    assert.match(asked(h, 'StrongerAdvice')[0]?.detail ?? '', /ran into trouble twice in this request: the project's checks failed after its changes, twice\./)
    assert.match(asked(h, 'StrongerModel')[0]?.detail ?? '', /ran into trouble again in this request: the project's checks failed after its changes, 4 times\./)
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'main', 'main', 'main', 'planner', 'main', 'main', 'main', 'main', 'planner', 'planner'])
  })
})
