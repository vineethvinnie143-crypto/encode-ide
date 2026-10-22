import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FREE_REF, mainLabel, modelMode, mainRefs } from '@shared/models'
import type { ModelProfile, Settings } from '@shared/types'
import { finishDemo, finishFree, finishOwn, freeConnection, ownConnection, uniqueName } from './connect'
import { OPENROUTER_URL, PRESETS, keyWarning, presetOf, sameAddress } from './presets'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ profiles: [demo], activeProfileId: 'demo', roles: {}, freeOnly: true, freeProfileId: null, setupDone: false, ...patch }) as Settings
const ids = () => {
  let n = 0
  return () => `id-${++n}`
}
const apply = (base: Settings, patch: Partial<Settings>): Settings => ({ ...base, ...patch })

describe('connecting the free models', () => {
  it('makes an OpenRouter connection when there is none, and does not touch the demo', () => {
    const { profiles, profileId } = freeConnection(settings(), ids())
    assert.equal(profiles.length, 2)
    assert.deepEqual(profiles[0], demo)
    assert.deepEqual(profiles[1], { id: 'id-1', name: 'OpenRouter', kind: 'openrouter', baseUrl: OPENROUTER_URL, model: '', hasApiKey: false })
    assert.equal(profileId, 'id-1')
  })

  it('takes over the OpenRouter connection that serves the free models, or any other, before making a new one', () => {
    const named: ModelProfile = { id: 'a', name: 'OpenRouter', kind: 'openrouter', baseUrl: OPENROUTER_URL, model: '', hasApiKey: true }
    const other: ModelProfile = { ...named, id: 'b', name: 'Paid OpenRouter' }
    assert.equal(freeConnection(settings({ profiles: [demo, named, other], freeProfileId: 'b' }), ids()).profileId, 'b')
    assert.equal(freeConnection(settings({ profiles: [demo, { ...named, hasApiKey: false }, other], freeProfileId: null }), ids()).profileId, 'b', 'one that has a key is the free profile')
    assert.equal(freeConnection(settings({ profiles: [demo, { ...named, hasApiKey: false }] }), ids()).profileId, 'a', 'one without a key is still better than a duplicate')
  })

  it('on a first start chooses the free models for the main role and turns "free models only" on', () => {
    const first = settings()
    const { profiles, profileId } = freeConnection(first, ids())
    const stored = apply(first, { profiles })
    const done = apply(stored, finishFree(stored, profileId))
    assert.deepEqual(done.roles, { main: [FREE_REF] })
    assert.equal(done.activeProfileId, profileId)
    assert.equal(done.freeProfileId, profileId)
    assert.equal(done.freeOnly, true)
    assert.equal(done.setupDone, true)
    assert.equal(modelMode(done), 'router')
    assert.equal(mainLabel(done), 'Free models')
  })

  it('later leaves "free models only" as the person set it', () => {
    const base = settings({ setupDone: true, freeOnly: false })
    const { profiles, profileId } = freeConnection(base, ids())
    const stored = apply(base, { profiles })
    assert.equal(finishFree(stored, profileId).freeOnly, undefined)
    assert.equal(apply(stored, finishFree(stored, profileId)).freeOnly, false)
  })
})

