import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TransportError,
  classifyHttpFailure,
  classifyNetworkFailure,
  classifyStreamError,
  contextOverflow,
  errorSnippet,
  retryAtFrom,
} from './errors'

const NOW = Date.parse('2026-10-21T12:00:00Z')

describe('classifyHttpFailure', () => {
  it('reads the numbers out of a context overflow, from every provider dialect', () => {
    const openai = classifyHttpFailure(
      400,
      undefined,
      JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70012 tokens.", code: 'context_length_exceeded' } }),
    )
    assert.equal(openai.kind, 'context-overflow')
    assert.equal(openai.window, 65536)
    assert.equal(openai.used, 70012)

    const anthropic = classifyHttpFailure(
      400,
      undefined,
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215,001 tokens > 200,000 maximum' } }),
    )
    assert.equal(anthropic.kind, 'context-overflow')
    assert.equal(anthropic.window, 200000)
    assert.equal(anthropic.used, 215001)

    assert.equal(classifyHttpFailure(413, undefined, '').kind, 'context-overflow')
  })

  it('keeps auth, payment and missing models apart', () => {
    assert.equal(classifyHttpFailure(401, undefined, '{"error":{"message":"Invalid API key"}}').kind, 'auth')
    assert.equal(classifyHttpFailure(402, undefined, '{"error":{"message":"Insufficient credits"}}').kind, 'payment')
    assert.equal(classifyHttpFailure(404, undefined, '{"error":{"message":"model not found"}}').kind, 'not-found')
    assert.equal(classifyHttpFailure(403, undefined, '{"error":{"message":"Input was flagged by moderation"}}').kind, 'content-filter')
    assert.equal(classifyHttpFailure(403, undefined, 'forbidden').kind, 'auth')
  })

  it('takes the retry time from Retry-After before any reset header', () => {
    const error = classifyHttpFailure(429, { 'retry-after': '7', 'x-ratelimit-reset-requests': '1m0s' }, 'slow down', NOW)
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.retryAt, NOW + 7000)
  })

  it('tells a spent daily quota from a per-minute limit', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } })
    assert.equal(classifyHttpFailure(429, undefined, body).kind, 'quota')
  })

  it('treats 5xx as transient server trouble and 529 as overload', () => {
    assert.equal(classifyHttpFailure(502, undefined, 'bad gateway').kind, 'server')
    assert.equal(classifyHttpFailure(529, undefined, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').kind, 'overloaded')
    assert.equal(classifyHttpFailure(503, undefined, 'The server is over capacity').kind, 'overloaded')
  })

  it('names the missing feature when an endpoint cannot stream or call tools', () => {
    const stream = classifyHttpFailure(400, undefined, '{"error":{"message":"Streaming is not supported for this model"}}')
    assert.equal(stream.kind, 'unsupported')
    assert.equal(stream.feature, 'stream')
    const tools = classifyHttpFailure(404, undefined, '{"error":{"message":"No endpoints found that support tool use."}}')
    assert.equal(tools.kind, 'unsupported')
    assert.equal(tools.feature, 'tools')
    assert.equal(classifyHttpFailure(400, undefined, '{"error":{"message":"temperature is invalid"}}').kind, 'invalid-request')
  })

  it("adds OpenRouter's upstream error text and never echoes a key", () => {
    const body = JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: 'bad request upstream' } } })
    assert.match(classifyHttpFailure(400, undefined, body).message, /Provider returned error \(bad request upstream\)/)
    const leaky = classifyHttpFailure(401, undefined, 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz')
    assert.doesNotMatch(leaky.message, /abcdefghijklmnop/)
  })
})

describe('retryAtFrom', () => {
  it('reads Retry-After as seconds or as an HTTP date', () => {
    assert.equal(retryAtFrom({ 'retry-after': '2.5' }, NOW), NOW + 2500)
    assert.equal(retryAtFrom({ 'retry-after': 'Wed, 21 Oct 2026 12:01:00 GMT' }, NOW), NOW + 60_000)
    assert.equal(retryAtFrom({ 'retry-after-ms': '150' }, NOW), NOW + 150)
  })

  it("prefers the reset of the limit that is spent over the others", () => {
    const headers = new Headers({
      'x-ratelimit-remaining-requests': '12',
      'x-ratelimit-reset-requests': '2s',
      'x-ratelimit-remaining-tokens': '0',
      'x-ratelimit-reset-tokens': '6m0s',
    })
    assert.equal(retryAtFrom(headers, NOW), NOW + 360_000)
  })

  it("reads Anthropic's RFC 3339 resets and OpenRouter's epoch milliseconds", () => {
    assert.equal(retryAtFrom({ 'anthropic-ratelimit-requests-reset': '2026-10-21T12:00:30Z', 'anthropic-ratelimit-requests-remaining': '0' }, NOW), NOW + 30_000)
    assert.equal(retryAtFrom({ 'x-ratelimit-reset': String(NOW + 45_000) }, NOW), NOW + 45_000)
  })

  it('ignores resets in the past and headers it cannot read', () => {
    assert.equal(retryAtFrom({ 'x-ratelimit-reset': String(NOW - 1000) }, NOW), undefined)
    assert.equal(retryAtFrom({ 'retry-after': 'soon' }, NOW), undefined)
    assert.equal(retryAtFrom(undefined, NOW), undefined)
  })
})

describe('classifyStreamError', () => {
  it("maps Anthropic's error types", () => {
    assert.equal(classifyStreamError('overloaded_error', 'Overloaded').kind, 'overloaded')
    assert.equal(classifyStreamError('rate_limit_error', 'Too many').kind, 'rate-limit')
    assert.equal(classifyStreamError(undefined, 'prompt is too long: 300000 tokens > 200000 maximum').kind, 'context-overflow')
  })

  it('falls back to the code an OpenAI-style chunk carries', () => {
    assert.equal(classifyStreamError(undefined, 'Upstream error', 502).kind, 'server')
    assert.equal(classifyStreamError(undefined, 'free-models-per-day', 429).kind, 'quota')
  })
})

describe('classifyNetworkFailure', () => {
  it('finds the socket code in the cause chain', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const error = classifyNetworkFailure(new TypeError('fetch failed', { cause }), 'https://api.example.com')
    assert.equal(error.kind, 'network')
    assert.match(error.message, /ECONNRESET/)
    assert.equal(classifyNetworkFailure(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }), 'here').kind, 'timeout')
  })

  it('passes a TransportError through unchanged', () => {
    const original = new TransportError('protocol', 'bad stream')
    assert.equal(classifyNetworkFailure(original, 'here'), original)
  })
})

describe('contextOverflow and errorSnippet', () => {
  it('returns null for errors that are not about the window', () => {
    assert.equal(contextOverflow('Invalid API key'), null)
    assert.deepEqual(contextOverflow('context_length_exceeded'), { window: undefined, used: undefined })
  })

  it('caps long text and masks bearer tokens', () => {
    assert.equal(errorSnippet('a'.repeat(700)).length, 601)
    assert.equal(errorSnippet('header Bearer abcdefghijklmnop'), 'header Bearer …')
  })
})
