import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SERVER_TOOL_REFUSED_CODE,
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

    // When the server splits what it counted, the prompt is the part the conversation can shrink.
    const split = classifyHttpFailure(
      400,
      undefined,
      JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (7568 in the messages, 1432 in the completion). Please reduce the length of the messages or completion." } }),
    )
    assert.equal(split.window, 8192)
    assert.equal(split.used, 7568)
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
    for (const text of ['This model does not support PDF input.', 'No endpoints found that support file input.', 'Document inputs are not supported for this model.']) {
      const documents = classifyHttpFailure(400, undefined, JSON.stringify({ error: { message: text } }))
      assert.deepEqual([documents.kind, documents.feature], ['unsupported', 'documents'], text)
    }
    assert.equal(classifyHttpFailure(400, undefined, '{"error":{"message":"temperature is invalid"}}').kind, 'invalid-request')
  })

  it("adds OpenRouter's upstream error text and never echoes a key", () => {
    const body = JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: 'bad request upstream' } } })
    assert.match(classifyHttpFailure(400, undefined, body).message, /Provider returned error \(bad request upstream\)/)
    const leaky = classifyHttpFailure(401, undefined, 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz')
    assert.doesNotMatch(leaky.message, /abcdefghijklmnop/)
  })
})

describe('classifyHttpFailure: a preset whose server tool the API does not take', () => {
  // As OpenRouter answered a model called through `@preset/...` that has its Shell tool on; the user id is made up.
  const body = JSON.stringify({
    error: {
      message: "Tool 'openrouter:shell' is not available for the 'chat-completions' API. It is only supported for: responses, anthropic-messages.",
      code: 400,
      metadata: { provider_name: null },
    },
    user_id: 'user_0000000000000000000000000000',
  })

  it('is a refusal of the request, said in words that point at the preset', () => {
    const error = classifyHttpFailure(400, undefined, body)
    assert.equal(error.kind, 'invalid-request')
    assert.equal(error.status, 400)
    assert.equal(error.code, SERVER_TOOL_REFUSED_CODE)
    assert.match(error.message, /openrouter:shell/)
    assert.match(error.message, /preset/)
    assert.match(error.message, /chat-completions API/)
    assert.doesNotMatch(error.message, /user_0000/, 'nothing but the tool and the API is taken from the body')
  })

  it('says which APIs do take the tool, so a client can ask one of them instead', () => {
    assert.deepEqual(classifyHttpFailure(400, undefined, body).apis, ['responses', 'anthropic-messages'])
    const one = classifyHttpFailure(400, undefined, "{\"error\":{\"message\":\"Tool 'openrouter:shell' is not available for the 'chat-completions' API. It is only supported for: responses.\"}}")
    assert.deepEqual(one.apis, ['responses'])
    const unsaid = classifyHttpFailure(400, undefined, "{\"error\":{\"message\":\"Tool 'openrouter:shell' is not available for the 'chat-completions' API\"}}")
    assert.equal(unsaid.apis, undefined, 'a refusal that names no API says nothing about which would work')
  })

  it('is not mistaken for a model that cannot call tools, which would be learned and stay learned', () => {
    // The body talks about a tool that is "not available", as the tools-unsupported pattern does.
    assert.notEqual(classifyHttpFailure(400, undefined, body).kind, 'unsupported')
    assert.equal(classifyHttpFailure(400, undefined, '{"error":{"message":"Tool use is not supported by this model"}}').kind, 'unsupported')
  })

  it('reads only the wording of this error, and only from a 400', () => {
    assert.equal(classifyHttpFailure(404, undefined, body).code, undefined)
    const other = classifyHttpFailure(400, undefined, "{\"error\":{\"message\":\"Tool 'lookup' is not available for the 'chat-completions' API\"}}")
    assert.notEqual(other.code, SERVER_TOOL_REFUSED_CODE, 'a tool of the caller is not an OpenRouter server tool')
    const hostile = classifyHttpFailure(400, undefined, `{"error":{"message":"Tool 'openrouter:${'x'.repeat(80)}' is not available for the 'chat-completions' API"}}`)
    assert.notEqual(hostile.code, SERVER_TOOL_REFUSED_CODE, 'a name that is too long to be a tool is not echoed')
  })
})

