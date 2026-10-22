import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRouterConfig } from './config'
import { FreeTier } from './free-tier'
import { HealthTracker } from './health'
import { staticKeys } from './keys'
import { CANARY_RETRY_MS, FreePool } from './pool'
import { ModelRegistry } from './registry'
import { scopes, selectCandidates, type SelectionContext } from './select'
import { catalogEntry, FakeClock } from './testing'

function context(settings: unknown, keys: Record<string, string> = { openrouter: 'sk-or-v1-test-0123456789' }) {
  const clock = new FakeClock()
  const { config } = parseRouterConfig(settings)
  const registry = new ModelRegistry()
  registry.setProviders(config.providers)
  registry.setOverrides(config.models)
  const health = new HealthTracker(clock)
  const pool = new FreePool(registry, health, clock)
  const tier = new FreeTier(clock, 'openrouter', config.freePool.requestsPerMinute)
  const ctx: SelectionContext = {
    config,
    registry,
    health,
    pool,
    freeTier: (provider) => (provider === 'openrouter' ? tier : undefined),
    keys: staticKeys(keys),
    hasAdapter: (type) => type !== 'anthropic',
    clock,
  }
  return { ctx, clock, registry, health, pool, tier, config }
}

const requirements = { promptTokens: 1_000, maxOutputTokens: 4_096, tools: false, images: false }

