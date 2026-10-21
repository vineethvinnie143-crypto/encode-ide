import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultModel, inferEditFormat, inferFamily, inferReasoning, ModelRegistry } from './registry'
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
})