describe("classifyHttpFailure: OpenRouter's account limits", () => {
  const MIDNIGHT = Date.parse('2026-10-22T00:00:00Z')
  const rateLimited = (message: string, metadata: Record<string, unknown> = {}) =>
    JSON.stringify({ error: { message, code: 429, metadata: { error_type: 'rate_limit_exceeded', ...metadata } } })

  it('scopes a free per-minute cap to the whole key and waits for its reset', () => {
    const headers = { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(NOW + 40_000) }
    const error = classifyHttpFailure(429, headers, rateLimited('Rate limit exceeded: free-models-per-min.'), NOW)
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.scope, 'account')
    assert.equal(error.retryAt, NOW + 40_000)
    assert.equal(error.code, 'rate_limit_exceeded')
  })

  it('reads the daily cap from headers echoed in the body, and from its wording', () => {
    const echoed = { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(MIDNIGHT) } }
    const silent = classifyHttpFailure(429, undefined, rateLimited('Rate limit exceeded', echoed), NOW)
    assert.equal(silent.kind, 'quota')
    assert.equal(silent.scope, 'account')
    assert.equal(silent.retryAt, MIDNIGHT)

    const worded = classifyHttpFailure(429, undefined, rateLimited('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', echoed), NOW)
    assert.equal(worded.kind, 'quota')
    assert.equal(worded.retryAt, MIDNIGHT)
  })

  it("keeps an upstream provider's 429 on that model", () => {
    const body = JSON.stringify({
      error: { message: 'Provider returned error', code: 429, metadata: { raw: 'model:free is temporarily rate-limited upstream', provider_name: 'Upstream' } },
    })
    const error = classifyHttpFailure(429, { 'retry-after': '5' }, body, NOW)
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.scope, undefined)
    assert.equal(error.retryAt, NOW + 5000)
  })

  it('ignores echoed header values that are not text or numbers', () => {
    const body = rateLimited('Rate limit exceeded', { headers: { 'X-RateLimit-Limit': { nested: 1 }, 'X-RateLimit-Reset': [1, 2], 'bad name': '3' } })
    const error = classifyHttpFailure(429, undefined, body, NOW)
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.scope, undefined)
    assert.equal(error.retryAt, undefined)
  })

  it('treats a full in-flight budget as a short wait and an empty balance as payment', () => {
    const inFlight = (reason: string) =>
      JSON.stringify({ error: { message: 'In-flight budget exhausted', code: 402, metadata: { limit_source: 'openrouter_in_flight_budget', reason } } })
    const busy = classifyHttpFailure(402, { 'retry-after': '3' }, inFlight('in_flight_budget_exhausted'), NOW)
    assert.equal(busy.kind, 'rate-limit')
    assert.equal(busy.scope, 'account')
    assert.equal(busy.retryAt, NOW + 3000)

    const tooBig = classifyHttpFailure(402, undefined, inFlight('weight_exceeds_budget'), NOW)
    assert.equal(tooBig.kind, 'payment')
    assert.equal(tooBig.scope, 'account')

    const keyLimit = JSON.stringify({ error: { message: 'Key limit exceeded', code: 402, metadata: { limit_source: 'openrouter_key_limit' } } })
    assert.equal(classifyHttpFailure(402, undefined, keyLimit, NOW).kind, 'payment')
  })

  it('reads a spent budget as payment until the budget resets, not as a bad key', () => {
    const budget = (resetsAt: string | null) =>
      JSON.stringify({ error: { message: 'Budget exceeded', code: 403, metadata: { limit_source: 'openrouter_workspace_budget', resets_at: resetsAt } } })
    const daily = classifyHttpFailure(403, undefined, budget('2026-10-22T00:00:00Z'), NOW)
    assert.equal(daily.kind, 'payment')
    assert.equal(daily.scope, 'account')
    assert.equal(daily.retryAt, MIDNIGHT)
    const lifetime = classifyHttpFailure(403, undefined, budget(null), NOW)
    assert.equal(lifetime.kind, 'payment')
    assert.equal(lifetime.retryAt, undefined)
  })
})

