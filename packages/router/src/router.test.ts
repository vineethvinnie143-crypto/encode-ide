import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TransportError, type ClientEvent, type CompletionOutcome, type ToolUseBlock } from '@encode/providers'
import { nextUtcMidnight } from './openrouter'
import { catalogEntry, faults, TestWorld, type TestWorldOptions } from './testing'

const A = 'vendor/alpha:free'
const B = 'vendor/beta:free'
const C = 'vendor/gamma:free'

/** Three free OpenRouter models, ranked A, B, C by their eval score. */
function freeWorld(options: TestWorldOptions = {}): TestWorld {
  const world = new TestWorld({ catalogs: { openrouter: [catalogEntry(A), catalogEntry(B), catalogEntry(C)] }, ...options })
  world.router.registry.setScores({ [`openrouter:${A}`]: { main: 0.9 }, [`openrouter:${B}`]: { main: 0.6 }, [`openrouter:${C}`]: { main: 0.3 } })
  return world
}

function done(outcome: CompletionOutcome): Extract<CompletionOutcome, { kind: 'done' }> {
  assert.equal(outcome.kind, 'done', `expected done, got ${JSON.stringify(outcome)}`)
  return outcome as Extract<CompletionOutcome, { kind: 'done' }>
}

function types(events: ClientEvent[]): string[] {
  return events.map((event) => event.type).filter((type, index, all) => type !== 'text' || all[index - 1] !== 'text')
}

describe('ModelRouter: answering', () => {
  it('answers with the best model and reports the attempt', async () => {
    const world = freeWorld()
    const { outcome, events, text } = await world.complete()
    done(outcome)
    assert.equal(text, `hello from ${A}`)
    assert.deepEqual(types(events), ['attempt', 'text'])
    assert.deepEqual(events[0], { type: 'attempt', attempt: 1, key: `openrouter:${A}`, provider: 'openrouter', model: A })
    assert.equal(world.calls.length, 1)
    // Free OpenRouter models get the next free models as server-side fallbacks.
    assert.deepEqual(world.calls[0].target.serverFallbacks, [B, C])
  })

  it('sends the key, the output budget and the data policy with the target', async () => {
    const world = freeWorld({ settings: { providers: { openrouter: { type: 'openrouter' } }, freePool: { dataCollection: 'deny' } } })
    await world.complete({ requirements: { promptTokens: 110_000, maxOutputTokens: 32_000, tools: false, images: false } })
    const { target } = world.calls[0]
    assert.equal(target.apiKey, 'sk-or-v1-test-key-0123456789')
    assert.equal(target.dataCollection, 'deny')
    // The window left after the prompt (with a 10% margin for another tokenizer) caps the output budget.
    assert.equal(target.maxOutputTokens, 131_072 - 121_000)
  })
})

