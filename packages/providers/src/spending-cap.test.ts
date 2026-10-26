import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CompletionRequest, ModelClient } from './contract'
import { listedCost, spendingCap, tallyStream, unreportedCost } from './spending-cap'

describe('a spending cap (ADRs 0137, 0138)', () => {
  const request = { role: 'main', payload: { system: [], messages: [], tools: [] }, requirements: {}, signal: new AbortController().signal } as unknown as CompletionRequest
  const billed = (cost: number | undefined, price?: { input: number; output: number }): ModelClient => ({
    budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000, ...(price ? { price, cache: { read: 0.1, write: 1, boundThinking: false, source: 'price' as const } } : {}) }),
    complete: async () => ({
      kind: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'openrouter', model: 'some/model', family: 'other' } },
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 800_000, cacheWriteTokens: 0, ...(cost !== undefined ? { cost } : {}) },
      finish: 'stop',
    }),
  })

  test('prices a call by the listed prices when the provider does not say', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 800_000, cacheWriteTokens: 0 }
    // 200k uncached at $0.30, 800k cached at a tenth of that, 100k written at $1.20.
    assert.ok(Math.abs(listedCost(usage, { price: { input: 0.3, output: 1.2 }, cache: { read: 0.1, write: 1, boundThinking: false, source: 'price' } })! - (0.06 + 0.024 + 0.12)) < 1e-12)
    assert.equal(listedCost(usage, {}), undefined)
    assert.equal(listedCost(usage, { price: { input: 0, output: 0 } }), undefined, 'a price of nothing is no price')
  })

  test('refuses the call that could pass the limit, and every call after it', async () => {
    const cap = spendingCap(1)
    const client = cap.wrap(billed(0.4))
    await client.complete(request)
    await client.complete(request)
    assert.equal(cap.spent(), 0.8)
    assert.equal(cap.signal.aborted, false)
    await assert.rejects(client.complete(request), /Stopped: it reached its spending cap \(\$0\.80 of \$1\.00 spent; the next call could cost \$0\.40\)\.$/)
    assert.equal(cap.signal.aborted, true)
    assert.equal(cap.spent(), 0.8, 'the refused call was never made')
    await assert.rejects(client.complete(request), /Stopped/)
  })

  test('counts a call the provider did not price by the listed prices, and stops when there are none', async () => {
    const listed = spendingCap(5)
    await listed.wrap(billed(undefined, { input: 0.3, output: 1.2 })).complete(request)
    assert.ok(Math.abs(listed.spent() - 0.204) < 1e-12)
    const unknown = spendingCap(5)
    await unknown.wrap(billed(undefined)).complete(request)
    assert.match(unknown.stopped() ?? '', /a call to some\/model said nothing of what it cost, and the model has no listed price/)
    assert.equal(unknown.signal.aborted, true)
    assert.throws(() => spendingCap(0), /above 0/)
  })

  describe('what no provider reports', () => {
    const price = { input: 0.3, output: 1.2 }
    const priced = (complete: ModelClient['complete']): ModelClient => ({ budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000, price }), complete })
    const asked = (signal = new AbortController().signal) => ({ ...request, requirements: { promptTokens: 10_000, maxOutputTokens: 1_000, tools: false, images: false }, signal }) as CompletionRequest

    test('counts a call stopped midway by what it read and what it streamed', async () => {
      const cap = spendingCap(5)
      const stop = new AbortController()
      const client = cap.wrap(
        priced(async (call) => {
          call.onEvent?.({ type: 'attempt', attempt: 1, key: 'openrouter:m', provider: 'openrouter', model: 'm' })
          call.onEvent?.({ type: 'thinking', text: 'x'.repeat(3_500) })
          stop.abort(new Error('The Reviewer did not answer in time.'))
          throw call.signal.reason
        }),
      )
      await assert.rejects(client.complete(asked(stop.signal)), /did not answer in time/)
      // 10k tokens read at $0.30 a million, 1k written at $1.20.
      assert.ok(Math.abs(cap.spent() - 0.0042) < 1e-12, String(cap.spent()))
    })

    test('adds the attempts the router gave up on midway to what the reply cost', async () => {
      const cap = spendingCap(5)
      const client = cap.wrap(
        priced(async (call) => {
          call.onEvent?.({ type: 'attempt', attempt: 1, key: 'openrouter:m', provider: 'openrouter', model: 'm' })
          call.onEvent?.({ type: 'text', text: 'x'.repeat(700) })
          call.onEvent?.({ type: 'discard', reason: 'The stream ended before the reply was complete.' })
          call.onEvent?.({ type: 'attempt', attempt: 2, key: 'openrouter:m', provider: 'openrouter', model: 'm' })
          call.onEvent?.({ type: 'text', text: 'ok' })
          return { kind: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 10_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 }, finish: 'stop' }
        }),
      )
      await client.complete(asked())
      assert.ok(Math.abs(cap.spent() - (0.01 + 0.003 + 0.00024)) < 1e-12, String(cap.spent()))
    })

    test('counts nothing for a call stopped before it began, or an attempt that failed before it wrote', async () => {
      const stopped = new AbortController()
      stopped.abort(new Error('The run ended.'))
      const cap = spendingCap(5)
      await assert.rejects(
        cap.wrap(
          priced(async (call) => {
            throw call.signal.reason
          }),
        ).complete(asked(stopped.signal)),
        /run ended/,
      )
      assert.equal(cap.spent(), 0)
      const { request: watched, tally } = tallyStream(asked())
      watched.onEvent?.({ type: 'attempt', attempt: 1, key: 'a:m', provider: 'a', model: 'm' })
      watched.onEvent?.({ type: 'discard', reason: 'refused' })
      assert.equal(unreportedCost(watched, tally, false, { price }), 0)
      assert.equal(unreportedCost(watched, { discarded: [7], current: 0 }, false, {}), undefined, 'no price, no guess')
    })
  })
})
