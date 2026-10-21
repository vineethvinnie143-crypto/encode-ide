import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createAssembler } from './assembler'
import type { TransportEvent, TransportTarget } from './contract'
import { TransportError } from './errors'
import type { ModelRequest } from './messages'
import { buildChatBody, createOpenAICompatibleAdapter, createOpenRouterAdapter } from './openai'

type Reply = (response: http.ServerResponse) => void

let server: http.Server
let baseUrl = ''
let replies: Reply[] = []
let seen: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, any> }> = []

before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    seen.push({ headers: request.headers, body: JSON.parse(raw) })
    const reply = replies.shift()
    if (reply) reply(response)
    else response.writeHead(500).end('no reply queued')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

after(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  replies = []
  seen = []
})

const json =
  (status: number, payload: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  }

const events =
  (...chunks: unknown[]): Reply =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) response.write(typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}\n\n`)
    response.end('data: [DONE]\n\n')
  }

function target(overrides: Partial<TransportTarget> = {}): TransportTarget {
  return {
    key: 'local:m',
    provider: 'local',
    providerType: 'openai-compatible',
    baseUrl,
    model: 'm',
    family: 'other',
    apiKey: 'sk-test-key',
    maxOutputTokens: 4096,
    capabilities: { tools: true, parallelTools: true, images: false, reasoning: false, promptCache: false },
    ...overrides,
  }
}

const request: ModelRequest = {
  system: [{ text: 'You are eNCode.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
}

async function run(adapter = createOpenAICompatibleAdapter(), t = target(), r = request) {
  const events: TransportEvent[] = []
  for await (const event of adapter.stream({ target: t, request: r, signal: new AbortController().signal })) events.push(event)
  const assembler = createAssembler({ origin: { provider: t.provider, model: t.model, family: t.family } })
  for (const event of events) assembler.push(event)
  return { events, reply: assembler.finish() }
}

describe('OpenAI-compatible adapter', () => {
  it('streams text, reasoning, split tool calls and the usage tail', async () => {
    replies = [
      events(
        ': keepalive\n\n',
        { model: 'm-served', choices: [{ delta: { reasoning_content: 'thinking…' } }] },
        { choices: [{ delta: { content: 'Reading it.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
      ),
    ]
    const { events: streamed, reply } = await run()
    assert.ok(streamed.some((event) => event.type === 'keepalive'))
    assert.deepEqual(reply.message.content, [
      { type: 'thinking', text: 'thinking…' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    assert.equal(reply.message.origin?.model, 'm-served')
    assert.equal(reply.finish, 'tool_use')
    assert.deepEqual(reply.usage, { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 })
    assert.equal(seen[0].headers.authorization, 'Bearer sk-test-key')
    assert.equal(seen[0].body.stream, true)
    assert.deepEqual(seen[0].body.stream_options, { include_usage: true })
    assert.equal(seen[0].body.tool_choice, 'auto')
  })

  it('reads a server that ignores stream: true and answers with one JSON body', async () => {
    replies = [
      json(200, {
        model: 'm',
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', function: { name: 'Read', arguments: { file_path: 'b.ts' } } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]
    const { reply } = await run()
    assert.deepEqual(reply.message.content, [{ type: 'tool-use', id: 'call_9', name: 'Read', input: { file_path: 'b.ts' } }])
  })

  it('asks again without streaming when the server says it cannot stream', async () => {
    replies = [
      json(400, { error: { message: 'Streaming is not supported by this endpoint' } }),
      json(200, { choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }] }),
    ]
    const { reply } = await run()
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'plain' }])
    assert.equal(seen.length, 2)
    assert.equal(seen[1].body.stream, false)
    assert.equal(seen[1].body.stream_options, undefined)
  })

  it('drops an optional parameter the server names as unknown, and lowers max_tokens to its limit', async () => {
    replies = [
      json(400, { error: { message: "Unrecognized request argument supplied: stream_options" } }),
      json(400, { error: { message: 'max_tokens is too large: 4096. This model supports at most 2048 completion tokens.' } }),
      events({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    ]
    const { reply } = await run(undefined, undefined, { ...request, maxOutputTokens: 8000 })
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'ok' }])
    assert.equal(seen[0].body.max_tokens, 4096, 'clamped to the target limit')
    assert.equal(seen[1].body.stream_options, undefined)
    assert.equal(seen[2].body.max_tokens, 2048)
  })

  it('does not resend a prompt that is too long, and reports its numbers', async () => {
    replies = [json(400, { error: { message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens." } })]
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TransportError)
      assert.equal(error.kind, 'context-overflow')
      assert.equal(error.window, 8192)
      assert.equal(error.used, 9000)
      return true
    })
    assert.equal(seen.length, 1)
  })

  it('fails a stream that ends before the reply finished', async () => {
    replies = [
      (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\n`)
      },
    ]
    await assert.rejects(run(), (error: unknown) => error instanceof TransportError && error.kind === 'protocol')
  })

  it('surfaces an error chunk inside the stream with its kind', async () => {
    replies = [events({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } })]
    await assert.rejects(run(), (error: unknown) => error instanceof TransportError && error.kind === 'quota')
  })

  it("passes OpenRouter's fallbacks, data policy and attribution", async () => {
    replies = [events({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]
    await run(createOpenRouterAdapter(), target({ providerType: 'openrouter', serverFallbacks: ['b:free', 'm', 'c:free'], dataCollection: 'deny' }))
    const { headers, body } = seen[0]
    assert.equal(headers['x-title'], 'eNCode IDE')
    assert.ok(headers['http-referer'])
    assert.deepEqual(body.models, ['m', 'b:free', 'c:free'])
    assert.deepEqual(body.provider, { data_collection: 'deny' })
    assert.deepEqual(body.usage, { include: true })
  })
})

