import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { messageText, type ClientEvent, type CompletionOutcome } from '@encode/providers'
import { DEFAULT_LIMITS } from './config'
import type { RequestTrace } from './router'
import { catalogEntry, faults, TestWorld, type Script } from './testing'

/**
 * The chaos suite: random providers misbehaving in every way the router
 * knows of, against invariants that must hold whatever happens.
 *
 *  1. complete() never rejects, unless the caller aborted, and then with exactly its reason.
 *  2. The event stream is well formed: attempts count up, content follows an attempt,
 *     nothing follows a discard until the next attempt, a switch names the next attempt.
 *  3. Only a clean finish commits: the committed text is the last attempt's text, whole,
 *     never a piece of a discarded stream.
 *  4. A model is not called while it cools down, and no free model while the free tier is closed.
 *  5. No more than 20 free requests go to OpenRouter in any minute.
 *  6. A request pauses only when its budget is spent or nothing can run.
 *  7. Every request ends within bounded simulated time.
 *  8. With only free models enabled, no model that is not free is ever called, however the free ones fail.
 *  9. A model the provider refused for this account (privacy settings, app-only) is not asked again,
 *     and the key is never blamed for it.
 *
 * Seeded: ENCODE_PROPERTY_SEED replays a failure, ENCODE_PROPERTY_RUNS runs more cases.
 */

type Fault =
  | 'reply'
  | 'tool'
  | 'cut'
  | 'midstream'
  | 'server'
  | 'overloaded'
  | 'network'
  | 'slow'
  | 'keepalive'
  | 'stall'
  | 'hang'
  | 'empty'
  | 'badjson'
  | 'ratelimit'
  | 'ratelimit-unknown'
  | 'minutecap'
  | 'served'
  | 'overflow'
  | 'notfound'
  | 'policy'
  | 'apponly'

interface Step {
  fault: Fault
  /** Retry time for rate limits, in ms. */
  ms: number
}

interface Scenario {
  models: string[]
  paid: boolean
  /** Only free models enabled: the paid model on the role's list must never be called. */
  freeOnly: boolean
  behaviors: Step[][]
  requests: Array<{ gapMs: number; tools: boolean; sticky?: string; abortAtMs?: number }>
}

const COMMON_FAULTS = gen.oneOf<Fault>('cut', 'midstream', 'server', 'overloaded', 'slow', 'stall', 'empty', 'badjson', 'ratelimit', 'ratelimit-unknown')
const RARE_FAULTS = gen.oneOf<Fault>('network', 'keepalive', 'hang', 'served', 'minutecap', 'overflow', 'notfound', 'policy', 'apponly')
/** A normal day: mostly answers, now and then a failure. */
const CALM = gen.weighted<Fault>([8, gen.oneOf('reply')], [3, gen.oneOf('tool')], [1, COMMON_FAULTS], [0.6, RARE_FAULTS])
/** A bad day: mostly failures, so budgets run out and requests pause. */
const STORM = gen.weighted<Fault>([1, gen.oneOf('reply')], [1, gen.oneOf('tool')], [5, COMMON_FAULTS], [2, RARE_FAULTS])

const scenario: Gen<Scenario> = (random, size) => {
  const count = gen.int(2, 6)(random, size)
  const models = Array.from({ length: count }, (_, index) => `vendor/m${index}:free`)
  const storm = random() < 0.35
  const step = gen.map(gen.tuple(storm ? STORM : CALM, gen.int(1_000, 60_000)), ([fault, ms]): Step => ({ fault, ms }))
  return {
    models,
    paid: random() < 0.4,
    freeOnly: random() < 0.5,
    behaviors: models.map(() => gen.array(step, 1, 6)(random, size)),
    requests: gen.array(
      gen.map(gen.tuple(gen.int(0, 120_000), gen.int(0, 9), gen.int(0, 2), gen.int(1, 100_000)), ([gapMs, toolRoll, session, abortRoll]) => ({
        gapMs,
        tools: toolRoll < 4,
        ...(session ? { sticky: `s${session}` } : {}),
        // One request in ten is stopped by the user: most while the reply streams, some much later.
        ...(abortRoll % 10 === 0 ? { abortAtMs: abortRoll % 20 === 0 ? abortRoll : 1 + (abortRoll % 1_500) } : {}),
      })),
      1,
      8,
    )(random, size),
  }
}

