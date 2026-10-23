import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ANTHROPIC_VERSION } from '@encode/providers'
import { fetchModelList, modelListUrl, parseModelList } from './model-list'
import { fetchFreeQuota, fetchOpenRouterCatalog, freeVerdict, nextUtcMidnight, parseKeyInfo, parseOpenRouterCatalog, type Fetch } from './openrouter'

const BASE = 'https://openrouter.ai/api/v1'
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

interface SentRequest {
  url: string
  headers: Record<string, string>
}

/** A fetch that serves fixed bodies by URL and records what was asked. Unknown URLs get a 404. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): { fetch: Fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = []
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, headers: { ...init?.headers } })
    const route = routes[url]
    const status = route ? (route.status ?? 200) : 404
    return { ok: status >= 200 && status < 300, status, json: async () => route?.body ?? {} }
  }
  return { fetch, sent }
}

/** A minimal valid /models entry, with overrides. */
function item(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 131_072,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' },
    top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
    supported_parameters: ['tools'],
    ...extra,
  }
}

describe('OpenRouter catalog', () => {
  it('reads limits, capabilities, prices and dates from a /models entry', () => {
    const [model] = parseOpenRouterCatalog({
      data: [
        {
          id: 'qwen/qwen3-coder:free',
          name: ' Qwen3 Coder (free) ',
          created: 1_753_000_000,
          context_length: 100_000,
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          pricing: { prompt: '0', completion: '0' },
          top_provider: { context_length: 262_144, max_completion_tokens: 65_536 },
          supported_parameters: ['tools', 'tool_choice', 'reasoning'],
          expiration_date: '2026-11-30T00:00:00Z',
        },
      ],
    })
    assert.deepEqual(model, {
      model: 'qwen/qwen3-coder:free',
      name: 'Qwen3 Coder (free)',
      family: 'qwen',
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      capabilities: { tools: true, parallelTools: true, images: true, documents: false, reasoning: true, promptCache: false },
      editFormat: 'replace',
      price: { input: 0, output: 0 },
      free: true,
      created: 1_753_000_000_000,
      expiresAt: Date.parse('2026-11-30T00:00:00Z'),
      roles: undefined,
    })
  })

  it('marks a model that takes files as one that reads PDFs as documents', () => {
    const entry = (inputs: string[]) => ({ id: 'vendor/model', context_length: 100_000, architecture: { input_modalities: inputs }, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] })
    const [reads, plain] = parseOpenRouterCatalog({ data: [entry(['text', 'image', 'file']), { ...entry(['text', 'image']), id: 'vendor/other' }] })
    assert.equal(reads.capabilities.documents, true)
    assert.equal(plain.capabilities.documents, false)
  })

  it('prices per million tokens, and calls a model free only when its id says so and it costs nothing', () => {
    const models = parseOpenRouterCatalog({
      data: [
        item('paid/model', { pricing: { prompt: '0.000003', completion: '0.0000002', input_cache_write: '0.00000375' } }),
        item('promo/model'),
        item('odd/model:free', { pricing: { prompt: '0.000001', completion: '0' } }),
      ],
    })
    assert.deepEqual(
      models.map((model) => [model.model, model.price, model.free, model.capabilities.promptCache]),
      [
        ['paid/model', { input: 3, output: 0.2 }, false, true],
        ['promo/model', { input: 0, output: 0 }, false, false],
        ['odd/model:free', { input: 1, output: 0 }, false, false],
      ],
    )
  })

  it('calls a model free only when its id says so and every price it quotes is zero', () => {
    const zero = { prompt: '0', completion: '0' }
    const models = parseOpenRouterCatalog({
      data: [
        item('every/field:free', { pricing: { ...zero, request: '0', image: '0', audio: '0', web_search: '0', internal_reasoning: '0', input_cache_read: '0', input_cache_write: '0', discount: 0.5 } }),
        item('plain/numbers:free', { pricing: { prompt: 0, completion: 0, request: 0 } }),
        item('fee/per-request:free', { pricing: { ...zero, request: '0.01' } }),
        item('fee/per-image:free', { pricing: { ...zero, image: '0.004' } }),
        item('fee/per-search:free', { pricing: { ...zero, web_search: '0.01' } }),
        item('fee/reasoning:free', { pricing: { ...zero, internal_reasoning: '0.000002' } }),
        item('fee/cache:free', { pricing: { ...zero, input_cache_read: '0.0000001' } }),
        item('fee/unheard-of:free', { pricing: { ...zero, per_gpu_hour: '0.5' } }),
        item('fee/words:free', { pricing: { ...zero, image: 'free' } }),
        item('fee/null:free', { pricing: { ...zero, image: null } }),
        item('fee/object:free', { pricing: { ...zero, image: { usd: 0 } } }),
        item('fee/negative:free', { pricing: { ...zero, request: '-1' } }),
        item('fee/fraction-of-a-cent:free', { pricing: { prompt: '0.0000000000001', completion: '0' } }),
        item('zero/without-the-suffix', { pricing: zero }),
      ],
    })
    assert.deepEqual(
      models.map((model) => [model.model, model.free]),
      [
        ['every/field:free', true],
        ['plain/numbers:free', true],
        ['fee/per-request:free', false],
        ['fee/per-image:free', false],
        ['fee/per-search:free', false],
        ['fee/reasoning:free', false],
        ['fee/cache:free', false],
        ['fee/unheard-of:free', false],
        ['fee/words:free', false],
        ['fee/null:free', false],
        ['fee/object:free', false],
        ['fee/negative:free', false],
        ['fee/fraction-of-a-cent:free', false],
        ['zero/without-the-suffix', false],
      ],
    )
    // The registry rounds prices to a millionth of a dollar per million tokens; the free check does not.
    assert.equal(models.find((model) => model.model === 'fee/fraction-of-a-cent:free')?.price.input, 0)
  })

  it('says why a model is not free', () => {
    const zero = { prompt: '0', completion: '0' }
    assert.deepEqual(freeVerdict('a/b:free', zero), { free: true, reasons: [] })
    assert.deepEqual(freeVerdict('a/b', zero).reasons, ['its id does not end in :free'])
    assert.deepEqual(freeVerdict('a/b:free', { prompt: '0.000001', completion: '0', request: 'x' }).reasons, ['its prompt price is "0.000001", not zero', 'its request price is "x", not zero'])
    assert.deepEqual(freeVerdict('a/b:free', {}).reasons, ['no prompt price is listed', 'no completion price is listed'])
    assert.deepEqual(freeVerdict('a/b:free', { ...zero, image: null, audio: [1], web_search: true }).reasons, ['its image price is null, not zero', 'its audio price is object, not zero', 'its web_search price is boolean, not zero'])
    // A response is untrusted: a long value is cut short, and so is a long list.
    assert.equal(freeVerdict('a/b:free', { ...zero, image: 'x'.repeat(500) }).reasons[0], `its image price is "${'x'.repeat(24)}…", not zero`)
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`fee${index}`, '1']))
    assert.equal(freeVerdict('a/b:free', { ...zero, ...many }).reasons.length, 8)
  })

  it('leaves out what it cannot use: image-only output, no window or price, bad ids and repeats', () => {
    const models = parseOpenRouterCatalog({
      data: [
        null,
        'text',
        item('image/gen', { architecture: { output_modalities: ['image'] } }),
        item('no/window', { context_length: 0, top_provider: {} }),
        item('no/price', { pricing: {} }),
        item('blank/price', { pricing: { prompt: '', completion: '' } }),
        item('auto/router', { pricing: { prompt: '-1', completion: '-1' } }),
        item('has space'),
        item('x'.repeat(300)),
        item('ok/model'),
        item('ok/model', { name: 'the repeat' }),
      ],
    })
    assert.deepEqual(models.map((model) => [model.model, model.name]), [['ok/model', 'ok/model']])
    assert.deepEqual(parseOpenRouterCatalog({ data: 'nope' }), [])
    assert.deepEqual(parseOpenRouterCatalog(null), [])
  })

  it('defaults the output limit to a quarter of the window, at most 16k, and never past the window', () => {
    const models = parseOpenRouterCatalog({
      data: [
        item('a', { context_length: 32_000, top_provider: {} }),
        item('b', { context_length: 200_000, top_provider: {} }),
        item('c', { top_provider: { context_length: 4_000, max_completion_tokens: 8_000 } }),
        item('d', { top_provider: {}, per_request_limits: { completion_tokens: 2_048 } }),
      ],
    })
    assert.deepEqual(models.map((model) => [model.model, model.contextWindow, model.maxOutputTokens]), [
      ['a', 32_000, 8_000],
      ['b', 200_000, 16_384],
      ['c', 4_000, 4_000],
      ['d', 131_072, 2_048],
    ])
  })

  it("takes a virtual model's roles, strings only", () => {
    const [model] = parseOpenRouterCatalog({ data: [item('encode/free-main', { roles: ['main', 3, 'planner'] })] })
    assert.deepEqual(model.roles, ['main', 'planner'])
  })

  it('fetches every page on the same origin, and never sends a key', async () => {
    const { fetch, sent } = fakeFetch({
      [`${BASE}/models`]: { body: { data: [item('a')], links: { next: '/api/v1/models?page=2' } } },
      [`${BASE}/models?page=2`]: { body: { data: [item('b'), item('a')], links: { next: 'https://elsewhere.test/models' } } },
      'https://elsewhere.test/models': { body: { data: [item('planted')] } },
    })
    const models = await fetchOpenRouterCatalog({ fetch, baseUrl: BASE })
    assert.deepEqual(models.map((model) => model.model), ['a', 'b'])
    assert.deepEqual(sent.map((request) => request.url), [`${BASE}/models`, `${BASE}/models?page=2`])
    assert.ok(sent.every((request) => !('authorization' in request.headers)))
  })

  it('stops after ten pages, and fails on an HTTP error', async () => {
    const routes: Record<string, { body: unknown }> = {}
    for (let page = 0; page < 20; page++) routes[page ? `${BASE}/models?page=${page}` : `${BASE}/models`] = { body: { data: [item(`m${page}`)], links: { next: `/api/v1/models?page=${page + 1}` } } }
    const { fetch, sent } = fakeFetch(routes)
    assert.equal((await fetchOpenRouterCatalog({ fetch, baseUrl: BASE })).length, 10)
    assert.equal(sent.length, 10)
    const failing = fakeFetch({ [`${BASE}/models`]: { status: 503, body: {} } })
    await assert.rejects(fetchOpenRouterCatalog({ fetch: failing.fetch, baseUrl: BASE }), /HTTP 503/)
  })
})

