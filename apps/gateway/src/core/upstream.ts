import type { AttemptOutcome } from './control'
import { eventError, hasContent, LineDecoder, readDataLine, type UpstreamError } from './sse'
import { MINUTE, SECOND } from './time'

/**
 * One upstream attempt: send the request to OpenRouter and read until the
 * first event worth committing to. Nothing has reached the client yet, so any
 * failure up to that point can be retried elsewhere without the client
 * noticing. The caller decides what to do with the classified failure.
 */

export interface AttemptInput {
  fetch: typeof fetch
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  firstEventTimeoutMs: number
  /** Aborts the attempt when the client leaves or the request runs out of time. */
  signal: AbortSignal
  now: () => number
}

export interface Committed {
  kind: 'committed'
  /** The model OpenRouter says is answering. */
  model: string
  /** Every byte read so far, to forward first and as they are. */
  head: Uint8Array[]
  /** Every event in those bytes, for building a non-streamed answer. Events after the first content are not checked yet. */
  events: Record<string, unknown>[]
  /** True when the end marker was among those bytes. */
  done: boolean
  /** Continues parsing where the attempt stopped. */
  decoder: LineDecoder
  reader: ReadableStreamDefaultReader<Uint8Array>
  /** Aborts the upstream request. */
  abort: (reason?: unknown) => void
  ttftMs: number
}

export interface Failed {
  kind: 'failed'
  outcome: AttemptOutcome
  status?: number
  retryAfterMs?: number
  /** For rejected requests only: the upstream's reason, trimmed, for the client that sent the request. */
  detail?: string
}

export type AttemptResult = Committed | Failed

/** Beyond this, a reset time means the daily limit, not the per-minute one. */
const DAILY_RESET_THRESHOLD_MS = 2 * MINUTE
const MAX_HEAD_BYTES = 256 * 1024
const MAX_ERROR_BODY = 8 * 1024

class FirstEventTimeout extends Error {}

/** A short, single-line excerpt of an upstream message that is safe to show the client who sent the request. */
export function safeDetail(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean
}

function resetMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const value = Number(header)
  if (!Number.isFinite(value) || value <= 0) return undefined
  // OpenRouter sends epoch milliseconds; accept epoch seconds too.
  const at = value > 1e12 ? value : value > 1e9 ? value * 1000 : now + value * 1000
  return Math.max(0, at - now)
}

function retryAfterHeader(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * SECOND
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

const CONTEXT_PROBLEM = /context|maximum.{0,20}tokens|too long|token limit/i

/** Classifies an HTTP error from OpenRouter. */
export function classifyHttpFailure(status: number, headers: Headers, body: string, now: number): Failed {
  let message: unknown
  try {
    message = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message
  } catch {
    message = undefined
  }
  if (status === 429) {
    // OpenRouter's own limits come with X-RateLimit-* headers; a provider's do not.
    const platform = headers.has('x-ratelimit-limit') || headers.has('x-ratelimit-reset')
    if (platform) {
      const wait = resetMs(headers.get('x-ratelimit-reset'), now) ?? retryAfterHeader(headers.get('retry-after'), now)
      if (wait !== undefined && wait > DAILY_RESET_THRESHOLD_MS) return { kind: 'failed', outcome: 'daily_exhausted', status, retryAfterMs: wait }
      return { kind: 'failed', outcome: 'account_limited', status, retryAfterMs: wait ?? 10 * SECOND }
    }
    return { kind: 'failed', outcome: 'rate_limited', status, retryAfterMs: retryAfterHeader(headers.get('retry-after'), now) }
  }
  if (status === 402) return { kind: 'failed', outcome: 'payment_required', status }
  if (status === 401) return { kind: 'failed', outcome: 'unauthorized', status }
  if (status === 404) return { kind: 'failed', outcome: 'not_found', status }
  if (status === 403) return { kind: 'failed', outcome: 'rejected', status, detail: safeDetail(message) ?? 'The model refused this request.' }
  if (status === 400 || status === 413 || status === 422) {
    // A prompt too long for these models may still fit a larger one.
    if (typeof message === 'string' && CONTEXT_PROBLEM.test(message)) return { kind: 'failed', outcome: 'error', status }
    return { kind: 'failed', outcome: 'rejected', status, detail: safeDetail(message) ?? `The model rejected the request (HTTP ${status}).` }
  }
  return { kind: 'failed', outcome: 'error', status }
}

/** Classifies an error event that arrived before any content. */
export function classifyEventFailure(error: UpstreamError): Failed {
  const code = typeof error.code === 'string' ? Number(error.code) : error.code
  if (code === 429) return { kind: 'failed', outcome: 'rate_limited', status: 429 }
  if (code === 402) return { kind: 'failed', outcome: 'payment_required', status: 402 }
  if (code === 400 && error.message && CONTEXT_PROBLEM.test(error.message)) return { kind: 'failed', outcome: 'error', status: 400 }
  return { kind: 'failed', outcome: 'error', ...(typeof code === 'number' && Number.isFinite(code) ? { status: code } : {}) }
}

/** Cancels a body read when the attempt is aborted, so a stalled upstream cannot hold the attempt past its deadline. */
function cancelOnAbort(signal: AbortSignal, reader: ReadableStreamDefaultReader<Uint8Array>): void {
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined)
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
}

