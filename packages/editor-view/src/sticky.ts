import { EditorSelection, leadingWhitespace } from '@encode/editor'
import { fillLine } from './line'
import type { EditorView } from './view'

/** The most lines pinned at once. */
export const STICKY_MAX = 5
/** Characters of a pinned line drawn; a longer one is cut (it is a heading, not the place to read it). */
const STICKY_CHARS = 400

interface Row {
  line: number
  dom: HTMLDivElement
  number: HTMLDivElement
  text: HTMLDivElement
  /** What the text was drawn from, so it is drawn again only when that changes. */
  drawn: { text: string; tokens: readonly number[] } | null
}

/**
 * Sticky scroll: the first lines of the blocks the top of the view is in (a class, then its method, then a loop in
 * it) stay pinned above the text, so the person always sees where they are. The blocks are the fold ranges. As a
 * block's end scrolls up, its line is pushed up with it. A click on a pinned line goes to it.
 */
export class StickyController {
  readonly dom: HTMLDivElement
  private rows: Row[] = []
  private shown: number[] = []
  private push = 0

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div')
    this.dom.className = 'enc-sticky'
    this.dom.setAttribute('aria-hidden', 'true')
    this.dom.hidden = true
    view.root.append(this.dom)
    view.listen(this.dom, 'mousedown', (event) => this.down(event))
    view.listen(this.dom, 'wheel', (event) => this.wheel(event), { passive: false })
  }

  /** The pinned lines' total height, which reveals keep clear of. */
  get height(): number {
    return this.shown.length * this.view.metrics.lineHeight + this.push
  }

  /** The lines pinned now, outermost first. */
  get lines(): readonly number[] {
    return this.shown
  }

  /** Works out the lines to pin for the scroll position and draws them. Cheap when nothing changed. */
  update(): void {
    const view = this.view
    const lines = view.options.stickyScroll && view.options.folding ? this.compute() : []
    this.shown = lines.map((entry) => entry.line)
    this.push = lines.length ? lines[lines.length - 1].push : 0
    if (!lines.length) {
      if (!this.dom.hidden) this.dom.hidden = true
      return
    }
    this.dom.hidden = false
    const { lineHeight } = view.metrics
    const gutter = view.gutterWidthPx
    this.dom.style.width = `${view.textAreaWidth + gutter}px`
    this.dom.style.height = `${Math.max(0, lines.length * lineHeight + this.push)}px`
    while (this.rows.length < lines.length) this.rows.push(this.makeRow())
    while (this.rows.length > lines.length) this.rows.pop()!.dom.remove()
    const scrollLeft = view.scrollLeftInDoc
    lines.forEach((entry, index) => {
      const row = this.rows[index]
      row.line = entry.line
      const top = index * lineHeight + (index === lines.length - 1 ? entry.push : 0)
      row.dom.style.top = `${top}px`
      row.dom.style.zIndex = String(STICKY_MAX - index)
      row.number.style.width = `${gutter}px`
      const label = view.options.lineNumbers ? String(entry.line) : ''
      if (row.number.textContent !== label) row.number.textContent = label
      const info = view.state.doc.line(entry.line)
      const text = info.text.length > STICKY_CHARS ? info.text.slice(0, STICKY_CHARS) : info.text
      const { tokens } = view.lineTokens(entry.line)
      if (!row.drawn || row.drawn.text !== text || row.drawn.tokens !== tokens) {
        fillLine(row.text, text, tokens, 0, text.length)
        row.drawn = { text, tokens }
      }
      row.text.style.transform = `translateX(${-scrollLeft}px)`
    })
  }

  /** The lines to pin, outermost first, with how far the last is pushed up (zero or less). */
  private compute(): { line: number; push: number }[] {
    const view = this.view
    const { lineHeight } = view.metrics
    const viewport = view.viewportHeight
    // Pinned lines never take more than a third of the view.
    const max = Math.min(STICKY_MAX, Math.floor(viewport / lineHeight / 3))
    if (max < 1) return []
    const top = view.scrollTopInDoc
    let chosen: { start: number; end: number }[] = []
    for (let depth = 0; depth < max; depth++) {
      // The line just under the lines pinned so far: the blocks it is in are what those lines should be.
      const line = view.lineAtDocY(top + depth * lineHeight)
      const chain = view.folding.enclosing(line, max).filter((range) => view.lineTop(range.start) < top + depth * lineHeight)
      if (chain.length <= depth) break
      // A chain that no longer agrees with the lines above (that block ended) stops here.
      if (chosen.some((range, index) => chain[index].start !== range.start)) break
      chosen = chain.slice(0, depth + 1)
    }
    if (!chosen.length) return []
    // Blank first lines are no headings; keep the rest.
    chosen = chosen.filter((range) => leadingWhitespace(view.state.doc.line(range.start).text).length < view.state.doc.line(range.start).text.length)
    return chosen.map((range, index) => {
      // The block's last line is about to leave: its heading is pushed up with it.
      const bottom = view.lineTop(range.end) + lineHeight - top
      return { line: range.start, push: Math.min(0, bottom - (index + 1) * lineHeight) }
    }).filter((entry, index, all) => index < all.length - 1 || entry.push > -lineHeight)
  }

  private makeRow(): Row {
    const dom = document.createElement('div')
    dom.className = 'enc-sticky-row'
    const number = document.createElement('div')
    number.className = 'enc-sticky-num'
    const clip = document.createElement('div')
    clip.className = 'enc-sticky-clip'
    const text = document.createElement('div')
    text.className = 'enc-sticky-text'
    clip.append(text)
    dom.append(number, clip)
    this.dom.append(dom)
    return { line: 0, dom, number, text, drawn: null }
  }

  /** A click on a pinned line puts the cursor on it and scrolls it to where it was pinned. */
  private down(event: MouseEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    const row = this.rows.find((candidate) => candidate.dom.contains(event.target as Node))
    if (!row) return
    const view = this.view
    const index = this.rows.indexOf(row)
    const info = view.state.doc.line(row.line)
    const pos = info.from + leadingWhitespace(info.text).length
    view.dispatch({ selection: EditorSelection.cursor(pos), origin: 'select.pointer' })
    view.scrollToDocY(view.lineTop(row.line) - index * view.metrics.lineHeight)
    view.focus()
  }

  /** The wheel over the pinned lines scrolls the text under them. */
  private wheel(event: WheelEvent): void {
    if (event.ctrlKey) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? this.view.metrics.lineHeight : event.deltaMode === 2 ? this.view.viewportHeight : 1
    this.view.scrollBy(event.deltaY * unit)
    this.view.scroller.scrollLeft += event.deltaX * unit
  }

  stateReplaced(): void {
    for (const row of this.rows) row.drawn = null
  }

  destroy(): void {
    this.dom.remove()
  }
}
