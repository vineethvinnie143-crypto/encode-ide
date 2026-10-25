import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CacheTerms } from '@encode/providers'
import { BOUND_LIMIT, MAX_STEPS_AHEAD, MIN_SAVING_TOKENS, MIN_STEPS_AHEAD, rewritePays, ROLLING_FLOOR, shorteningPolicy, stepsAhead } from './shortening'

const terms = (over: Partial<CacheTerms>): CacheTerms => ({ read: 0.1, write: 1, boundThinking: false, source: 'price', ...over })

describe('shortening profiles (ADR 0130)', () => {
  it('shortens in bulk, two steps behind and to 800 characters, where the provider binds the reasoning', () => {
    const policy = shorteningPolicy(terms({ read: 0.1, write: 1.25, boundThinking: true }))
    assert.equal(policy.profile, 'bound')
    assert.deepEqual(policy.recent, { steps: 2, reads: 2 })
    assert.equal(policy.limit, BOUND_LIMIT)
    assert.equal(policy.atRequestStart, true)
    assert.equal(policy.floor, 32_000)
  })

  it('rolls a step behind where a rewrite costs little, keeping what the model finds code by for three', () => {
    const policy = shorteningPolicy(terms({ read: 0.25 }))
    assert.equal(policy.profile, 'rolling')
    assert.deepEqual(policy.recent, { steps: 1, reads: 3 })
    assert.equal(policy.atRequestStart, false)
    assert.equal(policy.floor, ROLLING_FLOOR)
    assert.equal(policy.share, 0.1)
  })

  it('rolls from 16,000 tokens in any window where nothing is cached', () => {
    const policy = shorteningPolicy(terms({ read: 1 }))
    assert.equal(policy.profile, 'uncached')
    assert.equal(policy.share, 0)
    assert.equal(shorteningPolicy(terms({ read: 0.95 })).profile, 'uncached', 'a discount of a twentieth is no cache')
  })

  it('assumes a cache at a tenth of the price when the client cannot tell', () => {
    const policy = shorteningPolicy(undefined)
    assert.equal(policy.profile, 'rolling')
    assert.equal(policy.terms.read, 0.1)
  })

  it('rewrites when what it saves on the requests ahead is more than what it sends again now', () => {
    const cheap = { read: 0.02, write: 1 }
    const tenth = { read: 0.1, write: 1 }
    // 2,000 saved over 10 requests at a tenth: 2,000; a tail of 2,000 sent again at nine tenths: 1,800.
    assert.equal(rewritePays(2_000, 2_000, 10, tenth), true)
    assert.equal(rewritePays(2_000, 2_500, 10, tenth), false)
    assert.equal(rewritePays(2_000, 2_000, 10, cheap), false, 'a cache at 2% is cheaper to keep than to write again')
    assert.equal(rewritePays(2_000, 50_000, 10, { read: 1, write: 1 }), true, 'without a cache nothing is sent again for it')
    assert.equal(rewritePays(MIN_SAVING_TOKENS - 1, 0, 40, { read: 1, write: 1 }), false, 'too little to change the prompt for')
    assert.equal(rewritePays(5_000, 100_000, 4, { read: 0.1, write: 1.25 }, true), true, 'an expired cache costs nothing to give up')
  })

  it('expects a conversation to go on about as long as it has', () => {
    assert.equal(stepsAhead(0), MIN_STEPS_AHEAD)
    assert.equal(stepsAhead(12), 12)
    assert.equal(stepsAhead(500), MAX_STEPS_AHEAD)
  })
})
