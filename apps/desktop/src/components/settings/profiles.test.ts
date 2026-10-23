import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelProfile, Settings } from '@shared/types'
import { presetOf } from '../models/presets'
import { addProfile, editProfile, kindPatch, removeProfile, chooseProfile } from './profiles'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo', hasApiKey: false }
const router: ModelProfile = { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', hasApiKey: true }
const paid: ModelProfile = { id: 'paid', name: 'DeepSeek', kind: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasApiKey: true }

const connections = (overrides: Partial<Settings> = {}) => ({
  profiles: [demo, router, paid],
  activeProfileId: 'or',
  roles: {},
  freeProfileId: null,
  ...overrides,
})

describe('changing a connection', () => {
  it('changes only the fields named, on that connection', () => {
    const patch = editProfile(connections(), 'paid', { name: 'My DeepSeek' })
    assert.deepEqual(patch, { profiles: [demo, router, { ...paid, name: 'My DeepSeek' }] })
  })

  it('moves the main role to the new model of the connection that answers, when it held only the old one', () => {
    const patch = editProfile(connections({ roles: { main: ['or:qwen/qwen3-coder:free'] } }), 'or', { model: 'z-ai/glm-4.5-air:free' })
    assert.deepEqual(patch.roles?.main, ['or:z-ai/glm-4.5-air:free'])
    assert.equal(patch.activeProfileId, 'or')
    const implicit = editProfile(connections(), 'or', { model: 'z-ai/glm-4.5-air:free' })
    assert.deepEqual(implicit.roles?.main, ['or:z-ai/glm-4.5-air:free'], 'a main role taken from the active connection follows too')
  })

  it('leaves a main role the person built from several models alone, and one on another connection', () => {
    const several = editProfile(connections({ roles: { main: ['or:qwen/qwen3-coder:free', 'paid:deepseek-chat'] } }), 'or', { model: 'other' })
    assert.equal(several.roles, undefined)
    const other = editProfile(connections({ roles: { main: ['paid:deepseek-chat'] } }), 'or', { model: 'other' })
    assert.equal(other.roles, undefined)
    assert.deepEqual(editProfile(connections(), 'missing', { name: 'x' }), {})
  })

  it('points a connection made OpenRouter at OpenRouter, and empties that address when it becomes custom', () => {
    assert.deepEqual(kindPatch({ baseUrl: 'https://api.deepseek.com' }, 'openrouter'), { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })
    assert.deepEqual(kindPatch({ baseUrl: 'https://openrouter.ai/api/v1' }, 'custom'), { kind: 'custom', baseUrl: '' })
    assert.deepEqual(kindPatch({ baseUrl: 'https://api.deepseek.com' }, 'custom'), { kind: 'custom', baseUrl: 'https://api.deepseek.com' })
  })
})

describe('adding, removing and choosing connections', () => {
  it('adds a connection from a preset with a name of its own', () => {
    const { patch, profile } = addProfile(connections(), presetOf('openrouter'), 'new-id')
    assert.equal(profile.name, 'OpenRouter 2')
    assert.equal(profile.baseUrl, 'https://openrouter.ai/api/v1')
    assert.equal(profile.hasApiKey, false)
    assert.deepEqual(patch.profiles?.map((item) => item.id), ['demo', 'or', 'paid', 'new-id'])
    assert.equal(patch.activeProfileId, 'or', 'the one that answers stays')
  })

  it('removes a connection with what named it, and keeps the last one', () => {
    const patch = removeProfile(connections({ activeProfileId: 'paid', roles: { main: ['paid:deepseek-chat'], reviewer: ['or:qwen/qwen3-coder:free'] }, freeProfileId: 'or' }), 'paid')
    assert.ok(patch)
    assert.deepEqual(patch.profiles?.map((item) => item.id), ['demo', 'or'])
    assert.equal(patch.activeProfileId, 'demo')
    assert.deepEqual(patch.roles, { reviewer: ['or:qwen/qwen3-coder:free'] })
    assert.equal(patch.freeProfileId, 'or')
    assert.equal(removeProfile(connections({ freeProfileId: 'or' }), 'or')?.freeProfileId, null)
    assert.equal(removeProfile(connections({ profiles: [demo] }), 'demo'), null)
    assert.equal(removeProfile(connections(), 'missing'), null)
  })

  it('makes a connection the one that answers with its model, or hands the main role to the demo', () => {
    assert.deepEqual(chooseProfile(connections(), 'paid'), { roles: { main: ['paid:deepseek-chat'] }, activeProfileId: 'paid' })
    assert.deepEqual(chooseProfile(connections({ roles: { main: ['paid:deepseek-chat'], explore: ['or:qwen/qwen3-coder:free'] } }), 'demo'), {
      roles: { explore: ['or:qwen/qwen3-coder:free'] },
      activeProfileId: 'demo',
    })
    assert.deepEqual(chooseProfile(connections({ profiles: [demo, router, { ...paid, model: ' ' }] }), 'paid'), { activeProfileId: 'paid' })
  })
})
