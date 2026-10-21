import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GatewayHeaders, GatewayPaths, readGatewayError, VirtualModels } from '@encode/gateway-protocol'
import {
  answerEvents,
  CATALOG,
  chunk,
  controlledStream,
  errorResponse,
  Harness,
  OPENROUTER_KEY,
  readSse,
  sseResponse,
} from '../testing/harness'

async function signedIn(options: Parameters<typeof Harness.create>[0] = {}) {
  const harness = await Harness.create(options)
  const session = await harness.signIn()
  return { harness, token: session.access_token, session }
}

async function errorOf(response: Response) {
  const body = await response.json()
  const error = readGatewayError(body)
  assert.ok(error, `not a gateway error: ${JSON.stringify(body)}`)
  return error
}

/** The gateway error that ends a failed stream. */
function streamError(text: string) {
  const { events } = readSse(text)
  const last = events[events.length - 1]
  return readGatewayError(last)
}

describe('a streamed chat request', () => {
  it('starts with a keepalive, names the model, relays the stream and settles the real usage', async () => {
    const { harness, token } = await signedIn()
    const response = await harness.chat(token, { stream: true, messages: [{ role: 'user', content: 'a secret prompt' }] })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get(GatewayHeaders.quotaRemaining), String(harness.config.user.requestsPerDay - 1))
    assert.equal(response.headers.get(GatewayHeaders.quotaReset), String(Date.UTC(2026, 9, 22)))
    assert.match(response.headers.get(GatewayHeaders.requestId) ?? '', /^req_/)
    const text = await response.text()
    await harness.idle()

    assert.ok(text.startsWith(': keepalive\n\n'))
    const { comments, events, done } = readSse(text)
    assert.ok(comments.includes('encode-model acme/big:free'))
    assert.equal(done, true)
    const content = events.map((event) => (event as { choices: Array<{ delta?: { content?: string } }> }).choices[0]?.delta?.content ?? '').join('')
    assert.equal(content, 'Hello from acme/big:free')

    const [sent] = harness.openrouter.chats
    assert.equal(sent.headers.get('authorization'), `Bearer ${OPENROUTER_KEY}`)
    assert.equal(sent.headers.get('x-title'), 'eNCode')
    assert.equal(sent.headers.get('http-referer'), 'https://encode.example.test')
    assert.deepEqual(sent.body.models, ['acme/big:free', 'acme/medium:free', 'beta/vision:free'])
    assert.equal(sent.body.model, 'acme/big:free')
    assert.equal(sent.body.stream, true)
    assert.deepEqual(sent.body.stream_options, { include_usage: true })
    assert.match(String(sent.body.user), /^[0-9a-f]{16}$/)

    const [state] = harness.users.states.values() as IterableIterator<{ requests: number; inputTokens: number; outputTokens: number; leases: unknown[] }>
    assert.equal(state.requests, 1)
    assert.equal(state.inputTokens, 120)
    assert.equal(state.outputTokens, 30)
    assert.equal(state.leases.length, 0)
    assert.deepEqual(harness.control.reports, [{ model: 'acme/big:free', outcome: 'ok', ttftMs: 0, inputTokens: 120, outputTokens: 30 }])

    const logged = harness.log.events.find((event) => event.name === 'chat')
    assert.equal(logged?.fields.ending, 'ok')
    assert.ok(!harness.log.text().includes('a secret prompt'), 'prompts are never logged')
    assert.ok(!harness.log.text().includes(OPENROUTER_KEY), 'the key is never logged')
    assert.ok(!text.includes(OPENROUTER_KEY))
  })

  it('sends keepalives while the upstream is slow to start', async () => {
    const { harness, token } = await signedIn({ tweak: (config) => (config.upstream.keepaliveMs = 10) })
    harness.openrouter.script.push(async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return sseResponse(answerEvents(String(body.model), 'late'))
    })
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    const keepalives = readSse(text).comments.filter((comment) => comment === 'keepalive').length
    assert.ok(keepalives >= 3, `${keepalives} keepalives`)
  })

  it('fails over to another free model without the client seeing the failure', async () => {
    const { harness, token } = await signedIn({ tweak: (config) => (config.upstream.fallbackModels = 1) })
    harness.openrouter.script.push(
      () => errorResponse(429, 'Provider rate limited'),
      () => sseResponse([chunk('acme/medium:free', { role: 'assistant' }), { error: { code: 502, message: 'Provider returned error' } }]),
    )
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    const { comments, events } = readSse(text)
    assert.deepEqual(
      harness.openrouter.chats.map((entry) => entry.body.models),
      [['acme/big:free'], ['acme/medium:free'], ['beta/vision:free']],
    )
    assert.ok(comments.includes('encode-model beta/vision:free'))
    assert.ok(!text.includes('Provider'), 'failed attempts never reach the client')
    assert.equal(events.filter((event) => readGatewayError(event)).length, 0)
    assert.deepEqual(
      harness.control.reports.map((report) => [report.model, report.outcome]),
      [
        ['acme/big:free', 'rate_limited'],
        ['acme/medium:free', 'error'],
        ['beta/vision:free', 'ok'],
      ],
    )
  })

  it('ends with a gateway error, and refunds the request, when every free model fails', async () => {
    const { harness, token } = await signedIn()
    harness.openrouter.script.push(() => errorResponse(503, 'down'))
    const response = await harness.chat(token, { stream: true })
    assert.equal(response.status, 200)
    const text = await response.text()
    await harness.idle()
    const error = streamError(text)
    assert.equal(error?.code, 'upstream_unavailable')
    assert.ok((error?.retry_after ?? 0) > 0)
    const [state] = harness.users.states.values() as IterableIterator<{ requests: number; refunds: number }>
    assert.deepEqual([state.requests, state.refunds], [0, 1])
  })

  it('passes a rejection back as a request error, without a refund', async () => {
    const { harness, token } = await signedIn({ tweak: (config) => (config.upstream.fallbackModels = 1) })
    harness.openrouter.script.push(
      () => errorResponse(400, 'tool_choice is invalid for this model'),
      () => errorResponse(400, 'tool_choice is invalid for this model'),
    )
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    assert.deepEqual(streamError(text), { code: 'invalid_request', message: 'tool_choice is invalid for this model', type: 'invalid_request_error' })
    assert.equal(harness.openrouter.chats.length, 2, 'a second model gets one chance')
    const [state] = harness.users.states.values() as IterableIterator<{ requests: number; refunds: number }>
    assert.deepEqual([state.requests, state.refunds], [1, 0])
  })

  it('moves past models that are closed to our key, never blames the request, and leaves them alone afterwards', async () => {
    const { harness, token } = await signedIn({ tweak: (config) => (config.upstream.fallbackModels = 1) })
    harness.openrouter.script.push(
      () => errorResponse(403, 'acme/big:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps'),
      () => errorResponse(404, '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons: Free model training'),
    )
    const first = await harness.chat(token, { stream: true })
    assert.equal(first.status, 200)
    const text = await first.text()
    await harness.idle()
    const { comments, events, done } = readSse(text)
    assert.ok(done, 'the third model answers')
    assert.ok(comments.includes('encode-model beta/vision:free'))
    assert.ok(!text.includes('harness') && !text.includes('guardrail') && !text.includes('acme/'), 'the refusals stay inside the gateway')
    assert.equal(events.filter((event) => readGatewayError(event)).length, 0)
    assert.deepEqual(
      harness.control.reports.map((report) => [report.model, report.outcome]),
      [
        ['acme/big:free', 'not_found'],
        ['acme/medium:free', 'not_found'],
        ['beta/vision:free', 'ok'],
      ],
    )

    // The next request starts with the model that worked, not with the two that are closed.
    await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    assert.equal(harness.openrouter.chats[3].body.model, 'beta/vision:free')
    const [state] = harness.users.states.values() as IterableIterator<{ requests: number; refunds: number }>
    assert.deepEqual([state.requests, state.refunds], [2, 0])
  })

  it('ends a stream that fails after content with the upstream error and then a gateway error', async () => {
    const { harness, token } = await signedIn()
    harness.openrouter.script.push(() =>
      sseResponse([chunk('acme/big:free', { content: 'Half an ans' }), { error: { code: 502, message: 'Provider disconnected' } }], false),
    )
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    assert.ok(text.includes('Half an ans'))
    assert.equal(streamError(text)?.code, 'upstream_error')
    assert.equal(harness.openrouter.chats.length, 1, 'content reached the client, so there is no failover')
    assert.deepEqual(harness.control.reports.at(-1)?.outcome, 'error')
  })

  it('treats a stream that stops without a finish or end marker as cut off', async () => {
    const { harness, token } = await signedIn()
    harness.openrouter.script.push(() => sseResponse([chunk('acme/big:free', { content: 'Trunc' })], false))
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    assert.equal(streamError(text)?.code, 'upstream_error')
  })

  it('gives up on a model that sends nothing in time and tries the rest', async () => {
    const { harness, token } = await signedIn({
      tweak: (config) => {
        config.upstream.firstEventTimeoutMs = 30
        config.upstream.fallbackModels = 1
      },
    })
    const stalled = controlledStream()
    harness.openrouter.script.push(() => stalled.response)
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    await stalled.cancelled
    assert.ok(readSse(text).comments.includes('encode-model acme/medium:free'))
    assert.equal(harness.control.reports[0].outcome, 'timeout')
  })

  it('stops the upstream and keeps the request counted when the client leaves mid-stream', async () => {
    const { harness, token } = await signedIn()
    const upstream = controlledStream()
    harness.openrouter.script.push(() => upstream.response)
    const leave = new AbortController()
    const response = await harness.chat(token, { stream: true }, { signal: leave.signal })
    upstream.send(chunk('acme/big:free', { content: 'Hel' }))
    const reader = response.body!.getReader()
    let seen = ''
    while (!seen.includes('Hel')) seen += new TextDecoder().decode((await reader.read()).value)
    leave.abort()
    await upstream.cancelled
    await reader.cancel().catch(() => undefined)
    await harness.idle()
    assert.equal(harness.log.events.find((event) => event.name === 'chat')?.fields.ending, 'client_closed')
    const [state] = harness.users.states.values() as IterableIterator<{ requests: number; leases: unknown[] }>
    assert.deepEqual([state.requests, state.leases.length], [1, 0])
  })
})