describe('ModelRouter: silent failover', () => {
  it('drops a stream that dies mid-reply and commits only the clean attempt', async () => {
    const world = freeWorld({ behavior: { [A]: faults.cutStream('half an answer') } })
    const { outcome, events, text } = await world.complete()
    done(outcome)
    assert.equal(text, `hello from ${B}`)
    assert.deepEqual(types(events), ['attempt', 'text', 'discard', 'switch', 'attempt', 'text'])
    const switched = events.find((event) => event.type === 'switch')
    assert.deepEqual(switched && { from: switched.from, to: switched.to }, { from: `openrouter:${A}`, to: `openrouter:${B}` })
  })

  for (const [name, behavior] of [
    ['an error inside the stream', faults.midStreamError()],
    ['a 5xx before the stream', faults.serverError()],
    ['an overloaded model', faults.overloaded()],
  ] as const) {
    it(`fails over after ${name} and cools the model down`, async () => {
      const world = freeWorld({ behavior: { [A]: behavior } })
      const { text } = await world.complete()
      assert.equal(text, `hello from ${B}`)
      const report = world.router.status().models.find((model) => model.key === `openrouter:${A}`)
      assert.equal(report?.state, 'cooling')
      assert.equal(report?.failures, 1)
    })
  }

  it('gives up on a model that sends nothing before the first-token deadline', async () => {
    const world = freeWorld({ behavior: { [A]: faults.slowFirstToken(25_000) } })
    const started = world.clock.now()
    const { text } = await world.complete()
    assert.equal(text, `hello from ${B}`)
    assert.equal(world.callsTo(B)[0].at - started, 20_000)
  })

  it('waits longer for a model that reasons first', async () => {
    const world = freeWorld({ catalogs: { openrouter: [catalogEntry(A, { capabilities: { tools: true, parallelTools: true, images: false, reasoning: true, promptCache: false } })] }, behavior: { [A]: faults.slowFirstToken(45_000) } })
    const { text } = await world.complete()
    assert.equal(text, 'late but fine')
  })

  it('lets keepalives hold the first token off, but not forever', async () => {
    const patient = freeWorld({ behavior: { [A]: faults.keepaliveThenReply(5, 10_000) } })
    assert.equal((await patient.complete()).text, 'served after keepalives')

    const stuck = freeWorld({ behavior: { [A]: faults.keepaliveOnly(10_000) } })
    const started = stuck.clock.now()
    const { text } = await stuck.complete()
    assert.equal(text, `hello from ${B}`)
    assert.equal(stuck.callsTo(B)[0].at - started, 120_000)
  })

  it('abandons a stream that stalls after it started', async () => {
    const world = freeWorld({ behavior: { [A]: faults.stallAfter() } })
    const started = world.clock.now()
    const { text, events } = await world.complete()
    assert.equal(text, `hello from ${B}`)
    assert.equal(world.callsTo(B)[0].at - started, 60_000)
    assert.ok(events.some((event) => event.type === 'discard'))
  })

  it('cannot be held by an adapter that ignores its abort signal', async () => {
    const world = freeWorld({ behavior: { [A]: faults.hangIgnoringAbort() } })
    const { text } = await world.complete()
    assert.equal(text, `hello from ${B}`)
  })

  it('credits an OpenRouter server-side fallback to the model that answered', async () => {
    const world = freeWorld({ behavior: { [A]: faults.servedBy(B) } })
    const { outcome } = await world.complete()
    const { message } = done(outcome)
    assert.equal(message.origin?.model, B)
    const models = world.router.status().models
    assert.equal(models.find((model) => model.key === `openrouter:${B}`)?.successes, 1)
    assert.equal(models.find((model) => model.key === `openrouter:${A}`)?.successes ?? 0, 0)
  })
})

