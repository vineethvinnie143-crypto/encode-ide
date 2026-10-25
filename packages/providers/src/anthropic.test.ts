import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { anthropicToolId, buildAnthropicBody, createAnthropicAdapter, toAnthropicMessages } from './anthropic'
import { createAssembler } from './assembler'
import type { TransportEvent, TransportTarget } from './contract'
import { TransportError } from './errors'
import type { ModelRequest } from './messages'

type Reply = (response: http.ServerResponse) => void

let server: http.Server
let baseUrl = ''
let replies: Reply[] = []
let seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }> = []

before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    seen.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(raw) })
    const reply = replies.shift()
    if (reply) reply(response)
    else response.writeHead(500).end('no reply queued')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  replies = []
  seen = []
})

const sse =
  (...events: Array<[string, unknown]>): Reply =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  }

const json =
  (status: number, payload: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  }

const CAPS = { tools: true, parallelTools: true, images: true, reasoning: true, promptCache: true }

function target(overrides: Partial<TransportTarget> = {}): TransportTarget {
  return {
    key: 'anthropic:claude-opus-5-5',
    provider: 'anthropic',
    providerType: 'anthropic',
    baseUrl,
    model: 'claude-opus-5-5',
    family: 'anthropic',
    apiKey: 'sk-ant-test',
    maxOutputTokens: 128_000,
    capabilities: CAPS,
    ...overrides,
  }
}

