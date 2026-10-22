import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelProfile } from '../../shared/types'
import { ModelsService } from './models'
import type { SettingsService } from './settings'

interface Call {
  url: string
  headers: Record<string, string>
}

function setup(profiles: ModelProfile[], keys: Record<string, string>, reply: (url: string) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const settings = { raw: () => ({ profiles }), keyFor: (id: string) => keys[id] ?? '' } as unknown as SettingsService
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url)
    calls.push({ url: address, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) })
    const { status = 200, body = {} } = reply(address)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { service: new ModelsService(settings, fetchStub), calls }
}

const profile = (patch: Partial<ModelProfile>): ModelProfile => ({ id: 'p', name: 'Provider', kind: 'custom', baseUrl: 'https://api.example.test/v1', model: '', hasApiKey: true, ...patch })
const catalog = { data: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', context_length: 262144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }, { id: 'vendor/paid', name: 'Paid', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: [] }] }

describe('the OpenRouter connection test', () => {
  const or = profile({ id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })

  it('asks OpenRouter whether the key is good, because the catalog is public and a wrong key would pass it', async () => {
    const { service, calls } = setup([or], { or: 'sk-or-v1-secret' }, (url) => (url.endsWith('/key') ? { body: { data: {} } } : { body: catalog }))
    const result = await service.test('or')
    assert.equal(result.ok, true)
    assert.match(result.message, /accepted the key/)
    assert.match(result.message, /2 models, 1 free/)
    const keyCall = calls.find((call) => call.url.endsWith('/key'))
    assert.equal(keyCall?.url, 'https://openrouter.ai/api/v1/key')
    assert.equal(keyCall?.headers.authorization, 'Bearer sk-or-v1-secret')
    assert.equal(calls.find((call) => call.url.endsWith('/models'))?.headers.authorization, undefined, 'the public catalog is asked for without the key')
  })

  it('says a refused key was refused, with what to do about it', async () => {
    const { service } = setup([or], { or: 'sk-or-v1-wrong' }, (url) => (url.endsWith('/key') ? { status: 401 } : { body: catalog }))
    const result = await service.test('or')
    assert.equal(result.ok, false)
    assert.match(result.message, /did not accept the key \(HTTP 401\)/)
    assert.doesNotMatch(result.message, /sk-or/)
  })

  it('says so when there is no key yet, and when OpenRouter cannot be reached', async () => {
    const none = setup([or], {}, () => ({ body: catalog }))
    assert.match((await none.service.test('or')).message, /no key yet/)
    const down = setup([or], { or: 'k' }, () => ({ status: 503 }))
    const result = await down.service.test('or')
    assert.equal(result.ok, false)
    assert.match(result.message, /having trouble \(HTTP 503\)/)
  })
})

describe('a provider\'s model list', () => {
  it('is read from /models with a bearer key for an OpenAI-style server', async () => {
    const { service, calls } = setup([profile({})], { p: 'sk-test' }, () => ({ body: { data: [{ id: 'b-model' }, { id: 'a-model', name: 'A model' }] } }))
    const models = await service.provider('p')
    assert.deepEqual(models.map((model) => model.id), ['a-model', 'b-model'], 'sorted by id')
    assert.equal(models[0].name, 'A model')
    assert.equal(calls[0].url, 'https://api.example.test/v1/models')
    assert.equal(calls[0].headers.authorization, 'Bearer sk-test')
    assert.equal(models[0].contextLength, undefined, 'no guessed window is passed off as a fact')
  })

  it('is read from Anthropic\'s /v1/models with its own headers, whether or not the base URL ends in /v1', async () => {
    for (const baseUrl of ['https://api.anthropic.com', 'https://api.anthropic.com/v1/']) {
      const { service, calls } = setup([profile({ baseUrl })], { p: 'sk-ant-test' }, () => ({ body: { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] } }))
      const models = await service.provider('p')
      assert.equal(models[0].name, 'Claude Sonnet 4.5')
      assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000')
      assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test')
      assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
      assert.equal(calls[0].headers.authorization, undefined)
    }
  })

  it('marks a server on this computer as free, and sends no key it was not given', async () => {
    const { service, calls } = setup([profile({ baseUrl: 'http://localhost:11434/v1', hasApiKey: false })], {}, () => ({ body: { data: [{ id: 'llama3.2' }] } }))
    const [model] = await service.provider('p')
    assert.equal(model.free, true)
    assert.equal(model.pricing, 'runs on this computer')
    assert.equal(calls[0].headers.authorization, undefined)
  })

  it('flags a model the listing says cannot call tools', async () => {
    const { service } = setup([profile({})], { p: 'k' }, () => ({ body: { data: [{ id: 'chat-only', supports_tools: false }, { id: 'agent' }] } }))
    const models = await service.provider('p')
    assert.equal(models.find((model) => model.id === 'chat-only')?.tools, false)
    assert.equal(models.find((model) => model.id === 'agent')?.tools, undefined)
  })

  it('explains a refusal in words, without the key', async () => {
    for (const [status, pattern] of [
      [401, /did not accept the key \(HTTP 401\)/],
      [404, /no model list at this address \(HTTP 404\)/],
      [429, /limiting requests/],
      [500, /having trouble \(HTTP 500\)/],
    ] as const) {
      const { service } = setup([profile({ name: 'DeepSeek' })], { p: 'sk-secret' }, () => ({ status }))
      await assert.rejects(service.provider('p'), (error: Error) => pattern.test(error.message) && error.message.includes('DeepSeek') && !error.message.includes('sk-secret'))
    }
  })

  it('never sends a key over plain http to a server that is not this computer', async () => {
    for (const baseUrl of ['http://api.example.test/v1', 'http://192.168.1.20:8000/v1', 'https://user:secret@api.example.test/v1']) {
      const { service, calls } = setup([profile({ baseUrl })], { p: 'sk-secret' }, () => ({ body: { data: [] } }))
      await assert.rejects(service.provider('p'), (error: Error) => error.message.startsWith('Provider: ') && !error.message.includes('sk-secret') && !error.message.includes('secret@'))
      assert.equal(calls.length, 0, `${baseUrl} was not asked`)
    }
  })

  it('names the connection when it cannot be reached at all', async () => {
    const settings = { raw: () => ({ profiles: [profile({ name: 'Offline' })] }), keyFor: () => '' } as unknown as SettingsService
    const service = new ModelsService(settings, (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.example.test')
    }) as typeof fetch)
    await assert.rejects(service.provider('p'), /Could not reach Offline: getaddrinfo ENOTFOUND/)
  })
})

describe('the connection test for other servers', () => {
  it('needs a base URL, not a model, so a key can be checked before one is chosen', async () => {
    const ok = setup([profile({})], { p: 'k' }, () => ({ body: { data: [{ id: 'm' }] } }))
    assert.deepEqual(await ok.service.test('p'), { ok: true, message: 'Connected · 1 models available' })
    const blank = setup([profile({ baseUrl: ' ' })], {}, () => ({}))
    assert.deepEqual(await blank.service.test('p'), { ok: false, message: 'Set a base URL first.' })
  })

  it('passes a refusal on', async () => {
    const { service } = setup([profile({ name: 'OpenAI' })], { p: 'k' }, () => ({ status: 401 }))
    const result = await service.test('p')
    assert.equal(result.ok, false)
    assert.match(result.message, /OpenAI did not accept the key/)
  })
})