describe('connecting a key of one\'s own', () => {
  const key: ModelProfile = { id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true }

  it('makes a connection named for the provider, with the address of the preset', () => {
    const { profiles, profileId } = ownConnection(settings(), presetOf('anthropic'), presetOf('anthropic').baseUrl, ids())
    assert.deepEqual(profiles[1], { id: 'id-1', name: 'Anthropic', kind: 'custom', baseUrl: 'https://api.anthropic.com', model: '', hasApiKey: false })
    assert.equal(profileId, 'id-1')
  })

  it('keeps a second key apart from the first, since it is usually another account, and numbers the name', () => {
    const { profiles, profileId } = ownConnection(settings({ profiles: [demo, key] }), presetOf('openai'), presetOf('openai').baseUrl, ids())
    assert.equal(profileId, 'id-1')
    assert.deepEqual(profiles.map((profile) => profile.name), ['Demo (offline)', 'OpenAI', 'OpenAI 2'])
  })

  it('takes over a connection at the same address that has no key yet, whatever the slash or capitals', () => {
    const unfinished: ModelProfile = { ...key, hasApiKey: false, baseUrl: 'https://API.openai.com/v1/' }
    const result = ownConnection(settings({ profiles: [demo, unfinished] }), presetOf('openai'), presetOf('openai').baseUrl, ids())
    assert.equal(result.profileId, 'oa')
    assert.equal(result.profiles.length, 2)
  })

  it('uses the one connection to a server on this computer however often it is chosen', () => {
    const local: ModelProfile = { id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', hasApiKey: true }
    assert.equal(ownConnection(settings({ profiles: [demo, local] }), presetOf('ollama'), presetOf('ollama').baseUrl, ids()).profileId, 'ol')
  })

  it('uses the address typed for a custom provider, and OpenRouter\'s own address for OpenRouter', () => {
    const custom = ownConnection(settings(), presetOf('custom'), ' https://llm.example.test/v1 ', ids())
    assert.equal(custom.profiles[1].baseUrl, 'https://llm.example.test/v1')
    const router = ownConnection(settings(), presetOf('openrouter'), 'https://elsewhere.test', ids())
    assert.equal(router.profiles[1].baseUrl, OPENROUTER_URL)
    assert.equal(router.profiles[1].kind, 'openrouter')
  })

  it('makes the model the main one, remembers it on the connection and allows billed models', () => {
    const base = settings({ profiles: [demo, key] })
    const done = apply(base, finishOwn(base, 'oa', 'gpt-4o', false))
    assert.deepEqual(done.roles, { main: ['oa:gpt-4o'] })
    assert.equal(done.activeProfileId, 'oa')
    assert.equal(done.profiles.find((profile) => profile.id === 'oa')?.model, 'gpt-4o')
    assert.equal(done.freeOnly, false)
    assert.equal(done.setupDone, true)
    assert.equal(mainLabel(done), 'gpt-4o')
  })

  it('leaves "free models only" alone for a model that costs nothing', () => {
    const base = settings({ profiles: [demo, key] })
    assert.equal(apply(base, finishOwn(base, 'oa', 'free-model', true)).freeOnly, true)
  })

  it('keeps the other roles when the main model changes', () => {
    const base = settings({ profiles: [demo, key], roles: { reviewer: ['oa:o3'], main: ['oa:old'] }, setupDone: true })
    const done = apply(base, finishOwn(base, 'oa', 'gpt-4o', false))
    assert.deepEqual(done.roles, { reviewer: ['oa:o3'], main: ['oa:gpt-4o'] })
  })
})

describe('the offline demo', () => {
  it('hands the main role back to the demo and finishes the setup', () => {
    const base = settings({ profiles: [demo, { id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasApiKey: true }], activeProfileId: 'oa', roles: { main: ['oa:gpt-4o'], reviewer: ['oa:o3'] } })
    const done = apply(base, finishDemo(base))
    assert.deepEqual(done.roles, { reviewer: ['oa:o3'] })
    assert.equal(done.activeProfileId, 'demo')
    assert.equal(done.setupDone, true)
    assert.equal(modelMode(done), 'demo')
    assert.deepEqual(mainRefs(done), [])
  })
})

describe('names and addresses', () => {
  it('keep connection names apart without caring for capitals', () => {
    assert.equal(uniqueName([{ name: 'openai' }], 'OpenAI'), 'OpenAI 2')
    assert.equal(uniqueName([{ name: 'OpenAI' }, { name: 'OpenAI 2' }], 'OpenAI'), 'OpenAI 3')
    assert.equal(uniqueName([], 'OpenAI'), 'OpenAI')
  })

  it('compare addresses by host and path', () => {
    assert.equal(sameAddress('https://api.openai.com/v1/', 'https://API.openai.com/v1'), true)
    assert.equal(sameAddress('https://api.openai.com/v1', 'https://api.openai.com/v2'), false)
    assert.equal(sameAddress('', ''), false, 'two blanks are not the same address')
  })

  it('give every preset a unique id, and a blank address only to the custom one', () => {
    assert.equal(new Set(PRESETS.map((preset) => preset.id)).size, PRESETS.length)
    assert.deepEqual(PRESETS.filter((preset) => !preset.baseUrl).map((preset) => preset.id), ['custom'])
  })
})

describe('a key pasted in the wrong place', () => {
  it('is warned about, softly, and a key that looks right is not', () => {
    const router = presetOf('openrouter')
    assert.equal(keyWarning(router, 'sk-or-v1-abc'), null)
    assert.equal(keyWarning(router, ''), null)
    assert.match(keyWarning(router, 'sk-proj-abc') ?? '', /start with sk-or-/)
    assert.match(keyWarning(router, 'sk-or-v1-abc\ndef') ?? '', /space or a line break/)
    assert.equal(keyWarning(presetOf('custom'), 'anything'), null, 'a custom provider has no known shape')
  })
})
