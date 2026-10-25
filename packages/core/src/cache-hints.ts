/**
 * What keeps a provider's prompt cache warm between requests (ADR 0128).
 *
 * - A key for the conversation. OpenRouter keeps the requests that carry the same one on the provider that cached the
 *   first, from the first request on (without it, only after a cache hit); OpenAI sends them to the same cache. The key
 *   is a hash, so nothing on this computer is named by it.
 * - The hour-long cache. Claude keeps a marked prefix for five minutes from the start of the request that last read
 *   it, and for an hour when asked, at twice the price of a normal input token to write instead of 1.25 times. Once a
 *   session has waited longer than five minutes between two requests (the person read and thought, an approval sat, a
 *   long command ran), it is likely to wait again, and every later wait would write the whole prefix again: from then
 *   on its requests ask for the hour.
 */
import { createHash } from 'node:crypto'

/** Start to start, the longest wait the five-minute cache survives. */
export const SHORT_CACHE_MS = 5 * 60_000

/** The key of one agent's conversation in a session: the main agent's, a subagent's or an attempt's. */
export function cacheKeyOf(sessionId: string, agentId: string): string {
  return `encode-${createHash('sha256').update(`${sessionId}\0${agentId}`).digest('hex').slice(0, 32)}`
}

/** When a session's requests start, for the choice of the cache's lifetime. One for each session, kept across its turns. */
export class CacheClock {
  private last: number | undefined
  private waits = false

  constructor(private readonly now: () => number = Date.now) {}

  /** Notes that a request starts now; true when it should ask for the hour-long cache. */
  start(): boolean {
    const now = this.now()
    if (this.last !== undefined && now - this.last > SHORT_CACHE_MS) this.waits = true
    this.last = now
    return this.waits
  }
}