/** Texts a clean reply can commit; anything else in a committed message is a leak from a discarded stream. */
const CLEAN = /^(hello from (vendor\/m\d:free|claude-test)|answer from a fallback|)$/

function scriptFor(step: Step, model: string, models: string[]): Script {
  switch (step.fault) {
    case 'reply':
      return faults.reply(`hello from ${model}`, { gapMs: 200 })
    case 'tool':
      return faults.toolCall('Read', { path: 'a.ts' })
    case 'cut':
      return faults.cutStream('partial answer, cut')
    case 'midstream':
      return faults.midStreamError('partial answer, then an error')
    case 'server':
      return faults.serverError()
    case 'overloaded':
      return faults.overloaded()
    case 'network':
      return faults.networkError()
    case 'slow':
      return faults.slowFirstToken(25_000, 'partial: too late')
    case 'keepalive':
      return faults.keepaliveOnly(10_000, 30)
    case 'stall':
      return faults.stallAfter('partial answer, then silence')
    case 'hang':
      return faults.hangIgnoringAbort()
    case 'empty':
      return faults.emptyReply()
    case 'badjson':
      return faults.badToolJson()
    case 'ratelimit':
      return faults.rateLimited(step.ms)
    case 'ratelimit-unknown':
      return faults.rateLimited()
    case 'minutecap':
      return faults.freeMinuteCap(step.ms)
    case 'served': {
      const other = models.find((candidate) => candidate !== model) ?? model
      return faults.servedBy(other)
    }
    case 'overflow':
      return faults.contextOverflow(32_768)
    case 'notfound':
      return faults.notFound()
    case 'policy':
      return faults.policyBlocked()
    case 'apponly':
      return faults.appOnly(model)
  }
}

/** Faults that rule a model out for the rest of a request. */
const EXCLUDES = new Set<Fault>(['overflow', 'notfound', 'badjson', 'empty', 'policy', 'apponly'])
/** Faults after which the provider will not serve the model on this account for a day. */
const REFUSES = new Set<Fault>(['policy', 'apponly'])

/**
 * Failures after which the model is avoided for at least the first cooldown.
 * A rate limit with a retry time is avoided for exactly that time instead, which is checked on its own.
 */
const COOLS = new Set<Fault>(['cut', 'midstream', 'server', 'overloaded', 'slow', 'keepalive', 'stall', 'hang', 'ratelimit-unknown'])

function checkEvents(events: Array<{ event: ClientEvent; at: number }>): void {
  let attempt = 0
  let discarded = false
  let pendingSwitch: string | undefined
  for (const { event, at } of events) {
    switch (event.type) {
      case 'attempt':
        assert.equal(event.attempt, attempt + 1, 'attempts count up from 1')
        attempt = event.attempt
        discarded = false
        if (pendingSwitch !== undefined) assert.equal(event.key, pendingSwitch, 'a switch names the next attempt')
        pendingSwitch = undefined
        break
      case 'text':
      case 'thinking':
      case 'tool-call':
        assert.ok(attempt > 0, 'content follows an attempt')
        assert.ok(!discarded, 'nothing follows a discard until the next attempt')
        break
      case 'discard':
        assert.ok(attempt > 0)
        discarded = true
        break
      case 'switch':
        assert.notEqual(event.from, event.to)
        pendingSwitch = event.to
        break
      case 'wait':
        assert.ok(event.until > at, 'a wait ends in the future')
        break
    }
  }
}

/** The text of the last attempt, as the UI saw it. */
function lastAttemptText(events: Array<{ event: ClientEvent }>): { text: string; discarded: boolean } {
  let text = ''
  let discarded = false
  for (const { event } of events) {
    if (event.type === 'attempt') {
      text = ''
      discarded = false
    } else if (event.type === 'text') {
      text += event.text
    } else if (event.type === 'discard') {
      discarded = true
    }
  }
  return { text, discarded }
}

/** What the runs exercised, so a generator change cannot quietly make the suite vacuous. */
const seen = { faults: new Set<string>(), outcomes: new Set<string>(), events: new Set<string>(), guardedRuns: 0 }

