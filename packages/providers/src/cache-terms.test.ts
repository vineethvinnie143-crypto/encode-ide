import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cacheTermsOf, CLAUDE_CACHE_TTL_MS } from './cache-terms'

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