describe("classifyHttpFailure: eNCode's gateway codes", () => {
  const gateway = (code: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: { message: `gateway says ${code}`, type: 'error', code, ...extra } })

  it('keeps an expired token apart from a revoked one', () => {
    const expired = classifyHttpFailure(401, undefined, gateway('token_expired'), NOW)
    assert.equal(expired.kind, 'auth')
    assert.equal(expired.code, 'token_expired')
    assert.equal(classifyHttpFailure(401, undefined, gateway('invalid_token'), NOW).code, 'invalid_token')
  })

  it("binds the user's limits and quotas to the whole account, with the body's retry_after", () => {
    const busy = classifyHttpFailure(429, undefined, gateway('concurrency_limited', { retry_after: 12 }), NOW)
    assert.equal(busy.kind, 'rate-limit')
    assert.equal(busy.scope, 'account')
    assert.equal(busy.retryAt, NOW + 12_000)

    for (const [status, code] of [[429, 'daily_quota_exhausted'], [503, 'free_tier_exhausted'], [503, 'service_disabled']] as const) {
      const error = classifyHttpFailure(status, undefined, gateway(code, { retry_after: 3600 }), NOW)
      assert.equal(error.kind, 'quota', code)
      assert.equal(error.scope, 'account', code)
      assert.equal(error.retryAt, NOW + 3_600_000, code)
    }
  })

  it('prefers a Retry-After header over the body, and backs off from a failing upstream', () => {
    const error = classifyHttpFailure(429, { 'retry-after': '2' }, gateway('rate_limited', { retry_after: 30 }), NOW)
    assert.equal(error.retryAt, NOW + 2000)
    const upstream = classifyHttpFailure(503, undefined, gateway('upstream_unavailable', { retry_after: 30 }), NOW)
    assert.equal(upstream.kind, 'server')
    assert.equal(upstream.retryAt, NOW + 30_000)
    assert.equal(classifyHttpFailure(404, undefined, gateway('model_not_found'), NOW).kind, 'not-found')
  })

  it('never reads an inherited property as a code', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const error = classifyHttpFailure(400, undefined, JSON.stringify({ error: { message: 'odd', type: code, code } }), NOW)
      assert.equal(error.kind, 'invalid-request', code)
    }
    assert.equal(classifyStreamError('constructor', 'odd').kind, 'server')
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

  it('finds headers in a plain record whatever their case', () => {
    assert.equal(retryAtFrom({ 'Retry-After': '3' }, NOW), NOW + 3000)
    assert.equal(retryAtFrom({ 'X-RateLimit-Reset': String(NOW + 9000) }, NOW), NOW + 9000)
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

  it("reads the gateway's in-band codes and retry_after", () => {
    const error = classifyStreamError('free_tier_exhausted', 'The free tier is used up for today.', undefined, { retryAfterSeconds: 600, now: NOW })
    assert.equal(error.kind, 'quota')
    assert.equal(error.scope, 'account')
    assert.equal(error.retryAt, NOW + 600_000)
    assert.equal(error.code, 'free_tier_exhausted')
    const upstream = classifyStreamError('upstream_unavailable', 'Every free model failed.', 503, { retryAfterSeconds: 30, now: NOW })
    assert.equal(upstream.kind, 'server')
    assert.equal(upstream.status, 503)
    assert.equal(upstream.retryAt, NOW + 30_000)
  })

  it('keeps the retry time of a rate limit that arrives mid-stream', () => {
    const error = classifyStreamError(undefined, 'Rate limit exceeded', 429, { retryAfterSeconds: 4, now: NOW })
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.retryAt, NOW + 4000)
    assert.equal(classifyStreamError(undefined, 'Rate limit exceeded', 429, { retryAfterSeconds: -1, now: NOW }).retryAt, undefined)
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
