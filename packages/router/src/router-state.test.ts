import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRouterConfig } from './config'
import type { Fetch } from './openrouter'
import type { RequestTrace } from './router'
import { catalogEntry, faults, TestWorld } from './testing'

const BASE = 'https://openrouter.ai/api/v1'
const KEY = 'sk-or-v1-test-key-0123456789'
const A = 'vendor/alpha:free'
const B = 'vendor/beta:free'
const C = 'vendor/gamma:free'
const HOUR = 60 * 60_000

interface SentRequest {
  url: string
  headers: Record<string, string>
}

/** OpenRouter's catalog and key endpoints, served from memory. */
class FakeOpenRouter {
  status = 200
  /** Models whose listing carries a price per request. */
  fees = new Set<string>()
  readonly sent: SentRequest[] = []

  constructor(
    public models: string[],
    public quota?: { used: number; limit: number; remaining: number },
  ) {}

  readonly fetch: Fetch = async (url, init) => {
    this.sent.push({ url, headers: { ...init?.headers } })
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (this.status !== 200) return { ok: false, status: this.status, json: async () => ({}) }
    if (url === `${BASE}/models`) {
      return reply({
        data: this.models.map((id) => ({
          id,
          name: id,
          context_length: 131_072,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          pricing: this.fees.has(id) ? { prompt: '0', completion: '0', request: '0.01' } : id.endsWith(':free') ? { prompt: '0', completion: '0' } : { prompt: '0.000001', completion: '0.000004' },
          top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
          supported_parameters: ['tools'],
        })),
      })
    }
    if (url === `${BASE}/key`) return reply({ data: { label: 'sk-or-v1-tes...', ...(this.quota ? { free_model_daily_requests: this.quota } : {}) } })
    return { ok: false, status: 404, json: async () => ({}) }
  }

  requests(path: string): SentRequest[] {
    return this.sent.filter((request) => request.url === `${BASE}${path}`)
  }
}

function catalogStatus(world: TestWorld) {
  return world.router.status().catalogs.find((catalog) => catalog.provider === 'openrouter')
}

describe('ModelRouter: catalogs and the free quota', () => {
  it('loads the catalog and the free quota, sending the key only to the key endpoint', async () => {
    const openrouter = new FakeOpenRouter([A, B, 'vendor/paid'], { used: 10, limit: 1_000, remaining: 990 })
    const world = new TestWorld({ fetch: openrouter.fetch })
    await world.router.refresh()
    assert.deepEqual(catalogStatus(world), { provider: 'openrouter', fetchedAt: world.clock.now(), models: 3, free: 2 })
    assert.equal(world.router.status().freeTiers[0].daily?.remaining, 990)
    assert.equal(openrouter.requests('/models')[0].headers.authorization, undefined)
    assert.equal(openrouter.requests('/key')[0].headers.authorization, `Bearer ${KEY}`)
  })

  it('says so when models claim to be free but none passes the check, instead of leaving the pool empty without a word', async () => {
    const charging = new FakeOpenRouter([A, B])
    charging.fees = new Set([A, B])
    const logs: string[] = []
    const world = new TestWorld({ fetch: charging.fetch, router: { onLog: (entry) => logs.push(`${entry.level}: ${entry.message}`) } })
    await world.router.refresh()
    assert.equal(catalogStatus(world)?.free, 0)
    assert.deepEqual(logs, ['warn: openrouter lists 2 models with a :free id, but none passed the free check, so the free pool is empty. Run scripts/free-models.mjs to see each price.'])

    const mixed = new FakeOpenRouter([A, B])
    mixed.fees = new Set([A])
    const quiet: string[] = []
    const other = new TestWorld({ fetch: mixed.fetch, router: { onLog: (entry) => quiet.push(entry.message) } })
    await other.router.refresh()
    assert.equal(catalogStatus(other)?.free, 1)
    assert.deepEqual(quiet, [])
  })

  it('waits for a missing catalog before the first request, then answers from the pool', async () => {
    const openrouter = new FakeOpenRouter([A], { used: 0, limit: 1_000, remaining: 1_000 })
    const world = new TestWorld({ fetch: openrouter.fetch })
    const { outcome, text } = await world.complete()
    assert.equal(outcome.kind, 'done')
    assert.equal(text, `hello from ${A}`)
  })

  it('fetches once for concurrent refreshes, then only what has gone stale', async () => {
    const openrouter = new FakeOpenRouter([A], { used: 0, limit: 1_000, remaining: 1_000 })
    const world = new TestWorld({ fetch: openrouter.fetch })
    await Promise.all([world.router.refresh(), world.router.refresh()])
    await world.router.refresh()
    assert.deepEqual([openrouter.requests('/models').length, openrouter.requests('/key').length], [1, 1])
    // The quota is re-read every 15 minutes, the catalog every 6 hours.
    await world.clock.advance(16 * 60_000)
    await world.router.refresh()
    assert.deepEqual([openrouter.requests('/models').length, openrouter.requests('/key').length], [1, 2])
    await world.clock.advance(6 * HOUR)
    await world.router.refresh()
    assert.deepEqual([openrouter.requests('/models').length, openrouter.requests('/key').length], [2, 3])
  })

  it('refetches a catalog on demand, but not twice in a minute', async () => {
    const openrouter = new FakeOpenRouter([A])
    const world = new TestWorld({ fetch: openrouter.fetch })
    await world.router.refresh()
    await world.router.refresh({ force: true })
    assert.equal(openrouter.requests('/models').length, 1)
    await world.clock.advance(60_000)
    openrouter.models = [A, B]
    await world.router.refresh({ force: true })
    assert.equal(openrouter.requests('/models').length, 2)
    assert.equal(catalogStatus(world)?.models, 2)
  })

  it('keeps the last good catalog when a sync fails, alerts once, and clears the error when it recovers', async () => {
    const openrouter = new FakeOpenRouter([A])
    const world = new TestWorld({ fetch: openrouter.fetch })
    await world.router.refresh()
    openrouter.status = 503
    await world.clock.advance(7 * HOUR)
    await world.router.refresh()
    await world.router.refresh()
    assert.equal(catalogStatus(world)?.models, 1)
    assert.equal(catalogStatus(world)?.error, 'eNCode could not load the list of models from openrouter.')
    const catalogAlerts = world.alerts.filter((alert) => alert.type === 'catalog')
    assert.equal(catalogAlerts.length, 1)
    assert.match(catalogAlerts[0].detail ?? '', /HTTP 503/)
    openrouter.status = 200
    await world.router.refresh()
    assert.equal(catalogStatus(world)?.error, undefined)
  })

  it('treats a failed quota read as a gap, not a catalog failure', async () => {
    const openrouter = new FakeOpenRouter([A], { used: 0, limit: 1_000, remaining: 1_000 })
    const world = new TestWorld({ fetch: openrouter.fetch })
    await world.router.refresh()
    const original = openrouter.fetch
    const failingKey: Fetch = async (url, init) => (url.endsWith('/key') ? { ok: false, status: 500, json: async () => ({}) } : original(url, init))
    const logs: string[] = []
    const flaky = new TestWorld({ fetch: failingKey, router: { onLog: (entry) => logs.push(entry.message) } })
    await flaky.router.refresh()
    assert.equal(catalogStatus(flaky)?.error, undefined)
    assert.equal(flaky.alerts.length, 0)
    assert.ok(logs.some((message) => message.includes('free-request quota')))
    assert.ok(logs.every((message) => !message.includes(KEY)))
  })

  it('pauses with a reason when the free model list cannot be loaded at all', async () => {
    const openrouter = new FakeOpenRouter([A])
    openrouter.status = 502
    const world = new TestWorld({ fetch: openrouter.fetch })
    const { outcome } = await world.complete()
    assert.equal(outcome.kind, 'paused')
    if (outcome.kind === 'paused') {
      assert.equal(outcome.reason, 'unavailable')
      assert.equal(outcome.message, 'The list of free models from openrouter has not loaded yet. Check the connection.')
    }
  })
})

