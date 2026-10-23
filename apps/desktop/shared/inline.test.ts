import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { headToLine, inlineState, isInlineSuggest, isRationedRef, tailFromLine } from './inline'
import { FREE_REF } from './models'
import type { ModelProfile, Settings } from './types'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const router: ModelProfile = { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true }
const ollama: ModelProfile = { id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', hasApiKey: false }

const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ profiles: [demo, router, ollama], activeProfileId: 'or', roles: {}, freeOnly: false, inlineSuggest: 'auto', ...patch }) as Settings

describe('whether the editor suggests code as you type', () => {
  it('is off when the setting says so, in the offline demo, and with no model', () => {
    assert.equal(inlineState(settings({ inlineSuggest: 'off', roles: { main: ['or:openai/gpt-5-mini'] } })).on, false)
    const offline = inlineState(settings({ activeProfileId: 'demo' }))
    assert.equal(offline.on, false)
    assert.match(offline.reason, /offline demo/)
    const none = inlineState(settings())
    assert.equal(none.on, false)
    assert.match(none.reason, /No model is connected/)
  })

  it('uses the Inline suggestions model, else what the utility and main roles use', () => {
    const own = inlineState(settings({ roles: { main: ['or:anthropic/claude-sonnet'], utility: ['or:openai/gpt-5-mini'], inline: ['ol:qwen2.5-coder'] } }))
    assert.deepEqual(own, { on: true, reason: 'Suggestions come from Ollama: qwen2.5-coder.' })
    assert.equal(inlineState(settings({ roles: { main: ['or:anthropic/claude-sonnet'], utility: ['or:openai/gpt-5-mini'] } })).reason, 'Suggestions come from OpenRouter: openai/gpt-5-mini.')
    assert.equal(inlineState(settings({ roles: { main: ['or:anthropic/claude-sonnet'] } })).reason, 'Suggestions come from OpenRouter: anthropic/claude-sonnet.')
  })

  it('under Auto keeps the free models daily requests for the agent; On spends them', () => {
    for (const main of [FREE_REF, 'or:qwen/qwen3-coder:free']) {
      const auto = inlineState(settings({ roles: { main: [main] } }))
      assert.equal(auto.on, false, main)
      assert.match(auto.reason, /kept for the agent/)
      assert.equal(inlineState(settings({ inlineSuggest: 'on', roles: { main: [main] } })).on, true, main)
    }
    // A server on this computer is free and has no daily limit.
    assert.equal(inlineState(settings({ roles: { main: ['ol:qwen2.5-coder'] } })).on, true)
  })

  it('with only free models allowed, takes the first free model of the role, or says there is none', () => {
    const mixed = settings({ freeOnly: true, roles: { main: [FREE_REF], inline: ['or:openai/gpt-5-mini', 'ol:qwen2.5-coder'] } })
    assert.equal(inlineState(mixed).reason, 'Suggestions come from Ollama: qwen2.5-coder.')
    const paid = inlineState(settings({ freeOnly: true, roles: { main: [FREE_REF], inline: ['or:openai/gpt-5-mini'] } }))
    assert.equal(paid.on, false)
    assert.match(paid.reason, /only free models/)
  })

  it('knows which models are rationed, and which settings values are modes', () => {
    const s = settings()
    assert.equal(isRationedRef(s, FREE_REF), true)
    assert.equal(isRationedRef(s, 'or:deepseek/deepseek-chat:free'), true)
    assert.equal(isRationedRef(s, 'or:deepseek/deepseek-chat'), false)
    assert.equal(isRationedRef(s, 'ol:qwen2.5-coder'), false)
    assert.equal(isRationedRef(s, 'gone:model'), false)
    assert.equal(isInlineSuggest('auto'), true)
    assert.equal(isInlineSuggest('always'), false)
    assert.equal(isInlineSuggest(1), false)
  })
})

describe('cutting what is sent at whole lines', () => {
  it('keeps the end of the text before the cursor from the start of a line', () => {
    assert.equal(tailFromLine('short', 10), 'short')
    assert.equal(tailFromLine('one\ntwo\nthree', 9), 'three')
    assert.equal(tailFromLine('x'.repeat(20), 10), '', 'a line longer than the limit is not sent in half')
  })

  it('keeps the start of the text after the cursor to the end of a line', () => {
    assert.equal(headToLine('short', 10), 'short')
    assert.equal(headToLine('one\ntwo\nthree', 9), 'one\ntwo')
    assert.equal(headToLine('x'.repeat(20), 10), '')
  })
})
