/**
 * Highlighting on another thread. `serveHighlighting` runs inside a worker and tokenizes the batches the page sends;
 * `connectHighlighting` is the page's side, a HighlightService any number of editors share. Both only pass text one
 * way and numbers the other, and each checks what it is given.
 */
import { tokenizeBatch, type HighlightBatch, type HighlightResult, type HighlightService } from './highlight'
import { languageById } from './languages'

/** The part of the scope inside a worker that the worker's side uses. */
export interface HighlightPort {
  postMessage(message: unknown, transfer?: unknown[]): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/** The part of a worker that the page's side uses. */
export interface HighlightWorkerPort {
  postMessage(message: unknown, transfer?: unknown[]): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: { data?: unknown }) => void): void
  terminate(): void
}

interface Request {
  seq: number
  batch: HighlightBatch
}

interface Reply {
  seq: number
  result: HighlightResult | null
}

/** A batch the worker takes: anything else is answered with null. */
const MAX_LINES = 65_536

function readBatch(value: unknown): HighlightBatch | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, language, brackets, state, lines } = value as Record<string, unknown>
  if (!Number.isInteger(id) || typeof language !== 'string' || typeof state !== 'string') return null
  if (!Array.isArray(lines) || lines.length > MAX_LINES || !lines.every((line) => typeof line === 'string')) return null
  if (brackets !== null && !(Array.isArray(brackets) && brackets.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string')))) {
    return null
  }
  return { id: id as number, language, brackets: brackets as HighlightBatch['brackets'], state, lines: lines as string[] }
}

/** Answers batches on `port`, the scope of the worker this runs in. */
export function serveHighlighting(port: HighlightPort): void {
  let warned = false
  port.addEventListener('message', (event) => {
    const data = event.data as Partial<Request> | null
    const seq = data?.seq
    if (!Number.isInteger(seq)) return
    const batch = readBatch(data?.batch)
    const language = batch ? languageById(batch.language) : undefined
    let result: HighlightResult | null = null
    if (batch && language) {
      result = tokenizeBatch(language.tokenizer, batch, (error) => {
        if (warned) return
        warned = true
        console.warn('Tokenizer failed on a line; it is shown as plain text.', error)
      })
    }
    const reply: Reply = { seq: seq as number, result }
    port.postMessage(reply, result ? [result.states.buffer, ...(result.summaries ? [result.summaries.buffer] : [])] : [])
  })
}

/** A batch that takes longer than this means the worker is stuck: it is stopped and the editors tokenize themselves. */
export const BATCH_TIMEOUT_MS = 20_000

export interface HighlightConnection extends HighlightService {
  /** False once the worker failed or was closed: batches resolve null at once. */
  readonly alive: boolean
  close(): void
}

/**
 * The page's side of a highlighting worker. Batches go out in order and come back in order; a worker that reports an
 * error, sends something unreadable or takes too long is stopped, and every batch out resolves null.
 */
export function connectHighlighting(worker: HighlightWorkerPort, timeoutMs = BATCH_TIMEOUT_MS): HighlightConnection {
  const pending = new Map<number, { resolve: (result: HighlightResult | null) => void; timer: ReturnType<typeof setTimeout> }>()
  let seq = 0
  let alive = true

  const fail = () => {
    if (!alive) return
    alive = false
    try {
      worker.terminate()
    } catch {
      /* already gone */
    }
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer)
      resolve(null)
    }
    pending.clear()
  }

  worker.addEventListener('message', (event) => {
    const data = event.data as Partial<Reply> | null
    const entry = Number.isInteger(data?.seq) ? pending.get(data!.seq!) : undefined
    if (!entry) return
    pending.delete(data!.seq!)
    clearTimeout(entry.timer)
    entry.resolve(data?.result ?? null)
  })
  worker.addEventListener('error', fail)
  worker.addEventListener('messageerror', fail)

  return {
    get alive() {
      return alive
    },
    run(batch) {
      if (!alive) return Promise.resolve(null)
      const id = ++seq
      return new Promise((resolve) => {
        const timer = setTimeout(fail, timeoutMs)
        pending.set(id, { resolve, timer })
        try {
          worker.postMessage({ seq: id, batch } satisfies Request)
        } catch {
          fail()
        }
      })
    },
    close: fail,
  }
}
