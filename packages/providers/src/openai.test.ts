import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createAssembler } from './assembler'
import type { TransportEvent, TransportTarget } from './contract'
import { TransportError } from './errors'
import type { AssistantMessage, ModelRequest } from './messages'
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

  it('sends a PDF to a model that reads documents as a file after the tool message, and its text to one that does not', () => {
    const request: ModelRequest = {
      system: [],
      tools: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        { role: 'assistant', content: [{ type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a.pdf' } }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolUseId: 'call_1',
              content: [
                { type: 'text', text: 'PDF a.pdf: 2 pages.' },
                { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'a (page 2).pdf', pages: 1, text: '(Page 2 also has figures.)' },
              ],
            },
          ],
        },
      ],
    }
    const caps = { tools: true, parallelTools: true, images: true, reasoning: false, promptCache: false }
    const reads = buildChatBody(target({ capabilities: { ...caps, documents: true } }), request, false) as { messages: Array<Record<string, unknown>> }
    assert.deepEqual(reads.messages.slice(2), [
      { role: 'tool', tool_call_id: 'call_1', content: 'PDF a.pdf: 2 pages.' },
      { role: 'user', content: [{ type: 'file', file: { filename: 'a (page 2).pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } }] },
    ])
    const cannot = buildChatBody(target({ capabilities: caps }), request, false) as { messages: Array<Record<string, unknown>> }
    assert.deepEqual(cannot.messages.slice(2), [{ role: 'tool', tool_call_id: 'call_1', content: 'PDF a.pdf: 2 pages.\n\n(Page 2 also has figures.)' }])
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

describe('reasoning read and sent back by family (ADR 0099)', () => {
  const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })
  const results = (id: string) => ({ role: 'user' as const, content: [{ type: 'tool-result' as const, toolUseId: id, content: [{ type: 'text' as const, text: 'ok' }] }] })

  it("reads OpenRouter's details, a call's extra_content and a <think> block from the stream", async () => {
    replies.push(
      events(
        { choices: [{ delta: { reasoning: 'Read ', reasoning_details: [{ type: 'reasoning.text', text: 'Read ', index: 0, format: 'google-gemini-v1' }] } }] },
        { choices: [{ delta: { reasoning: 'it.', reasoning_details: [{ type: 'reasoning.text', text: 'it.', index: 0 }, { type: 'reasoning.encrypted', data: 'ENC', index: 1 }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' }, extra_content: { google: { thought_signature: 'S1' } } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ),
    )
    const { reply } = await run(createOpenAICompatibleAdapter(), target({ family: 'google', model: 'gemini-3-pro' }))
    assert.deepEqual(reply.message.content, [
      {
        type: 'thinking',
        text: 'Read it.',
        details: [
          { type: 'reasoning.text', text: 'Read it.', index: 0, format: 'google-gemini-v1' },
          { type: 'reasoning.encrypted', data: 'ENC', index: 1 },
        ],
      },
      { type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a' }, extra: { google: { thought_signature: 'S1' } } },
    ])

    replies.push(events({ choices: [{ delta: { content: '<think>Plan it' } }] }, { choices: [{ delta: { content: '.</think>\n\nDone.' }, finish_reason: 'stop' }] }))
    const tagged = await run(createOpenAICompatibleAdapter(), target({ family: 'minimax', model: 'MiniMax-M2' }))
    assert.deepEqual(tagged.reply.message.content, [
      { type: 'thinking', text: 'Plan it.' },
      { type: 'text', text: 'Done.' },
    ])
  })

  it('sends each family its own reasoning back, in its field, and other models’ never', () => {
    const own = (model: string, provider = 'local'): AssistantMessage => ({
      role: 'assistant',
      origin: { provider, model, family: 'other' },
      content: [
        { type: 'thinking', text: 'Think.', details: [{ type: 'reasoning.text', text: 'Think.', signature: 'sig', index: 0 }] },
        { type: 'text', text: 'Reading.' },
        { type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a' }, extra: { google: { thought_signature: 'S1' } } },
      ],
    })
    const history = (first: AssistantMessage, second: AssistantMessage): ModelRequest => ({
      system: [],
      tools: [],
      messages: [user('fix it'), first, results('call_1'), user('and the test'), second, results('call_1')],
    })
    const assistants = (body: Record<string, unknown>) => (body.messages as Array<Record<string, any>>).filter((message) => message.role === 'assistant')

    const deepseek = assistants(buildChatBody(target({ family: 'deepseek', model: 'deepseek-v4-pro' }), history(own('claude-x', 'other'), own('deepseek-v4-pro')), false))
    assert.deepEqual(
      deepseek.map((message) => message.reasoning_content),
      ['(This step was taken without reasoning that can be shown.)', 'Think.'],
    )
    assert.ok(deepseek.every((message) => !('extra_content' in message.tool_calls[0]) || message === deepseek[1]))

    const minimax = assistants(buildChatBody(target({ family: 'minimax', model: 'MiniMax-M2' }), history(own('MiniMax-M2'), own('MiniMax-M2')), false))
    assert.deepEqual(
      minimax.map((message) => message.content),
      ['<think>Think.</think>\n\nReading.', '<think>Think.</think>\n\nReading.'],
    )

    const gemini = assistants(buildChatBody(target({ family: 'google', model: 'gemini-3-pro' }), history(own('gpt-x'), own('gpt-x')), false))
    assert.equal(gemini[0].tool_calls[0].extra_content, undefined, 'an earlier turn is not checked')
    assert.deepEqual(gemini[1].tool_calls[0].extra_content, { google: { thought_signature: 'skip_thought_signature_validator' } })
    const signed = assistants(buildChatBody(target({ family: 'google', model: 'gemini-3-pro' }), history(own('gemini-3-pro'), own('gemini-3-pro')), false))
    assert.deepEqual(signed[1].tool_calls[0].extra_content, { google: { thought_signature: 'S1' } })

    const router = assistants(buildChatBody(target({ provider: 'openrouter', family: 'anthropic', model: 'anthropic/claude-x', providerType: 'openrouter' }), history(own('anthropic/claude-x', 'openrouter'), own('anthropic/claude-x', 'openrouter')), true))
    assert.equal(router[0].reasoning_details, undefined, 'an earlier turn')
    assert.deepEqual(router[1].reasoning_details, [{ type: 'reasoning.text', text: 'Think.', signature: 'sig', index: 0 }])

    const plain = assistants(buildChatBody(target({ family: 'openai', model: 'gpt-x' }), history(own('gpt-x'), own('gpt-x')), false))
    assert.ok(plain.every((message) => !('reasoning_content' in message) && !('reasoning' in message)), 'OpenAI is sent what it always was')
  })

  it('goes on with a tool-call loop on a server that, like DeepSeek in thinking mode, refuses a step without its reasoning', async () => {
    const strict: Reply = (response) => {
      const body = seen[seen.length - 1].body
      const missing = body.messages.some((message: Record<string, unknown>) => message.role === 'assistant' && typeof message.reasoning_content !== 'string')
      if (missing) json(400, { error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' } })(response)
      else events({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })(response)
    }
    const deepseek = target({ family: 'deepseek', model: 'deepseek-v4-pro', capabilities: { tools: true, parallelTools: true, images: false, reasoning: true, promptCache: false } })
    replies.push(
      events(
        { choices: [{ delta: { reasoning_content: 'Read a first.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' } }] }, finish_reason: 'tool_calls' }] },
      ),
      strict,
    )
    const first = await run(createOpenAICompatibleAdapter(), deepseek, { ...request, messages: [user('fix it')] })
    const second = await run(createOpenAICompatibleAdapter(), deepseek, { ...request, messages: [user('fix it'), first.reply.message, results('call_1')] })
    assert.deepEqual(second.reply.message.content, [{ type: 'text', text: 'Done.' }])
    assert.equal(seen[1].body.messages[2].reasoning_content, 'Read a first.')
  })

  it("sends a family's temperature for code when the person set none, and the person's when they did (ADR 0100)", () => {
    const temperature = (overrides: Partial<TransportTarget>, set?: number) =>
      (buildChatBody(target(overrides), { ...request, ...(set !== undefined ? { temperature: set } : {}) }, false) as { temperature?: number }).temperature
    assert.equal(temperature({ family: 'deepseek', model: 'deepseek-chat' }), 0)
    assert.equal(temperature({ family: 'deepseek', model: 'deepseek-chat' }, 0.4), 0.4)
    assert.equal(temperature({ family: 'qwen', model: 'qwen/qwen3-coder' }), 0.7)
    assert.equal(temperature({ family: 'qwen', model: 'qwen/qwen3-max' }), undefined)
    assert.equal(temperature({ family: 'zhipu', model: 'z-ai/glm-4.6' }), undefined)
    const reasoning = { tools: true, parallelTools: true, images: false, reasoning: true, promptCache: false }
    assert.equal(temperature({ family: 'deepseek', model: 'deepseek-reasoner', capabilities: reasoning }), undefined, 'a reasoning model keeps its own')
  })

  it('asks again without the reasoning when a server names its field as unknown, never on DeepSeek’s demand for it', async () => {
    const history: ModelRequest = {
      ...request,
      messages: [
        user('fix it'),
        { role: 'assistant', origin: { provider: 'local', model: 'kimi-k3', family: 'moonshot' }, content: [{ type: 'thinking', text: 'Think.' }, { type: 'tool-use', id: 'call_1', name: 'Read', input: {} }] },
        results('call_1'),
      ],
    }
    replies.push(json(400, { error: { message: 'Unrecognized request argument supplied: reasoning_content' } }), events({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }))
    await run(createOpenAICompatibleAdapter(), target({ family: 'moonshot', model: 'kimi-k3' }), history)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].body.messages[2].reasoning_content, 'Think.')
    assert.equal('reasoning_content' in seen[1].body.messages[2], false)

    replies.push(json(400, { error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' } }))
    await assert.rejects(run(createOpenAICompatibleAdapter(), target({ family: 'deepseek', model: 'deepseek-v4-pro' }), history))
    assert.equal(seen.length, 3, 'not sent again without it')
  })
})
