import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cacheTermsOf, CLAUDE_CACHE_TTL_MS } from './cache-terms'
import { effortPerStep } from './families'

describe('cache terms (ADR 0130)', () => {
  it("reads the cache's prices from a price list, as shares of an uncached token", () => {
    assert.deepEqual(cacheTermsOf({ family: 'anthropic', reasoning: true, price: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 } }), {
      read: 0.1,
      write: 1.25,
      boundThinking: true,
      ttlMs: CLAUDE_CACHE_TTL_MS,
      source: 'price',
    })
    assert.deepEqual(cacheTermsOf({ family: 'deepseek', reasoning: true, price: { input: 0.3, cacheRead: 0.006 } }), { read: 0.02, write: 1, boundThinking: false, source: 'price' })
  })

  it('takes a price list without a cache price for one that discounts nothing', () => {
    assert.deepEqual(cacheTermsOf({ family: 'meta', reasoning: false, price: { input: 0.2 } }), { read: 1, write: 1, boundThinking: false, source: 'price' })
  })

  it('keeps shares within reason when a price list is odd', () => {
    const odd = cacheTermsOf({ family: 'other', reasoning: false, price: { input: 1, cacheRead: 5, cacheWrite: 0.5 } })
    assert.equal(odd.read, 1)
    assert.equal(odd.write, 1)
    assert.equal(cacheTermsOf({ family: 'other', reasoning: false, price: { input: 1, cacheRead: Number.NaN } }).read, 1)
  })

  it("falls back on what the family's providers usually charge without a price (a free model, a direct provider, a preset)", () => {
    assert.deepEqual(cacheTermsOf({ family: 'deepseek', reasoning: true }), { read: 0.1, write: 1, boundThinking: false, source: 'family' })
    assert.deepEqual(cacheTermsOf({ family: 'anthropic', reasoning: false, price: { input: 0 } }), { read: 0.1, write: 1.25, boundThinking: false, ttlMs: CLAUDE_CACHE_TTL_MS, source: 'family' })
    assert.equal(cacheTermsOf({ family: 'other', reasoning: false }).read, 0.5)
  })

  it('binds thinking only for a model that reasons in a family whose providers check it', () => {
    assert.equal(cacheTermsOf({ family: 'google', reasoning: true }).boundThinking, true)
    assert.equal(cacheTermsOf({ family: 'google', reasoning: false }).boundThinking, false)
    assert.equal(cacheTermsOf({ family: 'moonshot', reasoning: true }).boundThinking, false)
  })
})

describe('an effort for each step (ADR 0135)', () => {
  it('changes only where the prompt cache does not see it', () => {
    assert.equal(effortPerStep('openai', 'openai/gpt-5-mini', true), true)
    assert.equal(effortPerStep('deepseek', '@preset/deepseek-v4', true), true)
    assert.equal(effortPerStep('moonshot', 'moonshotai/kimi-k2-thinking', true), true)
    assert.equal(effortPerStep('openai', 'openai/gpt-oss-120b', true), false, 'gpt-oss writes its effort into the system message')
    assert.equal(effortPerStep('anthropic', 'anthropic/claude-sonnet-4.5', true), false, "Claude's reasoning is checked against its request")
    assert.equal(effortPerStep('google', 'google/gemini-2.5-pro', true), false)
    assert.equal(effortPerStep('qwen', 'qwen/qwen3-coder', true), false, 'not known to keep its cache')
    assert.equal(effortPerStep('openai', 'openai/gpt-4.1', false), false, 'a model that does not reason has no effort to change')
  })
})
