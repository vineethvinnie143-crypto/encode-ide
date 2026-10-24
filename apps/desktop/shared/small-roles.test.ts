import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applySmallRoles, smallRoleSuggestion } from './small-roles'
import type { ModelInfo, ModelProfile, Settings } from './types'

const router: ModelProfile = { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true }
const anthropic: ModelProfile = { id: 'an', name: 'Anthropic', kind: 'custom', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', hasApiKey: true }
const ollama: ModelProfile = { id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder', hasApiKey: false }

const draft = (patch: Partial<Settings> = {}) =>
  ({ profiles: [router, anthropic, ollama], activeProfileId: 'or', roles: { main: ['or:anthropic/claude-sonnet-4.5'] }, freeOnly: false, ...patch }) as Settings

const priced = (id: string, input: number, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, price: { input, output: input * 5 }, tools: true, ...extra })

const openRouterList: ModelInfo[] = [
  priced('anthropic/claude-sonnet-4.5', 3),
  priced('anthropic/claude-3.5-haiku', 0.8),
  priced('anthropic/claude-haiku-4.5', 1),
  priced('openai/gpt-5', 1.25),
  priced('openai/gpt-5-mini', 0.25),
  priced('google/gemini-2.5-pro', 1.25),
  priced('google/gemini-2.5-flash', 0.3),
  priced('google/gemini-2.5-flash-lite', 0.1),
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', free: true, tools: true },
  priced('deepseek/deepseek-chat', 0.3),
]
const lists: Record<string, ModelInfo[]> = {
  or: openRouterList,
  an: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }],
  ol: [{ id: 'qwen3-coder', name: 'qwen3-coder', free: true }],
}
const catalog = (profileId: string) => lists[profileId]

describe('a cheaper model for the small jobs', () => {
  it('is the newest smaller model of Main’s family on the same connection, for the small roles that follow Main', () => {
    const found = smallRoleSuggestion(draft(), catalog)
    assert.equal(found?.ref, 'or:anthropic/claude-haiku-4.5')
    assert.deepEqual(found?.roles, ['explore', 'utility'])
    assert.equal(Math.round((found?.saving ?? 0) * 100), 67)
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:openai/gpt-5'] } }), catalog)?.ref, 'or:openai/gpt-5-mini')
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:google/gemini-2.5-pro'] } }), catalog)?.ref, 'or:google/gemini-2.5-flash', 'flash, not flash-lite')
    // A direct connection lists no prices: the sibling still is the smaller model.
    const direct = smallRoleSuggestion(draft({ roles: { main: ['an:claude-sonnet-4-5'] } }), catalog)
    assert.equal(direct?.ref, 'an:claude-haiku-4-5')
    assert.equal(direct?.saving, undefined)
  })

  it('leaves out the roles that have a list of their own, and is not made when none is left', () => {
    assert.deepEqual(smallRoleSuggestion(draft({ roles: { main: ['or:openai/gpt-5'], explore: ['or:openai/gpt-5'] } }), catalog)?.roles, ['utility'])
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:openai/gpt-5'], explore: ['@free'], utility: ['or:openai/gpt-5'] } }), catalog), null)
  })

  it('never suggests a free model, nor one for a Main that is free, small already, local or only free models may run', () => {
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['@free'] } }), catalog), null)
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:qwen/qwen3-coder:free'] } }), catalog), null)
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:openai/gpt-5-mini'] } }), catalog), null)
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['or:deepseek/deepseek-chat'] } }), catalog), null, 'no smaller sibling')
    assert.equal(smallRoleSuggestion(draft({ roles: { main: ['ol:qwen3-coder'] } }), catalog), null)
    assert.equal(smallRoleSuggestion(draft({ freeOnly: true }), catalog), null)
    // Free siblings are not suggested: free providers may keep what they are sent.
    const freeOnlySibling = { or: [priced('anthropic/claude-sonnet-4.5', 3), { id: 'anthropic/claude-haiku-4.5', name: 'h', free: true, tools: true }] }
    assert.equal(smallRoleSuggestion(draft(), (id) => freeOnlySibling[id as 'or']), null)
  })

  it('is not made for a sibling that costs as much, or that cannot call tools', () => {
    const dear = { or: [priced('anthropic/claude-sonnet-4.5', 3), priced('anthropic/claude-haiku-4.5', 3)] }
    assert.equal(smallRoleSuggestion(draft(), (id) => dear[id as 'or']), null)
    const toolless = { or: [priced('anthropic/claude-sonnet-4.5', 3), priced('anthropic/claude-haiku-4.5', 1, { tools: false })] }
    assert.equal(smallRoleSuggestion(draft(), (id) => toolless[id as 'or']), null)
  })

  it('gives the model to its roles and leaves the others as they were', () => {
    const roles = { main: ['or:openai/gpt-5'], reviewer: ['or:openai/gpt-5'] }
    assert.deepEqual(applySmallRoles({ roles }, { ref: 'or:openai/gpt-5-mini', roles: ['explore', 'utility'] }), {
      roles: { main: ['or:openai/gpt-5'], reviewer: ['or:openai/gpt-5'], explore: ['or:openai/gpt-5-mini'], utility: ['or:openai/gpt-5-mini'] },
    })
  })
})