async function runScenario(input: Scenario): Promise<void> {
  const played: Array<{ model: string; step: Step }> = []
  const behavior = Object.fromEntries(
    input.models.map((model, index) => [
      model,
      (call: number) => {
        const steps = input.behaviors[index]
        const step = steps[Math.min(call, steps.length - 1)]
        played.push({ model, step })
        return scriptFor(step, model, input.models)
      },
    ]),
  )
  const traces: RequestTrace[] = []
  /** Calls the user stopped mid-way: not failures, so they set no cooldown. */
  const stopped = new Set<number>()
  const settings = input.paid
    ? { providers: { openrouter: { type: 'openrouter' }, anthropic: { type: 'anthropic' } }, freeOnly: input.freeOnly, roles: { main: ['@free', 'anthropic:claude-test'] } }
    : { providers: { openrouter: { type: 'openrouter' } } }
  const world = new TestWorld({
    settings,
    catalogs: { openrouter: input.models.map((model) => catalogEntry(model)) },
    keys: { openrouter: 'sk-or-v1-chaos-key-0123456789', anthropic: 'sk-ant-chaos-key-0123456789' },
    behavior: { ...behavior, 'claude-test': (call: number) => {
      played.push({ model: 'claude-test', step: { fault: 'reply', ms: 0 } })
      return call % 3 === 2 ? faults.overloaded() : faults.reply('hello from claude-test')
    } },
    router: { onTrace: (trace) => traces.push(trace) },
  })
  const limits = DEFAULT_LIMITS

  for (const request of input.requests) {
    await world.clock.advance(request.gapMs)
    const before = world.calls.length
    const startedAt = world.clock.now()
    const events: Array<{ event: ClientEvent; at: number }> = []
    const controller = new AbortController()
    const reason = new Error('stopped by the user')
    if (request.abortAtMs !== undefined) world.clock.setTimeout(() => controller.abort(reason), request.abortAtMs)
    const pending = world.router.complete({
      role: 'main',
      payload: { system: [{ text: 'chaos' }], messages: [], tools: [] },
      requirements: { promptTokens: 1_000, maxOutputTokens: 4_096, tools: request.tools, images: false },
      signal: controller.signal,
      ...(request.sticky ? { sticky: request.sticky } : {}),
      onEvent: (event) => events.push({ event, at: world.clock.now() }),
    })

    // 1. Only an abort rejects, with its own reason.
    let outcome: CompletionOutcome | undefined
    try {
      outcome = await world.clock.run(pending, 24 * 60 * 60_000)
    } catch (error) {
      assert.ok(controller.signal.aborted, `complete() rejected without an abort: ${String(error)}`)
      assert.equal(error, reason)
      if (world.calls.length > before) stopped.add(world.calls.length - 1)
    }
    if (!controller.signal.aborted) controller.abort(new Error('the test moves on'))

    // 7. Bounded time: the failover budget, plus one slow attempt, plus waits.
    assert.ok(world.clock.now() - startedAt <= 15 * 60_000, `the request took ${world.clock.now() - startedAt} ms`)

    // 2. Well-formed events.
    checkEvents(events)
    for (const { event } of events) seen.events.add(event.type)
    seen.outcomes.add(outcome ? (outcome.kind === 'paused' ? `paused:${outcome.reason}` : outcome.kind) : 'aborted')
    if (!outcome) continue
    const trace = traces.at(-1)!

    // 3. Only a clean finish commits.
    if (outcome.kind === 'done') {
      const text = messageText(outcome.message)
      assert.match(text, CLEAN, `committed text from a discarded stream: ${JSON.stringify(text)}`)
      const flawed = outcome.message.content.some((block) => block.type === 'tool-use' && block.invalid) || !outcome.message.content.length
      if (!flawed) {
        const last = lastAttemptText(events)
        assert.equal(last.discarded, false, 'the committed attempt was not discarded')
        assert.equal(last.text, text, 'the UI saw exactly what was committed')
      }
    }

    // 6. A pause only when the budget is spent or nothing can run.
    const played_ = played.slice(before, world.calls.length)
    for (const key of trace.excluded) {
      const model = key.slice(key.indexOf(':') + 1)
      assert.ok(
        key.startsWith('provider:') || played_.some((entry) => entry.model === model && EXCLUDES.has(entry.step.fault)),
        `${key} was ruled out without a reason to: ${JSON.stringify(played_)}`,
      )
    }
    if (outcome.kind === 'paused' && (outcome.reason === 'unavailable' || outcome.reason === 'rate-limit' || outcome.reason === 'network')) {
      const elapsed = trace.endedAt - (trace.firstProblemAt ?? trace.startedAt)
      const spent = trace.costly > limits.maxFailovers || elapsed >= limits.maxFailoverMs || trace.attempts >= limits.maxAttempts
      const ready = world.router
        .preview('main', { promptTokens: 1_000, maxOutputTokens: 4_096, tools: request.tools, images: false })
        .candidates.filter((key) => !trace.excluded.includes(key))
      assert.ok(spent || !ready.length, `paused with budget left and ${ready.join(', ')} ready: ${JSON.stringify({ trace, outcome })}`)
    }
    assert.equal(trace.attempts >= world.calls.length - before, true, 'every call is an attempt')
  }

  // 4. No call while the model cools down, or while the free tier is closed.
  for (const entry of played) seen.faults.add(entry.step.fault)
  const calls = world.calls.map((call, index) => ({ ...call, step: played[index] }))
  calls.forEach((call, index) => {
    assert.equal(call.step.model, call.model, 'the play log lines up with the calls')
    if (call.step.step.fault === 'ratelimit') {
      for (const later of calls.slice(index + 1)) if (later.model === call.model) assert.ok(later.at >= call.at + call.step.step.ms, `${call.model} called during its retry time`)
    }
    if (COOLS.has(call.step.step.fault) && !stopped.has(index)) {
      const next = calls.slice(index + 1).find((later) => later.model === call.model)
      if (next) assert.ok(next.at >= call.at + limits.cooldownMs, `${call.model} called ${next.at - call.at} ms after a failure`)
    }
    if (call.step.step.fault === 'minutecap') {
      for (const later of calls.slice(index + 1)) {
        if (later.model.endsWith(':free')) assert.ok(later.at >= call.at + call.step.step.ms, 'a free model was called while the free tier was closed')
      }
    }
  })

  // 5. At most 20 free requests a minute.
  const free = calls.filter((call) => call.model.endsWith(':free')).map((call) => call.at)
  for (const at of free) assert.ok(free.filter((other) => other >= at && other < at + 60_000).length <= 20, 'more than 20 free requests in a minute')

  // 8. Free-only mode never reaches the paid model on the list.
  if (input.paid && input.freeOnly) {
    seen.guardedRuns++
    assert.deepEqual(calls.filter((call) => !call.model.endsWith(':free')).map((call) => call.model), [], 'a model that is not free was called in free-only mode')
  }

  // 9. A refused model is not asked again, and the key is not blamed. A fallback that names the model as the one
  // that answered would lift the refusal, so runs with one are left out of the first check.
  if (!played.some((entry) => entry.step.fault === 'served')) {
    calls.forEach((call, index) => {
      if (REFUSES.has(call.step.step.fault)) assert.deepEqual(calls.slice(index + 1).filter((later) => later.model === call.model), [], `${call.model} was asked again after the provider refused it`)
    })
  }
  assert.deepEqual(world.router.status().blocks.filter((block) => block.kind === 'auth'), [], 'a refused model blocked the provider')
  assert.deepEqual(world.alerts.filter((alert) => alert.type === 'key-refused'), [], 'a refused model was taken for a refused key')
}