describe('buildChatBody', () => {
  const history: ModelRequest = {
    system: [{ text: 'stable', cache: true }, { text: 'today is Wednesday' }],
    tools: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        origin: { provider: 'a', model: 'claude-x', family: 'anthropic' },
        content: [
          { type: 'thinking', text: 'secret', signature: 'sig' },
          { type: 'text', text: 'Sure.' },
          { type: 'tool-use', id: 'toolu_01', name: 'Read', input: { file_path: 'a.png' } },
          { type: 'tool-use', id: 'toolu_02', name: 'Write', input: {}, invalid: { raw: '{"file_path": "x', error: 'bad' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolUseId: 'toolu_01', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
          { type: 'tool-result', toolUseId: 'toolu_02', content: [{ type: 'text', text: 'invalid JSON' }], isError: true },
          { type: 'text', text: '<reminder>todo list is empty</reminder>' },
        ],
      },
    ],
  }

  it('turns tool results into tool messages, moves their images after them, and never sends other models’ thinking', () => {
    const body = buildChatBody(target({ capabilities: { tools: true, parallelTools: true, images: true, reasoning: false, promptCache: false } }), history, false)
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'stable\n\ntoday is Wednesday' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'Sure.',
        tool_calls: [
          { id: 'toolu_01', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.png"}' } },
          { id: 'toolu_02', type: 'function', function: { name: 'Write', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_01', content: '(The result is the image below.)' },
      { role: 'tool', tool_call_id: 'toolu_02', content: 'invalid JSON' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: '<reminder>todo list is empty</reminder>' },
        ],
      },
    ])
  })

  it("rewrites ids into Mistral's nine-character form, the same way for calls and results", () => {
    const body = buildChatBody(target({ family: 'mistral' }), history, false) as { messages: Array<Record<string, any>> }
    const call = body.messages[2].tool_calls[0].id
    assert.match(call, /^[A-Za-z0-9]{9}$/)
    assert.equal(body.messages[3].tool_call_id, call)
  })

  it('marks cache breakpoints through OpenRouter for models that take them', () => {
    const body = buildChatBody(
      target({ providerType: 'openrouter', family: 'anthropic', capabilities: { tools: true, parallelTools: true, images: true, reasoning: true, promptCache: true } }),
      history,
      true,
    ) as { messages: Array<Record<string, any>> }
    const marks = JSON.stringify(body.messages).match(/cache_control/g) ?? []
    assert.ok(marks.length >= 2 && marks.length <= 4, `got ${marks.length} breakpoints`)
    assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' })
    assert.equal(body.messages[0].content[1].cache_control, undefined)
  })

  it('describes images as text for a model that cannot read them', () => {
    const body = buildChatBody(target(), history, false) as { messages: Array<Record<string, any>> }
    assert.match(JSON.stringify(body.messages[5]), /cannot read images/)
  })
})
