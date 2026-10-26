/**
 * What a run prints, as the console shows it: whole lines, a few at a time. Text comes in pieces (a program's output,
 * a debugger's output events); each stream keeps the line it has not ended yet, and prints it after a short pause
 * when no end comes. Lines are handed on in batches, so a program that prints fast does not flood the window.
 */
import type { OutputLine } from './types'

/** A line the program printed without its end yet is printed after this long. */
const PARTIAL_LINE_MS = 100
const BATCH_MS = 30
/** One line is cut at this length: a program that prints megabytes without a line end still gives lines. */
const MAX_LINE_CHARS = 20_000

type Stream = OutputLine['category']

export class OutputBatch {
  private readonly pending: OutputLine[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly partial = new Map<Stream, { text: string; timer: NodeJS.Timeout | null; source?: OutputLine['source'] }>()

  constructor(
    private readonly sink: (lines: OutputLine[]) => void,
    /** A line that is the debugger's business, not the program's: left out. */
    private readonly skip: (category: Stream, text: string) => boolean = () => false,
  ) {}

  /** Text of a stream, in pieces as it came. */
  print(category: Stream, text: string, source?: OutputLine['source']): void {
    const partial = this.partial.get(category) ?? { text: '', timer: null }
    this.partial.set(category, partial)
    if (partial.timer) clearTimeout(partial.timer)
    partial.timer = null
    // The place of a console call is the place of the line it starts.
    if (!partial.text) partial.source = source
    const lines = (partial.text + text).split(/\r?\n/)
    partial.text = lines.pop() ?? ''
    for (const line of lines) {
      this.line({ category, text: line, ...(partial.source ? { source: partial.source } : {}) })
      partial.source = undefined
    }
    if (partial.text.length > MAX_LINE_CHARS) {
      this.line({ category, text: partial.text.slice(0, MAX_LINE_CHARS) })
      partial.text = partial.text.slice(MAX_LINE_CHARS)
    }
    if (partial.text) {
      partial.timer = setTimeout(() => this.end(category), PARTIAL_LINE_MS)
      partial.timer.unref?.()
    }
  }

  /** The line a stream has not ended yet, printed now. */
  end(category: Stream): void {
    const partial = this.partial.get(category)
    if (!partial) return
    if (partial.timer) clearTimeout(partial.timer)
    partial.timer = null
    if (partial.text) this.line({ category, text: partial.text, ...(partial.source ? { source: partial.source } : {}) })
    partial.text = ''
    partial.source = undefined
  }

  /** A whole line. */
  line(line: OutputLine): void {
    if (this.skip(line.category, line.text)) return
    this.pending.push(line.text.length > MAX_LINE_CHARS ? { ...line, text: line.text.slice(0, MAX_LINE_CHARS) } : line)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), BATCH_MS)
    this.timer.unref?.()
  }

  /** Every stream's unended line, and every line waiting, handed on now. */
  flush(): void {
    for (const category of this.partial.keys()) this.end(category)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending.length) return
    this.sink(this.pending.splice(0))
  }
}
