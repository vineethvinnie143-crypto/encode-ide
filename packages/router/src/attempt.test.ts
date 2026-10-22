import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { repairJson, TransportError, userText, type ClientEvent, type ModelRequest, type ProviderAdapter, type TransportEvent, type TransportTarget } from '@encode/providers'
import { runAttempt, type AttemptResult, type AttemptTiming } from './attempt'
import { FakeClock, faults, ScriptedAdapter, type Script } from './testing'

const TIMING: AttemptTiming = { firstTokenMs: 20_000, keepaliveFirstTokenMs: 120_000, idleMs: 60_000, keepaliveIdleMs: 300_000 }

const TARGET: TransportTarget = {
  key: 'openrouter:test/model',
  provider: 'openrouter',
  providerType: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'test/model',
  family: 'other',
  maxOutputTokens: 4_096,
  capabilities: { tools: true, parallelTools: true, images: false, reasoning: false, promptCache: false },
}

const PAYLOAD: ModelRequest = { system: [], messages: [userText('hi')], tools: [] }

interface Run {
  result: AttemptResult
  events: ClientEvent[]
  elapsed: number
  clock: FakeClock
}

type Source = Script | ((clock: FakeClock) => ProviderAdapter)

async function run(source: Source, options: { signal?: AbortSignal; clock?: FakeClock; repair?: boolean; timing?: Partial<AttemptTiming> } = {}): Promise<Run> {
  const clock = options.clock ?? new FakeClock()
  const adapter = typeof source === 'function' ? source(clock) : new ScriptedAdapter('openrouter', clock, () => source)
  const events: ClientEvent[] = []
  const startedAt = clock.now()
  const result = await clock.run(
    runAttempt({
      adapter,
      target: TARGET,
      payload: PAYLOAD,
      signal: options.signal ?? new AbortController().signal,
      clock,
      timing: { ...TIMING, ...options.timing },
      ...(options.repair ? { repairJson } : {}),
      emit: (event) => events.push(event),
    }),
  )
  return { result, events, elapsed: clock.now() - startedAt, clock }
}

/** Records the signal each call was given. */
function spy(signals: AbortSignal[], make: (clock: FakeClock) => ProviderAdapter): (clock: FakeClock) => ProviderAdapter {
  return (clock) => {
    const adapter = make(clock)
    return {
      type: adapter.type,
      stream: (input) => {
        signals.push(input.signal)
        return adapter.stream(input)
      },
    }
  }
}

/** An adapter built from one iterator, for streams a script cannot express. */
function fromIterator(iterator: AsyncIterator<TransportEvent>): () => ProviderAdapter {
  return () => ({ type: 'openrouter', stream: () => ({ [Symbol.asyncIterator]: () => iterator }) })
}

const ev = (event: TransportEvent) => ({ event })
const text = (value: string) => ev({ type: 'text', text: value })
const finish = ev({ type: 'finish', reason: 'stop' })
const keepalives = (count: number, everyMs: number): Script => Array.from({ length: count }, () => [{ wait: everyMs }, ev({ type: 'keepalive' })]).flat()

function failed(result: AttemptResult): TransportError {
  assert.equal(result.ok, false, 'the attempt should have failed')
  return (result as Extract<AttemptResult, { ok: false }>).error
}

