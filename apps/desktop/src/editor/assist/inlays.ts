import type { EditorView } from '@encode/editor-view'
import { inlayHintsToView } from '../hints'
import { onMarksChanged } from '../marks'
import { askServers } from './ask'

/** How long the hints wait after typing stops before they are asked for again. */
const TYPED_MS = 350
/** How long they wait after scrolling stops. */
const SCROLLED_MS = 120

/**
 * Asks the file's language server for its inlay hints (the types it worked out, the names of the parameters arguments
 * go to) for the lines on screen and a screen either side, and has the view draw them. Asked when a file is shown,
 * once typing pauses, when scrolling leaves the lines asked for, and once a server starts marking the file. One per
 * editor view.
 *
 * Asked only while hints are on (`wanted`); turned off, they are taken away, and turned on, asked for again (`wake`).
 */
export class EditorInlays {
  private path: string | null = null
  private token = 0
  private timer: number | undefined
  /** The lines (1-based) the hints drawn were asked for. */
  private asked: { first: number; last: number } | null = null
  /** The last answer was that no server gives hints for the file. */
  private none = false
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    private readonly wanted: () => boolean = () => true,
  ) {
    this.stops.push(
      view.on('transaction', (tr) => {
        if (tr.docChanged) this.schedule(TYPED_MS)
      }),
      view.on('viewport', () => {
        if (!this.path || this.none || !this.wanted()) return
        const { first, last } = view.viewportLines
        if (!this.asked || first < this.asked.first || last > this.asked.last) this.schedule(SCROLLED_MS)
      }),
      // A server that starts for the file after it was shown marks it: hints can be asked for now.
      onMarksChanged((path) => {
        if (path === this.path && this.none) this.schedule(TYPED_MS)
      }),
    )
  }

  /** The editor shows another file, or none; the view has the new state already (and no hints). */
  show(path: string | null): void {
    this.path = path
    this.token++
    this.none = false
    this.asked = null
    window.clearTimeout(this.timer)
    if (path) void this.refresh()
  }

  /** Hints were turned on or off. */
  wake(): void {
    if (!this.wanted()) {
      this.token++
      window.clearTimeout(this.timer)
      this.asked = null
      this.view.setInlayHints(null)
      return
    }
    if (this.path) void this.refresh()
  }

  /** Asks for the hints of the lines on screen and a screen either side, for the text as it is. */
  async refresh(): Promise<void> {
    const path = this.path
    window.clearTimeout(this.timer)
    if (!path || !this.wanted()) return
    const token = ++this.token
    const doc = this.view.state.doc
    const { first, last } = this.view.viewportLines
    const screen = Math.max(1, last - first + 1)
    const range = { first: Math.max(1, first - screen), last: Math.min(doc.lineCount, last + screen) }
    const hints = await askServers({ kind: 'inlayHints', path, startLine: range.first - 1, endLine: range.last - 1 })
    // Another file, a newer question, hints turned off, or text typed meanwhile: that answer is not for what is on screen.
    if (token !== this.token || this.path !== path || !this.wanted()) return
    if (this.view.state.doc !== doc) return this.schedule(TYPED_MS)
    this.none = hints === null
    this.asked = hints ? range : null
    this.view.setInlayHints(hints ? inlayHintsToView(hints) : null)
  }

  dispose(): void {
    this.token++
    window.clearTimeout(this.timer)
    for (const stop of this.stops.splice(0)) stop()
  }

  private schedule(ms: number): void {
    window.clearTimeout(this.timer)
    if (this.path && this.wanted()) this.timer = window.setTimeout(() => void this.refresh(), ms)
  }
}
