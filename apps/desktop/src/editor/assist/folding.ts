import { normalizeFoldRanges } from '@encode/editor'
import type { EditorView } from '@encode/editor-view'
import { onMarksChanged } from '../marks'
import { askServers } from './ask'

/** How long folding waits after typing stops before it asks the server again. */
const REFRESH_MS = 400

/**
 * Asks the file's language server how it folds (its blocks, comments, imports and regions) when the file is shown,
 * again once typing pauses, and once a server starts marking the file; the view folds by them. With no server, or one
 * that does not fold, the view folds by indentation and `#region` markers. One per editor view.
 *
 * Asked only while folding is on (`wanted`); a question skipped meanwhile is asked once it is on again (`wake`).
 */
export class EditorFolding {
  private path: string | null = null
  private token = 0
  private timer: number | undefined
  /** The last answer was that no server folds the file. */
  private none = false
  private stale = false
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    private readonly wanted: () => boolean = () => true,
  ) {
    this.stops.push(
      view.on('transaction', (tr) => {
        if (tr.docChanged) this.schedule()
      }),
    )
    // A server that starts for the file after it was shown marks it: its ranges can be asked for now.
    this.stops.push(
      onMarksChanged((path) => {
        if (path === this.path && this.none) this.schedule()
      }),
    )
  }

  /** The editor shows another file, or none; the view has the new state already. */
  show(path: string | null): void {
    this.path = path
    this.token++
    this.none = false
    this.stale = false
    window.clearTimeout(this.timer)
    if (path) void this.refresh()
  }

  /** Folding was turned on again: a question skipped while it was off is asked now. */
  wake(): void {
    if (this.stale && this.path && this.wanted()) void this.refresh()
  }

  /** Asks for the ranges now, for the text as it is. */
  async refresh(): Promise<void> {
    const path = this.path
    if (!path) return
    window.clearTimeout(this.timer)
    if (!this.wanted()) {
      this.stale = true
      return
    }
    this.stale = false
    const token = ++this.token
    const doc = this.view.state.doc
    const ranges = await askServers({ kind: 'folding', path })
    // Another file, a newer question, or text typed meanwhile: that answer is not for what is on screen.
    if (token !== this.token || this.path !== path) return
    if (this.view.state.doc !== doc) return this.schedule()
    this.none = ranges === null
    this.view.folding.setRanges(ranges ? normalizeFoldRanges(doc, ranges) : null)
  }

  dispose(): void {
    this.token++
    window.clearTimeout(this.timer)
    for (const stop of this.stops.splice(0)) stop()
  }

  private schedule(): void {
    window.clearTimeout(this.timer)
    if (this.path) this.timer = window.setTimeout(() => void this.refresh(), REFRESH_MS)
  }
}