function replyText(result: AttemptResult): string {
  assert.equal(result.ok, true, result.ok ? '' : `the attempt failed: ${result.error.message}`)
  const { reply } = result as Extract<AttemptResult, { ok: true }>
  return reply.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('runAttempt', () => {
  it('assembles a clean reply and forwards its content as it streams', async () => {
    const { result, events } = await run([ev({ type: 'model', model: 'test/model-v2' }), { wait: 1_500 }, text('Hello'), text(''), text(', world'), ev({ type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }), finish])
    assert.equal(replyText(result), 'Hello, world')
    assert.equal(result.servedModel, 'test/model-v2')
    assert.equal(result.ttftMs, 1_500)
    assert.equal(result.streamed, true)
    assert.deepEqual(events, [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world' },
    ])
  })

  it('times out a model that sends nothing, before anything reached the screen', async () => {
    const { result, elapsed, events } = await run(faults.slowFirstToken(30_000))
    const error = failed(result)
    assert.equal(error.kind, 'timeout')
    assert.equal(error.message, 'test/model sent nothing within 20 s.')
    assert.equal(elapsed, 20_000)
    assert.equal(result.streamed, false)
    assert.deepEqual(events, [])
  })

  it('does not take an empty delta for the first token', async () => {
    const { result, elapsed } = await run([text(''), ev({ type: 'thinking', text: '' }), { hang: 'until-abort' }])
    assert.equal(failed(result).message, 'test/model sent nothing within 20 s.')
    assert.equal(elapsed, 20_000)
  })

  it('times out a stream that stops, aborts the call, and says content was shown', async () => {
    const signals: AbortSignal[] = []
    const { result, elapsed } = await run(spy(signals, (clock) => new ScriptedAdapter('openrouter', clock, () => faults.stallAfter('partial'))))
    assert.equal(failed(result).message, 'test/model stopped sending for 60 s.')
    assert.equal(elapsed, 60_000)
    assert.equal(result.streamed, true)
    assert.equal(signals[0].aborted, true)
  })

  it('switches to the shorter idle limit once the first token arrives', async () => {
    // A server on this machine gets three minutes to load its model, but not three minutes per gap.
    const { result, elapsed } = await run([{ wait: 1_000 }, text('a'), { hang: 'until-abort' }], { timing: { firstTokenMs: 180_000 } })
    assert.equal(failed(result).message, 'test/model stopped sending for 60 s.')
    assert.equal(elapsed, 61_000)
  })

  it('lets keepalives hold the first token only up to their cap', async () => {
    const { result, elapsed } = await run(faults.keepaliveOnly(10_000))
    assert.equal(failed(result).message, 'test/model sent nothing within 120 s.')
    assert.equal(elapsed, 120_000)
  })

  it('keeps a reply that arrives after keepalives within the cap', async () => {
    const { result } = await run(faults.keepaliveThenReply(9, 10_000))
    assert.equal(replyText(result), 'served after keepalives')
    assert.equal(result.ttftMs, 90_000)
  })

  it('lets keepalives after the first token stretch the gap only up to their own cap', async () => {
    const { result, elapsed } = await run([text('a'), ...keepalives(50, 30_000)])
    assert.equal(failed(result).message, 'test/model stopped sending for 300 s.')
    assert.equal(elapsed, 300_000)
  })

  it('counts usage after the first token as a sign of life', async () => {
    const { result } = await run([text('a'), { wait: 50_000 }, ev({ type: 'usage', usage: { outputTokens: 1 } }), { wait: 50_000 }, text('b'), finish])
    assert.equal(replyText(result), 'ab')
  })

  it('waits briefly for trailing usage after the finish, then keeps the reply', async () => {
    const { result, elapsed } = await run([text('done'), finish, { hang: 'until-abort' }])
    assert.equal(replyText(result), 'done')
    assert.equal(elapsed, 5_000)
  })

  it('keeps a finished reply when the stream errors after the finish', async () => {
    const { result } = await run([text('done'), finish, { fail: new TransportError('server', 'late error') }])
    assert.equal(replyText(result), 'done')
  })

  it('fails a stream that closes before its finish', async () => {
    const { result } = await run(faults.cutStream('half'))
    const error = failed(result)
    assert.equal(error.kind, 'protocol')
    assert.equal(error.message, 'The stream from test/model ended before the reply was complete.')
    assert.equal(result.streamed, true)
  })

  it("passes a provider's error through, and makes anything else a protocol error", async () => {
    assert.equal(failed((await run(faults.midStreamError())).result).kind, 'server')
    const broken = {
      next: () => Promise.reject(new Error('socket hang up')),
    }
    const error = failed((await run(fromIterator(broken))).result)
    assert.equal(error.kind, 'protocol')
    assert.equal(error.message, 'test/model: socket hang up')
    const throwing = {
      next: (): Promise<IteratorResult<TransportEvent>> => {
        throw new Error('not a promise')
      },
    }
    assert.equal(failed((await run(fromIterator(throwing))).result).kind, 'protocol')
  })

  it('fails cleanly when the adapter throws before it streams', async () => {
    const refusing = () => ({
      type: 'openrouter' as const,
      stream: (): AsyncIterable<TransportEvent> => {
        throw new TransportError('invalid-request', 'This provider has no base URL. Set one in Settings.')
      },
    })
    assert.equal(failed((await run(refusing)).result).kind, 'invalid-request')
    const crashing = () => ({
      type: 'openrouter' as const,
      stream: (): AsyncIterable<TransportEvent> => {
        throw new Error('bad adapter')
      },
    })
    const error = failed((await run(crashing)).result)
    assert.equal(error.kind, 'protocol')
    assert.match(error.message, /bad adapter/)
  })

  it('returns the raw tool-call arguments next to the parsed ones, and forwards the call as it streams', async () => {
    const args = { path: 'src/a.ts', content: 'export const a = 1\n' }
    const { result, events } = await run(faults.toolCall('Write', args, { id: 'call_7' }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.rawArguments, [JSON.stringify(args)])
    assert.deepEqual(result.reply.message.content, [{ type: 'tool-use', id: 'call_7', name: 'Write', input: args }])
    assert.deepEqual(events[0], { type: 'tool-call', index: 0, id: 'call_7', name: 'Write', arguments: JSON.stringify(args).slice(0, 10) })
    assert.equal(events.map((event) => (event.type === 'tool-call' ? event.arguments : '')).join(''), JSON.stringify(args))
  })

  it('repairs malformed tool JSON when given a repair, and keeps what the model sent', async () => {
    const raw = "{path: 'a.ts', content: 'x',}"
    const { result } = await run(faults.toolCall('Write', raw), { repair: true })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.rawArguments, [raw])
    const [call] = result.reply.message.content
    assert.equal(call.type, 'tool-use')
    if (call.type === 'tool-use') assert.deepEqual(call.input, { path: 'a.ts', content: 'x' })
  })

  it("rejects with the caller's reason at once, without waiting for an adapter that ignores it", async () => {
    const signals: AbortSignal[] = []
    const controller = new AbortController()
    const clock = new FakeClock()
    clock.setTimeout(() => controller.abort(new Error('stopped by the user')), 1_000)
    await assert.rejects(
      run(
        spy(signals, (inner) => new ScriptedAdapter('openrouter', inner, () => faults.hangIgnoringAbort())),
        { signal: controller.signal, clock },
      ),
      /stopped by the user/,
    )
    assert.equal(signals[0].aborted, true)
    assert.equal(clock.pending, 0, 'the watchdog is cleared')
  })

  it('never calls the adapter when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    const clock = new FakeClock()
    const adapter = new ScriptedAdapter('openrouter', clock, () => faults.reply('x'))
    await assert.rejects(run(() => adapter, { signal: controller.signal, clock }), /already gone/)
    assert.equal(adapter.calls.length, 0)
  })

  it('abandons a stream that ignores its signal, closing it without waiting', async () => {
    let returned = 0
    const stuck: AsyncIterator<TransportEvent> = {
      next: () => new Promise<never>(() => undefined),
      return: () => {
        returned++
        return new Promise<never>(() => undefined)
      },
    }
    const { result, elapsed } = await run(fromIterator(stuck))
    assert.equal(failed(result).kind, 'timeout')
    assert.equal(elapsed, 20_000)
    assert.equal(returned, 1)
  })

  it('does not close a stream that already ended', async () => {
    let returned = 0
    const events: TransportEvent[] = [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'stop' }]
    const finite: AsyncIterator<TransportEvent> = {
      next: async () => (events.length ? { done: false, value: events.shift()! } : { done: true, value: undefined }),
      return: async () => {
        returned++
        return { done: true, value: undefined }
      },
    }
    const { result } = await run(fromIterator(finite))
    assert.equal(replyText(result), 'ok')
    assert.equal(returned, 0)
  })
})