describe('selectCandidates', () => {
  it('sets every model that cannot take the call aside, with the reason', () => {
    const { ctx, registry, health, clock } = context({
      providers: { openrouter: { type: 'openrouter' }, anthropic: { type: 'anthropic' }, local: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' }, other: { type: 'openai-compatible', baseUrl: 'https://api.other.test/v1' } },
      roles: { main: ['anthropic:claude-sonnet-5', 'other:model', 'openrouter:old/model', 'openrouter:no/tools', 'openrouter:cooling/model', 'local:qwen', 'openrouter:ok/model'] },
    })
    registry.setCatalog('openrouter', [
      catalogEntry('old/model', { expiresAt: clock.now() - 1 }),
      catalogEntry('no/tools', { capabilities: { tools: false, parallelTools: false, images: false, reasoning: false, promptCache: false } }),
      catalogEntry('cooling/model'),
      catalogEntry('ok/model'),
    ], clock.now())
    health.failure('openrouter:cooling/model', { kind: 'server', message: 'HTTP 502' })
    const { candidates, skipped } = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements: { ...requirements, tools: true } })
    assert.deepEqual(candidates.map((candidate) => candidate.info.key), ['local:qwen', 'openrouter:ok/model'])
    assert.deepEqual(
      skipped.map((skip) => [skip.key, skip.reason]),
      [
        ['anthropic:claude-sonnet-5', 'no-adapter'],
        ['other:model', 'no-key'],
        ['openrouter:old/model', 'expired'],
        ['openrouter:no/tools', 'tools'],
        ['openrouter:cooling/model', 'cooling'],
      ],
    )
  })

  it('blocks paid models without touching free ones, and a whole provider at once', () => {
    const { ctx, registry, health, clock } = context({ roles: { main: ['openrouter:paid/model', 'openrouter:free/model:free'] } })
    registry.setCatalog('openrouter', [catalogEntry('paid/model'), catalogEntry('free/model:free')], clock.now())
    health.block(scopes.paid('openrouter'), { until: clock.now() + 60_000, kind: 'payment', reason: 'no credit' })
    let result = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements })
    assert.deepEqual(result.candidates.map((candidate) => candidate.info.model), ['free/model:free'])
    assert.equal(result.skipped[0].reason, 'paid-blocked')
    health.block(scopes.provider('openrouter'), { until: clock.now() + 60_000, kind: 'auth', reason: 'bad key' })
    result = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements })
    assert.equal(result.candidates.length, 0)
    assert.ok(result.skipped.every((skip) => skip.reason === 'provider-blocked' && skip.until === clock.now() + 60_000))
  })

  it("fits the prompt with a margin for another tokenizer, but none for the session's own model", () => {
    const { ctx, registry, clock } = context({ roles: { main: ['openrouter:a', 'openrouter:b'] } })
    registry.setCatalog('openrouter', [catalogEntry('a', { contextWindow: 100_000 }), catalogEntry('b', { contextWindow: 100_000 })], clock.now())
    const big = { ...requirements, promptTokens: 95_000, maxOutputTokens: 512 }
    assert.equal(selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements: big }).candidates.length, 0)
    const sticky = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements: big, sticky: 'openrouter:b' })
    assert.deepEqual(sticky.candidates.map((candidate) => [candidate.info.model, candidate.maxOutputTokens]), [['b', 512]])
    const skip = sticky.skipped.find((entry) => entry.key === 'openrouter:a')
    assert.deepEqual(skip && [skip.reason, skip.window], ['context', 100_000])
  })

  it('clamps the output budget to what the window leaves', () => {
    const { ctx, registry, clock } = context({ roles: { main: ['openrouter:a'] } })
    registry.setCatalog('openrouter', [catalogEntry('a', { contextWindow: 50_000, maxOutputTokens: 40_000 })], clock.now())
    const [candidate] = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements: { ...requirements, promptTokens: 30_000, maxOutputTokens: 32_000 } }).candidates
    assert.equal(candidate.maxOutputTokens, 50_000 - 33_000)
  })

  it('skips the free tier while it is closed, or when the pacing wait is too long', () => {
    const { ctx, registry, tier, clock } = context({ freePool: { requestsPerMinute: 1, maxPacingWaitMs: 10_000 } })
    registry.setCatalog('openrouter', [catalogEntry('a:free')], clock.now())
    tier.record()
    assert.equal(selectCandidates(ctx, { role: 'main', refs: ['@free'], requirements }).skipped[0].reason, 'pacing')
    tier.close({ until: clock.now() + 5_000, kind: 'free-rpm', reason: 'minute cap' })
    assert.equal(selectCandidates(ctx, { role: 'main', refs: ['@free'], requirements }).skipped[0].reason, 'free-closed')
  })

  it('offers later free models as OpenRouter server-side fallbacks, never a paid one', () => {
    const { ctx, registry, clock } = context({ roles: { main: ['openrouter:a:free', 'openrouter:paid', 'openrouter:b:free', 'openrouter:c:free', 'openrouter:d:free'] } })
    registry.setCatalog('openrouter', ['a:free', 'paid', 'b:free', 'c:free', 'd:free'].map((id) => catalogEntry(id)), clock.now())
    const { candidates } = selectCandidates(ctx, { role: 'main', refs: ctx.config.roles.main, requirements })
    assert.deepEqual(candidates[0].serverFallbacks, ['b:free', 'c:free'])
    assert.deepEqual(candidates[1].serverFallbacks, [])
  })
})

