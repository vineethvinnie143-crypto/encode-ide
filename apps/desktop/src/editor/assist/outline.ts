import type { EditorView } from '@encode/editor-view'
import type { EditorSymbol } from '@shared/types'
import { create } from '../../store'
import { onMarksChanged } from '../marks'
import type { Spot } from '../symbols'
import { askServers, lspAt } from './ask'

/** What the breadcrumbs and the outline read: the symbols of the file the editor shows, and where its cursor is. */
export interface OutlineView {
  path: string | null
  /** The file's symbols as the server last gave them; null before the first answer, or with no server for the file. */
  symbols: EditorSymbol[] | null
  /** `none`: no server gives this file an outline. */
  status: 'idle' | 'loading' | 'ready' | 'none'
  /** The cursor, as the servers count. */
  at: Spot
}

export const useOutline = create<OutlineView>(() => ({ path: null, symbols: null, status: 'idle', at: { line: 0, character: 0 } }))

/** How long the outline waits after typing stops before it asks again. */
const REFRESH_MS = 400

/**
 * Keeps `useOutline` for an editor view: asks the file's server for its symbols when the file is shown, again once
 * typing pauses, and once a server starts marking the file; follows the cursor. One per editor view.
 *
 * It asks only while something shows the symbols (`wanted`: the breadcrumbs, the outline, Go to symbol); a question
 * skipped meanwhile is asked once something does (`wake`).
 */
export class EditorOutline {
  private path: string | null = null
  private token = 0
  private timer: number | undefined
  private frame = 0
  /** A question was skipped while nothing showed the symbols: the store's are not for the text as it is. */
  private stale = false
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    private readonly wanted: () => boolean = () => true,
  ) {
    this.stops.push(
      view.on('transaction', (tr) => {
        if (tr.docChanged) this.schedule()
        if (tr.docChanged || tr.selectionChanged) this.follow()
      }),
    )
    // A server that starts for the file after it was shown marks it: its outline can be asked for now.
    this.stops.push(
      onMarksChanged((path) => {
        if (path === this.path && useOutline.getState().status === 'none') this.schedule()
      }),
    )
  }

  /** The editor shows another file, or none. */
  show(path: string | null): void {
    this.path = path
    this.token++
    window.clearTimeout(this.timer)
    const { doc, selection } = this.view.state
    useOutline.setState({ path, symbols: null, status: path && this.wanted() ? 'loading' : 'idle', at: lspAt(doc, selection.main.head) })
    this.stale = false
    if (path) void this.refresh()
  }

  /** Something began to show the symbols: a question skipped while nothing did is asked now. */
  wake(): void {
    if (!this.stale || !this.path || !this.wanted()) return
    if (!useOutline.getState().symbols) useOutline.setState({ status: 'loading' })
    void this.refresh()
  }

  /** Asks for the symbols now, for the text as it is. */
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
    const symbols = await askServers({ kind: 'symbols', path })
    // Another file, a newer question, or text typed meanwhile: that answer is not for what is on screen.
    if (token !== this.token || this.path !== path) return
    if (this.view.state.doc !== doc) return this.schedule()
    useOutline.setState({ symbols, status: symbols ? 'ready' : 'none' })
  }

  dispose(): void {
    this.token++
    window.clearTimeout(this.timer)
    cancelAnimationFrame(this.frame)
    for (const stop of this.stops.splice(0)) stop()
    useOutline.setState({ path: null, symbols: null, status: 'idle' })
  }

  private schedule(): void {
    window.clearTimeout(this.timer)
    if (this.path) this.timer = window.setTimeout(() => void this.refresh(), REFRESH_MS)
  }

  /** The cursor, once a frame at most: the breadcrumbs and the outline follow it. */
  private follow(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const { doc, selection } = this.view.state
      const at = lspAt(doc, selection.main.head)
      const now = useOutline.getState().at
      if (now.line !== at.line || now.character !== at.character) useOutline.setState({ at })
    })
  }
}