describe('ModelRouter: model checks and canaries', () => {
  function world(behavior: TestWorld['behavior'] = {}, quota?: { used: number; limit: number; remaining: number }) {
    const value = new TestWorld({ catalogs: { openrouter: [catalogEntry(A), catalogEntry(B), catalogEntry(C)] }, behavior })
    if (quota) value.router.freeTier('openrouter')?.applyQuota({ ...quota, resetAt: value.clock.now() + HOUR })
    return value
  }

  it('passes a model that calls the echo tool, and records its canary', async () => {
    const value = world({ [A]: faults.toolCall('echo', { text: 'eNCode' }) })
    const result = await value.clock.run(value.router.checkModel(`openrouter:${A}`))
    assert.deepEqual([result.ok, result.toolCall, result.model], [true, true, A])
    assert.equal(value.router.pool.canary(`openrouter:${A}`)?.status, 'passed')
    const [call] = value.callsTo(A)
    assert.deepEqual(call.request.tools.map((tool) => tool.name), ['echo'])
  })

  it('fails the canary of a model that answers without calling the tool', async () => {
    const value = world({ [B]: faults.reply('I would rather not.') })
    const result = await value.clock.run(value.router.checkModel(`openrouter:${B}`))
    assert.deepEqual([result.ok, result.toolCall], [true, false])
    assert.equal(value.router.pool.canary(`openrouter:${B}`)?.status, 'failed')
  })

  it('reports a failed call, counts it against the model, and leaves the canary alone', async () => {
    const value = world({ [C]: faults.serverError(503) })
    const result = await value.clock.run(value.router.checkModel(`openrouter:${C}`))
    assert.equal(result.ok, false)
    assert.equal(result.message, "vendor/gamma:free had a problem on the provider's side.")
    assert.match(result.detail ?? '', /HTTP 503/)
    assert.equal(value.router.pool.canary(`openrouter:${C}`), undefined)
    assert.equal(value.router.health.report().models.find((model) => model.key === `openrouter:${C}`)?.failures, 1)
  })

  it('explains a model it cannot check', async () => {
    const value = world()
    assert.match((await value.router.checkModel('nowhere:model')).message, /does not name a configured provider/)
    const keyless = new TestWorld({ keys: {} })
    assert.match((await keyless.router.checkModel(`openrouter:${A}`)).message, /No key is set for openrouter/)
  })

  it('runs canaries only while plenty of free requests are left today', async () => {
    const echo = faults.toolCall('echo', { text: 'eNCode' })
    const unknown = world({ [A]: echo, [B]: echo, [C]: echo })
    assert.deepEqual(await unknown.clock.run(unknown.router.runCanaries()), [], 'no canaries while the allowance is unknown')
    const small = world({ [A]: echo, [B]: echo, [C]: echo }, { used: 0, limit: 50, remaining: 50 })
    assert.deepEqual(await small.clock.run(small.router.runCanaries()), [], 'none on a 50-a-day account')
    const large = world({ [A]: echo, [B]: echo, [C]: echo }, { used: 0, limit: 1_000, remaining: 1_000 })
    const results = await large.clock.run(large.router.runCanaries({ limit: 2 }))
    assert.equal(results.length, 2)
    assert.ok(results.every((result) => result.toolCall))
    assert.equal(large.router.pool.unchecked('openrouter', large.router.settings.freePool, 10).length, 1)
  })
})

