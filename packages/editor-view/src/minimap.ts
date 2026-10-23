import { T, TOKEN_NAMES } from '@encode/editor'
import type { LineSpec, MarkSpec } from './decorations'
import { KIND_MASK, TOKEN_CLASSES } from './line'
import type { EditorView } from './view'

/** The minimap's width in CSS pixels, and the columns of text it draws (one pixel each). */
export const MINIMAP_WIDTH = 92
const COLUMNS = 84
const PADDING_LEFT = 6
/** The height of one line in it, in CSS pixels. */
const ROW = 2
/** The text area must keep at least this much room for the minimap to show. */
const MIN_TEXT_WIDTH = 420

/**
 * A small picture of the document beside the text: each line two pixels high, each character a pixel wide, coloured
 * as highlighted, with the selection, search matches, problems and changes marked. A slider shows the part in view;
 * dragging it or clicking the map scrolls there. Folded lines are left out, as in the text. Drawn on a canvas, only
 * the lines the map shows, and only when what it shows changed.
 */
export class MinimapController {
  readonly dom: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly slider: HTMLDivElement
  private context: CanvasRenderingContext2D | null = null
  private shownWidth = 0
  /** Colours by token kind, and the overview colours of decoration classes, read from the theme. */
  private palette: { tokens: string[]; fg: string; selection: string; overview: Map<string, string | null> } | null = null
  private probe: HTMLSpanElement | null = null
  private drawnKey = ''
  private drag: { startY: number; startTop: number; ratio: number } | null = null
  private observer: MutationObserver | null = null

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div')
    this.dom.className = 'enc-minimap'
    this.dom.setAttribute('aria-hidden', 'true')
    this.dom.hidden = true
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'enc-minimap-canvas'
    this.slider = document.createElement('div')
    this.slider.className = 'enc-minimap-slider'
    this.dom.append(this.canvas, this.slider)
    view.root.append(this.dom)
    view.listen(this.dom, 'mousedown', (event) => this.down(event))
    view.listen(this.dom, 'wheel', (event) => this.wheel(event), { passive: false })
    // A theme change recolours the map.
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      this.observer = new MutationObserver(() => this.invalidateColors())
      this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      view.addDisposer(() => this.observer?.disconnect())
    }
  }

  /** The width the minimap takes from the text area: zero while it is off or the editor is too narrow for it. */
  widthFor(viewportWidth: number, gutterWidth: number): number {
    if (!this.view.options.minimap) return 0
    return viewportWidth - gutterWidth - MINIMAP_WIDTH >= MIN_TEXT_WIDTH ? MINIMAP_WIDTH : 0
  }

  /** Lays the map out for this width (from `widthFor`) and draws it if anything it shows changed. */
  update(width: number): void {
    this.shownWidth = width
    if (!width) {
      if (!this.dom.hidden) this.dom.hidden = true
      return
    }
    const view = this.view
    const scroller = view.scroller
    const height = scroller.clientHeight
    const scrollbar = scroller.offsetWidth - scroller.clientWidth
    this.dom.hidden = false
    this.dom.style.right = `${scrollbar}px`
    this.dom.style.width = `${width}px`
    this.dom.style.height = `${height}px`

    const layout = this.layout(height)
    this.slider.style.top = `${layout.sliderTop}px`
    this.slider.style.height = `${layout.sliderHeight}px`

    const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const key = [width, height, ratio, layout.firstRow, layout.rows, view.state.doc.length, view.state.version, view.state.selection.ranges.map((range) => `${range.anchor}:${range.head}`).join(','), view.decorationsVersion, view.highlightFrontier, this.palette ? 1 : 0, layout.hiddenKey].join('|')
    if (key === this.drawnKey) return
    this.drawnKey = key
    this.draw(width, height, ratio, layout.firstRow, layout.rows)
  }

  /** Which visible rows the map shows, and where the slider is over them. */
  private layout(height: number): { firstRow: number; rows: number; sliderTop: number; sliderHeight: number; hiddenKey: string } {
    const view = this.view
    const heights = view.heightMap
    const total = heights.lineCount - heights.hiddenCount
    const capacity = Math.max(1, Math.floor(height / ROW))
    const { lineHeight } = view.metrics
    const top = view.scrollTopInDoc
    const maxTop = Math.max(0, heights.contentHeight - view.viewportHeight)
    const progress = maxTop > 0 ? Math.min(1, Math.max(0, top / maxTop)) : 0
    const firstRow = total > capacity ? Math.round((total - capacity) * progress) : 0
    const viewRow = this.rowOf(view.lineAtDocY(top))
    const sliderHeight = Math.max(4, Math.round((view.viewportHeight / lineHeight) * ROW))
    const sliderTop = (viewRow - firstRow) * ROW + ((top - view.lineTop(view.lineAtDocY(top))) / lineHeight) * ROW
    const hiddenKey = heights.hidden.map((range) => `${range.from}-${range.to}`).join(',')
    return { firstRow, rows: Math.min(capacity, total - firstRow), sliderTop: Math.max(0, sliderTop), sliderHeight, hiddenKey }
  }

  /** The visible row (0-based) of a line that shows. */
  private rowOf(line: number): number {
    return line - 1 - this.view.heightMap.hiddenBefore(line)
  }

  /** The line shown on visible row `row`. */
  private lineOfRow(row: number): number {
    let line = row + 1
    for (const range of this.view.heightMap.hidden) {
      if (range.from > line) break
      line += range.to - range.from + 1
    }
    return line
  }

  private draw(width: number, height: number, ratio: number, firstRow: number, rows: number): void {
    const canvas = this.canvas
    const deviceWidth = Math.round(width * ratio)
    const deviceHeight = Math.round(height * ratio)
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth
      canvas.height = deviceHeight
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    const context = (this.context ??= canvas.getContext('2d'))
    if (!context) return
    const palette = this.colors()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, deviceWidth, deviceHeight)
    if (rows <= 0) return
    const view = this.view
    const doc = view.state.doc
    const tabSize = view.state.config.tabSize
    const rowDevice = Math.max(1, Math.round(ROW * ratio))
    const block = Math.max(1, Math.round(ROW * ratio * 0.7))
    const charDevice = Math.max(1, ratio)
    const left = Math.round(PADDING_LEFT * ratio)
    const heights = view.heightMap

    const firstLine = this.lineOfRow(firstRow)
    let lastLine = firstLine
    const lines: number[] = []
    for (let line = firstLine, row = 0; row < rows && line <= doc.lineCount; line = heights.nextVisible(line + 1), row++) {
      lines.push(line)
      lastLine = line
    }

    // Behind the text: changed lines, the selection's lines.
    const lineSpecs: LineSpec[] = []
    view.collectLines(firstLine, lastLine, lineSpecs)
    const rowOfLine = new Map(lines.map((line, index) => [line, index]))
    for (const spec of lineSpecs) {
      const index = rowOfLine.get(spec.line)
      const colour = index === undefined ? null : this.overview(spec.className)
      if (!colour) continue
      context.fillStyle = colour
      context.globalAlpha = 0.45
      context.fillRect(0, index! * rowDevice, deviceWidth, rowDevice)
    }
    context.globalAlpha = 1
    context.fillStyle = palette.selection
    for (const range of view.state.selection.ranges) {
      if (range.empty) continue
      const from = doc.lineAt(range.from).number
      const to = doc.lineAt(range.to).number
      for (let line = Math.max(from, firstLine); line <= Math.min(to, lastLine); line = heights.nextVisible(line + 1)) {
        const index = rowOfLine.get(line)
        if (index !== undefined) context.fillRect(0, index * rowDevice, deviceWidth, rowDevice)
      }
    }

    // The text, as blocks coloured by token.
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const text = doc.line(line).text
      if (!text) continue
      const { tokens } = view.lineTokens(line)
      const y = index * rowDevice + Math.floor((rowDevice - block) / 2)
      let column = 0
      let token = 0
      let kind: number = T.plain
      let next = tokens.length ? tokens[0] : Infinity
      let runStart = -1
      let runColour = ''
      const flush = (end: number) => {
        if (runStart < 0) return
        context.fillStyle = runColour
        context.fillRect(left + runStart * charDevice, y, (end - runStart) * charDevice, block)
        runStart = -1
      }
      for (let offset = 0; offset < text.length && column < COLUMNS; offset++) {
        while (offset >= next) {
          kind = tokens[token + 1] & KIND_MASK
          token += 2
          next = token < tokens.length ? tokens[token] : Infinity
        }
        const code = text.charCodeAt(offset)
        if (code === 9) {
          flush(column)
          column += tabSize - (column % tabSize)
          continue
        }
        if (code === 32) {
          flush(column)
          column++
          continue
        }
        const colour = palette.tokens[kind] ?? palette.fg
        if (runStart >= 0 && colour !== runColour) flush(column)
        if (runStart < 0) {
          runStart = column
          runColour = colour
        }
        column++
      }
      flush(Math.min(column, COLUMNS))
    }

    // Over the text: search matches and problems, where they are on their line.
    const marks: MarkSpec[] = []
    view.collectMarks(doc.line(firstLine).from, doc.line(lastLine).to, marks)
    let budget = 2000
    for (const mark of marks) {
      if (budget-- <= 0) break
      const colour = this.overview(mark.className)
      if (!colour) continue
      const line = doc.lineAt(mark.from)
      const index = rowOfLine.get(line.number)
      if (index === undefined) continue
      const start = Math.min(COLUMNS, mark.from - line.from)
      const end = Math.min(COLUMNS, Math.max(start + 1, Math.min(line.to, mark.to) - line.from))
      context.fillStyle = colour
      context.fillRect(left + start * charDevice, index * rowDevice, Math.max(charDevice * 2, (end - start) * charDevice), rowDevice)
    }
  }

  /** The colours of the theme, read once and again after a theme change. */
  private colors(): NonNullable<MinimapController['palette']> {
    if (this.palette) return this.palette
    const probe = this.probeEl()
    const tokens = TOKEN_NAMES.map((_, kind) => {
      probe.className = TOKEN_CLASSES[kind]
      return getComputedStyle(probe).color
    })
    probe.className = ''
    const style = getComputedStyle(this.view.root)
    const fg = style.color
    const selection = style.getPropertyValue('--e-selection').trim() || 'rgba(88, 129, 255, 0.3)'
    this.palette = { tokens, fg, selection, overview: new Map() }
    return this.palette
  }

  /** The colour a decoration class asks the map to draw it with (its --enc-overview), or null when it asks for none. */
  private overview(className: string): string | null {
    const palette = this.colors()
    const known = palette.overview.get(className)
    if (known !== undefined) return known
    const probe = this.probeEl()
    probe.className = className
    const value = getComputedStyle(probe).getPropertyValue('--enc-overview').trim()
    probe.className = ''
    const colour = value || null
    palette.overview.set(className, colour)
    return colour
  }

  private probeEl(): HTMLSpanElement {
    if (!this.probe) {
      this.probe = document.createElement('span')
      this.probe.className = ''
      this.probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
      this.dom.append(this.probe)
    }
    return this.probe
  }

  invalidateColors(): void {
    this.palette = null
    this.drawnKey = ''
    this.view.requestRender()
  }

  // ----------------------------------------------------------------- the pointer

  private down(event: MouseEvent): void {
    if (event.button !== 0 || !this.shownWidth) return
    event.preventDefault()
    const view = this.view
    const box = this.dom.getBoundingClientRect()
    const y = event.clientY - box.top
    const height = view.scroller.clientHeight
    const layout = this.layout(height)
    const onSlider = y >= layout.sliderTop && y <= layout.sliderTop + layout.sliderHeight
    if (!onSlider) {
      // A click on the map centres the view on the line clicked.
      const row = Math.min(layout.firstRow + layout.rows - 1, layout.firstRow + Math.max(0, Math.floor(y / ROW)))
      const line = this.lineOfRow(row)
      view.scrollToDocY(view.lineTop(line) - (view.viewportHeight - view.metrics.lineHeight) / 2)
    }
    // Then the slider follows the pointer until the button is let go.
    const heights = view.heightMap
    const total = heights.lineCount - heights.hiddenCount
    const travel = Math.max(1, Math.min(height, total * ROW) - layout.sliderHeight)
    const maxTop = Math.max(0, heights.contentHeight - view.viewportHeight)
    this.drag = { startY: event.clientY, startTop: view.scrollTopInDoc, ratio: maxTop / travel }
    this.dom.classList.add('enc-minimap-dragging')
    window.addEventListener('mousemove', this.move, true)
    window.addEventListener('mouseup', this.up, true)
  }

  private readonly move = (event: MouseEvent): void => {
    if (!this.drag) return
    if (event.buttons === 0) return this.up()
    this.view.scrollToDocY(this.drag.startTop + (event.clientY - this.drag.startY) * this.drag.ratio)
  }

  private readonly up = (): void => {
    this.drag = null
    this.dom.classList.remove('enc-minimap-dragging')
    window.removeEventListener('mousemove', this.move, true)
    window.removeEventListener('mouseup', this.up, true)
  }

  private wheel(event: WheelEvent): void {
    if (event.ctrlKey) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? this.view.metrics.lineHeight : event.deltaMode === 2 ? this.view.viewportHeight : 1
    this.view.scrollBy(event.deltaY * unit)
  }

  destroy(): void {
    this.up()
    this.observer?.disconnect()
    this.dom.remove()
  }
}
