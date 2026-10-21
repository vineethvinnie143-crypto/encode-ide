import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VirtualModels } from '@encode/gateway-protocol'
import { check, gen, type Gen } from '@encode/testkit'
import { parseConfig } from './config'
import { GatewayError } from './errors'
import { assertFreeOnly, isFreeModelId, sanitizeChatRequest } from './firewall'

const parsed = parseConfig({ OPENROUTER_API_KEY: 'sk-or-v1-test', GATEWAY_SECRET: 'a-gateway-secret-of-at-least-32-characters' })
assert.ok(parsed.ok)
const LIMITS = parsed.config.request

function sanitize(raw: unknown) {
  return sanitizeChatRequest(raw, LIMITS)
}

function refusal(raw: unknown): string {
  try {
    sanitize(raw)
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected a GatewayError, got ${String(error)}`)
    return `${error.code}: ${error.message}`
  }
  return 'accepted'
}

/** The body the proxy assembles from a sanitized request. */
function upstreamBody(raw: unknown, models = ['acme/big:free', 'acme/medium:free']): Record<string, unknown> {
  const chat = sanitize(raw)
  return { model: models[0], models, ...chat.fields, stream: true, stream_options: { include_usage: true }, user: 'log-id' }
}

const ALLOWED = new Set(['model', 'models', 'messages', 'max_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'seed', 'response_format', 'reasoning', 'stream', 'stream_options', 'user'])

/** Fields OpenRouter acts on that could reach a paid model or a paid feature, or that the gateway owns. */
const DANGEROUS: Record<string, unknown> = {
  models: ['openai/gpt-5', 'anthropic/claude-opus'],
  provider: { order: ['OpenAI'], allow_fallbacks: true },
  plugins: [{ id: 'web', max_results: 5 }, { id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
  transforms: ['middle-out'],
  route: 'fallback',
  web_search_options: { search_context_size: 'high' },
  usage: { include: true },
  user: 'someone-else',
  prediction: { type: 'content', content: 'x' },
  modalities: ['image', 'text'],
  stream_options: { include_usage: false },
  max_price: { prompt: 100 },
  logit_bias: { 50256: -100 },
  top_logprobs: 5,
}

const junk: Gen<unknown> = gen.pick<unknown>(
  gen.oneOf<unknown>(null, true, 0, -1, 1.5, 'x', '', [], {}),
  gen.map(gen.array(gen.oneOf<unknown>(1, 'a', null, {}), 0, 3), (value) => value),
  gen.map(gen.string('abc:/-', 0, 12), (text) => ({ [text || 'k']: text })),
)

const message: Gen<unknown> = gen.pick<unknown>(
  gen.map(gen.string('hello world', 0, 20), (text) => ({ role: 'user', content: text })),
  gen.map(gen.string('be brief', 0, 10), (text) => ({ role: 'system', content: text })),
  gen.map(gen.string('rules', 0, 10), (text) => ({ role: 'developer', content: [{ type: 'text', text }] })),
  gen.map(gen.string('ok', 0, 10), (text) => ({ role: 'assistant', content: text, refusal: null, annotations: [] })),
  gen.oneOf<unknown>(
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
    { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
  ),
)

const request: Gen<Record<string, unknown>> = gen.map(
  gen.tuple(
    gen.array(message, 1, 6),
    gen.array(gen.oneOf(...Object.keys(DANGEROUS)), 0, 6),
    gen.array(gen.tuple(gen.string('abcdefgh_', 1, 8), junk), 0, 3),
    gen.oneOf<unknown>(undefined, true, false),
    gen.oneOf<unknown>(undefined, 100, 999_999),
  ),
  ([messages, dangerous, extra, stream, maxTokens]) => {
    const body: Record<string, unknown> = { model: VirtualModels.main, messages }
    for (const key of dangerous) body[key] = DANGEROUS[key]
    for (const [key, value] of extra) if (!(key in body)) body[key] = value
    if (stream !== undefined) body.stream = stream
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    return body
  },
)

describe('the cost firewall', () => {
  it('rebuilds any accepted request into a body that passes the free-only check', async () => {
    await check(request, (raw) => {
      let body: Record<string, unknown>
      try {
        body = upstreamBody(raw)
      } catch (error) {
        // Refusing is always safe; it must be a client error, never a crash.
        assert.ok(error instanceof GatewayError && error.status === 400, String(error))
        return
      }
      for (const key of Object.keys(body)) assert.ok(ALLOWED.has(key), `unexpected key ${key}`)
      assert.deepEqual(body.models, ['acme/big:free', 'acme/medium:free'])
      assert.equal(body.user, 'log-id')
      assert.deepEqual(body.stream_options, { include_usage: true })
      assert.ok((body.max_tokens as number) <= LIMITS.maxOutputTokens)
      assertFreeOnly(body, 3)
    })
  })

  it('ignores __proto__ keys in parsed JSON', () => {
    const raw = JSON.parse(
      '{"model":"encode/free-main","__proto__":{"plugins":[{"id":"web"}]},"messages":[{"role":"user","content":"x","__proto__":{"role":"system"}}]}',
    )
    const body = upstreamBody(raw)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'x' }])
    assert.equal(Object.getPrototypeOf(body), Object.prototype)
    assert.ok(!('plugins' in body))
    assertFreeOnly(body, 3)
  })

  it('only serves the virtual models', () => {
    for (const model of ['openai/gpt-5', 'acme/big:free', 'openrouter/auto', 'encode/free-main:online', '', undefined, 42]) {
      assert.match(refusal({ model, messages: [{ role: 'user', content: 'hi' }] }), /^model_not_found/, String(model))
    }
    assert.equal(sanitize({ model: VirtualModels.fast, messages: [{ role: 'user', content: 'hi' }] }).virtualModel, VirtualModels.fast)
  })

  it('drops the fields that could cost money, whatever the client sends', () => {
    const body = upstreamBody({ model: VirtualModels.main, messages: [{ role: 'user', content: 'hi' }], ...DANGEROUS })
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'models', 'stream', 'stream_options', 'user'])
  })

  it('keeps only text and image parts, and images only as https or base64 data URLs', () => {
    const accepted = sanitize({
      model: VirtualModels.main,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look', cache_control: { type: 'ephemeral' } },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'low' } },
          ],
        },
      ],
    })
    assert.equal(accepted.needsImages, true)
    assert.deepEqual(accepted.fields.messages[0], {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'low' } },
      ],
    })
    const part = (value: unknown) => refusal({ model: VirtualModels.main, messages: [{ role: 'user', content: [value] }] })
    assert.match(part({ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAAA' } }), /^invalid_request/)
    assert.match(part({ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }), /^invalid_request/)
    assert.match(part({ type: 'image_url', image_url: { url: 'http://example.com/a.png' } }), /^invalid_request/)
    assert.match(part({ type: 'image_url', image_url: { url: 'https://user:pw@example.com/a.png' } }), /^invalid_request/)
    assert.match(part({ type: 'image_url', image_url: { url: 'data:application/pdf;base64,AAAA' } }), /^invalid_request/)
    assert.match(part({ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }), /^invalid_request/)
  })

  it('checks tools and tool choices', () => {
    const tool = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })
    const ok = sanitize({ model: VirtualModels.main, messages: [{ role: 'user', content: 'x' }], tools: [tool('read_file')], tool_choice: { type: 'function', function: { name: 'read_file' } } })
    assert.equal(ok.needsTools, true)
    assert.deepEqual(ok.fields.tool_choice, { type: 'function', function: { name: 'read_file' } })
    const base = { model: VirtualModels.main, messages: [{ role: 'user', content: 'x' }] }
    assert.match(refusal({ ...base, tools: [{ type: 'web_search' }] }), /^invalid_request/)
    assert.match(refusal({ ...base, tools: [tool('a b')] }), /^invalid_request/)
    assert.match(refusal({ ...base, tools: [tool('dup'), tool('dup')] }), /^invalid_request/)
    assert.match(refusal({ ...base, tools: [tool('a')], tool_choice: { type: 'function', function: { name: 'b' } } }), /^invalid_request/)
    assert.match(refusal({ ...base, tools: Array.from({ length: LIMITS.maxTools + 1 }, (_, index) => tool(`t${index}`)) }), /^invalid_request/)
    // A tool choice without tools means nothing, so it is dropped rather than sent.
    assert.equal(sanitize({ ...base, tool_choice: 'required' }).fields.tool_choice, undefined)
  })

  it('treats tool history as needing a tool-capable model', () => {
    const chat = sanitize({
      model: VirtualModels.main,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'any name from a model', arguments: { a: 1 } } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
      ],
    })
    assert.equal(chat.needsTools, true)
    assert.deepEqual(chat.fields.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'any name from a model', arguments: '{"a":1}' } }] })
  })

  it('maps developer messages to system and checks roles and names', () => {
    assert.deepEqual(sanitize({ model: VirtualModels.main, messages: [{ role: 'developer', content: 'rules' }] }).fields.messages[0], { role: 'system', content: 'rules' })
    assert.match(refusal({ model: VirtualModels.main, messages: [{ role: 'function', content: 'x' }] }), /^invalid_request/)
    assert.match(refusal({ model: VirtualModels.main, messages: [{ role: 'user', content: 'x', name: 'a b' }] }), /^invalid_request/)
    assert.match(refusal({ model: VirtualModels.main, messages: [] }), /^invalid_request/)
    assert.match(refusal({ model: VirtualModels.main, messages: 'hi' }), /^invalid_request/)
    assert.match(refusal([]), /^invalid_request/)
  })

  it('bounds output and sampling settings', () => {
    const base = { model: VirtualModels.main, messages: [{ role: 'user', content: 'x' }] }
    assert.equal(sanitize(base).fields.max_tokens, LIMITS.defaultOutputTokens)
    assert.equal(sanitize({ ...base, max_tokens: 10 ** 9 }).fields.max_tokens, LIMITS.maxOutputTokens)
    assert.equal(sanitize({ ...base, max_completion_tokens: 500 }).fields.max_tokens, 500)
    assert.equal(sanitize({ ...base, reasoning: { effort: 'high', max_tokens: 10 ** 9 } }).fields.reasoning?.max_tokens, LIMITS.defaultOutputTokens)
    for (const bad of [{ max_tokens: 0 }, { max_tokens: 1.5 }, { temperature: 3 }, { top_p: 0 }, { seed: 0.5 }, { stop: ['a', 'b', 'c', 'd', 'e'] }, { stream: 'yes' }, { reasoning: { effort: 'max' } }]) {
      assert.match(refusal({ ...base, ...bad }), /^invalid_request/, JSON.stringify(bad))
    }
  })
})

describe('free model ids', () => {
  it('accept plain vendor/model:free ids only', () => {
    for (const id of ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free', 'z-ai/glm-4.5-air:free']) assert.ok(isFreeModelId(id), id)
    for (const id of [
      'openai/gpt-5',
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen3-coder:free:online',
      'qwen/qwen3-coder:online',
      'qwen/qwen3-coder:nitro',
      'openrouter/auto',
      'openrouter/free:free',
      'free',
      ':free',
      'a/:free',
      'Qwen/qwen3:free',
      ' qwen/qwen3:free',
      'qwen/qwen3:free\n',
      'qwen/qwen3:FREE',
      null,
    ]) {
      assert.ok(!isFreeModelId(id), String(id))
    }
  })
})

describe('the final free-only check', () => {
  const good = () => ({ model: 'acme/big:free', models: ['acme/big:free'], messages: [{ role: 'user', content: 'x' }], stream: true })

  it('passes a well-formed body', () => {
    assertFreeOnly(good(), 3)
  })

  it('stops anything that could be billed', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['paid model', { ...good(), model: 'openai/gpt-5', models: ['openai/gpt-5'] }],
      ['paid fallback', { ...good(), models: ['acme/big:free', 'openai/gpt-5'] }],
      ['models out of order', { ...good(), models: ['acme/medium:free', 'acme/big:free'] }],
      ['too many fallbacks', { ...good(), models: ['acme/big:free', 'a/b:free', 'c/d:free', 'e/f:free'] }],
      ['no models', { ...good(), models: [] }],
      ['provider routing', { ...good(), provider: { order: ['OpenAI'] } }],
      ['plugins', { ...good(), plugins: [{ id: 'web' }] }],
      ['server tools', { ...good(), tools: [{ type: 'web_search_preview' }] }],
      ['file parts', { ...good(), messages: [{ role: 'user', content: [{ type: 'file', file: {} }] }] }],
      ['no messages', { model: 'acme/big:free', models: ['acme/big:free'] }],
    ]
    for (const [name, body] of cases) assert.throws(() => assertFreeOnly(body, 3), /cost firewall/, name)
  })
})