describe('a non-streamed chat request', () => {
  it('answers with one chat.completion and names the model in a header', async () => {
    const { harness, token } = await signedIn()
    const response = await harness.chat(token, { model: VirtualModels.fast })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get(GatewayHeaders.model), 'gamma/small:free')
    const body = (await response.json()) as { object: string; model: string; choices: Array<{ message: { content: string } }>; usage: unknown }
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, 'Hello from gamma/small:free')
    assert.deepEqual(body.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })
    assert.equal(harness.openrouter.chats[0].body.stream, true, 'the gateway always streams from OpenRouter')
  })

  it('fails over when a model breaks off mid-answer, since nothing reached the client yet', async () => {
    const { harness, token } = await signedIn({ tweak: (config) => (config.upstream.fallbackModels = 1) })
    harness.openrouter.script.push(() => sseResponse([chunk('acme/big:free', { content: 'Hal' }), { error: { code: 500, message: 'boom' } }], false))
    const response = await harness.chat(token, {})
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    assert.equal(body.choices[0].message.content, 'Hello from acme/medium:free')
    assert.equal(response.headers.get(GatewayHeaders.model), 'acme/medium:free')
  })

  it('answers with a plain HTTP error when no model can serve it', async () => {
    const { harness, token } = await signedIn()
    harness.openrouter.script.push(() => errorResponse(503, 'down'))
    const response = await harness.chat(token, {})
    assert.equal(response.status, 503)
    assert.ok(Number(response.headers.get('retry-after')) > 0)
    assert.equal((await errorOf(response)).code, 'upstream_unavailable')
  })
})

