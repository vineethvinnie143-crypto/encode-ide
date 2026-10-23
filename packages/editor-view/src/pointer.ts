import { EditorSelection, SelectionRange, indexAtColumn, lineRangeAt, toggleCursorAt, wordRangeAt } from '@encode/editor'
import { FOLD_COLUMN } from './folding'
import type { EditorView } from './view'

type Mode = 'char' | 'word' | 'line' | 'column'

interface Drag {
  mode: Mode
  /** Ranges that stay as they were: the other cursors when adding one with Alt. */
  base: readonly SelectionRange[]
  /** Where the drag started: a position, or for words and lines the range that was picked. */
  origin: SelectionRange
  /** For column selection: the visual column the drag started at. */
  column: number
  line: number
}

/** The farthest the pointer may be outside the editor before the view starts scrolling by itself, and how fast. */
const SCROLL_EDGE = 8
const SCROLL_STEP = 40

/**
 * Mouse selection: click, double click (word), triple click (line), shift
 * to extend, Alt to add a cursor, Shift+Alt to drag a column selection,
 * clicks in the gutter to select lines. A drag past the edge scrolls.
 */
export class PointerHandler {
  private drag: Drag | null = null
  private last = { x: 0, y: 0 }
  private timer = 0

  constructor(private readonly view: EditorView) {
    view.listen(view.scroller, 'mousedown', (event) => this.down(event))
    view.listen(view.scroller, 'contextmenu', (event) => this.contextMenu(event))
  }

  get dragging(): boolean {
    return this.drag !== null
  }

  private ignored(event: MouseEvent): boolean {
    const target = event.target as Element | null
    if (target?.closest('.enc-zone, .enc-widgets, button, input, textarea')) return true
    // The scrollbars belong to the browser.
    const rect = this.view.scroller.getBoundingClientRect()
    return event.clientX > rect.left + this.view.scroller.clientWidth || event.clientY > rect.top + this.view.scroller.clientHeight
  }

  private down(event: MouseEvent): void {
    if (event.button !== 0 || this.ignored(event)) return
    const view = this.view
    // Keep the focus in the textarea and the browser from starting its own selection or drag.
    event.preventDefault()
    view.focus()
    // A click ends a composition with what was composed, where it was composed.
    view.input.commitComposition()
    const state = view.state
    const target = event.target as Element
    // The marker after a folded line, and the chevrons in the gutter's last column, fold and unfold.
    const pill = target.closest<HTMLElement>('.enc-fold-pill')
    if (pill) {
      view.folding.unfold(Number(pill.dataset.line))
      return
    }
    const inGutter = !!target.closest('.enc-gutter')
    if (inGutter && view.options.folding && event.clientX >= view.gutterRight() - FOLD_COLUMN && !event.shiftKey) {
      const line = view.lineAtClientY(event.clientY)
      if (view.folding.isFolded(line) || view.folding.startsAt(line)) {
        if (event.altKey) {
          if (view.folding.isFolded(line)) view.folding.unfoldRecursively(line)
          else view.folding.foldRecursively(line)
        } else view.folding.toggle(line)
        return
      }
    }
    // Past the end of a row a break ends, the caret goes at that row's end.
    const at: { assoc?: -1 | 1 } = {}
    const pos = inGutter ? state.doc.line(view.lineAtClientY(event.clientY)).from : view.posAtCoords(event.clientX, event.clientY, at)
    const clicks = ((Math.max(1, event.detail) - 1) % 3) + 1
    const command = view.mac ? event.metaKey : event.ctrlKey
    const add = event.altKey && !event.shiftKey
    const column = event.altKey && event.shiftKey && !inGutter

    if (command && clicks === 1 && !add && !column) view.emit('navigate', { pos, modifiers: { shift: event.shiftKey, alt: event.altKey } })

    const base = add ? state.selection.ranges : []
    if (add && clicks === 1) {
      const toggled = toggleCursorAt(state, pos)
      if (!toggled) return
      view.dispatch(toggled)
      // A cursor that was removed does not start a drag; one that was added can be dragged out into a selection.
      if (toggled.state.selection.ranges.length < state.selection.ranges.length) return
      const after = toggled.state.selection
      this.begin({ mode: 'char', base: after.ranges.filter((_, index) => index !== after.mainIndex), origin: SelectionRange.cursor(pos), column: 0, line: 0 }, event)
      return
    }
    if (inGutter) {
      const origin = lineRangeAt(state, pos)
      this.begin({ mode: 'line', base, origin, column: 0, line: 0 }, event)
      this.apply(event.clientX, event.clientY, pos)
      return
    }
    if (column) {
      const line = state.doc.lineAt(pos)
      const col = this.columnAt(event.clientX)
      this.begin({ mode: 'column', base: [], origin: SelectionRange.cursor(pos), column: col, line: line.number }, event)
      this.apply(event.clientX, event.clientY, pos)
      return
    }
    if (event.shiftKey && clicks === 1) {
      const main = state.selection.main
      view.dispatch({ selection: state.selection.replaceRange(main.extend(pos)), origin: 'select' })
      this.begin({ mode: 'char', base: state.selection.ranges.filter((_, index) => index !== state.selection.mainIndex), origin: SelectionRange.cursor(main.anchor), column: 0, line: 0 }, event)
      return
    }
    const origin = clicks === 1 ? SelectionRange.cursor(pos, undefined, at.assoc) : clicks === 2 ? wordRangeAt(state, pos) : lineRangeAt(state, pos)
    const mode: Mode = clicks === 1 ? 'char' : clicks === 2 ? 'word' : 'line'
    this.begin({ mode, base, origin, column: 0, line: 0 }, event)
    this.apply(event.clientX, event.clientY, pos)
  }

