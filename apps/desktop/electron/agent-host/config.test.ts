import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelProfile, Settings } from '../../shared/types'
import { hostConfigOf } from './config'

const profile = (patch: Partial<ModelProfile>): ModelProfile => ({ id: 'p', name: 'P', kind: 'custom', baseUrl: 'https://example.test/v1', model: 'm', hasApiKey: true, ...patch })

const settings = (patch: Partial<Settings>): Settings =>
  ({ profiles: [profile({})], activeProfileId: 'p', policy: 'workspace-write', maxSteps: 30, maxGoalRounds: 8, recentWorkspaces: [], lastWorkspace: null, agentMode: 'code', keyStorage: { mode: 'keychain' }, ...patch }) as Settings

describe('the host configuration', () => {
  it('carries the limits and the active model, and never a key', () => {
    const config = hostConfigOf(settings({ policy: 'read-only', maxSteps: 12, maxGoalRounds: 3 }))
    assert.deepEqual(config, { policy: 'read-only', maxSteps: 12, maxGoalRounds: 3, profile: { id: 'p', kind: 'custom', baseUrl: 'https://example.test/v1', model: 'm' } })
    assert.doesNotMatch(JSON.stringify(config), /hasApiKey|apiKey/)
  })

  it('adds the context window when the catalog knows it', () => {
    const config = hostConfigOf(settings({ profiles: [profile({ kind: 'openrouter', model: 'a/b:free' })] }), (p) => (p.model === 'a/b:free' ? 131_072 : undefined))
    assert.equal(config.profile?.contextWindow, 131_072)
  })

  it('has no model when none is active', () => {
    assert.equal(hostConfigOf(settings({ activeProfileId: null })).profile, null)
    assert.equal(hostConfigOf(settings({ activeProfileId: 'gone' })).profile, null)
  })
})