describe('the cost firewall in front of OpenRouter', () => {
  it('sends only :free models and none of the routing fields a client adds', async () => {
    const { harness, token } = await signedIn()
    const response = await harness.chat(token, {
      stream: true,
      models: ['openai/gpt-5'],
      provider: { order: ['OpenAI'] },
      plugins: [{ id: 'web' }],
      transforms: ['middle-out'],
      user: 'someone-else',
      stream_options: { include_usage: false },
    })
    await response.text()
    await harness.idle()
    const [sent] = harness.openrouter.chats
    assert.deepEqual(Object.keys(sent.body).sort(), ['max_tokens', 'messages', 'model', 'models', 'stream', 'stream_options', 'user'])
    assert.ok((sent.body.models as string[]).every((id) => id.endsWith(':free')))
    assert.notEqual(sent.body.user, 'someone-else')
  })

  it('refuses real model ids before anything is sent or counted', async () => {
    const { harness, token } = await signedIn()
    for (const model of ['openai/gpt-5', 'acme/big:free', 'openrouter/auto']) {
      const response = await harness.chat(token, { model })
      assert.equal(response.status, 400)
      assert.equal((await errorOf(response)).code, 'model_not_found')
    }
    assert.equal(harness.openrouter.chats.length, 0)
    assert.equal(harness.users.states.size, 0)
  })

  it('refuses requests no free model can take, without counting them', async () => {
    const { harness, token } = await signedIn({ pool: CATALOG.filter((model) => !model.images) })
    const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }
    const blind = await harness.chat(token, { messages: [image] })
    assert.deepEqual(await errorOf(blind), {
      code: 'upstream_unavailable',
      message: 'No free model that reads images is available right now.',
      type: 'upstream_error',
      retry_after: 60,
    })
    const huge = await harness.chat(token, { messages: [{ role: 'user', content: 'x'.repeat(600_000) }] })
    assert.equal((await errorOf(huge)).message, 'No free model can take a request of this size right now.')
    assert.equal(harness.users.states.size, 0)
    assert.equal(harness.openrouter.chats.length, 0)
  })
})

