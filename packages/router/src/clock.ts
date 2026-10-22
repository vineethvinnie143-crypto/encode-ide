/**
 * Time as the router sees it. Every cooldown, watchdog and pacing wait goes
 * through a Clock, so tests drive the router on a fake clock and a 15-minute
 * cooldown takes no real time.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
}

/** The reason an aborted signal carries, or a standard AbortError when it has none. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = () => {
      clock.clearTimeout(handle)
      reject(abortReason(signal!))
    }
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
