import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { needsNoGuide, shortGuide } from './guide'

describe('which models get the short guide', () => {
  it('are the frontier models, however the provider writes their names', () => {
    for (const model of [
      'claude-sonnet-4-5',
      'claude-sonnet-4-20250514',
      'claude-opus-4-1-20250805',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4:beta',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'gpt-5',
      'openai/gpt-5.1-codex',
      'gpt-5-2025-08-07',
      'gpt-5-pro',
      'o3',
      'google/gemini-2.5-pro',
      'gemini-3-pro-preview',
      'x-ai/grok-4',
    ]) {
      assert.ok(needsNoGuide(model), model)
    }
  })

  it('leave out older and smaller models, and every other family', () => {
    for (const model of [
      'claude-3-5-sonnet-20241022',
      'anthropic/claude-3.7-sonnet',
      'claude-haiku-4-5',
      'gpt-5-mini',
      'gpt-5.1-codex-mini',
      'gpt-4.1',
      'o3-mini',
      'gemini-2.5-flash',
      'gemini-2.0-pro-exp',
      'grok-4-fast',
      'deepseek/deepseek-chat',
      'qwen/qwen3-coder',
      'z-ai/glm-4.6',
      'moonshotai/kimi-k2',
      'scripted',
      '@free',
    ]) {
      assert.ok(!needsNoGuide(model), model)
    }
  })

  it('are sent the full guide when the person chooses it', () => {
    assert.equal(shortGuide(undefined, 'gpt-5'), true)
    assert.equal(shortGuide('auto', 'gpt-5'), true)
    assert.equal(shortGuide('full', 'gpt-5'), false)
    assert.equal(shortGuide('auto', 'qwen/qwen3-coder'), false)
  })
})
