import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerEvents, chunk, controlledStream, errorResponse, sseResponse } from '../testing/harness'
import { attemptUpstream, classifyEventFailure, classifyHttpFailure, safeDetail, type AttemptInput } from './upstream'

const NOW = Date.UTC(2026, 9, 21, 9)

function attempt(respond: (signal: AbortSignal) => Response | Promise<Response>, extra: Partial<AttemptInput> = {}) {
  const controller = new AbortController()
  const input: AttemptInput = {
    fetch: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => respond(init!.signal!)) as typeof fetch,
    url: 'https://openrouter.example.test/api/v1/chat/completions',
    headers: {},
    body: { model: 'acme/big:free', models: ['acme/big:free'] },
    firstEventTimeoutMs: 2_000,
    signal: controller.signal,
    now: Date.now,
    ...extra,
  }
  return { controller, result: attemptUpstream(input) }
}

describe('HTTP failures from OpenRouter', () => {
  const headers = (values: Record<string, string> = {}) => new Headers(values)

  it("tell a provider's rate limit from the account's per-minute and daily limits", () => {
    assert.deepEqual(classifyHttpFailure(429, headers({ 'retry-after': '7' }), '{}', NOW), { kind: 'failed', outcome: 'rate_limited', status: 429, retryAfterMs: 7_000 })
    assert.deepEqual(classifyHttpFailure(429, headers({ 'x-ratelimit-limit': '20', 'x-ratelimit-reset': String(NOW + 15_000) }), '{}', NOW), {
      kind: 'failed',
      outcome: 'account_limited',
      status: 429,
      retryAfterMs: 15_000,
    })
    const daily = classifyHttpFailure(429, headers({ 'x-ratelimit-limit': '1000', 'x-ratelimit-reset': String(NOW + 6 * 3_600_000) }), '{}', NOW)
    assert.equal(daily.outcome, 'daily_exhausted')
    assert.equal(daily.retryAfterMs, 6 * 3_600_000)
    assert.equal(classifyHttpFailure(429, headers({ 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 30) }), '{}', NOW).retryAfterMs, 30_000)
  })

  it('stop the whole tier on key and payment problems, and retire missing models', () => {
    assert.equal(classifyHttpFailure(402, headers(), '{}', NOW).outcome, 'payment_required')
    assert.equal(classifyHttpFailure(401, headers(), '{}', NOW).outcome, 'unauthorized')
    assert.equal(classifyHttpFailure(404, headers(), '{}', NOW).outcome, 'not_found')
    assert.equal(classifyHttpFailure(500, headers(), 'oops', NOW).outcome, 'error')
    assert.equal(classifyHttpFailure(503, headers(), '', NOW).outcome, 'error')
  })

  it('pass a rejection back to the client, except a prompt too long for these models', () => {
    assert.deepEqual(classifyHttpFailure(400, headers(), JSON.stringify({ error: { message: 'tool_choice\nis invalid' } }), NOW), {
      kind: 'failed',
      outcome: 'rejected',
      status: 400,
      detail: 'tool_choice is invalid',
    })
    assert.equal(classifyHttpFailure(400, headers(), JSON.stringify({ error: { message: "This endpoint's maximum context length is 32768 tokens" } }), NOW).outcome, 'error')
    assert.equal(classifyHttpFailure(403, headers(), JSON.stringify({ error: { message: 'Input was flagged' } }), NOW).detail, 'Input was flagged')
    assert.match(classifyHttpFailure(422, headers(), 'not json', NOW).detail ?? '', /HTTP 422/)
  })

  it('retire a model that OpenRouter reserves for listed apps, instead of blaming the request', () => {
    const reserved = JSON.stringify({
      error: {
        code: 403,
        message: 'acme/big:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps',
      },
    })
    assert.deepEqual(classifyHttpFailure(403, headers(), reserved, NOW), { kind: 'failed', outcome: 'not_found', status: 403 })
    assert.equal(classifyHttpFailure(403, headers(), JSON.stringify({ error: { message: 'Input was flagged' } }), NOW).outcome, 'rejected')
  })

  it('retire a model that the privacy settings of the account rule out', () => {
    const guardrail = JSON.stringify({
      error: {
        code: 404,
        message:
          '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons): Free model training',
      },
    })
    assert.deepEqual(classifyHttpFailure(404, headers(), guardrail, NOW), { kind: 'failed', outcome: 'not_found', status: 404 })
  })

  it('never hand a credential to the client in a rejection', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef'
    const body = JSON.stringify({ error: { message: `Bad request for ${key}, also other-secret-value` } })
    assert.equal(classifyHttpFailure(400, headers(), body, NOW, ['other-secret-value']).detail, 'Bad request for [redacted], also [redacted]')
    const long = classifyHttpFailure(400, headers(), JSON.stringify({ error: { message: `${'x'.repeat(295)} ${key}` } }), NOW)
    assert.ok(!(long.detail ?? '').includes('sk-or'), 'no prefix of the key survives the cut')
  })

  it('keep upstream details short and on one line', () => {
    assert.equal(safeDetail('a\u0000b\n\tc'), 'a b c')
    assert.equal(safeDetail('x'.repeat(400))?.length, 301)
    assert.equal(safeDetail('   '), undefined)
    assert.equal(safeDetail(42), undefined)
  })

  it('classify error events that arrive before any content', () => {
    assert.equal(classifyEventFailure({ code: 429 }).outcome, 'rate_limited')
    assert.equal(classifyEventFailure({ code: '402' }).outcome, 'payment_required')
    assert.equal(classifyEventFailure({ code: 502, message: 'Provider returned error' }).outcome, 'error')
    assert.equal(classifyEventFailure({}).outcome, 'error')
  })
})

