import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClientEvent, CompletionRequest, ProviderAdapter, StreamInput, TransportEvent } from './contract'
import { createDirectClient, routeFor } from './direct-client'
import { TransportError } from './errors'

type Script = (input: StreamInput) => AsyncGenerator<TransportEvent>

/** An adapter that plays one script per call, in order. */
function scripted(...scripts: Script[]): ProviderAdapter & { calls: number } {
  const adapter = {
    type: 'openai-compatible' as const,
    calls: 0,
    stream(input: StreamInput) {
      const script = scripts[adapter.calls++]
      if (!script) throw new Error('no script left')
      return script(input)
    },
  }
  return adapter
}

const reply = (text: string): Script =>
  async function* () {
    yield { type: 'model', model: 'served' }
    yield { type: 'text', text }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: 'stop' }
  }

const failing = (error: TransportError, afterText?: string): Script =>
  async function* () {
    if (afterText) yield { type: 'text', text: afterText }
    throw error
  }

/** Resolves never; rejects with the signal's reason once it aborts (at once if it already has). */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

const route = routeFor({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-model', contextWindow: 32_000 })

function setup(adapter: ProviderAdapter, overrides: Partial<Parameters<typeof createDirectClient>[0]> = {}) {
  const sleeps: number[] = []
  const client = createDirectClient({
    route: () => route,
    adapters: { 'openai-compatible': adapter },
    now: () => 1_000_000,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...overrides,
  })
  return { client, sleeps }
}

function call(overrides: Partial<CompletionRequest> = {}): CompletionRequest & { events: ClientEvent[] } {
  const events: ClientEvent[] = []
  return {
    role: 'main',
    payload: { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] },
    requirements: { promptTokens: 20_000, maxOutputTokens: 1000, tools: false, images: false },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    events,
    ...overrides,
  }
}

describe('DirectClient', () => {
  it('finishes a clean attempt with the served model recorded', async () => {
    const { client } = setup(scripted(reply('hello')))
    const request = call()
    const outcome = await client.complete(request)
    assert.equal(outcome.kind, 'done')
    if (outcome.kind !== 'done') return
    assert.deepEqual(outcome.message.content, [{ type: 'text', text: 'hello' }])
    assert.deepEqual(outcome.message.origin, { provider: 'local', model: 'served', family: 'other' })
    assert.deepEqual(request.events.map((event) => event.type), ['attempt', 'text'])
  })

  it('retries a dead stream, telling the UI to discard what it showed', async () => {
    const adapter = scripted(failing(new TransportError('network', 'reset'), 'partial'), reply('whole'))
    const { client, sleeps } = setup(adapter)
    const request = call()
    const outcome = await client.complete(request)
    assert.equal(outcome.kind, 'done')
    assert.equal(adapter.calls, 2)
    assert.deepEqual(sleeps, [1000])
    assert.deepEqual(request.events.map((event) => event.type), ['attempt', 'text', 'discard', 'wait', 'attempt', 'text'])
  })

  it('sits out a short rate limit until the server says, and pauses on a long one', async () => {
    const short = setup(scripted(failing(new TransportError('rate-limit', '429', { retryAt: 1_000_000 + 5000 })), reply('ok')))
    assert.equal((await short.client.complete(call())).kind, 'done')
    assert.deepEqual(short.sleeps, [5000])

    const long = setup(scripted(failing(new TransportError('rate-limit', '429', { retryAt: 1_000_000 + 3_600_000 }))))
    const outcome = await long.client.complete(call())
    assert.deepEqual(outcome.kind === 'paused' && [outcome.reason, outcome.retryAt], ['rate-limit', 1_000_000 + 3_600_000])
  })

  it('waits out a rate limit that names no time, with growing pauses, longer than it waits for other faults', async () => {
    const plain = () => failing(new TransportError('rate-limit', 'HTTP 429: Provider returned error', { status: 429 }))
    const clears = setup(scripted(plain(), plain(), plain(), plain(), reply('ok')))
    assert.equal((await clears.client.complete(call())).kind, 'done')
    assert.deepEqual(clears.sleeps, [1000, 2000, 4000, 8000])

    const stays = scripted(plain(), plain(), plain(), plain(), plain(), plain(), reply('never reached'))
    const gives = setup(stays)
    const outcome = await gives.client.complete(call())
    assert.deepEqual(outcome.kind === 'paused' && outcome.reason, 'rate-limit')
    assert.equal(stays.calls, 6)
    assert.deepEqual(gives.sleeps, [1000, 2000, 4000, 8000, 16000])

    const down = scripted(failing(new TransportError('server', 'HTTP 500')), failing(new TransportError('server', 'HTTP 500')), failing(new TransportError('server', 'HTTP 500')), reply('never reached'))
    const outcome500 = await setup(down).client.complete(call())
    assert.equal(outcome500.kind === 'paused' && outcome500.reason, 'unavailable')
    assert.equal(down.calls, 3, 'a fault that is not a limit keeps the shorter patience')
  })

  it('does not wait for a quota that is spent', async () => {
    const adapter = scripted(failing(new TransportError('quota', 'HTTP 429: free-models-per-day', { status: 429 })), reply('never reached'))
    const outcome = await setup(adapter).client.complete(call())
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'quota')
    assert.equal(adapter.calls, 1)
  })

  it('pauses at once on a rejected key, without retrying', async () => {
    const adapter = scripted(failing(new TransportError('auth', 'HTTP 401: invalid key', { status: 401 })))
    const { client } = setup(adapter)
    const outcome = await client.complete(call())
    assert.equal(outcome.kind, 'paused')
    assert.equal(outcome.kind === 'paused' && outcome.reason, 'auth')
    assert.match(outcome.kind === 'paused' ? outcome.message : '', /local-model on local: HTTP 401/)
    assert.equal(adapter.calls, 1)
  })

  it('answers an overflow with compact, and remembers the smaller window', async () => {
    const { client } = setup(scripted(failing(new TransportError('context-overflow', 'too long', { status: 400, used: 40_000 }))))
    const outcome = await client.complete(call())
    assert.deepEqual(outcome, { kind: 'compact', window: 24_000, used: 40_000 })
    assert.equal((await client.budget('main')).contextWindow, 24_000)
  })

  it('gives an empty reply one more chance', async () => {
    const empty: Script = async function* () {
      yield { type: 'finish', reason: 'stop' }
    }
    const adapter = scripted(empty, reply('second'))
    const { client } = setup(adapter)
    const outcome = await client.complete(call())
    assert.equal(outcome.kind === 'done' && outcome.message.content.length, 1)
    assert.equal(adapter.calls, 2)
  })

  it('abandons a silent stream after the idle timeout and tries again', async () => {
    const silent: Script = async function* (input) {
      yield { type: 'keepalive' }
      await untilAborted(input.signal)
    }
    const adapter = scripted(silent, reply('back'))
    const { client } = setup(adapter, { idleTimeoutMs: 20 })
    const outcome = await client.complete(call())
    assert.equal(outcome.kind, 'done')
    assert.equal(adapter.calls, 2)
  })

  it('rejects with the caller’s reason when aborted, and only then', async () => {
    const controller = new AbortController()
    const hang: Script = async function* (input) {
      yield { type: 'text', text: 'working' }
      controller.abort(new Error('stopped by user'))
      await untilAborted(input.signal)
    }
    const { client } = setup(scripted(hang))
    await assert.rejects(client.complete(call({ signal: controller.signal })), /stopped by user/)
  })

  it('builds a route from a profile with what the model table knows', () => {
    const claude = routeFor({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'k' })
    assert.equal(claude.target.providerType, 'anthropic')
    assert.equal(claude.target.family, 'anthropic')
    assert.equal(claude.contextWindow, 1_000_000)
    const openRouter = routeFor({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' })
    assert.equal(openRouter.target.providerType, 'openrouter')
    assert.equal(openRouter.contextWindow, 200_000)
    assert.equal(routeFor({ provider: 'x', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }).contextWindow, 64_000)
  })
})