describe('ModelRouter: rate limits and quotas', () => {
  it('cools only the model a 429 names, and keeps it out until its retry time', async () => {
    const world = freeWorld({ behavior: { [A]: [faults.rateLimited(30_000), faults.reply('A again')] } })
    assert.equal((await world.complete()).text, `hello from ${B}`)
    assert.equal((await world.complete()).text, `hello from ${B}`)
    assert.equal(world.callsTo(A).length, 1)
    await world.clock.advance(30_000)
    assert.equal((await world.complete()).text, 'A again')
    const report = world.router.status().models.find((model) => model.key === `openrouter:${A}`)
    assert.equal(report?.failures, 0, 'a rate limit is not ill health')
  })

  it("closes the whole free tier on OpenRouter's per-minute cap and waits it out", async () => {
    const world = freeWorld({ behavior: { [A]: [faults.freeMinuteCap(40_000), faults.reply('after the minute')] } })
    const started = world.clock.now()
    const { text, events } = await world.complete()
    assert.equal(text, 'after the minute')
    assert.equal(world.callsTo(B).length, 0, 'no other free model is tried in vain')
    assert.equal(world.callsTo(A)[1].at - started, 40_000)
    assert.ok(events.some((event) => event.type === 'wait' && event.until === started + 40_000))
  })

  it('paces free requests to stay under 20 a minute', async () => {
    const world = freeWorld()
    for (let index = 0; index < 25; index++) await world.complete()
    const times = world.calls.map((call) => call.at)
    for (const at of times) assert.ok(times.filter((other) => other >= at && other < at + 60_000).length <= 20)
    assert.equal(world.calls.length, 25)
  })

  it('pauses on a spent daily quota until midnight UTC, and alerts once', async () => {
    const world = freeWorld({ behavior: { [A]: faults.quotaExhausted() } })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind, 'paused')
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'quota')
    assert.equal(outcome.kind === 'paused' && outcome.retryAt, nextUtcMidnight(world.clock.now()))
    assert.equal(world.calls.length, 1)
    await world.complete()
    assert.equal(world.calls.length, 1, 'the closed tier is not asked again')
    assert.deepEqual(
      world.alerts.map((alert) => alert.type),
      ['quota'],
    )
  })

  it('falls through to a paid model when the free tier is closed', async () => {
    const world = freeWorld({
      settings: { providers: { openrouter: { type: 'openrouter' }, anthropic: { type: 'anthropic' } }, roles: { main: ['@free', 'anthropic:claude-sonnet-5'] } },
      keys: { openrouter: 'sk-or-v1-test-key-0123456789', anthropic: 'sk-ant-test-key-0123456789' },
      behavior: { [A]: faults.quotaExhausted() },
    })
    const { text } = await world.complete()
    assert.equal(text, 'hello from claude-sonnet-5')
    assert.equal(world.calls.at(-1)?.target.apiKey, 'sk-ant-test-key-0123456789')
  })
})

describe('ModelRouter: keys', () => {
  it('blocks a provider whose key is refused until the key changes', async () => {
    const world = freeWorld({ behavior: { [A]: [faults.auth(), faults.reply('works again')] } })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'auth')
    assert.deepEqual(world.alerts.map((alert) => alert.type), ['key-refused'])
    await world.complete()
    assert.equal(world.calls.length, 1)
    world.router.keysChanged('openrouter')
    assert.equal((await world.complete()).text, 'works again')
  })

  it("refreshes the gateway's expired token once, then asks for sign-in", async () => {
    let invalidated = 0
    let token = 'token-one-0123456789'
    const keys = {
      has: () => true,
      get: async () => token,
      invalidate: () => {
        invalidated++
        token = 'token-two-0123456789'
      },
    }
    const settings = { providers: { gateway: { type: 'openai-compatible', baseUrl: 'https://gateway.encode.test/v1', free: true } }, roles: { main: ['@free'] } }
    const catalogs = { gateway: [catalogEntry('encode/free-main', { roles: ['main'] })] }
    const world = new TestWorld({ settings, catalogs, keys, behavior: { 'encode/free-main': [faults.auth('token_expired'), faults.reply('signed in')] } })
    const { text } = await world.complete()
    assert.equal(text, 'signed in')
    assert.equal(invalidated, 1)
    assert.deepEqual(world.calls.map((call) => call.target.apiKey), ['token-one-0123456789', 'token-two-0123456789'])

    const revoked = new TestWorld({ settings, catalogs, keys, behavior: { 'encode/free-main': faults.auth('invalid_token') } })
    const { outcome } = await revoked.complete()
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'auth')
    assert.deepEqual(revoked.alerts.map((alert) => alert.type), ['sign-in'])
  })

  it('says which key is missing when no model can run', async () => {
    const world = freeWorld({ keys: {} })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'no-model')
    assert.match(outcome.kind === 'paused' ? outcome.message : '', /key for openrouter/)
    assert.equal(world.calls.length, 0)
  })

  it('never puts a key in a pause message or an alert', async () => {
    const key = 'sk-or-v1-secret-value-abcdef0123'
    const leak = new TransportError('auth', `HTTP 401: Incorrect API key provided: ${key}`, { status: 401 })
    const world = freeWorld({ keys: { openrouter: key }, behavior: { [A]: [{ fail: leak }] } })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'auth')
    assert.doesNotMatch(JSON.stringify(outcome), /secret-value/)
    assert.doesNotMatch(JSON.stringify(world.alerts), /secret-value/)
  })
})