describe('limits and switches', () => {
  it('needs a valid access token', async () => {
    const harness = await Harness.create()
    assert.equal((await errorOf(await harness.chat('', {}))).code, 'auth_required')
    assert.equal((await errorOf(await harness.chat('ea1.e30.AAAA', {}))).code, 'invalid_token')
    const { access_token: token } = await harness.signIn()
    harness.advance(3_600_000)
    const expired = await harness.chat(token, {})
    assert.equal(expired.status, 401)
    assert.equal((await errorOf(expired)).code, 'token_expired')
  })

  it('answers 503 service_disabled while the kill switch is on, from the environment or from KV', async () => {
    const env = await signedIn({ env: { KILL_SWITCH: 'true', KILL_SWITCH_MESSAGE: 'Paused for maintenance.' } })
    const response = await env.harness.chat(env.token, {})
    assert.equal(response.status, 503)
    assert.ok(response.headers.get('retry-after'))
    assert.deepEqual(await errorOf(response), { code: 'service_disabled', message: 'Paused for maintenance.', type: 'service_unavailable_error', retry_after: 900 })

    const kv = await signedIn()
    kv.harness.store.kill = { on: true, message: 'Paused from KV.' }
    assert.equal((await errorOf(await kv.harness.chat(kv.token, {}))).message, 'Paused from KV.')
    const status = (await (await kv.harness.fetch(GatewayPaths.status)).json()) as { free_tier: { available: boolean; message: string } }
    assert.deepEqual(status.free_tier, { available: false, message: 'Paused from KV.' })
    assert.equal(kv.harness.openrouter.chats.length, 0)
  })

  it('answers 429 with Retry-After once the daily quota is used', async () => {
    const { harness, token } = await signedIn({ env: { USER_REQUESTS_PER_DAY: '1' } })
    assert.equal((await harness.chat(token, {})).status, 200)
    harness.advance(10_000)
    const refused = await harness.chat(token, {})
    assert.equal(refused.status, 429)
    assert.equal(Number(refused.headers.get('retry-after')), Math.ceil((Date.UTC(2026, 9, 22) - harness.clock.now) / 1000))
    assert.equal((await errorOf(refused)).code, 'daily_quota_exhausted')
  })

  it('runs two streams at a time per account', async () => {
    const { harness, token } = await signedIn()
    const held = [controlledStream(), controlledStream()]
    harness.openrouter.script.push(() => held[0].response, () => held[1].response)
    const first = await harness.chat(token, { stream: true })
    const second = await harness.chat(token, { stream: true })
    const third = await harness.chat(token, { stream: true })
    assert.equal(third.status, 429)
    assert.equal((await errorOf(third)).code, 'concurrency_limited')
    for (const stream of held) {
      for (const event of answerEvents('acme/big:free', 'done')) stream.send(event)
      stream.send('data: [DONE]\n\n')
      stream.close()
    }
    await Promise.all([first.text(), second.text()])
    await harness.idle()
  })

  it('answers the global exhaustion and busy cases as plain HTTP errors, even for streams', async () => {
    const exhausted = await signedIn({ env: { GLOBAL_REQUESTS_PER_DAY: '1' } })
    assert.equal((await exhausted.harness.chat(exhausted.token, { stream: true }).then((response) => response.text())).includes('Hello'), true)
    await exhausted.harness.idle()
    const refused = await exhausted.harness.chat(exhausted.token, { stream: true })
    assert.equal(refused.status, 503)
    assert.equal((await errorOf(refused)).code, 'free_tier_exhausted')
    const [state] = exhausted.harness.users.states.values() as IterableIterator<{ requests: number; refunds: number }>
    assert.deepEqual([state.requests, state.refunds], [1, 1], 'the refused request was handed back')

    const busy = await signedIn({ env: { GLOBAL_REQUESTS_PER_MINUTE: '1' } })
    await (await busy.harness.chat(busy.token, { stream: true })).text()
    const second = await busy.harness.signIn({ id: 2002, login: 'hubot' })
    const queued = await busy.harness.chat(second.access_token, { stream: true })
    assert.equal(queued.status, 429)
    assert.equal((await errorOf(queued)).code, 'free_tier_busy')
  })

  it('pauses the free tier when OpenRouter refuses the key', async () => {
    const { harness, token } = await signedIn()
    harness.openrouter.script.push(() => errorResponse(401, 'No auth credentials found'))
    const text = await (await harness.chat(token, { stream: true })).text()
    await harness.idle()
    assert.equal(streamError(text)?.code, 'upstream_unavailable')
    const next = await harness.chat(token, { stream: true })
    assert.equal(next.status, 503)
    assert.equal((await errorOf(next)).code, 'free_tier_exhausted')
    assert.equal(harness.openrouter.chats.length, 1)
  })

  it('asks old clients to update', async () => {
    const { harness, token } = await signedIn({ env: { MIN_CLIENT_VERSION: '0.2.0' } })
    const old = await harness.chat(token, {}, { headers: { [GatewayHeaders.client]: 'desktop/0.1.9' } })
    assert.equal(old.status, 426)
    assert.equal((await errorOf(old)).code, 'client_outdated')
    assert.equal((await harness.chat(token, {}, { headers: { [GatewayHeaders.client]: 'desktop/0.2.0' } })).status, 200)
    assert.equal((await harness.chat(token, {})).status, 200, 'a client that sends no version is served')
  })
})

