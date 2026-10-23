import { EditorSelection, SelectionRange, type Snippet } from '@encode/editor'
import { ChangeSet, type ChangeSpec } from '@encode/text'
import { DecorationSet, type MarkSpec } from './decorations'
import type { EditorView } from './view'

const SOURCE = 'snippet'

interface Range {
  from: number
  to: number
}

interface Session {
  /** Each stop's ranges in the document, one set per place the snippet went in, in Tab order; the last is $0. */
  stops: { ranges: Range[]; choices?: string[] }[]
  current: number
  /** Where each copy of the snippet is, to tell when the cursor has left them all. */
  spans: Range[]
}

/** What else goes in with a snippet, in the same step: the edits a completion brings (an import at the top). */
export interface SnippetInsert {
  /** More changes in the document as it is now; they must not overlap the snippet's ranges. */
  changes?: readonly ChangeSpec[]
  origin?: string
}

/**
 * A snippet being filled in. The snippet goes in at every cursor; Tab and Shift+Tab move between its stops, each
 * selected at every copy at once so its mirrors change together, and the last Tab, Escape or leaving the snippet
 * ends it. The stops are followed through edits and drawn as a light box.
 */
export class SnippetController {
  private session: Session | null = null

  constructor(private readonly view: EditorView) {
    view.on('transaction', (tr) => {
      if (!this.session || tr.origin === 'snippet') return
      if (tr.origin === 'undo' || tr.origin === 'redo') return this.exit()
      if (tr.docChanged) this.map(tr.changes)
      const head = tr.state.selection.main.head
      if (!this.session.spans.some((span) => head >= span.from && head <= span.to)) this.exit()
      else if (tr.docChanged) this.draw()
    })
  }

  get active(): boolean {
    return this.session !== null
  }

  /** The values the stop being filled in offers, if it is a choice. */
  get choices(): readonly string[] | null {
    const session = this.session
    return session?.stops[session.current]?.choices ?? null
  }

  /**
   * Puts `snippet` in place of each of `ranges` and selects its first stop, or its end when it has none. Returns
   * false when the document is read-only.
   */
  insert(snippet: Snippet, ranges: readonly Range[], options: SnippetInsert = {}): boolean {
    const { state } = this.view
    if (state.config.readOnly || !ranges.length) return false
    this.exit()
    const specs: ChangeSpec[] = [...ranges.map((range) => ({ from: range.from, to: range.to, insert: snippet.text })), ...(options.changes ?? [])]
    const changes = ChangeSet.of(specs, state.doc.length)
    const bases = ranges.map((range) => changes.mapPos(range.from, -1))
    const stops = snippet.stops.map((stop) => ({
      ranges: bases.flatMap((base) => stop.ranges.map((range) => ({ from: base + range.from, to: base + range.to }))),
      ...(stop.choices ? { choices: stop.choices } : {}),
    }))
    const spans = bases.map((base) => ({ from: base, to: base + snippet.text.length }))
    const live = stops.length > 1
    const first = stops[0]
    this.view.dispatch({
      changes,
      selection: selectionOf(first.ranges),
      origin: options.origin ?? 'input.complete',
      scrollIntoView: true,
      isolateHistory: true,
    })
    if (live) {
      this.session = { stops, current: 0, spans }
      this.draw()
    }
    return true
  }

  /** Selects the next stop; past the last, ends the snippet at $0. False when no snippet is being filled in. */
  next(): boolean {
    const session = this.session
    if (!session) return false
    return this.go(session.current + 1)
  }

  /** Selects the stop before; false when there is none or no snippet is being filled in. */
  previous(): boolean {
    const session = this.session
    if (!session || session.current === 0) return false
    return this.go(session.current - 1)
  }

  /** Ends the snippet, leaving the text and selection as they are. False when there was none. */
  exit(): boolean {
    if (!this.session) return false
    this.session = null
    this.view.setSource(SOURCE, null)
    return true
  }

  /** @internal The view shows another document. */
  stateReplaced(): void {
    this.session = null
  }

  private go(index: number): boolean {
    const session = this.session!
    const last = session.stops.length - 1
    const target = Math.min(index, last)
    session.current = target
    this.view.dispatch({ selection: selectionOf(session.stops[target].ranges), origin: 'snippet', scrollIntoView: true })
    if (target === last) this.exit()
    else this.draw()
    return true
  }

  /** The stops through a change: the one being filled in grows with text typed at its edges, the others do not. */
  private map(changes: ChangeSet): void {
    const session = this.session!
    const mapRange = (range: Range, grow: boolean): Range => {
      const from = changes.mapPos(range.from, grow ? -1 : 1)
      const to = changes.mapPos(range.to, grow ? 1 : -1)
      return { from, to: Math.max(from, to) }
    }
    session.stops = session.stops.map((stop, index) => ({ ...stop, ranges: stop.ranges.map((range) => mapRange(range, index === session.current)) }))
    session.spans = session.spans.map((span) => mapRange(span, true))
  }

  private draw(): void {
    const session = this.session!
    const marks: MarkSpec[] = []
    const last = session.stops.length - 1
    session.stops.forEach((stop, index) => {
      // $0 is where the snippet ends, not a stop to fill in.
      if (index === last) return
      for (const range of stop.ranges) marks.push({ ...range, className: index === session.current ? 'enc-snippet-active' : 'enc-snippet-stop' })
    })
    this.view.setSource(SOURCE, marks.length ? DecorationSet.of(this.view.state.doc, { marks }) : null)
  }
}

function selectionOf(ranges: readonly Range[]): EditorSelection {
  return EditorSelection.create(ranges.map((range) => new SelectionRange(range.from, range.to)))
}