describe('OpenRouter free quota', () => {
  it("reads the key's daily free count with the key, resetting at midnight UTC", async () => {
    const { fetch, sent } = fakeFetch({
      [`${BASE}/key`]: {
        body: { data: { label: 'sk-or-v1-abc...', limit: null, limit_remaining: null, is_free_tier: true, free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } },
      },
    })
    const quota = await fetchFreeQuota({ fetch, baseUrl: BASE, apiKey: 'sk-or-v1-secret', now: NOW })
    assert.deepEqual(quota, { limit: 50, used: 12, remaining: 38, resetAt: Date.UTC(2026, 9, 22), creditsRemaining: null })
    assert.equal(sent[0].headers.authorization, 'Bearer sk-or-v1-secret')
  })

  it('works out a missing count, and reports nothing when the response has no quota', () => {
    assert.deepEqual(parseKeyInfo({ data: { free_model_daily_requests: { limit: 1_000, used: 10 }, limit_remaining: 4.5 } }, NOW), {
      limit: 1_000,
      used: 10,
      remaining: 990,
      resetAt: nextUtcMidnight(NOW),
      creditsRemaining: 4.5,
    })
    assert.equal(parseKeyInfo({ data: { free_model_daily_requests: { limit: 50, remaining: 50 } } }, NOW)?.used, 0)
    assert.equal(parseKeyInfo({ data: { label: 'x' } }, NOW), null)
    assert.equal(parseKeyInfo({ data: { free_model_daily_requests: { limit: -1, used: 'many' } } }, NOW), null)
    assert.equal(parseKeyInfo('junk', NOW), null)
  })

  it('names the next midnight UTC, even on the last day of a month', () => {
    assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 31, 23, 59, 59)), Date.UTC(2026, 10, 1))
    assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 21)), Date.UTC(2026, 9, 22))
  })
})