describe('the HTTP surface', () => {
  it('checks methods, paths, content types and sizes, and stamps every answer', async () => {
    const harness = await Harness.create({ env: { MAX_BODY_BYTES: String(16 * 1024) } })
    const cases: Array<[Response, number, string]> = [
      [await harness.fetch(GatewayPaths.chatCompletions), 405, 'method_not_allowed'],
      [await harness.fetch('/v1/nothing'), 404, 'not_found'],
      [await harness.fetch('/'), 404, 'not_found'],
    ]
    const { access_token: token } = await harness.signIn()
    cases.push([await harness.fetch(GatewayPaths.chatCompletions, { token, body: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type'])
    cases.push([await harness.fetch(GatewayPaths.chatCompletions, { token, json: { model: VirtualModels.main, messages: [{ role: 'user', content: 'x'.repeat(20_000) }] } }), 413, 'request_too_large'])
    cases.push([await harness.fetch(GatewayPaths.chatCompletions, { token, body: '{"model":', headers: { 'content-type': 'application/json' } }), 400, 'invalid_request'])
    for (const [response, status, code] of cases) {
      assert.equal(response.status, status, code)
      assert.equal((await errorOf(response)).code, code)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.match(response.headers.get(GatewayHeaders.requestId) ?? '', /^req_[A-Za-z0-9_-]{16}$/)
    }
  })

  it('describes the virtual models from the current pool', async () => {
    const harness = await Harness.create()
    const body = (await (await harness.fetch(GatewayPaths.models)).json()) as { object: string; data: Array<Record<string, unknown>> }
    assert.equal(body.object, 'list')
    const [main, fast] = body.data
    assert.deepEqual(main, {
      id: VirtualModels.main,
      object: 'model',
      owned_by: 'encode',
      name: 'eNCode Free',
      roles: ['main', 'planner', 'reviewer'],
      context_length: 65_536,
      max_output_tokens: 8_192,
      supports_tools: true,
      supports_images: true,
      available: true,
    })
    assert.equal(fast.id, VirtualModels.fast)
    assert.equal(fast.context_length, 32_768)
    assert.deepEqual(fast.roles, ['explore', 'summarizer', 'utility'])

    const empty = await Harness.create({ pool: null })
    const none = (await (await empty.fetch(GatewayPaths.models)).json()) as { data: Array<{ available: boolean }> }
    assert.deepEqual(none.data.map((entry) => entry.available), [false, false])
  })

  it('reports status and the data policy without signing in', async () => {
    const harness = await Harness.create({ env: { MIN_CLIENT_VERSION: '0.1.0' } })
    const body = (await (await harness.fetch(GatewayPaths.status)).json()) as Record<string, unknown>
    assert.equal(body.service, 'encode-gateway')
    assert.equal(body.api_version, 1)
    assert.deepEqual(body.free_tier, { available: true })
    assert.equal(body.min_client_version, '0.1.0')
    assert.match(String(body.data_policy), /may log prompts/)
  })
})
