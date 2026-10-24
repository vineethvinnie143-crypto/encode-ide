import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRouterConfig, resolveModelList } from '@encode/router'
import { FREE_REF } from '../../shared/models'
import type { ModelProfile, Settings } from '../../shared/types'
import { providerIds, routerSettingsOf } from './router-settings'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const openRouter = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true, ...patch })
const openai = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true, ...patch })
const anthropic = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'an', name: 'Anthropic', kind: 'custom', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', hasApiKey: true, ...patch })
const ollama = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', hasApiKey: false, ...patch })

const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ profiles: [demo], activeProfileId: 'demo', roles: {}, freeOnly: true, freeProfileId: null, setupDone: true, ...patch }) as Settings

describe('the router\'s providers', () => {
  it('are the profiles that can be called, typed by where they point, with the demo and unfinished ones left out', () => {
    const { providers } = routerSettingsOf(settings({ profiles: [demo, openRouter(), openai(), anthropic(), ollama(), openai({ id: 'blank', baseUrl: '  ' })], activeProfileId: 'oa' }))
    const ids = providerIds([demo, openRouter(), openai(), anthropic(), ollama()])
    assert.deepEqual(Object.keys(providers).sort(), ['p-an', 'p-ol', 'p-oa', 'p-or'].sort())
    assert.equal(providers[ids.get('or')!].type, 'openrouter')
    assert.equal(providers[ids.get('oa')!].type, 'openai-compatible')
    assert.equal(providers[ids.get('an')!].type, 'anthropic')
    assert.equal(providers[ids.get('or')!].baseUrl, 'https://openrouter.ai/api/v1')
  })

  it('need a key, except a server on this machine that has none, and only that server is free to call', () => {
    const { providers } = routerSettingsOf(settings({ profiles: [demo, openai(), ollama(), ollama({ id: 'ol2', hasApiKey: true })], activeProfileId: 'oa' }))
    assert.deepEqual(providers['p-oa'], { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false })
    assert.equal(providers['p-ol'].needsKey, false)
    assert.equal(providers['p-ol'].free, true)
    assert.equal(providers['p-ol2'].needsKey, true, 'a key given to a local server is sent to it')
    assert.equal(providers['p-ol2'].free, true)
  })

  it('get names the router accepts, one to one, whatever the profile ids look like', () => {
    const ids = providerIds([{ id: 'a b' }, { id: 'a_b' }, { id: 'a:b' }, { id: '9'.repeat(100) }])
    const names = [...ids.values()]
    assert.equal(new Set(names).size, 4)
    for (const name of names) assert.match(name, /^[a-z][a-z0-9_-]{0,63}$/i)
  })
})

