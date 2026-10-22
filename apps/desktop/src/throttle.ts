/**
 * Calls `run` at once the first time, and then at most once every `wait` ms: a burst of calls (an agent
 * writing a dozen files, each one announced) draws as a first update and one more at the end, not a dozen.
 */
export interface Throttled {
  (): void
  /** Drops a call that is waiting for its turn. */
  cancel(): void
}

export function throttle(run: () => void, wait: number): Throttled {
  let timer: ReturnType<typeof setTimeout> | undefined
  let waiting = false

  const fire = () => {
    run()
    timer = setTimeout(() => {
      timer = undefined
      if (!waiting) return
      waiting = false
      fire()
    }, wait)
  }

  const call = (() => {
    if (timer === undefined) fire()
    else waiting = true
  }) as Throttled
  call.cancel = () => {
    waiting = false
  }
  return call
}
