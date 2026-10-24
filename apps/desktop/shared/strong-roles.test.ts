import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyStrongRoles, strongRoleSuggestion } from './strong-roles'
import type { ModelInfo, ModelProfile, Settings } from './types'

const router: ModelProfile = { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true }
const deepseek: ModelProfile = { id: 'ds', name: 'DeepSeek', kind: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasApiKey: true }
const ollama: ModelProfile = { id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder', hasApiKey: false }

const draft = (patch: Partial<Settings> = {}) =>
  ({ profiles: [router, deepseek, ollama], activeProfileId: 'or', roles: { main: ['or:deepseek/deepseek-chat'] }, freeOnly: false, ...patch }) as Settings

const priced = (id: string, input: number, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, price: { input, output: input * 5 }, tools: true, ...extra })

const openRouterList: ModelInfo[] = [
  priced('deepseek/deepseek-chat', 0.28),
  priced('anthropic/claude-sonnet-4', 3),
  priced('anthropic/claude-sonnet-4.5', 3),
  priced('anthropic/claude-opus-4.1', 15),
  priced('anthropic/claude-haiku-4.5', 1),
  priced('openai/gpt-5', 1.25),
  priced('openai/gpt-5-pro', 15),
  priced('openai/gpt-5-mini', 0.25),
  priced('google/gemini-2.5-pro', 1.25),
  { id: 'x-ai/grok-4:free', name: 'Grok 4 (free)', free: true, tools: true },
]
const lists: Record<string, ModelInfo[]> = {
  or: openRouterList,
  ds: [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'deepseek-reasoner', name: 'deepseek-reasoner' }],
  ol: [{ id: 'qwen3-coder', name: 'qwen3-coder', free: true }],
}
const catalog = (profileId: string) => lists[profileId]

describe('a strong model for planning and review', () => {
  it('is the newest Sonnet on the same connection, else GPT-5, else Gemini Pro, for the roles that follow a smaller Main', () => {
    const found = strongRoleSuggestion(draft(), catalog)
    assert.equal(found?.ref, 'or:anthropic/claude-sonnet-4.5')
    assert.deepEqual(found?.roles, ['planner', 'reviewer'])
    assert.equal(found?.main.id, 'deepseek/deepseek-chat')
    const noClaude = (id: string) => (id === 'or' ? openRouterList.filter((model) => !model.id.includes('claude')) : lists[id])
    assert.equal(strongRoleSuggestion(draft(), noClaude)?.ref, 'or:openai/gpt-5', 'not GPT-5 Pro')
    const onlyGemini = (id: string) => (id === 'or' ? openRouterList.filter((model) => model.id.includes('gemini') || model.id.includes('deepseek')) : lists[id])
    assert.equal(strongRoleSuggestion(draft(), onlyGemini)?.ref, 'or:google/gemini-2.5-pro')
  })

  it('leaves out a role with a list of its own, and is not made when none is left', () => {
    assert.deepEqual(strongRoleSuggestion(draft({ roles: { main: ['or:deepseek/deepseek-chat'], reviewer: ['or:openai/gpt-5'] } }), catalog)?.roles, ['planner'])
    assert.equal(strongRoleSuggestion(draft({ roles: { main: ['or:deepseek/deepseek-chat'], planner: ['or:openai/gpt-5'], reviewer: ['or:openai/gpt-5'] } }), catalog), null)
  })

  it('is not made for a strong Main, free-only, a connection with no strong model, a local server or no catalog yet', () => {
    assert.equal(strongRoleSuggestion(draft({ roles: { main: ['or:anthropic/claude-sonnet-4.5'] } }), catalog), null)
    assert.equal(strongRoleSuggestion(draft({ freeOnly: true }), catalog), null)
    assert.equal(strongRoleSuggestion(draft({ roles: { main: ['ds:deepseek-chat'] } }), catalog), null, 'DeepSeek lists no strong model')
    assert.equal(strongRoleSuggestion(draft({ roles: { main: ['ol:qwen3-coder'] } }), catalog), null)
    assert.equal(strongRoleSuggestion(draft(), () => undefined), null)
    assert.equal(strongRoleSuggestion(draft(), (id) => (id === 'or' ? openRouterList.filter((model) => model.free || model.id.startsWith('deepseek')) : [])), null, 'never a free model')
  })

  it('gives the model to those roles only', () => {
    const roles = { main: ['or:deepseek/deepseek-chat'], explore: ['or:deepseek/deepseek-chat'] }
    assert.deepEqual(applyStrongRoles({ roles }, { ref: 'or:anthropic/claude-sonnet-4.5', roles: ['planner', 'reviewer'] }).roles, {
      ...roles,
      planner: ['or:anthropic/claude-sonnet-4.5'],
      reviewer: ['or:anthropic/claude-sonnet-4.5'],
    })
  })
})
