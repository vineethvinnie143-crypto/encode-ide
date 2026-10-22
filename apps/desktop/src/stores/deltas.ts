import type { ConversationEntry } from '@shared/types'

/**
 * A model streams its answer in pieces a few milliseconds apart, far more often than the screen is drawn.
 * Applying each piece would render the thread (and read the whole answer again) a hundred times a second
 * for nothing; the buffer holds the pieces until the next frame and hands them over once.
 */

/** Runs `run` once, soon, and returns a way to cancel it. */
export type Scheduler = (run: () => void) => () => void

/** What the buffer hands over: the new text of each entry, when the first piece came, and how many characters came. */
export interface Batch {
  texts: ReadonlyMap<string, string>
  firstAt: number
  chars: number
}

export interface DeltaBuffer {
  push(entryId: string, text: string): void
  /** Hands over what is held, now. Call it before applying any other event, so events keep their order. */
  flush(): void
  /** Forgets what is held: the session it belongs to is gone. */
  discard(): void
}

/**
 * The next animation frame; and after 100 ms whatever the frame is doing, since a minimised window draws no
 * frames and the text should still land.
 */
export const frameScheduler: Scheduler = (run) => {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    run()
  }
  const frame = requestAnimationFrame(finish)
  const timer = setTimeout(finish, 100)
  return () => {
    finished = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

export function createDeltaBuffer(onBatch: (batch: Batch) => void, schedule: Scheduler = frameScheduler, now: () => number = Date.now): DeltaBuffer {
  let texts = new Map<string, string>()
  let firstAt = 0
  let chars = 0
  let cancel: (() => void) | undefined

  const take = (): Batch | undefined => {
    cancel?.()
    cancel = undefined
    if (!texts.size) return undefined
    const batch = { texts, firstAt, chars }
    texts = new Map()
    firstAt = 0
    chars = 0
    return batch
  }

  return {
    push(entryId, text) {
      if (!texts.size) firstAt = now()
      texts.set(entryId, (texts.get(entryId) ?? '') + text)
      chars += text.length
      cancel ??= schedule(() => {
        cancel = undefined
        const batch = take()
        if (batch) onBatch(batch)
      })
    },
    flush() {
      const batch = take()
      if (batch) onBatch(batch)
    },
    discard() {
      take()
    },
  }
}

/**
 * The entries with the new text added to the ones it belongs to. The entry that is streaming is nearly always
 * the last, so each is looked for from the end; entries it does not touch keep their identity, which is what
 * lets the thread skip them. An entry that is not there is dropped (its session was closed or reset).
 */
export function appendTexts(entries: ConversationEntry[], texts: ReadonlyMap<string, string>): ConversationEntry[] {
  let next = entries
  for (const [id, text] of texts) {
    let index = next.length - 1
    while (index >= 0 && next[index].id !== id) index--
    if (index < 0) continue
    if (next === entries) next = entries.slice()
    next[index] = { ...next[index], text: (next[index].text ?? '') + text }
  }
  return next
}