describe('ModelRouter: replies that cannot be used', () => {
  const tools = { promptTokens: 1_000, maxOutputTokens: 4_096, tools: true, images: false }

  it('asks the same model once more about unreadable tool JSON, then another model', async () => {
    const world = freeWorld({ behavior: { [A]: faults.badToolJson(), [B]: faults.toolCall('Read', { path: 'a.ts' }) } })
    const { outcome, events } = await world.complete({ requirements: tools })
    const call = done(outcome).message.content.find((block): block is ToolUseBlock => block.type === 'tool-use')
    assert.deepEqual(call?.input, { path: 'a.ts' })
    assert.deepEqual(world.calls.map((entry) => entry.model), [A, A, B])
    assert.equal(events.filter((event) => event.type === 'discard').length, 2)
  })

  it('commits an unreadable call as invalid when no other model can try', async () => {
    const world = new TestWorld({ catalogs: { openrouter: [catalogEntry(A)] }, behavior: { [A]: faults.badToolJson() } })
    const { outcome } = await world.complete({ requirements: tools })
    const call = done(outcome).message.content.find((block): block is ToolUseBlock => block.type === 'tool-use')
    assert.equal(call?.invalid?.raw, '{"path": "a.ts", "content": "half of the fi')
    assert.equal(world.calls.length, 2)
  })

  it('commits a schema error at once, for core to answer', async () => {
    const world = freeWorld({ behavior: { [A]: faults.toolCall('Read', { file: 'a.ts' }) } })
    const { outcome } = await world.complete({
      requirements: tools,
      validateToolCall: (_name, input) => (typeof input.path === 'string' ? undefined : 'path is required'),
    })
    const call = done(outcome).message.content.find((block): block is ToolUseBlock => block.type === 'tool-use')
    assert.deepEqual(call?.invalid, { raw: '{"file":"a.ts"}', error: 'path is required' })
    assert.equal(world.calls.length, 1)
  })

  it('gives an empty reply one more try, then asks another model', async () => {
    const world = freeWorld({ behavior: { [A]: faults.emptyReply() } })
    const { text } = await world.complete()
    assert.equal(text, `hello from ${B}`)
    assert.deepEqual(world.calls.map((entry) => entry.model), [A, A, B])
  })

  it('pauses as refused when a safety filter stops the request, without trying another model', async () => {
    const world = freeWorld({ behavior: { [A]: faults.contentFilter() } })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'refused')
    assert.equal(world.calls.length, 1)
  })
})

describe('ModelRouter: context and capabilities', () => {
  it('learns a smaller window from an overflow and moves to a model the prompt fits', async () => {
    const world = freeWorld({ behavior: { [A]: faults.contextOverflow(32_768) } })
    const { text } = await world.complete({ requirements: { promptTokens: 40_000, maxOutputTokens: 4_096, tools: false, images: false } })
    assert.equal(text, `hello from ${B}`)
    assert.equal(world.router.registry.get('openrouter', A).contextWindow, 32_768)
    await world.complete({ requirements: { promptTokens: 40_000, maxOutputTokens: 4_096, tools: false, images: false } })
    assert.equal(world.callsTo(A).length, 1, 'the prompt no longer fits the learned window')
  })

  it('asks core to compact when no window fits the prompt', async () => {
    const world = freeWorld()
    const { outcome } = await world.complete({ requirements: { promptTokens: 200_000, maxOutputTokens: 4_096, tools: false, images: false } })
    assert.deepEqual(outcome, { kind: 'compact', window: 131_072, used: 200_000 })
    assert.equal(world.calls.length, 0)
  })

  it('learns that a model cannot call tools and leaves it out of tool calls', async () => {
    const world = freeWorld({ behavior: { [A]: faults.noTools(), [B]: faults.toolCall('Read', { path: 'a.ts' }) } })
    const requirements = { promptTokens: 1_000, maxOutputTokens: 4_096, tools: true, images: false }
    done((await world.complete({ requirements })).outcome)
    done((await world.complete({ requirements })).outcome)
    assert.equal(world.callsTo(A).length, 1)
    assert.equal(world.router.registry.get('openrouter', A).capabilities.tools, false)
  })
})