describe('ModelRouter chaos', () => {
  it('keeps every invariant under random provider failures', async () => {
    await check(scenario, runScenario, { maxSize: 12 })
    if ((Number(process.env.ENCODE_PROPERTY_RUNS) || 200) < 200) return
    const faultsPlayed: Fault[] = ['reply', 'tool', 'cut', 'midstream', 'server', 'overloaded', 'network', 'slow', 'keepalive', 'stall', 'hang', 'empty', 'badjson', 'ratelimit', 'ratelimit-unknown', 'minutecap', 'served', 'overflow', 'notfound', 'policy', 'apponly']
    assert.deepEqual(faultsPlayed.filter((fault) => !seen.faults.has(fault)), [], 'every fault was played')
    for (const outcome of ['done', 'paused:unavailable', 'aborted']) assert.ok(seen.outcomes.has(outcome), `no request ended ${outcome}`)
    for (const event of ['attempt', 'text', 'tool-call', 'discard', 'switch', 'wait']) assert.ok(seen.events.has(event), `no ${event} event was seen`)
    assert.ok(seen.guardedRuns > 0, 'no run had free-only mode on with a paid model listed')
    if (process.env.ENCODE_CHAOS_REPORT) console.log(JSON.stringify({ outcomes: [...seen.outcomes], events: [...seen.events] }))
  })
})
