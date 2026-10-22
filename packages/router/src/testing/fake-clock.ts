import type { Clock } from '../clock'

interface Timer {
  at: number
  order: number
  callback: () => void
}

/** Lets every pending promise reaction run, including chains that hop through several awaits. */
async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * A deterministic clock for tests. Time stands still until the test moves it,
 * and timers fire in time order (ties in the order they were set).
 *
 * `run(work)` is the usual entry point: it lets the work proceed and, whenever
 * everything is waiting on a timer, jumps straight to the next one. A test of a
 * 15-minute cooldown therefore runs in milliseconds, and a hang shows up as an
 * error instead of a stuck test.
 */
export class FakeClock implements Clock {
  private time: number
  private readonly timers = new Map<number, Timer>()
  private nextId = 1
  private order = 0

  /** Starts at a fixed instant (21 October 2026, 12:00 UTC) so failures replay exactly. */
  constructor(start = Date.UTC(2026, 9, 21, 12, 0, 0)) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + Math.max(0, Number.isFinite(ms) ? ms : 0), order: this.order++, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Timers not yet fired. */
  get pending(): number {
    return this.timers.size
  }

  private nextTimer(): [number, Timer] | undefined {
    let best: [number, Timer] | undefined
    for (const entry of this.timers) {
      const [, timer] = entry
      if (!best || timer.at < best[1].at || (timer.at === best[1].at && timer.order < best[1].order)) best = entry
    }
    return best
  }

  private fire([id, timer]: [number, Timer]): void {
    this.timers.delete(id)
    this.time = Math.max(this.time, timer.at)
    timer.callback()
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.time + Math.max(0, ms)
    await settle()
    for (let next = this.nextTimer(); next && next[1].at <= target; next = this.nextTimer()) {
      this.fire(next)
      await settle()
    }
    this.time = target
  }

  /**
   * Runs `work` to completion, advancing time whenever nothing else can make
   * progress. Fails when the work is stuck with no timer left to wait for, or
   * when it needs more than `limitMs` of simulated time.
   */
  async run<T>(work: Promise<T>, limitMs = 7 * 24 * 60 * 60 * 1000): Promise<T> {
    const deadline = this.time + limitMs
    let settled = false
    work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    while (true) {
      await settle()
      if (settled) return work
      const next = this.nextTimer()
      if (!next) {
        await settle(16)
        if (settled) return work
        throw new Error('FakeClock.run: the work is waiting, but no timer is pending, so it can never finish.')
      }
      if (next[1].at > deadline) throw new Error(`FakeClock.run: the work needs more than ${limitMs} ms of simulated time.`)
      this.fire(next)
    }
  }
}