describe('ModelRouter: state across restarts', () => {
  it('restores catalogs, learned facts, health, canaries and the free-tier count', async () => {
    const before = new TestWorld({ catalogs: { openrouter: [catalogEntry(A), catalogEntry(B)] }, behavior: { [A]: faults.serverError() } })
    await before.complete()
    before.router.registry.learn(`openrouter:${B}`, { contextWindow: 100_000 })
    before.router.pool.recordCanary(`openrouter:${B}`, 'passed')
    const snapshot = JSON.parse(JSON.stringify(before.router.snapshot()))

    const after = new TestWorld()
    after.router.restore(snapshot)
    assert.deepEqual(after.router.registry.list('openrouter').map((model) => [model.model, model.contextWindow]), [
      [A, 131_072],
      [B, 100_000],
    ])
    assert.equal(after.router.health.report().models.find((model) => model.key === `openrouter:${A}`)?.failures, 1)
    assert.equal(after.router.pool.canary(`openrouter:${B}`)?.status, 'passed')
    assert.equal(after.router.status().freeTiers[0].sentLastMinute, 2)
    after.router.restore({ version: 9 })
    after.router.restore('junk')
  })
})

describe('ModelRouter: settings, preview and traces', () => {
  it('applies new settings without losing what it learned', async () => {
    const value = new TestWorld({ catalogs: { openrouter: [catalogEntry(A), catalogEntry(B)] } })
    value.router.registry.setScores({ [`openrouter:${A}`]: { main: 0.9 }, [`openrouter:${B}`]: { main: 0.5 } })
    value.router.health.failure(`openrouter:${A}`, { kind: 'server', message: 'HTTP 502' })
    const { config } = parseRouterConfig({ providers: { openrouter: { type: 'openrouter' } }, roles: { main: [`openrouter:${B}`] }, freePool: { requestsPerMinute: 5 } })
    value.router.configure(config)
    assert.equal(value.router.health.report().models[0].failures, 1)
    assert.equal(value.router.freeTier('openrouter')?.status().requestsPerMinute, 5)
    const { text } = await value.complete()
    assert.equal(text, `hello from ${B}`)
  })

  it('previews the models a call would try, and why the others are left out', () => {
    const value = new TestWorld({ catalogs: { openrouter: [catalogEntry(A), catalogEntry(B, { contextWindow: 8_000 })] } })
    value.router.registry.setScores({ [`openrouter:${A}`]: { main: 0.9 } })
    const preview = value.router.preview('main', { promptTokens: 20_000, maxOutputTokens: 1_000, tools: true, images: false })
    assert.deepEqual(preview.candidates, [`openrouter:${A}`])
  })

  it('traces each request once, however it ends', async () => {
    const traces: RequestTrace[] = []
    const value = new TestWorld({
      catalogs: { openrouter: [catalogEntry(A), catalogEntry(B)] },
      behavior: { [A]: faults.cutStream() },
      router: { onTrace: (trace) => traces.push(trace) },
    })
    value.router.registry.setScores({ [`openrouter:${A}`]: { main: 0.9 }, [`openrouter:${B}`]: { main: 0.5 } })
    await value.complete()
    assert.equal(traces.length, 1)
    assert.deepEqual(
      { attempts: traces[0].attempts, costly: traces[0].costly, outcome: traces[0].outcome, model: traces[0].model },
      { attempts: 2, costly: 1, outcome: 'done', model: B },
    )
    const controller = new AbortController()
    value.behavior[B] = faults.hangIgnoringAbort()
    value.behavior[A] = faults.hangIgnoringAbort()
    value.clock.setTimeout(() => controller.abort(new Error('stop')), 1_000)
    await assert.rejects(value.complete({ signal: controller.signal }), /stop/)
    assert.equal(traces.length, 2)
    assert.equal(traces[1].outcome, 'aborted')
  })
})