  private begin(drag: Drag, event: MouseEvent): void {
    this.drag = drag
    this.last = { x: event.clientX, y: event.clientY }
    window.addEventListener('mousemove', this.move, true)
    window.addEventListener('mouseup', this.up, true)
    window.addEventListener('blur', this.cancel)
  }

  private readonly move = (event: MouseEvent): void => {
    if (!this.drag) return
    if (event.buttons === 0) {
      // The button was released outside the window.
      this.end()
      return
    }
    this.last = { x: event.clientX, y: event.clientY }
    this.apply(event.clientX, event.clientY)
    this.autoscroll()
  }

  private readonly up = (): void => this.end()
  private readonly cancel = (): void => this.end()

  private end(): void {
    this.drag = null
    window.removeEventListener('mousemove', this.move, true)
    window.removeEventListener('mouseup', this.up, true)
    window.removeEventListener('blur', this.cancel)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = 0
    }
  }

  private columnAt(clientX: number): number {
    const { charWidth, paddingX } = this.view.metrics
    return Math.max(0, Math.round((this.view.docXAt(clientX) - paddingX) / charWidth))
  }

  /** Updates the selection for the pointer at client coordinates. */
  private apply(clientX: number, clientY: number, known?: number): void {
    const drag = this.drag
    if (!drag) return
    const view = this.view
    const state = view.state
    const inGutter = drag.mode === 'line' && !!document.elementFromPoint(clientX, clientY)?.closest('.enc-gutter')
    const at: { assoc?: -1 | 1 } = { assoc: drag.origin.assoc }
    const pos = known ?? (inGutter ? state.doc.line(view.lineAtClientY(clientY)).from : view.posAtCoords(clientX, clientY, at))
    let ranges: SelectionRange[]
    if (drag.mode === 'column') {
      ranges = this.columnRanges(drag, clientX, view.lineAtClientY(clientY))
    } else {
      let range: SelectionRange
      if (drag.mode === 'char') {
        range = new SelectionRange(drag.origin.anchor, pos, undefined, at.assoc)
      } else {
        const unit = drag.mode === 'word' ? wordRangeAt(state, pos) : lineRangeAt(state, pos)
        range =
          pos < drag.origin.from
            ? new SelectionRange(drag.origin.to, Math.min(unit.from, drag.origin.from))
            : new SelectionRange(drag.origin.from, Math.max(unit.to, drag.origin.to))
      }
      ranges = [range]
    }
    const all = [...drag.base, ...ranges]
    const selection = EditorSelection.create(all, drag.base.length + (drag.mode === 'column' ? ranges.length - 1 : 0))
    if (!selection.eq(state.selection)) view.dispatch({ selection, origin: 'select' })
  }

  private columnRanges(drag: Drag, clientX: number, line: number): SelectionRange[] {
    const state = this.view.state
    const tabSize = state.config.tabSize
    const column = this.columnAt(clientX)
    const [first, last] = drag.line <= line ? [drag.line, line] : [line, drag.line]
    const ranges: SelectionRange[] = []
    for (let number = first; number <= last; number++) {
      // A column selection passes over folded lines.
      if (this.view.isLineHidden(number)) continue
      const info = state.doc.line(number)
      const anchor = info.from + indexAtColumn(info.text, drag.column, tabSize)
      const head = info.from + indexAtColumn(info.text, column, tabSize)
      ranges.push(new SelectionRange(anchor, head))
    }
    // The line the pointer is on is the main range.
    return drag.line <= line ? ranges : ranges.reverse()
  }

  /** Scrolls while the pointer is held outside the text area, and keeps the selection following it. */
  private autoscroll(): void {
    const rect = this.view.scroller.getBoundingClientRect()
    const dy = this.last.y < rect.top + SCROLL_EDGE ? this.last.y - rect.top - SCROLL_EDGE : this.last.y > rect.bottom - SCROLL_EDGE ? this.last.y - rect.bottom + SCROLL_EDGE : 0
    const dx = this.last.x < rect.left + SCROLL_EDGE ? this.last.x - rect.left - SCROLL_EDGE : this.last.x > rect.right - SCROLL_EDGE ? this.last.x - rect.right + SCROLL_EDGE : 0
    if (!dx && !dy) {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = 0
      }
      return
    }
    if (this.timer) return
    this.timer = window.setInterval(() => {
      if (!this.drag) return
      const box = this.view.scroller.getBoundingClientRect()
      const y = this.last.y < box.top + SCROLL_EDGE ? this.last.y - box.top - SCROLL_EDGE : this.last.y > box.bottom - SCROLL_EDGE ? this.last.y - box.bottom + SCROLL_EDGE : 0
      const x = this.last.x < box.left + SCROLL_EDGE ? this.last.x - box.left - SCROLL_EDGE : this.last.x > box.right - SCROLL_EDGE ? this.last.x - box.right + SCROLL_EDGE : 0
      if (!x && !y) return
      this.view.scroller.scrollTop += Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, y / 2))
      this.view.scroller.scrollLeft += Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, x / 2))
      this.apply(this.last.x, this.last.y)
    }, 24)
  }

  private contextMenu(event: MouseEvent): void {
    if (this.ignored(event)) return
    event.preventDefault()
    const view = this.view
    const pos = view.posAtCoords(event.clientX, event.clientY)
    const inside = view.state.selection.ranges.some((range) => range.from <= pos && pos <= range.to && !range.empty)
    if (!inside) view.dispatch({ selection: EditorSelection.cursor(pos), origin: 'select' })
    view.focus()
    view.emit('contextmenu', { x: event.clientX, y: event.clientY, pos })
  }

  destroy(): void {
    this.end()
  }
}