describe('provider model lists', () => {
  it('lists an OpenAI-compatible server with its key, taking what it reports over the model table', async () => {
    const provider = { type: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8000/v1' }
    const { fetch, sent } = fakeFetch({
      'http://127.0.0.1:8000/v1/models': {
        body: { data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 40_960 }, { id: 'tiny', supports_tools: false }, { id: 'gpt-4o' }, { id: '' }, 'junk'] },
      },
    })
    const models = await fetchModelList({ fetch, provider, apiKey: 'local-key' })
    assert.deepEqual(models.map((model) => [model.model, model.contextWindow, model.capabilities.tools]), [
      ['Qwen/Qwen3-32B', 40_960, true],
      ['tiny', 32_000, false],
      ['gpt-4o', 128_000, true],
    ])
    assert.equal(sent[0].headers.authorization, 'Bearer local-key')
  })

  it("lists Anthropic's models with its own path and headers", async () => {
    assert.equal(modelListUrl({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models?limit=1000')
    assert.equal(modelListUrl({ type: 'anthropic', baseUrl: 'https://proxy.test/anthropic/v1' }), 'https://proxy.test/anthropic/v1/models?limit=1000')
    const { fetch, sent } = fakeFetch({
      'https://api.anthropic.com/v1/models?limit=1000': {
        body: { data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-09-01T00:00:00Z' }], has_more: false },
      },
    })
    const [model] = await fetchModelList({ fetch, provider: { type: 'anthropic', baseUrl: 'https://api.anthropic.com' }, apiKey: 'sk-ant-secret' })
    assert.deepEqual([model.model, model.name, model.family, model.created], ['claude-sonnet-5', 'Claude Sonnet 5', 'anthropic', Date.parse('2026-09-01T00:00:00Z')])
    assert.equal(model.contextWindow, 1_000_000)
    assert.deepEqual(sent[0].headers, { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': 'sk-ant-secret' })
  })

  it("reads the gateway's role-tagged virtual models", () => {
    const [model] = parseModelList(
      { models: [{ id: 'encode/free-main', context_length: 131_072, max_output_tokens: 8_192, supports_tools: true, roles: ['main', 'planner', 7] }] },
      { type: 'openai-compatible', baseUrl: 'https://gateway.encode.test/v1' },
    )
    assert.deepEqual([model.contextWindow, model.maxOutputTokens, model.capabilities.tools, model.roles], [131_072, 8_192, true, ['main', 'planner']])
  })

  it('sends no key when it has none, and fails on an HTTP error', async () => {
    const { fetch, sent } = fakeFetch({ 'https://api.example.test/v1/models': { status: 401, body: { error: 'no key' } } })
    await assert.rejects(fetchModelList({ fetch, provider: { type: 'openai-compatible', baseUrl: 'https://api.example.test/v1' } }), /HTTP 401/)
    assert.deepEqual(sent[0].headers, { accept: 'application/json' })
  })
})
