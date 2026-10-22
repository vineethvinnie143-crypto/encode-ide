import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelInfo, ModelProfile } from '@shared/types'
import { catalogSignature, contextLabel, flatten, pickerGroups, type Catalog, type PickerInput } from './model-list'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const router: ModelProfile = { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true }
const openai: ModelProfile = { id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true }

const ready = (profile: ModelProfile, models: ModelInfo[]): Catalog => ({ state: 'ready', models, signature: catalogSignature(profile) })
const catalogs = {
  or: ready(router, [
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', free: true, pricing: 'free', contextLength: 262144, tools: true },
    { id: 'meta/llama-chat:free', name: 'Llama Chat (free)', free: true, tools: false },
    { id: 'vendor/big', name: 'Big', pricing: '$3.00 in · $15.00 out / 1M tok', contextLength: 1_000_000 },
  ]),
  oa: ready(openai, [
    { id: 'gpt-4o', name: 'gpt-4o' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
  ]),
}
const input = (patch: Partial<PickerInput> = {}): PickerInput => ({ settings: { profiles: [demo, router, openai], freeProfileId: null }, catalogs, query: '', selected: [], ...patch })
const titles = (groups: ReturnType<typeof pickerGroups>) => groups.map((group) => `${group.title}: ${group.items.map((item) => item.ref).join(', ')}`)

describe('the model picker\'s groups', () => {
  it('list "Free models" first when a connection can serve them, then each connection\'s models in the order they came', () => {
    assert.deepEqual(titles(pickerGroups(input())), [
      'Free: @free',
      'OpenRouter: or:qwen/qwen3-coder:free, or:meta/llama-chat:free, or:vendor/big',
      'OpenAI: oa:gpt-4o, oa:gpt-4o-mini',
    ])
  })

  it('leave "Free models" out when there is no OpenRouter connection with a key, and the demo and blank connections never appear as one', () => {
    const none = pickerGroups(input({ settings: { profiles: [demo, { ...router, hasApiKey: false }, { ...openai, id: 'blank', baseUrl: ' ' }], freeProfileId: null } }))
    assert.deepEqual(none.map((group) => group.title), ['OpenRouter'], 'a connection without a key is still listed, as it can list its models')
    assert.deepEqual(pickerGroups(input({ free: false })).map((group) => group.title), ['OpenRouter', 'OpenAI'])
  })

  it('offer the offline demo when asked', () => {
    const groups = pickerGroups(input({ demo: true }))
    assert.deepEqual(groups[groups.length - 1].items.map((item) => item.ref), ['demo'])
    assert.equal(groups[groups.length - 1].items[0].free, true)
  })

  it('put what is in use on top and not again below', () => {
    const groups = pickerGroups(input({ selected: ['oa:gpt-4o-mini', '@free'] }))
    assert.deepEqual(titles(groups), [
      'In use: @free, oa:gpt-4o-mini',
      'OpenRouter: or:qwen/qwen3-coder:free, or:meta/llama-chat:free, or:vendor/big',
      'OpenAI: oa:gpt-4o',
    ])
    assert.equal(groups[0].items.every((item) => item.selected), true)
  })

  it('say what each model is: its name, its id, whether it is free, cannot call tools, and what it costs', () => {
    const [, router_] = pickerGroups(input())
    const [coder, chat, big] = router_.items
    assert.deepEqual([coder.title, coder.detail, coder.free, coder.noTools, coder.contextLength], ['Qwen3 Coder (free)', 'qwen/qwen3-coder:free', true, false, 262144])
    assert.equal(chat.noTools, true)
    assert.deepEqual([big.free, big.price], [false, '$3.00 in · $15.00 out / 1M tok'])
  })

  it('narrow by every word typed, over the name, the id, the connection and "free"', () => {
    assert.deepEqual(flatten(pickerGroups(input({ query: 'qwen coder' }))).map((item) => item.ref), ['or:qwen/qwen3-coder:free'])
    assert.deepEqual(flatten(pickerGroups(input({ query: 'openai 4o' }))).map((item) => item.ref), ['oa:gpt-4o', 'oa:gpt-4o-mini'])
    assert.deepEqual(flatten(pickerGroups(input({ query: 'FREE' }))).map((item) => item.ref), ['@free', 'or:qwen/qwen3-coder:free', 'or:meta/llama-chat:free'])
    assert.deepEqual(pickerGroups(input({ query: 'no such model' })), [])
  })

  it('offer the model typed into a connection even when its provider does not list it', () => {
    const groups = pickerGroups(input({ settings: { profiles: [demo, { ...openai, model: 'gpt-5-preview' }], freeProfileId: null }, free: false }))
    assert.deepEqual(groups[0].items.map((item) => item.ref), ['oa:gpt-4o', 'oa:gpt-4o-mini', 'oa:gpt-5-preview'])
  })

  it('keep a long list short and count what was left out, then show more once something is typed', () => {
    const many: ModelInfo[] = Array.from({ length: 300 }, (_, n) => ({ id: `vendor/model-${n}`, name: `Model ${n}` }))
    const big = { ...catalogs, or: ready(router, many) }
    const [, group] = pickerGroups(input({ catalogs: big }))
    assert.equal(group.items.length, 40)
    assert.equal(group.hidden, 260)
    const searched = pickerGroups(input({ catalogs: big, query: 'model' }))[1]
    assert.equal(searched.items.length, 100)
    assert.equal(searched.hidden, 200)
  })

  it('say why a connection is empty: still loading, failed, or listing nothing', () => {
    const groups = pickerGroups(
      input({
        catalogs: {
          or: { state: 'loading', models: [], signature: '' },
          oa: { state: 'error', models: [], error: 'OpenAI did not accept the key (HTTP 401).', signature: '' },
        },
      }),
    )
    const loading = groups.find((group) => group.id === 'or')!
    const failed = groups.find((group) => group.id === 'oa')!
    assert.deepEqual([loading.state, loading.items.length], ['loading', 0])
    assert.deepEqual([failed.state, failed.message], ['error', 'OpenAI did not accept the key (HTTP 401).'])
    const empty = pickerGroups(input({ catalogs: { or: ready(router, []) }, free: false, settings: { profiles: [router], freeProfileId: null } }))
    assert.match(empty[0].message ?? '', /lists no models/)
  })
})

describe('a list read with other settings', () => {
  it('is told apart by the address and the key it was read with', () => {
    assert.notEqual(catalogSignature(openai), catalogSignature({ ...openai, hasApiKey: false }))
    assert.notEqual(catalogSignature(openai), catalogSignature({ ...openai, baseUrl: 'https://api.deepseek.com' }))
    assert.equal(catalogSignature(openai), catalogSignature({ ...openai, baseUrl: ' https://api.openai.com/v1 ' }))
  })
})

describe('a context window in words', () => {
  it('is rounded to thousands or millions', () => {
    assert.equal(contextLabel(262144), '262k')
    assert.equal(contextLabel(128000), '128k')
    assert.equal(contextLabel(1_048_576), '1M')
    assert.equal(contextLabel(2_000_000), '2M')
  })
})
