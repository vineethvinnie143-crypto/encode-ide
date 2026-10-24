import {
  createAssembler,
  isTransportError,
  TransportError,
  type AssembledReply,
  type ClientEvent,
  type ModelRequest,
  type ProviderAdapter,
  type TransportEvent,
  type TransportTarget,
} from '@encode/providers'
import { abortReason, type Clock } from './clock'

/**
 * One attempt: a single streamed call to one model, watched by a watchdog
 * and assembled into a reply. Content is forwarded to the UI as it arrives
 * but nothing is committed here; the router decides whether the reply is
 * kept, retried or discarded.
 *
 * The watchdog gives the first token its own deadline (longer for models
 * that reason first and for servers on this machine), then allows a gap of
 * `idleMs` between content. Keepalives prove the server is alive without
 * proving the model is: each one buys time, but only up to a cap, so a
 * proxy that pings in front of a stuck upstream cannot hold an attempt
 * forever.
 *
 * An adapter that ignores its abort signal is abandoned, not awaited.
 */

export interface AttemptTiming {
  firstTokenMs: number
  keepaliveFirstTokenMs: number
  idleMs: number
  keepaliveIdleMs: number
}

export interface AttemptInput {
  adapter: ProviderAdapter
  target: TransportTarget
  payload: ModelRequest
  /** The caller's signal. Its abort ends the attempt and rejects with its reason. */
  signal: AbortSignal
  clock: Clock
  timing: AttemptTiming
  repairJson?: (raw: string) => unknown
  newId?: () => string
  emit(event: ClientEvent): void
}

interface AttemptBase {
  /** The model that answered, when the server named one (OpenRouter may serve a fallback). */
  servedModel?: string
  /** Content reached the UI, so a failure must tell it to forget the attempt. */
  streamed: boolean
  /** Milliseconds from sending to the first content. */
  ttftMs?: number
}

export type AttemptResult =
  | (AttemptBase & {
      ok: true
      reply: AssembledReply
      /** The raw arguments of each tool call in the reply, in order, as the model sent them. */
      rawArguments: string[]
    })
  | (AttemptBase & { ok: false; error: TransportError })

/** After the finish event, how long to wait for trailing usage before taking the reply as it is. */
const AFTER_FINISH_MS = 5_000