const request: ModelRequest = {
  system: [{ text: 'You are eNCode.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
}

async function run(t = target(), r = request) {
  const events: TransportEvent[] = []
  for await (const event of createAnthropicAdapter().stream({ target: t, request: r, signal: new AbortController().signal })) events.push(event)
  const assembler = createAssembler({ origin: { provider: t.provider, model: t.model, family: t.family } })
  for (const event of events) assembler.push(event)
  return { events, reply: assembler.finish() }
}

describe('Anthropic adapter', () => {
  it('streams thinking with its signature, text, a tool call and usage', async () => {
    replies = [
      sse(
        ['message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan: read.' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['ping', { type: 'ping' }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading.' } }],
        ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 55 } }],
        ['message_stop', { type: 'message_stop' }],
      ),
    ]
    const { events, reply } = await run()
    assert.ok(events.some((event) => event.type === 'keepalive'))
    assert.deepEqual(reply.message.content, [
      { type: 'thinking', text: 'Plan: read.', signature: 'SIG' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool-use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    assert.equal(reply.finish, 'tool_use')
    assert.deepEqual(reply.usage, { inputTokens: 1000, outputTokens: 55, cacheReadTokens: 900, cacheWriteTokens: 80 })
    assert.equal(seen[0].url, '/v1/messages')
    assert.equal(seen[0].headers['x-api-key'], 'sk-ant-test')
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01')
  })

  it('fails on an error event mid-stream, classified', async () => {
    replies = [
      sse(
        ['message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }],
        ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
      ),
    ]
    await assert.rejects(run(), (error: unknown) => error instanceof TransportError && error.kind === 'overloaded')
  })

  it('fails a stream cut off before message_stop', async () => {
    replies = [sse(['message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }])]
    await assert.rejects(run(), (error: unknown) => error instanceof TransportError && error.kind === 'protocol')
  })

  it('drops thinking bound to another conversation and asks once more', async () => {
    const history: ModelRequest = {
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', origin: { provider: 'anthropic', model: 'claude-opus-5-5', family: 'anthropic' }, content: [{ type: 'thinking', text: 't', signature: 'old' }, { type: 'text', text: 'Hello.' }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    }
    replies = [
      json(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block.' },
      }),
      sse(
        ['message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ),
    ]
    const { reply } = await run(target(), history)
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'ok' }])
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[1].body.messages[1].content, [{ type: 'text', text: 'Hello.' }])
  })
})

describe('buildAnthropicBody', () => {
  const history: ModelRequest = {
    system: [{ text: 'stable rules', cache: true }, { text: 'environment' }],
    tools: request.tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      {
        role: 'assistant',
        origin: { provider: 'deepseek', model: 'deepseek-reasoner', family: 'deepseek' },
        content: [
          { type: 'thinking', text: 'not for claude' },
          { type: 'tool-use', id: 'functions.Read:0', name: 'Read', input: { file_path: 'a' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '<reminder>note</reminder>' },
          { type: 'tool-result', toolUseId: 'functions.Read:0', content: [{ type: 'text', text: 'file body' }] },
        ],
      },
      {
        role: 'assistant',
        origin: { provider: 'anthropic', model: 'claude-opus-5-5', family: 'anthropic' },
        content: [
          { type: 'thinking', text: 'mine', signature: 'S1' },
          { type: 'redacted-thinking', data: 'R' },
          { type: 'text', text: 'Done.' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ],
  }

  it("keeps Claude's thinking byte for byte, drops other families', and puts tool results first", () => {
    const messages = toAnthropicMessages(history)
    const id = anthropicToolId('functions.Read:0')
    assert.match(id, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(messages[1].content, [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a' } }])
    assert.deepEqual(messages[2].content, [
      { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'file body' }] },
      { type: 'text', text: '<reminder>note</reminder>' },
    ])
    assert.deepEqual(messages[3].content, [
      { type: 'thinking', thinking: 'mine', signature: 'S1' },
      { type: 'redacted_thinking', data: 'R' },
      { type: 'text', text: 'Done.' },
    ])
  })

  it('puts a PDF inside its tool result for a model that reads documents, and its text otherwise', () => {
    const withDocument: ModelRequest = {
      system: [],
      tools: [],
      messages: [
        { role: 'assistant', content: [{ type: 'tool-use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.pdf' } }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolUseId: 'toolu_1',
              content: [
                { type: 'text', text: 'PDF a.pdf: 2 pages.' },
                { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'a (page 2).pdf', pages: 1, text: '(Page 2 also has figures.)' },
              ],
            },
          ],
        },
      ],
    }
    const reads = buildAnthropicBody(target({ capabilities: { ...CAPS, documents: true } }), withDocument) as { messages: Array<{ content: unknown[] }> }
    assert.deepEqual(reads.messages[1].content[0], {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      cache_control: { type: 'ephemeral' },
      content: [
        { type: 'text', text: 'PDF a.pdf: 2 pages.' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      ],
    })
    const cannot = toAnthropicMessages(withDocument)
    assert.deepEqual(cannot[1].content[0], {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [
        { type: 'text', text: 'PDF a.pdf: 2 pages.' },
        { type: 'text', text: '(Page 2 also has figures.)' },
      ],
    })
  })

  it('uses adaptive thinking with summarized display and effort on new models, and no sampling parameters', () => {
    const body = buildAnthropicBody(target(), { ...history, reasoning: 'xhigh', temperature: 0.2 })
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.output_config, { effort: 'xhigh' })
    assert.equal(body.temperature, undefined)
    assert.equal(body.max_tokens, 32_000)
  })

  it('gives an older model a thinking budget only when asked, and its temperature otherwise', () => {
    const haiku = target({ model: 'claude-haiku-4-5', maxOutputTokens: 64_000 })
    const thinking = buildAnthropicBody(haiku, { ...history, messages: history.messages.slice(0, 1), reasoning: 'medium' })
    assert.deepEqual(thinking.thinking, { type: 'enabled', budget_tokens: 8192 })
    assert.equal(thinking.output_config, undefined)
    const plain = buildAnthropicBody(haiku, { ...history, temperature: 0.3 })
    assert.equal(plain.thinking, undefined)
    assert.equal(plain.temperature, 0.3)
  })

  it('leaves thinking off when the open tool turn of an older model started without it', () => {
    const haiku = target({ model: 'claude-haiku-4-5', maxOutputTokens: 64_000 })
    const body = buildAnthropicBody(haiku, { ...history, messages: history.messages.slice(0, 3), reasoning: 'high' })
    assert.equal(body.thinking, undefined)
  })

  it('marks at most four cache breakpoints: the stable system part and the latest user turns', () => {
    const body = buildAnthropicBody(target(), history) as Record<string, any>
    const marks = JSON.stringify(body).match(/cache_control/g) ?? []
    assert.equal(marks.length, 3)
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
    assert.equal(body.system[1].cache_control, undefined)
    assert.deepEqual(body.messages[4].content[0].cache_control, { type: 'ephemeral' })
    assert.deepEqual(body.messages[2].content[1].cache_control, { type: 'ephemeral' })
  })

  it('gives every mark the hour-long lifetime when the request asks for it, and only for Claude (ADR 0128)', () => {
    const body = buildAnthropicBody(target(), { ...history, cacheTtl: '1h' }) as Record<string, any>
    const marks = [...JSON.stringify(body).matchAll(/"cache_control":(\{[^}]*\})/g)].map((match) => JSON.parse(match[1]!))
    assert.equal(marks.length, 3)
    for (const mark of marks) assert.deepEqual(mark, { type: 'ephemeral', ttl: '1h' })
    const other = buildAnthropicBody(target({ family: 'deepseek' }), { ...history, cacheTtl: '1h' }) as Record<string, any>
    assert.doesNotMatch(JSON.stringify(other), /"ttl"/, "another model behind a Messages endpoint is not asked for Claude's lifetime")
  })

  it("asks for eager tool input streaming only from Anthropic's own endpoint", () => {
    const direct = buildAnthropicBody(target({ baseUrl: 'https://api.anthropic.com' }), history) as Record<string, any>
    assert.equal(direct.tools[0].eager_input_streaming, true)
    const proxied = buildAnthropicBody(target(), history) as Record<string, any>
    assert.equal(proxied.tools[0].eager_input_streaming, undefined)
  })
})
