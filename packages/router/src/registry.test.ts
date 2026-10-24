import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultModel, inferEditFormat, inferFamily, inferReasoning, isPreset, ModelRegistry } from './registry'
import { catalogEntry } from './testing'

const remote = { type: 'openai-compatible' as const, baseUrl: 'https://api.example.com/v1', free: false }
const local = { type: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', free: false }

describe('model defaults', () => {
  it("start from the shared model table, and assume a modest window on this machine", () => {
    assert.equal(defaultModel({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }, 'claude-sonnet-5').contextWindow, 1_000_000)
    assert.equal(defaultModel(remote, 'some-new-model').contextWindow, 64_000)
    assert.equal(defaultModel(local, 'some-new-model').contextWindow, 32_000)
    assert.equal(defaultModel(local, 'gpt-4o').contextWindow, 128_000, 'a known model keeps its window anywhere')
  })

  it('infer family, reasoning and edit format from the id', () => {
    assert.equal(inferFamily('qwen/qwen3-coder:free'), 'qwen')
    assert.equal(inferFamily('my-finetune', 'anthropic'), 'anthropic')
    assert.equal(inferFamily('my-finetune'), 'other')
    assert.equal(inferReasoning('deepseek/deepseek-r1:free', false), true)
    assert.equal(inferReasoning('o3-mini', false), true)
    assert.equal(inferReasoning('qwen/qwen3-thinking', false), true)
    assert.equal(inferReasoning('meta-llama/llama-4-scout', false), false)
    assert.equal(inferEditFormat('openai', 'gpt-5-codex'), 'patch')
    assert.equal(inferEditFormat('qwen', 'qwen3-coder'), 'replace')
  })
})

describe('ModelRegistry', () => {
  function registry(): ModelRegistry {
    const value = new ModelRegistry()
    value.setProviders({ openrouter: { type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', free: false }, gateway: { ...remote, free: true }, remote })
    return value
  }

  it('lets the catalog win over defaults, what failures taught over the catalog, and the user over everything', () => {
    const value = registry()
    value.setCatalog('openrouter', [catalogEntry('a/b:free', { contextWindow: 200_000 })], 1)
    assert.equal(value.get('openrouter', 'a/b:free').contextWindow, 200_000)
    assert.equal(value.get('openrouter', 'a/b:free').known, true)
    value.learn('openrouter:a/b:free', { contextWindow: 100_000, tools: false })
    value.learn('openrouter:a/b:free', { contextWindow: 150_000 })
    const learned = value.get('openrouter', 'a/b:free')
    assert.equal(learned.contextWindow, 100_000, 'a learned window only shrinks')
    assert.equal(learned.capabilities.tools, false)
    value.setOverrides({ 'openrouter:a/b:free': { contextWindow: 64_000, tools: true } })
    assert.equal(value.get('openrouter', 'a/b:free').contextWindow, 64_000)
    assert.equal(value.get('openrouter', 'a/b:free').capabilities.tools, true)
    value.unlearn('openrouter:a/b:free')
    value.setOverrides({})
    assert.equal(value.get('openrouter', 'a/b:free').contextWindow, 200_000)
  })

  it('describes an unlisted model with defaults, and makes every model of a free provider free', () => {
    const value = registry()
    const unknown = value.get('remote', 'mystery')
    assert.equal(unknown.known, false)
    assert.equal(unknown.free, false)
    assert.equal(value.get('gateway', 'encode/free-main').free, true)
  })

  it('takes eval scores per role, clamped to 0..1', () => {
    const value = registry()
    value.setScores({ 'openrouter:a/b:free': { main: 1.4, explore: -1, utility: Number.NaN } })
    assert.deepEqual(value.get('openrouter', 'a/b:free').scores, { main: 1, explore: 0 })
  })

  it('restores its snapshot, skipping anything malformed', () => {
    const value = registry()
    value.setCatalog('openrouter', [catalogEntry('a/b:free'), catalogEntry('c/d')], 42)
    value.learn('openrouter:a/b:free', { contextWindow: 30_000 })
    const restored = registry()
    restored.restore(JSON.parse(JSON.stringify(value.snapshot())))
    assert.deepEqual(restored.list('openrouter'), value.list('openrouter'))
    assert.equal(restored.catalogFetchedAt('openrouter'), 42)

    const damaged = registry()
    damaged.restore({ version: 1, catalogs: { openrouter: { fetchedAt: 1, models: [{ model: 'x' }, catalogEntry('ok:free')] } }, learned: { k: 'nonsense' } })
    assert.deepEqual(damaged.list('openrouter').map((model) => model.model), ['ok:free'])
    damaged.restore({ version: 2 })
    damaged.restore(null)
  })

  describe('an OpenRouter preset (ADR 0117)', () => {
    const P = '@preset/deepseek-v4-1-1017'
    const D = 'deepseek/deepseek-v4.1-flash-1017'
    const sees = { tools: true, parallelTools: true, images: true, documents: false, reasoning: true, promptCache: false }
    const listed = () => {
      const value = registry()
      value.setCatalog('openrouter', [catalogEntry(D, { name: 'DeepSeek: DeepSeek V4.1 Flash 1017', contextWindow: 1_000_000, capabilities: sees, price: { input: 0.02, output: 1 }, expiresAt: 5 }), catalogEntry('vendor/text-only')], 1)
      return value
    }

    it('is told apart by its id', () => {
      assert.equal(isPreset(P), true)
      assert.equal(isPreset('deepseek/deepseek-v4.1-flash-1017'), false)
    })

    it('is sent pictures until a reply says which model it is', () => {
      const value = listed()
      assert.equal(value.get('openrouter', P).capabilities.images, true)
      assert.equal(value.get('openrouter', P).known, false)
      assert.equal(value.get('remote', P).capabilities.images, false, 'only on OpenRouter is an @preset id a preset')
      assert.equal(value.get('openrouter', 'vendor/unlisted').capabilities.images, false, 'any other unlisted model is not')
    })

    it('is described as the listed model that answered for it, under its own id, and is never free by it', () => {
      const value = listed()
      value.learn(`openrouter:${P}`, { servedBy: D })
      const info = value.get('openrouter', P)
      assert.deepEqual(
        { model: info.model, name: info.name, window: info.contextWindow, images: info.capabilities.images, reasoning: info.capabilities.reasoning, price: info.price, known: info.known },
        { model: P, name: 'DeepSeek: DeepSeek V4.1 Flash 1017', window: 1_000_000, images: true, reasoning: true, price: { input: 0.02, output: 1 }, known: true },
      )
      assert.equal(info.expiresAt, undefined, 'the model behind it retiring does not retire the preset, which can be moved on')
      value.setCatalog('openrouter', [catalogEntry('vendor/free-one:free')], 2)
      value.learn(`openrouter:${P}`, { servedBy: 'vendor/free-one:free' })
      assert.equal(value.get('openrouter', P).free, false, 'the preset may send the next request to a paid model')
    })

    it('keeps what a failure taught while the same model answers, and forgets it when another does', () => {
      const value = listed()
      const key = `openrouter:${P}`
      value.learn(key, { images: false, contextWindow: 64_000 })
      value.learn(key, { servedBy: D })
      assert.equal(value.get('openrouter', P).capabilities.images, false)
      assert.equal(value.get('openrouter', P).contextWindow, 64_000)
      value.learn(key, { servedBy: D })
      assert.equal(value.get('openrouter', P).capabilities.images, false, 'the same model again: still learned')
      value.learn(key, { servedBy: 'vendor/text-only' })
      assert.equal(value.get('openrouter', P).contextWindow, 131_072, 'another model: what was taught about the one before goes')
      assert.equal(value.get('openrouter', P).capabilities.images, false, 'and this one cannot read pictures by its own listing')
    })

    it('keeps the model that answered across a restart', () => {
      const value = listed()
      value.learn(`openrouter:${P}`, { servedBy: D })
      const restored = registry()
      restored.restore(JSON.parse(JSON.stringify(value.snapshot())))
      assert.equal(restored.get('openrouter', P).contextWindow, 1_000_000)
      restored.restore({ version: 1, catalogs: {}, learned: { [`openrouter:${P}`]: { servedBy: 42 } } })
      assert.equal(restored.get('openrouter', P).contextWindow, 1_000_000, 'a malformed name is skipped')
    })
  })

  it("does not take a snapshot's word that a model with a price is free", () => {
    const value = registry()
    value.restore({
      version: 1,
      catalogs: {
        openrouter: {
          fetchedAt: 1,
          models: [catalogEntry('priced/model:free', { free: true, price: { input: 1, output: 4 } }), catalogEntry('no/price:free', { price: { input: Number.NaN, output: 0 } }), catalogEntry('ok:free')],
        },
      },
    })
    assert.deepEqual(value.list('openrouter').map((model) => [model.model, model.free]), [['ok:free', true]])
  })
})