describe('an upstream attempt', () => {
  it('commits at the first real content, keeping every byte read so far', async () => {
    const { result } = attempt(() => sseResponse([': OPENROUTER PROCESSING\n\n', ...answerEvents('acme/medium:free', 'Hello there')]))
    const outcome = await result
    assert.equal(outcome.kind, 'committed')
    if (outcome.kind !== 'committed') return
    assert.equal(outcome.model, 'acme/medium:free')
    assert.equal(outcome.events.length, 5, 'every event in the chunk, not only those up to the first text')
    assert.equal(outcome.done, true)
    const head = new TextDecoder().decode(Buffer.concat(outcome.head))
    assert.ok(head.startsWith(': OPENROUTER PROCESSING'))
    outcome.abort()
  })

  it('stops reading at the first content when it arrives in its own chunk', async () => {
    const stream = controlledStream()
    const { result } = attempt(() => stream.response)
    stream.send(chunk('acme/big:free', { role: 'assistant', content: '' }))
    stream.send(chunk('acme/big:free', { content: 'Hi' }))
    const outcome = await result
    assert.equal(outcome.kind, 'committed')
    if (outcome.kind !== 'committed') return
    assert.equal(outcome.events.length, 2)
    assert.equal(outcome.done, false)
    stream.send(chunk('acme/big:free', { content: ' there' }))
    const next = await outcome.reader.read()
    assert.ok(!next.done && new TextDecoder().decode(next.value).includes('there'))
    outcome.abort()
    await stream.cancelled
  })

  it('fails over on an error event before content, and on a stream that ends without any', async () => {
    const errored = await attempt(() => sseResponse([chunk('m', { role: 'assistant' }), { error: { code: 429, message: 'Rate limit exceeded' } }])).result
    assert.deepEqual(errored, { kind: 'failed', outcome: 'rate_limited', status: 429 })
    const empty = await attempt(() => sseResponse([chunk('m', { role: 'assistant' })])).result
    assert.deepEqual(empty, { kind: 'failed', outcome: 'error' })
    const silent = await attempt(() => sseResponse([], false)).result
    assert.deepEqual(silent, { kind: 'failed', outcome: 'error' })
  })

  it('classifies HTTP errors and JSON answers to a streaming request', async () => {
    assert.equal((await attempt(() => errorResponse(402, 'Insufficient credits')).result).kind, 'failed')
    const json = await attempt(() => Response.json({ error: { code: 429, message: 'busy' } })).result
    assert.deepEqual(json, { kind: 'failed', outcome: 'rate_limited', status: 429 })
    const thrown = await attempt(() => {
      throw new TypeError('fetch failed')
    }).result
    assert.deepEqual(thrown, { kind: 'failed', outcome: 'error' })
  })

  it('times out when no content arrives in time, and lets the upstream go', async () => {
    const stream = controlledStream()
    const started = Date.now()
    const { result } = attempt(() => stream.response, { firstEventTimeoutMs: 50 })
    stream.send(chunk('m', { role: 'assistant' }))
    assert.deepEqual(await result, { kind: 'failed', outcome: 'timeout' })
    assert.ok(Date.now() - started < 1_000)
    await stream.cancelled
  })

  it('reports a client that left as client_closed', async () => {
    const stream = controlledStream()
    const { controller, result } = attempt(() => stream.response)
    setTimeout(() => controller.abort(), 20)
    assert.deepEqual(await result, { kind: 'failed', outcome: 'client_closed' })
    const before = new AbortController()
    before.abort()
    const early = await attempt(() => sseResponse([]), { signal: before.signal }).result
    assert.deepEqual(early, { kind: 'failed', outcome: 'client_closed' })
  })
})