describe('ModelRouter: the failover budget', () => {
  it('pauses after four costly failures and says when to retry', async () => {
    const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => `vendor/${id}:free`)
    const world = new TestWorld({
      catalogs: { openrouter: models.map((id) => catalogEntry(id)) },
      behavior: Object.fromEntries(models.map((id) => [id, faults.serverError()])),
    })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind, 'paused')
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'unavailable')
    assert.ok(outcome.kind === 'paused' && outcome.retryAt !== undefined && outcome.retryAt > world.clock.now())
    assert.equal(world.calls.length, 4)
  })

  it('retries a lone model after its short cooldown before pausing', async () => {
    const world = new TestWorld({ catalogs: { openrouter: [catalogEntry(A)] }, behavior: { [A]: [faults.overloaded(), faults.overloaded(), faults.reply('third time')] } })
    const started = world.clock.now()
    const { text, events } = await world.complete()
    assert.equal(text, 'third time')
    assert.deepEqual(world.calls.map((call) => call.at - started), [0, 5_000, 15_000])
    assert.equal(events.filter((event) => event.type === 'wait').length, 2)
  })

  it('holds a provider back briefly after a network failure without blaming the model', async () => {
    const world = new TestWorld({ catalogs: { openrouter: [catalogEntry(A)] }, behavior: { [A]: [faults.networkError(), faults.reply('back online')] } })
    const { text } = await world.complete()
    assert.equal(text, 'back online')
    const report = world.router.status().models.find((model) => model.key === `openrouter:${A}`)
    assert.equal(report?.failures, 0)
  })
})

describe('ModelRouter: sessions, abort and budget', () => {
  it("keeps a session on the model it moved to, while other sessions use the best one", async () => {
    const world = freeWorld({ behavior: { [A]: [faults.rateLimited(1_000), faults.reply('A')] } })
    assert.equal((await world.complete({ sticky: 's1' })).text, `hello from ${B}`)
    await world.clock.advance(5_000)
    assert.equal((await world.complete({ sticky: 's1' })).text, `hello from ${B}`)
    assert.equal((await world.complete({ sticky: 's2' })).text, 'A')
  })

  it('rejects with the abort reason, and only then', async () => {
    const world = freeWorld({ behavior: { [A]: faults.reply('a long answer that takes a while', { gapMs: 1_000 }) } })
    const controller = new AbortController()
    const reason = new Error('stopped by the user')
    const pending = world.router.complete({
      role: 'main',
      payload: { system: [], messages: [], tools: [] },
      requirements: { promptTokens: 10, maxOutputTokens: 100, tools: false, images: false },
      signal: controller.signal,
    })
    world.clock.setTimeout(() => controller.abort(reason), 2_500)
    await assert.rejects(world.clock.run(pending), (error) => error === reason)
    const report = world.router.status().models.find((model) => model.key === `openrouter:${A}`)
    assert.equal(report?.failures ?? 0, 0, 'an abort is not a failure')
  })

  it("reports the window of the model a call would use now", async () => {
    const world = new TestWorld({ catalogs: { openrouter: [catalogEntry(A, { contextWindow: 262_144, maxOutputTokens: 32_768 })] } })
    assert.deepEqual(await world.router.budget('main'), { model: A, contextWindow: 262_144, maxOutputTokens: 32_768 })
    const empty = new TestWorld({ catalogs: {} })
    assert.equal((await empty.router.budget('main')).model, '@free')
  })
})
