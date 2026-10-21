import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readGatewayError, VirtualModels } from '@encode/gateway-protocol'
import { CATALOG, catalogJson, Harness } from '../testing/harness'
import { parseKeyInfo } from './app'

const HOUR = 3_600_000

describe("OpenRouter's key answer", () => {
  it("reads the free counters and the day's spend", () => {
    assert.deepEqual(
      parseKeyInfo({ data: { free_model_daily_requests: { limit: 1000, used: 40, remaining: 960 }, usage_daily: 0, limit: 5, limit_remaining: 4.5 } }),
      { free: { limit: 1000, used: 40, remaining: 960 }, creditsUsedToday: 0, creditLimit: 5, creditLimitRemaining: 4.5 },
    )
    assert.deepEqual(parseKeyInfo({ data: { usage_daily: 0.2 } }), { free: null, creditsUsedToday: 0.2, creditLimit: null, creditLimitRemaining: null })
    assert.equal(parseKeyInfo({ error: 'x' }), null)
    assert.equal(parseKeyInfo(null), null)
  })
})

describe('the scheduled job', () => {
  it("takes OpenRouter's counters, so the gateway stops when the account's free requests are gone", async () => {
    const harness = await Harness.create()
    const { access_token: token } = await harness.signIn()
    harness.openrouter.key = { data: { free_model_daily_requests: { limit: 1000, used: 1000, remaining: 0 }, usage_daily: 0 } }
    await harness.gateway.scheduled()
    const response = await harness.chat(token, {})
    assert.equal(response.status, 503)
    assert.equal(readGatewayError(await response.json())?.code, 'free_tier_exhausted')
  })

  it('sends a critical alert, once a day, when the free key spends money', async () => {
    const harness = await Harness.create()
    harness.openrouter.key = { data: { free_model_daily_requests: { limit: 1000, used: 3, remaining: 997 }, usage_daily: 0.0042 } }
    await harness.gateway.scheduled()
    await harness.gateway.scheduled()
    assert.equal(harness.webhooks.length, 1)
    const [hook] = harness.webhooks
    assert.equal(hook.url, 'https://hooks.example.test/alerts')
    assert.match(String(hook.body.text), /^\[eNCode gateway\] CRITICAL: The free-tier key spent 0.0042 credits today/)
    assert.equal(hook.body.content, hook.body.text)
  })

  it('pauses the free tier when the key is refused', async () => {
    const harness = await Harness.create()
    harness.openrouter.keyStatus = 401
    await harness.gateway.scheduled()
    assert.equal((await harness.control.status()).available, false)
    assert.equal(harness.webhooks.length, 1)
    assert.match(String(harness.webhooks[0].body.text), /401/)
  })

  it('rebuilds a missing or stale pool, and keeps the old one when the catalog comes back empty', async () => {
    const harness = await Harness.create({ pool: null })
    await harness.gateway.scheduled()
    assert.deepEqual(harness.store.doc?.pools[VirtualModels.main], ['acme/big:free', 'acme/medium:free', 'beta/vision:free'])
    const calls = () => harness.openrouter.calls.filter((call) => call.endsWith('/models')).length
    await harness.gateway.scheduled()
    assert.equal(calls(), 1, 'a fresh pool is not fetched again')
    harness.advance(HOUR)
    harness.openrouter.catalog = { data: [] }
    await harness.gateway.scheduled()
    assert.equal(calls(), 2)
    assert.equal(harness.store.doc?.models.length, CATALOG.length)
    assert.ok(harness.log.events.some((event) => event.name === 'pool_sync_empty'))
    harness.openrouter.catalog = catalogJson(CATALOG.slice(1))
    harness.advance(HOUR)
    await harness.gateway.scheduled()
    assert.equal(harness.store.doc?.pools[VirtualModels.main][0], 'acme/medium:free')
  })

  it('keeps going when one step fails, and prunes old sessions', async () => {
    const harness = await Harness.create()
    await harness.signIn()
    const [session] = harness.accounts.sessions.values()
    session.revokedAt = harness.clock.now
    harness.advance(31 * 24 * HOUR)
    harness.openrouter.catalog = 'not json at all'
    await harness.gateway.scheduled()
    assert.equal(harness.accounts.sessions.size, 0)
    assert.ok(harness.log.errors.some((error) => error.name === 'pool_sync_failed') || harness.log.events.some((event) => event.name === 'pool_sync_empty'))
  })
})
