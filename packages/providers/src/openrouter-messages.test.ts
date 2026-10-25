import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createAssembler } from './assembler'
import type { TransportEvent, TransportTarget } from './contract'
import { SERVER_TOOL_REFUSED_CODE, TransportError } from './errors'
import type { ModelRequest } from './messages'
import { createOpenRouterAdapter } from './openai'

type Reply = (response: http.ServerResponse) => void

let server: http.Server
let baseUrl = ''
/** What the server answers, by path, in order. */
let replies: Record<string, Reply[]> = {}
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }> = []

before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    const path = request.url ?? ''
    seen.push({ path, headers: request.headers, body: JSON.parse(raw) })
    const reply = replies[path]?.shift()
    if (reply) reply(response)
    else response.writeHead(500).end(`no reply queued for ${path}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

after(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  replies = {}
  seen = []
})

const CHAT = '/api/v1/chat/completions'
const MESSAGES = '/api/v1/messages'

const json =
  (status: number, payload: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  }

const sse =
  (...events: Array<[string, unknown]>): Reply =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  }

/** As OpenRouter answered a model called through `@preset/...` that has its Shell tool on. */
const SHELL_REFUSED = (apis = 'responses, anthropic-messages') =>
  json(400, {
    error: {
      message: `Tool 'openrouter:shell' is not available for the 'chat-completions' API. It is only supported for: ${apis}.`,
      code: 400,
      metadata: { provider_name: null },
    },
  })

const answer = (text: string): Reply =>
  sse(
    ['message_start', { type: 'message_start', message: { model: 'anthropic/claude-sonnet-4.5', usage: { input_tokens: 30, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  )

function target(overrides: Partial<TransportTarget> = {}): TransportTarget {
  return {
    key: 'openrouter:@preset/dev',
    provider: 'openrouter',
    providerType: 'openrouter',
    baseUrl,
    model: '@preset/dev',
    family: 'other',
    apiKey: 'sk-or-test-key',
    maxOutputTokens: 8192,
    capabilities: { tools: true, parallelTools: true, images: false, reasoning: false, promptCache: false },
    ...overrides,
  }
}

const request: ModelRequest = {
  system: [{ text: 'You are eNCode.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  maxOutputTokens: 2000,
  reasoning: 'high',
}

async function run(adapter = createOpenRouterAdapter(), t = target(), r = request, signal = new AbortController().signal) {
  const events: TransportEvent[] = []
  for await (const event of adapter.stream({ target: t, request: r, signal })) events.push(event)
  const assembler = createAssembler({ origin: { provider: t.provider, model: t.model, family: t.family } })
  for (const event of events) assembler.push(event)
  return { events, reply: assembler.finish() }
}

describe("OpenRouter's Messages API for a preset's server tool", () => {
  it('asks the Messages API when chat-completions refuses the tool, and streams that answer', async () => {
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [answer('Listing the files.')] }
    const { reply } = await run()
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'Listing the files.' }])
    assert.equal(reply.finish, 'stop')
    assert.deepEqual(reply.usage, { inputTokens: 30, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES])
  })

  it('sends the same model and conversation in Anthropic form, with the key as a bearer token', async () => {
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [answer('ok')] }
    await run()
    const [, call] = seen
    assert.equal(call.headers.authorization, 'Bearer sk-or-test-key')
    assert.equal(call.headers['x-api-key'], undefined, 'the key travels once, in the header OpenRouter documents')
    assert.equal(call.headers['x-title'], 'eNCode IDE')
    assert.equal(call.body.model, '@preset/dev')
    assert.equal(call.body.stream, true)
    assert.equal(call.body.max_tokens, 2000)
    assert.deepEqual(call.body.system, [{ type: 'text', text: 'You are eNCode.' }])
    assert.deepEqual(call.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    assert.equal(call.body.tools[0].name, 'Read')
    assert.deepEqual(call.body.tools[0].input_schema, request.tools[0].inputSchema)
  })

  it("names the conversation in OpenRouter's x-session-id header there (ADR 0128)", async () => {
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [answer('ok')] }
    await run(createOpenRouterAdapter(), target(), { ...request, cacheKey: 'encode-abc' })
    const [chat, messages] = seen
    assert.equal(chat.body.session_id, 'encode-abc')
    assert.equal(messages.headers['x-session-id'], 'encode-abc')
    assert.equal(messages.body.session_id, undefined)
  })

  it('leaves out thinking, effort and sampling, which OpenRouter does not document for this endpoint', async () => {
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [answer('ok')] }
    const claude = target({ model: 'anthropic/claude-opus-5-5', family: 'anthropic', capabilities: { tools: true, parallelTools: true, images: true, reasoning: true, promptCache: true } })
    await run(createOpenRouterAdapter(), claude, { ...request, temperature: 0.2 })
    const { body } = seen[1]
    assert.equal(body.thinking, undefined)
    assert.equal(body.output_config, undefined)
    assert.equal(body.temperature, undefined)
    // Prompt-cache marks are documented for Claude models there, so they stay.
    assert.ok(body.system.some((part: any) => part.cache_control))
  })

  it('asks the Messages API first from then on, for a while', async () => {
    let clock = 1_000_000
    const adapter = createOpenRouterAdapter({ now: () => clock })
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [answer('one'), answer('two'), answer('three')] }
    await run(adapter)
    await run(adapter)
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES, MESSAGES], 'the second call does not try chat-completions again')
    clock += 31 * 60_000
    replies[CHAT] = [SHELL_REFUSED()]
    await run(adapter)
    assert.deepEqual(seen.slice(3).map((call) => call.path), [CHAT, MESSAGES], 'chat-completions is tried again once the memory has run out')
  })

  it('remembers each model on its own', async () => {
    const adapter = createOpenRouterAdapter()
    replies = { [CHAT]: [SHELL_REFUSED(), json(200, { choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }], usage: {} })], [MESSAGES]: [answer('ok')] }
    await run(adapter)
    const { reply } = await run(adapter, target({ key: 'openrouter:other', model: 'other/model' }))
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'plain' }])
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES, CHAT])
  })

  it('does not ask the Messages API when the refusal names other APIs only', async () => {
    replies = { [CHAT]: [SHELL_REFUSED('responses')] }
    await assert.rejects(run(), (error: TransportError) => error.code === SERVER_TOOL_REFUSED_CODE && /openrouter:shell/.test(error.message))
    assert.deepEqual(seen.map((call) => call.path), [CHAT])
  })

  it('asks the Messages API when the refusal does not say which APIs take the tool', async () => {
    replies = {
      [CHAT]: [json(400, { error: { message: "Tool 'openrouter:shell' is not available for the 'chat-completions' API", code: 400 } })],
      [MESSAGES]: [answer('ok')],
    }
    const { reply } = await run()
    assert.equal(reply.message.content[0].type, 'text')
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES])
  })

  it('keeps the refusal when the Messages API fails too, and adds what it said, without reading it as a bad key', async () => {
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [json(401, { error: { type: 'authentication_error', message: 'No auth credentials found' } })] }
    await assert.rejects(run(), (error: TransportError) => {
      assert.equal(error.kind, 'invalid-request', 'the key works on chat-completions: it is not set aside as revoked')
      assert.equal(error.code, SERVER_TOOL_REFUSED_CODE)
      assert.match(error.message, /openrouter:shell/)
      assert.match(error.message, /Messages API, which answered: HTTP 401: No auth credentials found/)
      assert.doesNotMatch(error.message, /sk-or-test-key/)
      return true
    })
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES])
  })

  it('does not remember a Messages API that did not answer', async () => {
    const adapter = createOpenRouterAdapter()
    replies = { [CHAT]: [SHELL_REFUSED(), SHELL_REFUSED()], [MESSAGES]: [json(500, { error: { message: 'boom' } }), answer('ok')] }
    await assert.rejects(run(adapter))
    await run(adapter)
    assert.deepEqual(seen.map((call) => call.path), [CHAT, MESSAGES, CHAT, MESSAGES])
  })

  it('leaves other failures of chat-completions alone', async () => {
    replies = { [CHAT]: [json(429, { error: { message: 'Provider returned error', code: 429 } })] }
    await assert.rejects(run(), (error: TransportError) => error.kind === 'rate-limit')
    assert.deepEqual(seen.map((call) => call.path), [CHAT])
  })

  it('reports a failure in the middle of the Messages stream as that stream failing', async () => {
    replies = {
      [CHAT]: [SHELL_REFUSED()],
      [MESSAGES]: [
        sse(
          ['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } }],
          ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
        ),
      ],
    }
    await assert.rejects(run(), (error: TransportError) => error.kind === 'overloaded' && !/Messages API, which answered/.test(error.message))
  })

  it('does not fall back once the caller has stopped', async () => {
    const controller = new AbortController()
    replies = { [CHAT]: [SHELL_REFUSED()] }
    controller.abort(new Error('stopped'))
    await assert.rejects(run(createOpenRouterAdapter(), target(), request, controller.signal), /stopped/)
    assert.deepEqual(seen, [])
  })

  it('renames a tool the APIs do not accept, and maps the call back, on the Messages API too', async () => {
    const odd = 'github.search/issues'
    // The server names the call as it was sent it: the wire name is read from the request.
    const callTheTool: Reply = (response) =>
      sse(
        ['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: seen[1].body.tools[0].name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }],
      )(response)
    replies = { [CHAT]: [SHELL_REFUSED()], [MESSAGES]: [callTheTool] }
    const { reply } = await run(createOpenRouterAdapter(), target(), { ...request, tools: [{ name: odd, description: 'Search', inputSchema: { type: 'object' } }] })
    assert.match(seen[1].body.tools[0].name, /^[A-Za-z0-9_-]{1,64}$/)
    assert.deepEqual(reply.message.content, [{ type: 'tool-use', id: 'toolu_1', name: odd, input: {} }])
  })
})
