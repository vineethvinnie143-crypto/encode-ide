import type { ThinkingProgress } from './ui'

/** How often the live line hears of new thinking, at most (ADR 0125). */
export const THINKING_EVERY_MS = 400
/** The latest words the live line shows, at most. */
const LATEST_CHARS = 160
/** What is kept of the thinking to find its latest words in. */
const KEPT_CHARS = 1_000

/** Thinking on one line, without the markup the model writes its notes in. */
function flatten(text: string): string {
  return text
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The end of what the model thought, on one line, from a word's start, without the markup it writes its notes in. */
export function latestWords(text: string): string {
  const flat = flatten(text)
  if (flat.length <= LATEST_CHARS) return flat
  const tail = flat.slice(-LATEST_CHARS)
  const space = tail.indexOf(' ')
  return space > 0 && space < LATEST_CHARS / 2 ? tail.slice(space + 1) : tail
}

/**
 * The thinking of one model call, passed on as it comes: at once, then at most every THINKING_EVERY_MS, so a model that
 * thinks for minutes is seen to, and not as stuck. `end` says the call is over, when anything was passed on.
 */
export class ThinkingTicker {
  private text = ''
  private chars = 0
  private sentAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly send: (progress: ThinkingProgress | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  add(piece: string): void {
    if (!piece) return
    this.chars += piece.length
    this.text = (this.text + piece).slice(-KEPT_CHARS)
    const now = this.now()
    if (now - this.sentAt < THINKING_EVERY_MS) return
    const latest = latestWords(this.text)
    if (!latest) return
    this.sentAt = now
    // Cut: the words shown are the end of a longer thought, so the line starts with an ellipsis.
    const cut = this.chars > this.text.length || latest.length < flatten(this.text).length
    this.send({ chars: this.chars, latest, ...(cut ? { cut } : {}) })
  }

  end(): void {
    if (this.sentAt !== Number.NEGATIVE_INFINITY) this.send(null)
    this.text = ''
    this.chars = 0
    this.sentAt = Number.NEGATIVE_INFINITY
  }
}