describe('selectCandidates with only free models enabled', () => {
  const providers = {
    openrouter: { type: 'openrouter' },
    anthropic: { type: 'anthropic' },
    local: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', free: true },
  }
  const main = ['anthropic:claude-sonnet-5', 'openrouter:paid/model', 'openrouter:unlisted/model', 'openrouter:free/model:free', 'local:qwen']

  it('sets every model that is not free aside before anything else, and leaves the free ones alone', () => {
    const { ctx, registry, clock } = context({ freeOnly: true, providers, roles: { main } })
    registry.setCatalog('openrouter', [catalogEntry('paid/model'), catalogEntry('free/model:free')], clock.now())
    // The paid model was also tried already, and Anthropic has neither a key nor an adapter: it is still "not free" first.
    const { candidates, skipped } = selectCandidates(ctx, { role: 'main', refs: main, requirements, exclude: new Set(['openrouter:paid/model']) })
    assert.deepEqual(candidates.map((candidate) => candidate.info.key), ['openrouter:free/model:free', 'local:qwen'])
    assert.deepEqual(
      skipped.map((skip) => [skip.key, skip.reason]),
      [
        ['anthropic:claude-sonnet-5', 'not-free'],
        ['openrouter:paid/model', 'not-free'],
        ['openrouter:unlisted/model', 'not-free'],
      ],
    )
    assert.match(skipped[1].message, /paid\/model is not a free model, and only free models are enabled/)
    assert.match(skipped[2].message, /not in the provider's list of free models/)
  })

  it('changes nothing for the free pool, and nothing at all while the switch is off', () => {
    const on = context({ freeOnly: true, providers })
    on.registry.setCatalog('openrouter', [catalogEntry('paid/model'), catalogEntry('a:free'), catalogEntry('b:free')], on.clock.now())
    const pooled = selectCandidates(on.ctx, { role: 'main', refs: ['@free'], requirements })
    assert.deepEqual(pooled.candidates.map((candidate) => candidate.info.model).sort(), ['a:free', 'b:free'])
    assert.deepEqual(pooled.candidates.map((candidate) => candidate.serverFallbacks.length), [1, 0], 'the first free model has the second as its server-side fallback')
    assert.deepEqual(pooled.skipped, [])

    const off = context({ providers, roles: { main } })
    off.registry.setCatalog('openrouter', [catalogEntry('paid/model'), catalogEntry('free/model:free')], off.clock.now())
    const { candidates, skipped } = selectCandidates(off.ctx, { role: 'main', refs: main, requirements })
    assert.deepEqual(candidates.map((candidate) => candidate.info.key), ['openrouter:paid/model', 'openrouter:unlisted/model', 'openrouter:free/model:free', 'local:qwen'])
    assert.deepEqual(skipped.map((skip) => skip.reason), ['no-adapter'])
  })
})

describe('FreePool', () => {
  it('ranks by role fit first, then eval score, health and the canary', () => {
    const { registry, pool, health, clock, config } = context({})
    registry.setCatalog('openrouter', [
      catalogEntry('fast:free', { roles: ['explore'] }),
      catalogEntry('main:free', { roles: ['main'] }),
      catalogEntry('plain-a:free'),
      catalogEntry('plain-b:free'),
    ], clock.now())
    registry.setScores({ 'openrouter:plain-b:free': { main: 0.95 }, 'openrouter:plain-a:free': { main: 0.4 } })
    assert.deepEqual(pool.members('openrouter', 'main', config.freePool).map((model) => model.model), ['main:free', 'plain-b:free', 'plain-a:free', 'fast:free'])
    for (let index = 0; index < 6; index++) health.failure('openrouter:plain-b:free', { kind: 'server', message: 'x' })
    pool.recordCanary('openrouter:plain-a:free', 'passed')
    assert.deepEqual(pool.members('openrouter', 'main', config.freePool).slice(1, 3).map((model) => model.model), ['plain-a:free', 'plain-b:free'])
    assert.equal(pool.members('openrouter', 'explore', config.freePool)[0].model, 'fast:free')
  })

  it('leaves out paid, small, retired, excluded and failed models, and moves the session model first', async () => {
    const { registry, pool, clock, config } = context({ freePool: { exclude: ['bad/*'], minContextWindow: 16_000 } })
    registry.setCatalog('openrouter', [
      catalogEntry('paid'),
      catalogEntry('tiny:free', { contextWindow: 8_000 }),
      catalogEntry('old:free', { expiresAt: clock.now() - 1 }),
      catalogEntry('bad/model:free'),
      catalogEntry('flaky:free'),
      catalogEntry('good:free'),
      catalogEntry('other:free'),
    ], clock.now())
    pool.recordCanary('openrouter:flaky:free', 'failed', 'bad tool JSON')
    assert.deepEqual(pool.members('openrouter', 'main', config.freePool).map((model) => model.model).sort(), ['good:free', 'other:free'])
    assert.equal(pool.members('openrouter', 'main', config.freePool, 'openrouter:other:free')[0].model, 'other:free')
    await clock.advance(CANARY_RETRY_MS)
    assert.ok(pool.members('openrouter', 'main', config.freePool).some((model) => model.model === 'flaky:free'), 'a failed canary is retried after a week')
    assert.deepEqual(pool.unchecked('openrouter', config.freePool, 10).map((model) => model.model).sort(), ['flaky:free', 'good:free', 'other:free'])
  })
})
