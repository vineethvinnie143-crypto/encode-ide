import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createAnthropicAdapter } from './anthropic'
import type { ProviderAdapter, StreamInput, TransportEvent, TransportTarget } from './contract'
import type { AssistantMessage, ModelRequest, ToolDefinition } from './messages'
import { createOpenAICompatibleAdapter, createOpenRouterAdapter } from './openai'
import { acceptableToolNames, acceptedToolName, acceptingToolNames, isAcceptedToolName, ToolNames } from './tool-names'

const WIRE = /^[a-zA-Z0-9_-]{1,64}$/

function tool(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: { type: 'object', properties: {} } }
}

function requestWith(names: string[], history: AssistantMessage[] = []): ModelRequest {
  return { system: [{ text: 'You are eNCode.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, ...history], tools: names.map(tool) }
}

function called(name: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'tool-use', id: 'call_1', name, input: {} }] }
}

describe('tool names', () => {
  it('leaves names the APIs accept alone, and the request with them', () => {
    const names = ['Read', 'Bash', 'mcp__github__create_issue', 'a-b_c', 'x'.repeat(64)]
    for (const name of names) assert.equal(acceptedToolName(name), name)
    const request = requestWith(names, [called('Read')])
    const result = acceptableToolNames(request)
    assert.equal(result.request, request, 'nothing to change: the same request comes back')
    assert.equal(result.names.renamed, false)
  })

  it('renames what does not fit to a name that does, readable and with a hash of the real name', () => {
    const wire = acceptedToolName('openrouter:shell')
    assert.match(wire, WIRE)
    assert.match(wire, /^openrouter_shell_[0-9a-f]{8}$/)
    for (const name of ['a.b', 'a b', 'a/b', 'é', '工具', 'x'.repeat(65), '', ':::', 'tool name with spaces and: punctuation!']) {
      const renamed = acceptedToolName(name)
      assert.match(renamed, WIRE, `"${name}" became "${renamed}"`)
      assert.equal(isAcceptedToolName(name), false)
    }
    assert.equal(isAcceptedToolName(acceptedToolName('x'.repeat(200))), true)
    assert.equal(acceptedToolName('x'.repeat(200)).length, 64)
  })

  it('gives the same wire name on every request, whatever else is in it', () => {
    const alone = acceptedToolName('openrouter:shell')
    const first = new ToolNames(['Read', 'openrouter:shell', 'a.b'])
    const second = new ToolNames(['a.b', 'openrouter:shell'])
    assert.equal(first.wire('openrouter:shell'), alone)
    assert.equal(second.wire('openrouter:shell'), alone)
    assert.equal(first.wire('Read'), 'Read')
  })

  it('keeps names that differ only in what was replaced apart', () => {
    const names = new ToolNames(['a:b', 'a.b', 'a b', 'a/b'])
    const wires = ['a:b', 'a.b', 'a b', 'a/b'].map((name) => names.wire(name))
    assert.equal(new Set(wires).size, 4)
    for (const wire of wires) assert.match(wire, WIRE)
  })

  it('never lets a renamed tool take a name another tool already has', () => {
    const taken = acceptedToolName('a:b')
    const names = new ToolNames(['a:b', taken])
    assert.equal(names.wire(taken), taken, 'the name that fits keeps its own')
    assert.notEqual(names.wire('a:b'), taken)
    assert.match(names.wire('a:b'), WIRE)
    assert.equal(names.real(names.wire('a:b')), 'a:b')
    assert.equal(names.real(taken), taken)
  })

  it('maps the model\'s calls back, and leaves a name it made up as it was', () => {
    const names = new ToolNames(['openrouter:shell', 'Read'])
    assert.equal(names.real(names.wire('openrouter:shell')), 'openrouter:shell')
    assert.equal(names.real('Read'), 'Read')
    assert.equal(names.real('not_a_tool'), 'not_a_tool')
  })

  it('renames the tools and the earlier calls in the history together', () => {
    const request = requestWith(['openrouter:shell', 'Read'], [called('openrouter:shell'), called('Read')])
    const { request: renamed, names } = acceptableToolNames(request)
    assert.equal(names.renamed, true)
    const wire = names.wire('openrouter:shell')
    assert.deepEqual(renamed.tools.map((entry) => entry.name), [wire, 'Read'])
    const history = renamed.messages.slice(1).map((message) => (message.role === 'assistant' ? message.content[0] : null))
    assert.deepEqual(history.map((block) => (block?.type === 'tool-use' ? block.name : null)), [wire, 'Read'])
    // The request that came in is not touched, and what is not renamed is shared.
    assert.equal(request.tools[0].name, 'openrouter:shell')
    assert.equal(renamed.tools[1], request.tools[1])
    assert.equal(renamed.messages[2], request.messages[2])
  })

  it('renames a call in the history whose tool is no longer offered', () => {
    const { request, names } = acceptableToolNames(requestWith(['Read'], [called('old.tool')]))
    const block = (request.messages[1] as AssistantMessage).content[0]
    assert.ok(block.type === 'tool-use' && WIRE.test(block.name))
    assert.equal(names.real((block as { name: string }).name), 'old.tool')
  })
})

