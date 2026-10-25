import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelProfile, Settings } from '../../shared/types'
import { hostConfigOf } from './config'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const profile = (patch: Partial<ModelProfile>): ModelProfile => ({ id: 'p', name: 'P', kind: 'custom', baseUrl: 'https://example.test/v1', model: 'm', hasApiKey: true, ...patch })

const settings = (patch: Partial<Settings>): Settings =>
  ({ profiles: [profile({})], activeProfileId: 'p', policy: 'workspace-write', maxSteps: 30, maxGoalRounds: 8, computer: false, computerSupported: true, recentWorkspaces: [], lastWorkspace: null, agentMode: 'code', roles: {}, freeOnly: true, freeProfileId: null, setupDone: true, keyStorage: { mode: 'keychain' }, ...patch }) as Settings

describe('the host configuration', () => {
  it('carries the limits, which model answers and the router\'s settings, and never a key', () => {
    const config = hostConfigOf(settings({ policy: 'read-only', maxSteps: 12, maxGoalRounds: 3 }), () => 4)
    assert.equal(config.policy, 'read-only')
    assert.equal(config.maxSteps, 12)
    assert.equal(config.maxGoalRounds, 3)
    assert.equal(config.model, 'router')
    assert.deepEqual(config.router.roles, { main: ['p-p:m'] })
    assert.deepEqual(config.providers, { 'p-p': { profile: 'p', name: 'P', keyRevision: 4 } })
    assert.doesNotMatch(JSON.stringify(config), /hasApiKey|apiKey/)
  })

  it('names the search provider, and carries nothing of its key', () => {
    assert.equal(hostConfigOf(settings({})).searchProvider, 'parallel', 'a settings object from before search providers')
    const config = hostConfigOf(settings({ searchProvider: 'brave', searchKeys: ['brave'] }))
    assert.equal(config.searchProvider, 'brave')
    assert.doesNotMatch(JSON.stringify(config), /searchKeys|"key"/)
    assert.equal(hostConfigOf(settings({ searchProvider: 'bing' as never })).searchProvider, 'parallel', 'an unknown provider is not passed on')
  })

  it('tells the host whether the Computer tool is on, and never on a computer that has no way to run it', () => {
    assert.equal(hostConfigOf(settings({})).computer, false)
    assert.equal(hostConfigOf(settings({ computer: true })).computer, true)
    assert.equal(hostConfigOf(settings({ computer: true, computerSupported: false })).computer, false)
  })

  it('says a provider has no key by giving it no revision, and a new key by a new one', () => {
    const none = hostConfigOf(settings({ profiles: [profile({ hasApiKey: false })] }), () => 9)
    assert.equal(none.providers['p-p'].keyRevision, null)
    let revision = 1
    const first = hostConfigOf(settings({}), () => revision)
    revision = 2
    const second = hostConfigOf(settings({}), () => revision)
    assert.notEqual(first.providers['p-p'].keyRevision, second.providers['p-p'].keyRevision)
  })

  it('answers with the demo until a real model is chosen, and with nothing when the one chosen has no model yet', () => {
    assert.equal(hostConfigOf(settings({ profiles: [demo], activeProfileId: 'demo' })).model, 'demo')
    assert.equal(hostConfigOf(settings({ profiles: [demo, profile({ model: '' })], activeProfileId: 'p' })).model, 'none')
    assert.equal(hostConfigOf(settings({ profiles: [demo, profile({})], activeProfileId: 'p' })).model, 'router')
  })

  it('passes on the effort chosen for each role, and nothing for a settings object from before efforts', () => {
    assert.deepEqual(hostConfigOf(settings({ efforts: { main: 'max', explore: 'low' } })).efforts, { main: 'max', explore: 'low' })
    assert.deepEqual(hostConfigOf(settings({})).efforts, {})
    assert.deepEqual(hostConfigOf(settings({ efforts: { main: 'turbo' } as never })).efforts, {}, 'a level the models do not know is not passed on')
  })

  it('lists no provider for the demo, or for a profile with no address', () => {
    const config = hostConfigOf(settings({ profiles: [demo, profile({ id: 'blank', baseUrl: '' })], activeProfileId: 'demo' }))
    assert.deepEqual(config.providers, {})
    assert.deepEqual(config.router.providers, {})
  })
})