async function readLimited(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  cancelOnAbort(signal, reader)
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    /* a body cut short still classifies by status */
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return text.slice(0, limit)
}

export async function attemptUpstream(input: AttemptInput): Promise<AttemptResult> {
  const started = input.now()
  const controller = new AbortController()
  const onAbort = () => controller.abort(input.signal.reason)
  if (input.signal.aborted) return { kind: 'failed', outcome: 'client_closed' }
  input.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new FirstEventTimeout()), Math.max(1, input.firstEventTimeoutMs))
  const cleanup = () => {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', onAbort)
  }
  const failedBy = (fallback: Failed): Failed => {
    if (input.signal.aborted) return { kind: 'failed', outcome: 'client_closed' }
    if (controller.signal.reason instanceof FirstEventTimeout) return { kind: 'failed', outcome: 'timeout' }
    return fallback
  }

  let response: Response
  try {
    response = await input.fetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })
  } catch {
    cleanup()
    return failedBy({ kind: 'failed', outcome: 'error' })
  }

  if (!response.ok) {
    const text = await readLimited(response, MAX_ERROR_BODY, controller.signal)
    cleanup()
    return failedBy(classifyHttpFailure(response.status, response.headers, text, input.now()))
  }
  if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await readLimited(response, MAX_ERROR_BODY, controller.signal)
    cleanup()
    let error: UpstreamError | undefined
    try {
      const parsed = JSON.parse(text)
      error = parsed && typeof parsed === 'object' ? eventError(parsed as Record<string, unknown>) : undefined
    } catch {
      error = undefined
    }
    return failedBy(error ? classifyEventFailure(error) : { kind: 'failed', outcome: 'error', status: response.status })
  }

  const reader = response.body.getReader()
  cancelOnAbort(controller.signal, reader)
  const decoder = new LineDecoder()
  const head: Uint8Array[] = []
  const events: Record<string, unknown>[] = []
  let bytes = 0
  let model = ''
  const release = (reason?: unknown) => {
    controller.abort(reason)
    reader.cancel(reason).catch(() => undefined)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        cleanup()
        return failedBy({ kind: 'failed', outcome: 'error' })
      }
      head.push(value)
      bytes += value.byteLength
      let committed = false
      let ended = false
      for (const line of decoder.push(value)) {
        const data = readDataLine(line)
        if (committed) {
          // The rest of this chunk belongs to the answer; the caller checks it.
          if (data.kind === 'json') events.push(data.value)
          else if (data.kind === 'done') ended = true
          continue
        }
        if (data.kind === 'done') {
          cleanup()
          release()
          return { kind: 'failed', outcome: 'error' }
        }
        if (data.kind !== 'json') continue
        const error = eventError(data.value)
        if (error) {
          cleanup()
          release()
          return classifyEventFailure(error)
        }
        events.push(data.value)
        if (typeof data.value.model === 'string') model = data.value.model
        committed = hasContent(data.value)
      }
      if (committed) {
        cleanup()
        return {
          kind: 'committed',
          model: model || String(input.body.model),
          head,
          events,
          done: ended,
          decoder,
          reader,
          abort: release,
          ttftMs: input.now() - started,
        }
      }
      if (bytes > MAX_HEAD_BYTES) {
        cleanup()
        release()
        return { kind: 'failed', outcome: 'error' }
      }
    }
  } catch {
    cleanup()
    release()
    return failedBy({ kind: 'failed', outcome: 'error' })
  }
}