type Step = { kind: 'next'; result: IteratorResult<TransportEvent> } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'abort' }

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`
}

export async function runAttempt(input: AttemptInput): Promise<AttemptResult> {
  const { adapter, target, payload, signal, clock, timing, emit } = input
  if (signal.aborted) throw abortReason(signal)

  const controller = new AbortController()
  const assembler = createAssembler({
    origin: { provider: target.provider, model: target.model, family: target.family },
    repairJson: input.repairJson,
    newId: input.newId,
  })
  const startedAt = clock.now()
  let deadline = startedAt + timing.firstTokenMs
  let firstTokenAt: number | undefined
  let lastContentAt = startedAt
  let servedModel: string | undefined
  let streamed = false
  let finished = false
  let ended = false

  // One pending step at a time; the watchdog and the caller's abort settle it early.
  let settle: ((step: Step) => void) | undefined
  let timer: unknown
  let timerAt = Number.POSITIVE_INFINITY
  // The timer is set for the deadline it saw. A later deadline re-arms it when it fires;
  // an earlier one (the first token, the finish) re-arms it before the next step.
  const arm = () => {
    if (timer !== undefined) clock.clearTimeout(timer)
    timerAt = deadline
    timer = clock.setTimeout(
      () => {
        timer = undefined
        if (clock.now() >= deadline) settle?.({ kind: 'timeout' })
        else arm()
      },
      Math.max(0, deadline - clock.now()),
    )
  }
  const onAbort = () => settle?.({ kind: 'abort' })
  signal.addEventListener('abort', onAbort, { once: true })

  const base = (): AttemptBase => ({
    ...(servedModel ? { servedModel } : {}),
    streamed,
    ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - startedAt } : {}),
  })
  const succeed = (): AttemptResult => {
    const rawArguments = assembler
      .snapshot()
      .blocks.flatMap((block) => (block.type === 'tool-call' && block.name ? [block.arguments] : []))
    return { ok: true, reply: assembler.finish(), rawArguments, ...base() }
  }
  const fail = (error: TransportError): AttemptResult => ({ ok: false, error, ...base() })

  let iterator: AsyncIterator<TransportEvent> | undefined
  try {
    iterator = adapter.stream({ target, request: payload, signal: controller.signal })[Symbol.asyncIterator]()
    while (true) {
      if (timer === undefined || deadline < timerAt) arm()
      const source = iterator
      const step = await new Promise<Step>((resolve) => {
        let done = false
        const finish = (value: Step) => {
          if (done) return
          done = true
          if (settle === finish) settle = undefined
          resolve(value)
        }
        settle = finish
        if (signal.aborted) return finish({ kind: 'abort' })
        if (clock.now() >= deadline) return finish({ kind: 'timeout' })
        let next: Promise<IteratorResult<TransportEvent>>
        try {
          next = source.next()
        } catch (error) {
          return finish({ kind: 'error', error })
        }
        next.then(
          (result) => finish({ kind: 'next', result }),
          (error: unknown) => finish({ kind: 'error', error }),
        )
      })

      if (step.kind === 'abort') {
        controller.abort(abortReason(signal))
        throw abortReason(signal)
      }
      if (step.kind === 'timeout') {
        // A reply that finished is complete; only its trailing usage was late.
        if (finished) return succeed()
        const error =
          firstTokenAt === undefined
            ? new TransportError('timeout', `${target.model} sent nothing within ${seconds(clock.now() - startedAt)}.`)
            : new TransportError('timeout', `${target.model} stopped sending for ${seconds(clock.now() - lastContentAt)}.`)
        controller.abort(error)
        return fail(error)
      }
      if (step.kind === 'error') {
        if (signal.aborted) throw abortReason(signal)
        ended = true
        if (finished) return succeed()
        const { error } = step
        return fail(
          isTransportError(error)
            ? error
            : new TransportError('protocol', `${target.model}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
        )
      }
      if (step.result.done) {
        ended = true
        if (finished) return succeed()
        return fail(new TransportError('protocol', `The stream from ${target.model} ended before the reply was complete.`))
      }

      const event = step.result.value
      const now = clock.now()
      switch (event.type) {
        case 'keepalive':
          if (firstTokenAt === undefined) deadline = Math.max(deadline, Math.min(now + timing.firstTokenMs, startedAt + timing.keepaliveFirstTokenMs))
          else if (!finished) deadline = Math.max(deadline, Math.min(now + timing.idleMs, lastContentAt + timing.keepaliveIdleMs))
          continue
        case 'model':
          if (event.model) servedModel = event.model
          break
        case 'text':
        case 'thinking':
        case 'redacted-thinking':
        case 'reasoning-detail':
        case 'tool-call':
          // An empty delta (a role chunk, say) proves nothing about the model.
          if (event.type === 'text' ? !event.text : event.type === 'thinking' && !event.text && !event.signature) break
          firstTokenAt ??= now
          lastContentAt = now
          deadline = now + timing.idleMs
          break
        case 'usage':
          if (firstTokenAt !== undefined && !finished) deadline = Math.max(deadline, now + timing.idleMs)
          break
        case 'finish':
          finished = true
          deadline = now + AFTER_FINISH_MS
          break
      }
      assembler.push(event)
      if ((event.type === 'text' || event.type === 'thinking') && event.text) {
        streamed = true
        emit({ type: event.type, text: event.text })
      } else if (event.type === 'tool-call') {
        streamed = true
        emit({ type: 'tool-call', index: event.index, ...(event.id ? { id: event.id } : {}), ...(event.name ? { name: event.name } : {}), arguments: event.arguments })
      }
    }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal)
    if (iterator === undefined) {
      // The adapter threw before streaming anything.
      ended = true
      return fail(isTransportError(error) ? error : new TransportError('protocol', `${target.model}: ${String(error)}`, { cause: error }))
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (timer !== undefined) clock.clearTimeout(timer)
    if (!ended) {
      if (!controller.signal.aborted) controller.abort(new TransportError('timeout', 'The attempt was abandoned.'))
      // Never awaited: an adapter that ignores its signal must not hold the request.
      try {
        void Promise.resolve(iterator?.return?.()).catch(() => undefined)
      } catch {
        // A broken iterator cannot be closed; it is dropped.
      }
    }
  }
}