describe('the router\'s roles', () => {
  it('start from the active profile\'s model, so settings from before roles existed keep working', () => {
    const { roles } = routerSettingsOf(settings({ profiles: [demo, openai()], activeProfileId: 'oa' }))
    assert.deepEqual(roles, { main: ['p-oa:gpt-4o-mini'] })
  })

  it('carry the lists the settings name, each model under its provider, a model id with colons intact', () => {
    const { roles } = routerSettingsOf(
      settings({
        profiles: [demo, openRouter(), openai(), anthropic()],
        activeProfileId: 'an',
        roles: { main: ['an:claude-sonnet-4-5', 'or:qwen/qwen3-coder:free', FREE_REF], reviewer: ['oa:o3'] },
      }),
    )
    assert.deepEqual(roles, { main: ['p-an:claude-sonnet-4-5', 'p-or:qwen/qwen3-coder:free', '@free'], reviewer: ['p-oa:o3'] })
  })

  it('leave "@free" out when no connection can serve it, so it never falls to another key', () => {
    const { roles, freePool } = routerSettingsOf(settings({ profiles: [demo, openai()], activeProfileId: 'oa', roles: { main: [FREE_REF, 'oa:gpt-4o'] } }))
    assert.deepEqual(roles, { main: ['p-oa:gpt-4o'] })
    assert.deepEqual(freePool, { providers: [] })
  })

  it('give no role the free models unless the settings name them for it, though a free connection is set up (ADR 0094)', () => {
    const profiles = [demo, openRouter(), anthropic()]
    const router = routerSettingsOf(settings({ profiles, activeProfileId: 'an', freeOnly: false, freeProfileId: 'or', roles: { main: ['an:claude-sonnet-4-5'] } }))
    assert.deepEqual(router.roles, { main: ['p-an:claude-sonnet-4-5'] })
    const { config } = parseRouterConfig(router)
    for (const role of ['main', 'explore', 'planner', 'reviewer', 'summarizer', 'utility', 'inline']) assert.deepEqual(resolveModelList(config, { role }).refs, ['p-an:claude-sonnet-4-5'], role)
    // Named for one role, they serve that role (and those that follow it) only.
    const chosen = routerSettingsOf(settings({ profiles, activeProfileId: 'an', freeOnly: false, freeProfileId: 'or', roles: { main: ['an:claude-sonnet-4-5'], utility: [FREE_REF] } }))
    const parsed = parseRouterConfig(chosen).config
    assert.deepEqual(resolveModelList(parsed, { role: 'utility' }).refs, ['@free'])
    assert.deepEqual(resolveModelList(parsed, { role: 'inline' }).refs, ['@free'], 'inline suggestions follow Small tasks')
    assert.deepEqual(resolveModelList(parsed, { role: 'explore' }).refs, ['p-an:claude-sonnet-4-5'])
  })

  it('serve "@free" from the one connection that was named, and only that one', () => {
    const profiles = [demo, openRouter(), openRouter({ id: 'or2', name: 'Paid OpenRouter' })]
    assert.deepEqual(routerSettingsOf(settings({ profiles, activeProfileId: 'or', roles: { main: [FREE_REF] } })).freePool, { providers: ['p-or'] })
    assert.deepEqual(routerSettingsOf(settings({ profiles, activeProfileId: 'or', freeProfileId: 'or2', roles: { main: [FREE_REF] } })).freePool, { providers: ['p-or2'] })
  })

  it('drop what names a profile that is gone or cannot be called', () => {
    const { roles } = routerSettingsOf(settings({ profiles: [demo, openai({ baseUrl: '' })], activeProfileId: 'demo', roles: { main: ['oa:gpt-4o', 'gone:x'] } }))
    assert.deepEqual(roles, {})
  })
})

describe('what the router makes of it', () => {
  const full = settings({
    profiles: [demo, openRouter(), openai(), anthropic(), ollama()],
    activeProfileId: 'an',
    roles: { main: ['an:claude-sonnet-4-5', FREE_REF], explore: ['ol:llama3.2'], summarizer: [FREE_REF] },
    freeOnly: false,
  })

  it('has nothing to complain about', () => {
    const { config, problems } = parseRouterConfig(routerSettingsOf(full))
    assert.deepEqual(problems, [])
    assert.equal(config.freeOnly, false)
    assert.deepEqual(config.freePool.providers, ['p-or'])
  })

  it('sends a role without a list where core expects: explore has its own, plan and review follow main, compaction has its own', () => {
    const { config } = parseRouterConfig(routerSettingsOf(full))
    assert.deepEqual(resolveModelList(config, { role: 'explore' }).refs, ['p-ol:llama3.2'])
    assert.deepEqual(resolveModelList(config, { role: 'planner' }).refs, ['p-an:claude-sonnet-4-5', '@free'])
    assert.deepEqual(resolveModelList(config, { role: 'reviewer' }).refs, ['p-an:claude-sonnet-4-5', '@free'])
    assert.deepEqual(resolveModelList(config, { role: 'summarizer' }).refs, ['@free'])
    assert.deepEqual(resolveModelList(config, { role: 'utility' }).refs, ['p-an:claude-sonnet-4-5', '@free'])
  })

  it('keeps the free-only switch as it was set, and says no more than the settings do about keys', () => {
    assert.equal(parseRouterConfig(routerSettingsOf(settings({ freeOnly: true }))).config.freeOnly, true)
    const text = JSON.stringify(routerSettingsOf(full))
    assert.doesNotMatch(text, /hasApiKey|apiKey|sk-/)
  })

  it('has no provider and no model for the demo, so nothing real can be called by accident', () => {
    const { config } = parseRouterConfig(routerSettingsOf(settings()))
    assert.deepEqual(Object.keys(config.providers), [])
    assert.deepEqual(Object.keys(config.roles), [])
    assert.deepEqual(config.freePool.providers, [])
  })
})