describe('an adapter that accepts any tool name', () => {
  function recording(events: TransportEvent[]) {
    const seen: StreamInput[] = []
    let closed = false
    const adapter: ProviderAdapter = {
      type: 'openai-compatible',
      stream(input) {
        seen.push(input)
        return (async function* () {
          try {
            for (const event of events) yield event
          } finally {
            closed = true
          }
        })()
      },
    }
    return { adapter, seen, closed: () => closed }
  }

  const input = (request: ModelRequest): StreamInput => ({ target: undefined as never, request, signal: new AbortController().signal })

  async function collect(stream: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
    const out: TransportEvent[] = []
    for await (const event of stream) out.push(event)
    return out
  }

  it('sends valid names and hands back the real one in the call', async () => {
    const wire = acceptedToolName('openrouter:shell')
    const { adapter, seen } = recording([
      { type: 'text', text: 'Running.' },
      { type: 'tool-call', index: 0, id: 'call_1', name: wire, arguments: '{"a":' },
      { type: 'tool-call', index: 0, arguments: '1}' },
      { type: 'finish', reason: 'tool_use' },
    ])
    const events = await collect(acceptingToolNames(adapter).stream(input(requestWith(['openrouter:shell', 'Read']))))
    assert.deepEqual(seen[0].request.tools.map((entry) => entry.name), [wire, 'Read'])
    assert.deepEqual(events[1], { type: 'tool-call', index: 0, id: 'call_1', name: 'openrouter:shell', arguments: '{"a":' })
    assert.deepEqual(events[2], { type: 'tool-call', index: 0, arguments: '1}' }, 'a piece without a name is untouched')
    assert.equal(events.length, 4)
  })

  it('passes a request that needs no renaming straight through', async () => {
    const { adapter, seen } = recording([{ type: 'finish', reason: 'stop' }])
    const request = requestWith(['Read'])
    await collect(acceptingToolNames(adapter).stream(input(request)))
    assert.equal(seen[0].request, request)
  })

  it('closes the adapter\'s stream when the caller stops reading', async () => {
    const { adapter, closed } = recording([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
    for await (const _ of acceptingToolNames(adapter).stream(input(requestWith(['a:b'])))) break
    assert.equal(closed(), true)
  })

  it('has the type of the adapter it wraps', () => {
    assert.equal(acceptingToolNames({ type: 'anthropic', stream: () => (async function* () {})() }).type, 'anthropic')
  })
})

describe('on the wire', () => {
  let server: http.Server
  let baseUrl = ''
  let reply: (response: http.ServerResponse) => void = () => {}
  let seen: Array<Record<string, any>> = []

  before(async () => {
    server = http.createServer(async (request, response) => {
      let raw = ''
      for await (const part of request) raw += part
      seen.push(JSON.parse(raw))
      reply(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    seen = []
  })

  function target(overrides: Partial<TransportTarget>): TransportTarget {
    return {
      key: 'p:m',
      provider: 'p',
      providerType: 'openai-compatible',
      baseUrl,
      model: 'm',
      family: 'other',
      apiKey: 'sk-test',
      maxOutputTokens: 4096,
      capabilities: { tools: true, parallelTools: true, images: false, reasoning: false, promptCache: false },
      ...overrides,
    }
  }

  async function toolCalls(adapter: ProviderAdapter, t: TransportTarget, request: ModelRequest) {
    const calls: string[] = []
    for await (const event of adapter.stream({ target: t, request, signal: new AbortController().signal })) if (event.type === 'tool-call' && event.name) calls.push(event.name)
    return calls
  }

  const history = [called('openrouter:shell')]

  for (const [label, create, providerType] of [
    ['an OpenAI-compatible server', createOpenAICompatibleAdapter, 'openai-compatible'],
    ['OpenRouter', createOpenRouterAdapter, 'openrouter'],
  ] as const) {
    it(`${label} gets valid function names and the call comes back under the real one`, async () => {
      const wire = acceptedToolName('openrouter:shell')
      reply = (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: wire, arguments: '{}' } }] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }
      const calls = await toolCalls(create(), target({ providerType, baseUrl: `${baseUrl}/v1` }), requestWith(['openrouter:shell', 'Read'], history))
      assert.deepEqual(calls, ['openrouter:shell'])
      const body = seen[0]
      assert.deepEqual(body.tools.map((entry: any) => entry.function.name), [wire, 'Read'])
      for (const entry of body.tools) assert.match(entry.function.name, WIRE)
      const sent = body.messages.find((message: any) => message.tool_calls)
      assert.equal(sent.tool_calls[0].function.name, wire, 'the earlier call is renamed the same way')
    })
  }

  it('Anthropic gets valid tool names and the call comes back under the real one', async () => {
    const wire = acceptedToolName('openrouter:shell')
    reply = (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (name: string, data: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: wire, input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      send('message_stop', { type: 'message_stop' })
      response.end()
    }
    const t = target({ providerType: 'anthropic', family: 'anthropic', model: 'claude-opus-5-5', capabilities: { tools: true, parallelTools: true, images: true, reasoning: true, promptCache: true } })
    const calls = await toolCalls(createAnthropicAdapter(), t, requestWith(['openrouter:shell', 'Read'], history))
    assert.deepEqual(calls, ['openrouter:shell'])
    const body = seen[0]
    assert.deepEqual(body.tools.map((entry: any) => entry.name), [wire, 'Read'])
    const sent = body.messages.find((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_use'))
    assert.equal(sent.content.find((block: any) => block.type === 'tool_use').name, wire)
  })
})
