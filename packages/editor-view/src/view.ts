import {
  EditorSelection,
  EditorState,
  Highlighter,
  SelectionRange,
  T,
  Transaction,
  bracketAt,
  carryColumnIndexes,
  columnAt,
  forgetColumnIndexes,
  indentWidth,
  indexAtColumn,
  languageById,
  leadingWhitespace,
  nextCluster,
  previousCluster,
  unitWidth,
  MAX_BATCH_LINES,
  type HighlightResult,
  type HighlightService,
  type TransactionSpec,
} from '@encode/editor'
import type { ChangeSet, Line } from '@encode/text'
import { viewCommands, type ViewCommand } from './commands'
import type { DecorationSource, LineSpec, MarkSpec } from './decorations'
import { FindController } from './find'
import { FOLD_COLUMN, FoldController } from './folding'
import { HeightMap, ScrollScale, sameHidden, type HiddenLines, type Zone } from './heights'
import { InputHandler } from './input'
import { Keymap, defaultBindings, isMac, type KeyBinding } from './keymap'
import { DEPRECATED, fillLine, fillRows, hasRtl, isSimpleText, isolatesOf, withBrackets, withSemantic, type DrawnInlay, type InlaySpec, type SemanticSpan } from './line'
import { LineItems } from './line-items'
import { MinimapController } from './minimap'
import { PointerHandler } from './pointer'
import { RectPool } from './rects'
import { ReviewController } from './review-view'
import { SnippetController } from './snippet'
import { StickyController } from './sticky'
import { MIN_WRAP_WIDTH, WrapLayout, rowEnd, rowOf, rowStart, sameSpec, type LineWrap, type WrapSpec } from './wrap'

/** Lines longer than this are drawn in part: the piece around the viewport. */
export const LONG_LINE = 4000
/** Characters kept on either side of the viewport in a long line. */
const LONG_MARGIN = 800
/** The widest the scrollable area is made, in pixels; a wider text is scrolled through a scaled range, as a tall one is. */
const MAX_CONTENT_WIDTH = 16_000_000
/**
 * In a text wider than that, the layers are drawn from a left edge (`originX`) on this grid at least this far left of
 * the view, so that the pixel offsets in the DOM stay small.
 */
const ORIGIN_STEP_X = 1_000_000
const ORIGIN_MARGIN_X = 100_000
/** The furthest a line's text is shifted left of its box to bring a far part of the line into view. */
const MAX_SHIFT = 30_000_000
const PROBE_CHARS = 200
/** A line draws at most this many hints; a server that sends more for one line is not giving hints. */
const MAX_INLAYS_PER_LINE = 50
/** The largest kind a semantic token can be drawn as: a token kind with the flags above it. */
const KIND_LIMIT = 0xfff
const NO_BRACKETS: readonly number[] = []
const GUTTER_PAD_LEFT = 14
const GUTTER_PAD_RIGHT = 12
/** Documents up to this many lines are scanned once for their longest line. */
const SCAN_LIMIT = 50_000
/** Lines in the first batch for the highlighting thread, and after each edit. */
const FIRST_BATCH = 256
/** A wrapped line of more rows than this is drawn in part: the rows around the view. */
const MAX_DRAWN_ROWS = 240
/** Rows kept drawn past the view in such a line. */
const ROW_MARGIN = 60
/** The breaks of a line drawn in one row. */
const ONE_ROW: LineWrap = { breaks: [], indent: 0 }
/** Languages of prose rather than code: with `bidi`, all their text but inline code reads in its own order. */
const PROSE = new Set(['plaintext', 'markdown'])
const NO_ISOLATES: [number, number][] = []
/** A letter: of a left-to-right script, unless `hasRtl` says otherwise. */
const LETTER = /\p{L}/u

export interface EditorViewConfig {
  state: EditorState
  /** The element the editor is added to; without one the host appends `view.root` itself. */
  parent?: HTMLElement
  lineNumbers?: boolean
  indentGuides?: boolean
  highlightActiveLine?: boolean
  /** Lets the last line scroll up the viewport. Default true. */
  scrollBeyondEnd?: boolean
  cursorStyle?: 'line' | 'block' | 'underline'
  cursorBlink?: boolean
  /** Programming ligatures in the font. Default off: carets and selections stay on character cells. */
  ligatures?: boolean
  ariaLabel?: string
  /** Bindings that take precedence over the defaults. */
  bindings?: readonly KeyBinding[]
  /** Commands by name, for bindings; they override the built-in ones of the same name. */
  commands?: Readonly<Record<string, ViewCommand>>
  /** Overrides platform detection, for tests: "MacIntel", "Win32". */
  platform?: string
  /** Blocks fold, with chevrons in the gutter. Default true. */
  folding?: boolean
  /** The first lines of the blocks the top of the view is in stay pinned above the text. Default false. */
  stickyScroll?: boolean
  /** Brackets are coloured by how deeply they nest. Default false. */
  bracketColors?: boolean
  /** A small picture of the document beside the text, with a slider for the part in view. Default false. */
  minimap?: boolean
  /**
   * Tokenizes the document on another thread (a worker), so reading a large file through costs the page next to
   * nothing; the view still tokenizes the lines it draws near what is known. Without it, or once it fails, the view
   * tokenizes ahead in idle time.
   */
  highlighting?: HighlightService | null
  /**
   * Long lines break into rows that fit the text area ('on'), or the text area and `wrapColumn`, whichever is
   * narrower ('bounded'), and nothing scrolls sideways; or into rows of `wrapColumn` columns however wide the text area
   * is ('column'). Default 'off'.
   */
  wordWrap?: 'off' | 'on' | 'bounded' | 'column'
  /** The column 'bounded' and 'column' wrap at. Default 80. */
  wrapColumn?: number
  /** The rows after a line's first are indented as the line is (unless that takes more than half the row). Default true. */
  wrapIndent?: boolean
  /**
   * Spaces and tabs drawn as faint marks: 'all' of them, those at either end of a line and runs between words
   * ('boundary'), those at the end of a line ('trailing'), those in a selection ('selection'), or none. Default 'none'.
   */
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  /**
   * Works with a screen reader: the field the keyboard types into holds the lines around the main cursor and the
   * selection, so the screen reader reads the character, word or line the cursor moves over and what is selected. The
   * host turns it on when a screen reader is running or the user asks for it. Default false.
   */
  screenReader?: boolean
  /** Tab and Shift+Tab move the focus out of the editor instead of indenting; Ctrl+M turns it on and off. Default false. */
  tabMovesFocus?: boolean
  /**
   * Right-to-left text (Hebrew, Arabic and the like) in strings and comments, and in prose (plain text, Markdown), is
   * shown in reading order, each string or comment on its own so that it cannot move the code around it. Code stays
   * in the order it is stored and bidi controls stay markers, so what runs is what shows. Default false: every line in
   * stored order.
   */
  bidi?: boolean
}

type Options = Required<
  Pick<
    EditorViewConfig,
    | 'lineNumbers'
    | 'indentGuides'
    | 'highlightActiveLine'
    | 'scrollBeyondEnd'
    | 'cursorStyle'
    | 'cursorBlink'
    | 'ligatures'
    | 'ariaLabel'
    | 'folding'
    | 'stickyScroll'
    | 'bracketColors'
    | 'minimap'
    | 'wordWrap'
    | 'wrapColumn'
    | 'wrapIndent'
    | 'renderWhitespace'
    | 'screenReader'
    | 'tabMovesFocus'
    | 'bidi'
  >
>

export interface ViewZone {
  /** Lines above the zone (0: before the first line). The view keeps the zone attached to that line through edits. */
  after: number
  height: number
  /** The zone's content. The view sizes and places it. */
  dom: HTMLElement
  /**
   * Spans the part of the text in sight and stays put when the text scrolls sideways: a panel between the lines (a
   * peek), not more text. Without it the zone is as wide as the longest line and scrolls with the text.
   */
  fixed?: boolean
}

export interface ViewEvents {
  /** After a transaction was applied. */
  transaction: (tr: Transaction) => void
  /** The scroll position or the size of the editor changed. */
  viewport: () => void
  focus: () => void
  blur: () => void
  /** The pointer asked for a context menu at `pos`. */
  contextmenu: (event: { x: number; y: number; pos: number }) => void
  /** A key binding named a command the view does not run itself (goto line): the host handles it. */
  request: (name: string) => void
  /** Ctrl/Cmd+click at `pos`. */
  navigate: (event: { pos: number; modifiers: { shift: boolean; alt: boolean } }) => void
  /** Blocks were folded or unfolded: a host keeps `folding.folded` to fold them again when the file comes back. */
  folds: () => void
}

interface LineEl {
  dom: HTMLDivElement
  number: HTMLDivElement | null
  line: number
  text: string
  tokens: readonly number[] | null
  top: number
  simple: boolean
  /** The part of a long line in the DOM; the whole line when it is short. */
  from: number
  to: number
  exact: boolean
  /** The hints it was drawn with, and where they were drawn. */
  inlays: readonly InlaySpec[] | undefined
  drawnInlays: readonly DrawnInlay[]
  /** The breaks it was drawn with when it wraps, and the rows of it in the DOM (all of them unless it has very many). */
  wrap: LineWrap | null
  rowFrom: number
  rowTo: number
  /** The stretches its spaces and tabs were marked in, as a key. */
  whitespace: string
  /** The stretches shown in reading order (`isolatesOf`), as a key; empty when the line is all in stored order. */
  isolates: string
}

interface ZoneEntry {
  owner: string
  zone: ViewZone
  id: number
  pos: number
  atStart: boolean
  after: number
}

export interface ViewMetrics {
  charWidth: number
  lineHeight: number
  /** Text starts this far from a line's left edge. */
  paddingX: number
  /** False when the font is not monospace: positions are then always measured. */
  monospace: boolean
}

const SHORT = 0.6

/** Device pixels per CSS pixel: the screen's scale (125% on Windows is 1.25) times the page's zoom. */
function pixelRatio(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
}

function sameTokens(a: readonly number[] | null, b: readonly number[]): boolean {
  if (a === b) return true
  if (!a || a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

export class EditorView {
  state: EditorState
  readonly root: HTMLDivElement
  readonly scroller: HTMLDivElement
  readonly textarea: HTMLTextAreaElement
  /** For widgets that stay put while the text scrolls (the find box). */
  readonly widgets: HTMLDivElement
  readonly options: Options
  readonly mac: boolean

  private readonly sizer: HTMLDivElement
  private readonly gutter: HTMLDivElement
  private readonly gutterLayer: HTMLDivElement
  /** @internal */
  readonly content: HTMLDivElement
  private readonly layer: HTMLDivElement
  private readonly linesEl: HTMLDivElement
  private readonly zonesEl: HTMLDivElement
  private readonly cursorsEl: HTMLDivElement
  private readonly probe: HTMLDivElement
  private readonly probeA: HTMLSpanElement
  private readonly probeB: HTMLSpanElement
  private readonly backgrounds: RectPool
  private readonly marksPool: RectPool
  private readonly selectionPool: RectPool
  private readonly cursorPool: RectPool
  private readonly foldPool: RectPool

  private highlighter: Highlighter
  private heights: HeightMap
  private scale: ScrollScale
  private lineEls = new Map<number, LineEl>()
  private spare: LineEl[] = []
  private sources = new Map<string, DecorationSource>()
  private zones: ZoneEntry[] = []
  private attachedZones = new Set<ViewZone>()
  private nextZoneId = 1
  private listeners = new Map<keyof ViewEvents, Set<(...args: never[]) => void>>()
  private disposers: (() => void)[] = []

  metrics: ViewMetrics = { charWidth: 8, lineHeight: 20, paddingX: 12, monospace: true }
  private readonly announcer: HTMLDivElement
  private announceTimer: ReturnType<typeof setTimeout> | null = null
  private unwatchPixelRatio: (() => void) | null = null
  /** The device pixel ratio the metrics were last read at. */
  private measuredRatio = 0
  private viewport = { width: 0, height: 0 }
  private gutterWidth = 0
  private viewWidth = -1
  private contentWidth = 0
  private maxCols = 0
  private origin = 0
  private layerTop = 0
  /** Sideways: document pixels per scroll pixel, the document x at the view's left edge, and where the layers start. */
  private hscale = new ScrollScale(0, 0, MAX_CONTENT_WIDTH)
  private docLeft = 0
  private originX = 0
  private layerLeft = 0
  private rendered: { first: number; last: number } = { first: 0, last: -1 }
  private frame = 0
  private pendingReveal: { pos: number; center: boolean } | null = null
  /** A scroll position asked for by `setState`: set once the scrollable area has the new document's size. */
  private pendingScroll: { top: number; left: number } | null = null
  private bracketCache: { version: number; head: number; pair: [number, number] | null } | null = null
  private blink: Animation | null = null
  private idleWork = 0
  private readonly highlighting: HighlightService | null
  /** A batch is out on the highlighting thread. */
  private remoteBusy = false
  /** The highlighting thread failed: the view tokenizes ahead itself from now on. */
  private remoteFailed = false
  /** Lines in the next batch: few after an edit, which usually settles within a line or two, more as reading goes on. */
  private batchLines = FIRST_BATCH
  private destroyed = false
  private focused = false
  private lastScroll = { top: -1, left: -1 }

  readonly keymap: Keymap
  readonly commands: Readonly<Record<string, ViewCommand>>
  readonly bindings: readonly KeyBinding[]
  readonly input: InputHandler
  readonly pointer: PointerHandler
  readonly find: FindController
  readonly review: ReviewController
  readonly snippet: SnippetController
  readonly folding: FoldController
  readonly sticky: StickyController
  readonly minimap: MinimapController
  /** Goes up whenever a decoration source is set or follows an edit, so the minimap knows to draw again. */
  decorationsVersion = 0
  private minimapWidth = 0
  private tokenCache = new Map<number, { base: readonly number[]; brackets: readonly number[]; semantic: readonly SemanticSpan[] | undefined; tokens: readonly number[] }>()
  /** A server's semantic tokens, by line, followed through edits until it answers again. */
  private readonly semantic = new LineItems<SemanticSpan>((span, from, to) => ({ from, to, kind: span.kind }))
  /** While long lines wrap: the rows of every line, and the breaks of the lines drawn and asked about. */
  private wrapping: WrapLayout | null = null
  /** The text at the top of the view, and how far into its row the view starts, held while rows change above it. */
  private anchor: { pos: number; offset: number } | null = null
  /**
   * Where `restoreAnchor` last put the view, and the scroll offset that came of it. While the view stays there the next
   * hold takes this text again rather than reading it back from a scroll offset rounded to whole pixels (in a large file
   * one scroll pixel is several layout pixels), so the many holds of a large file's rows settling do not drift.
   */
  private placed: { pos: number; offset: number; scrollTop: number } | null = null
  private settleWork = 0
  /** A wrapped line is drawn only in part (the rows near the view), so scrolling may need to draw again. */
  private partialRows = false
  /** The layout heights the last drawing covers, the view and its overscan. */
  private drawWindow = { top: 0, bottom: 0 }
  /** A server's inlay hints, by line, followed through edits until it answers again. */
  private readonly inlays = new LineItems<InlaySpec>((inlay, from, to) => ({ ...inlay, from, to }))
  /**
   * What an input method is composing, drawn in place at every cursor until it is committed: by line, the hints of
   * that line with the composition among them (kept while the line's own hints are the same array, so a line is not
   * drawn again for nothing).
   */
  private composition: { text: string; at: Map<number, number[]>; merged: Map<number, { hints: readonly InlaySpec[] | undefined; all: readonly InlaySpec[] }> } | null = null

  constructor(config: EditorViewConfig) {
    this.state = config.state
    this.options = {
      lineNumbers: config.lineNumbers ?? true,
      indentGuides: config.indentGuides ?? true,
      highlightActiveLine: config.highlightActiveLine ?? true,
      scrollBeyondEnd: config.scrollBeyondEnd ?? true,
      cursorStyle: config.cursorStyle ?? 'line',
      cursorBlink: config.cursorBlink ?? true,
      ligatures: config.ligatures ?? false,
      ariaLabel: config.ariaLabel ?? 'Editor',
      folding: config.folding ?? true,
      stickyScroll: config.stickyScroll ?? false,
      bracketColors: config.bracketColors ?? false,
      minimap: config.minimap ?? false,
      wordWrap: config.wordWrap ?? 'off',
      wrapColumn: config.wrapColumn ?? 80,
      wrapIndent: config.wrapIndent ?? true,
      renderWhitespace: config.renderWhitespace ?? 'none',
      screenReader: config.screenReader ?? false,
      tabMovesFocus: config.tabMovesFocus ?? false,
      bidi: config.bidi ?? false,
    }
    this.highlighting = config.highlighting ?? null
    this.mac = isMac(config.platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform))
    this.bindings = [...(config.bindings ?? []), ...defaultBindings]
    this.keymap = new Keymap(this.bindings, this.mac)
    this.commands = { ...viewCommands, ...config.commands }

    this.highlighter = this.createHighlighter()
    this.heights = new HeightMap(this.metrics.lineHeight, this.state.doc.lineCount)
    this.scale = new ScrollScale(this.heights.totalHeight, 0)

    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement) => {
      const el = document.createElement(tag)
      el.className = className
      parent?.append(el)
      return el
    }
    this.root = make('div', 'enc-editor')
    this.scroller = make('div', 'enc-scroller', this.root)
    this.sizer = make('div', 'enc-sizer', this.scroller)
    this.gutter = make('div', 'enc-gutter', this.sizer)
    this.gutterLayer = make('div', 'enc-gutter-layer', this.gutter)
    this.content = make('div', 'enc-content', this.sizer)
    this.layer = make('div', 'enc-layer', this.content)
    const backgrounds = make('div', 'enc-bg', this.layer)
    const marks = make('div', 'enc-marks', this.layer)
    const selection = make('div', 'enc-selection', this.layer)
    this.linesEl = make('div', 'enc-lines', this.layer)
    const folds = make('div', 'enc-folds', this.layer)
    this.zonesEl = make('div', 'enc-zones', this.layer)
    this.cursorsEl = make('div', 'enc-cursors', this.layer)
    this.textarea = make('textarea', 'enc-input', this.layer)
    this.widgets = make('div', 'enc-widgets', this.root)
    // What a screen reader says when something happens that the text does not show (a fold, a count of cursors).
    this.announcer = make('div', 'enc-announce', this.root)
    this.announcer.setAttribute('aria-live', 'polite')
    this.announcer.setAttribute('aria-atomic', 'true')
    this.probe = make('div', 'enc-probe', this.root)
    this.probeA = make('span', 'enc-probe-a', make('div', 'enc-probe-row', this.probe))
    this.probeB = make('span', 'enc-probe-b', make('div', 'enc-probe-row', this.probe))
    this.probeA.textContent = 'x'.repeat(PROBE_CHARS)
    this.probeB.textContent = 'i'.repeat(PROBE_CHARS)
    this.backgrounds = new RectPool(backgrounds, 'enc-rect')
    this.marksPool = new RectPool(marks, 'enc-rect')
    this.selectionPool = new RectPool(selection, 'enc-rect enc-selection-rect')
    this.cursorPool = new RectPool(this.cursorsEl, 'enc-cursor')
    this.foldPool = new RectPool(folds, 'enc-fold-pill')

    this.root.dataset.encEditor = ''
    this.scroller.tabIndex = -1
    this.textarea.setAttribute('aria-label', this.options.ariaLabel)
    this.textarea.setAttribute('aria-multiline', 'true')
    this.textarea.setAttribute('role', 'textbox')
    this.textarea.setAttribute('autocomplete', 'off')
    this.textarea.setAttribute('autocorrect', 'off')
    this.textarea.setAttribute('autocapitalize', 'off')
    this.textarea.spellcheck = false
    this.root.classList.toggle('enc-ligatures', this.options.ligatures)
    this.root.classList.toggle('enc-readonly', this.state.config.readOnly)
    this.root.classList.toggle('enc-no-numbers', !this.options.lineNumbers)
    this.root.classList.toggle('enc-folding', this.options.folding)
    this.root.style.setProperty('--enc-tab-size', String(this.state.config.tabSize))

    this.input = new InputHandler(this)
    this.pointer = new PointerHandler(this)
    this.find = new FindController(this)
    this.review = new ReviewController(this)
    this.snippet = new SnippetController(this)
    this.folding = new FoldController(this)
    this.sticky = new StickyController(this)
    this.minimap = new MinimapController(this)

    this.listen(this.scroller, 'scroll', () => this.onScroll(), { passive: true })
    this.listen(this.scroller, 'wheel', (event) => this.onWheel(event), { passive: false })
    this.listen(this.textarea, 'focus', () => this.setFocused(true))
    this.listen(this.textarea, 'blur', () => this.setFocused(false))
    // The editor's own size: drawn in the callback, which runs after layout and before paint, so a resized or newly shown editor never has a blank frame.
    // (The scroller is watched for its scrollbars appearing, which drawing itself can cause, so that one only asks for the next frame.)
    const resize = new ResizeObserver(() => this.onResize(true))
    resize.observe(this.root)
    const inner = new ResizeObserver(() => this.onResize(false))
    inner.observe(this.scroller)
    this.disposers.push(() => resize.disconnect(), () => inner.disconnect())
    const probeObserver = new ResizeObserver(() => this.onProbeResize())
    probeObserver.observe(this.probeA)
    probeObserver.observe(this.probeB)
    probeObserver.observe(this.probeA.parentElement!)
    this.disposers.push(() => probeObserver.disconnect())
    if (typeof document !== 'undefined' && document.fonts) {
      const fonts = () => this.onProbeResize()
      document.fonts.addEventListener('loadingdone', fonts)
      this.disposers.push(() => document.fonts.removeEventListener('loadingdone', fonts))
    }
    this.watchPixelRatio()
    this.disposers.push(() => this.unwatchPixelRatio?.())

    if (config.parent) config.parent.append(this.root)
    this.measure()
    this.readViewport()
    this.input.syncMirror()
    this.scanLongestLine()
    this.scheduleIdleWork()
    this.requestRender()
  }

  // ----------------------------------------------------------------- events

  on<K extends keyof ViewEvents>(name: K, listener: ViewEvents[K]): () => void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    set.add(listener)
    return () => void set.delete(listener)
  }

  /** @internal */
  emit<K extends keyof ViewEvents>(name: K, ...args: Parameters<ViewEvents[K]>): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of [...set]) {
      // A listener that fails is reported, and the others still hear the event: a language server's copy of the
      // document and the file's saved mark stay in step even when another feature has a fault.
      try {
        ;(listener as (...a: Parameters<ViewEvents[K]>) => void)(...args)
      } catch (error) {
        reportError(error)
      }
    }
  }

  /** @internal */
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler as EventListener, options)
    this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options))
  }

  /** @internal */
  addDisposer(dispose: () => void): void {
    this.disposers.push(dispose)
  }

  // ----------------------------------------------------------------- state

  /** Applies a transaction made from the current state, or a description of one. */
  dispatch(spec: Transaction | TransactionSpec): Transaction {
    const tr = spec instanceof Transaction ? spec : this.state.update(spec)
    if (tr.startState !== this.state) throw new Error('The transaction was made from a state that is no longer current')
    this.apply(tr)
    return tr
  }

  private apply(tr: Transaction): void {
    const before = this.state
    this.state = tr.state
    if (tr.docChanged) {
      carryColumnIndexes(tr.changes, before.doc, tr.state.doc)
      if (this.wrapping) {
        this.wrapping.update(tr.changes, before.doc, tr.state.doc)
        this.scheduleSettle()
      }
      if (this.anchor) this.anchor.pos = tr.changes.mapPos(this.anchor.pos)
      const placed = this.placed
      if (placed) {
        // An edit before the text at the top moves it; one after leaves it where it was put.
        let before = false
        tr.changes.forEach((fromA) => {
          if (fromA < placed.pos) before = true
        })
        if (before) this.placed = null
        else placed.pos = tr.changes.mapPos(placed.pos)
      }
      this.highlighter.update(tr.changes, tr.state.doc)
      this.folding.documentChanged(tr.changes, before.doc, tr.state.doc)
      this.semantic.map(tr.changes, before.doc)
      this.inlays.map(tr.changes, before.doc)
      this.mapAfterChange(tr.changes)
      // The states below the edit may have changed (an opened comment): reading on starts again from it.
      this.batchLines = FIRST_BATCH
      this.scheduleIdleWork()
    }
    // A cursor that reached into a folded block (a search, an undo, Go to line) opens it.
    if (tr.docChanged || tr.selectionChanged) for (const range of tr.state.selection.ranges) this.folding.reveal(range.head)
    if (tr.state.config.language !== before.config.language) {
      this.highlighter.setTokenizer(tr.state.config.language.tokenizer)
      this.highlighter.setBrackets(this.options.bracketColors ? tr.state.config.language.brackets : null)
      this.tokenCache.clear()
      this.scheduleIdleWork()
    }
    if (tr.state.config.readOnly !== before.config.readOnly) this.root.classList.toggle('enc-readonly', tr.state.config.readOnly)
    if (tr.state.config.tabSize !== before.config.tabSize) this.root.style.setProperty('--enc-tab-size', String(tr.state.config.tabSize))
    if (tr.scrollIntoView) this.pendingReveal = { pos: tr.state.selection.main.head, center: false }
    if (tr.docChanged || tr.selectionChanged) this.restartBlink()
    // A screen reader reads the new text and selection at once, before the next frame is drawn.
    if (this.options.screenReader) this.input.syncMirror()
    this.requestRender()
    this.emit('transaction', tr)
  }

  /**
   * Has a screen reader say `message`, politely (after what it is saying): for what happens without the text showing
   * it where the cursor is. The same message twice is said twice.
   */
  announce(message: string): void {
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.announcer.textContent = ''
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null
      if (!this.destroyed) this.announcer.textContent = message
    }, 60)
  }

  /** Replaces the whole state (another file in the same editor), optionally restoring a scroll position. */
  setState(state: EditorState, scroll?: { top: number; left: number }): void {
    this.state = state
    this.highlighter = this.createHighlighter()
    this.batchLines = FIRST_BATCH
    this.root.classList.toggle('enc-readonly', state.config.readOnly)
    this.sources.clear()
    for (const zone of [...this.attachedZones]) this.detachZone(zone)
    this.zones = []
    this.bracketCache = null
    this.maxCols = 0
    // The rows of the new document are laid out when it is drawn.
    this.wrapping = null
    this.anchor = null
    this.placed = null
    for (const el of this.lineEls.values()) this.release(el)
    this.lineEls.clear()
    this.rendered = { first: 0, last: -1 }
    this.scanLongestLine()
    this.input.reset()
    this.find.stateReplaced()
    this.review.stateReplaced()
    this.snippet.stateReplaced()
    this.folding.stateReplaced()
    this.sticky.stateReplaced()
    this.semantic.clear()
    this.inlays.clear()
    this.tokenCache.clear()
    this.pendingReveal = null
    this.pendingScroll = scroll ?? null
    if (!scroll) {
      this.scroller.scrollTop = 0
      this.scroller.scrollLeft = 0
    }
    this.scheduleIdleWork()
    this.requestRender()
  }

  saveScroll(): { top: number; left: number } {
    return this.pendingScroll ?? { top: this.scroller.scrollTop, left: this.scroller.scrollLeft }
  }

  private createHighlighter(): Highlighter {
    const highlighter = new Highlighter(this.state.config.language.tokenizer, this.state.doc)
    highlighter.onError = (error) => console.warn('Tokenizer failed on a line; it is shown as plain text.', error)
    if (this.options?.bracketColors) highlighter.setBrackets(this.state.config.language.brackets)
    return highlighter
  }

  /**
   * The tokens line `n` is drawn with: the highlighter's, with each bracket coloured by depth when that is on. Shared
   * by the text, the pinned lines and the minimap.
   * @internal
   */
  lineTokens(n: number): { tokens: readonly number[]; exact: boolean } {
    const highlighted = this.highlighter.line(n)
    const semantic = this.semantic.line(n)
    if (!this.options.bracketColors && !semantic) return highlighted
    const { brackets, exact } = this.options.bracketColors ? this.highlighter.brackets(n) : { brackets: NO_BRACKETS, exact: true }
    if (!brackets.length && !semantic) return { tokens: highlighted.tokens, exact: highlighted.exact && exact }
    const cached = this.tokenCache.get(n)
    if (cached && cached.base === highlighted.tokens && cached.brackets === brackets && cached.semantic === semantic) return { tokens: cached.tokens, exact: highlighted.exact && exact }
    const length = this.state.doc.line(n).text.length
    let tokens = semantic ? withSemantic(highlighted.tokens, semantic, length) : highlighted.tokens
    if (brackets.length) tokens = withBrackets(tokens, brackets, length)
    if (this.tokenCache.size >= 4000) this.tokenCache.clear()
    this.tokenCache.set(n, { base: highlighted.tokens, brackets, semantic, tokens })
    return { tokens, exact: highlighted.exact && exact }
  }

  /**
   * A server's semantic tokens for the document as it is now: 1-based lines, columns in UTF-16 units, and the token
   * kind each is drawn as. They are drawn over the highlighter's colours and follow edits until they are set again; a
   * token that is not on its line, or overlaps the one before it, is left out. Null removes them.
   */
  setSemanticTokens(tokens: readonly { line: number; from: number; to: number; kind: number; deprecated?: boolean }[] | null): void {
    const byLine = new Map<number, SemanticSpan[]>()
    const doc = this.state.doc
    for (const token of tokens ?? []) {
      if (!Number.isInteger(token.line) || token.line < 1 || token.line > doc.lineCount) continue
      const length = doc.line(token.line).text.length
      const from = Math.max(0, token.from)
      const to = Math.min(length, token.to)
      if (!(to > from) || !Number.isInteger(token.kind) || token.kind < 0 || token.kind > KIND_LIMIT) continue
      let row = byLine.get(token.line)
      if (!row) byLine.set(token.line, (row = []))
      if (row.length && row[row.length - 1].to > from) continue
      row.push({ from, to, kind: token.deprecated ? token.kind | DEPRECATED : token.kind })
    }
    this.semantic.set(byLine)
    this.tokenCache.clear()
    this.requestRender()
  }

  /**
   * A server's inlay hints for the document as it is now: 1-based lines, the column each is drawn before, and its
   * label. They are drawn among the text but are not part of it (the caret, selections and copies skip them), and
   * follow edits until they are set again. Null removes them.
   */
  setInlayHints(hints: readonly { line: number; col: number; label: string; kind?: 'type' | 'parameter'; paddingLeft?: boolean; paddingRight?: boolean }[] | null): void {
    const byLine = new Map<number, InlaySpec[]>()
    const doc = this.state.doc
    for (const hint of hints ?? []) {
      if (!Number.isInteger(hint.line) || hint.line < 1 || hint.line > doc.lineCount || !hint.label) continue
      const text = doc.line(hint.line).text
      if (!Number.isInteger(hint.col) || hint.col < 0 || hint.col > text.length || text.length > LONG_LINE) continue
      let row = byLine.get(hint.line)
      if (!row) byLine.set(hint.line, (row = []))
      if (row.length >= MAX_INLAYS_PER_LINE) continue
      row.push({ from: hint.col, to: hint.col, label: hint.label, ...(hint.kind ? { kind: hint.kind } : {}), ...(hint.paddingLeft ? { paddingLeft: true } : {}), ...(hint.paddingRight ? { paddingRight: true } : {}) })
    }
    for (const row of byLine.values()) row.sort((a, b) => a.from - b.from)
    this.inlays.set(byLine)
    this.requestRender()
  }

  /** Goes up whenever the semantic tokens change, so what is drawn from the tokens knows to draw again. @internal */
  get semanticVersion(): number {
    return this.semantic.version
  }

  /** The inlay hints of line `n` as they are now (followed through edits). @internal */
  inlaysOf(n: number): readonly InlaySpec[] | undefined {
    return this.inlays.line(n)
  }

  /**
   * Shows `text` where each cursor is, as an input method composes it, moving the text after it along; null when the
   * composition ends. The document does not change until the composed text is committed.
   */
  setComposition(text: string | null): void {
    if (!text || this.state.config.readOnly) {
      if (!this.composition) return
      this.composition = null
    } else {
      const at = new Map<number, number[]>()
      const doc = this.state.doc
      for (const range of this.state.selection.ranges) {
        const line = doc.lineAt(range.head)
        const list = at.get(line.number) ?? []
        if (!list.includes(range.head - line.from)) list.push(range.head - line.from)
        at.set(line.number, list.sort((a, b) => a - b))
      }
      this.composition = { text, at, merged: new Map() }
    }
    this.requestRender()
  }

  /** Where the composition at the main cursor starts, in the layers; null when none is drawn there. */
  compositionCoords(): { x: number; y: number } | null {
    if (!this.composition) return null
    const { head, assoc } = this.state.selection.main
    const line = this.state.doc.lineAt(head)
    const el = this.lineEls.get(line.number)
    const drawn = el?.drawnInlays.find((inlay) => inlay.compose && inlay.col === head - line.from)
    if (!el || !drawn) return null
    return { x: drawn.el.getBoundingClientRect().left - el.dom.getBoundingClientRect().left, y: this.layerCoords(head, assoc).y }
  }

  /** The hints drawn in line `n`: the language server's (none in a line drawn in part), and a composition at each cursor in it. */
  private hintsOf(n: number, long: boolean): readonly InlaySpec[] | undefined {
    const hints = long ? undefined : this.inlays.line(n)
    const composing = this.composition
    const offsets = composing?.at.get(n)
    if (!composing || !offsets) return hints
    const known = composing.merged.get(n)
    if (known && known.hints === hints) return known.all
    const all: InlaySpec[] = [...(hints ?? [])]
    for (const offset of offsets) all.push({ from: offset, to: offset, label: composing.text, kind: 'compose' })
    // At the same column a composition comes before a server's hint: the textarea the input method writes in is put
    // at the first hint the caret is drawn before.
    all.sort((a, b) => a.from - b.from || (a.kind === 'compose' ? 0 : 1) - (b.kind === 'compose' ? 0 : 1))
    composing.merged.set(n, { hints, all })
    return all
  }

  /** Runs a command by name; false when it does not exist or did not apply. */
  runCommand(name: string): boolean {
    const command = this.commands[name]
    if (!command) {
      this.emit('request', name)
      return true
    }
    return command(this)
  }

  setOptions(options: Partial<Options>): void {
    if (options.folding === false && this.options.folding) this.folding.unfoldAll()
    const brackets = options.bracketColors !== undefined && options.bracketColors !== this.options.bracketColors
    // Wrapping on or off, or at another width, keeps the text at the top of the view where it is.
    if ((options.wordWrap ?? this.options.wordWrap) !== this.options.wordWrap || (options.wrapColumn ?? this.options.wrapColumn) !== this.options.wrapColumn || (options.wrapIndent ?? this.options.wrapIndent) !== this.options.wrapIndent) {
      this.holdAnchor()
    }
    const reader = options.screenReader !== undefined && options.screenReader !== this.options.screenReader
    Object.assign(this.options, options)
    if (reader) this.input.syncMirror()
    if (brackets) {
      this.highlighter.setBrackets(this.options.bracketColors ? this.state.config.language.brackets : null)
      this.tokenCache.clear()
      this.scheduleIdleWork()
    }
    this.root.classList.toggle('enc-ligatures', this.options.ligatures)
    this.root.classList.toggle('enc-no-numbers', !this.options.lineNumbers)
    this.root.classList.toggle('enc-folding', this.options.folding)
    this.restartBlink()
    this.requestRender()
  }

  // ----------------------------------------------------------------- decorations and zones

  /** Sets the decorations of one source (null removes them). A source is followed through document changes. */
  setSource(key: string, source: DecorationSource | null): void {
    if (source) this.sources.set(key, source)
    else this.sources.delete(key)
    this.decorationsVersion++
    this.requestRender()
  }

  /** The line backgrounds every source paints in lines `from`..`to`. @internal */
  collectLines(from: number, to: number, out: LineSpec[]): void {
    for (const source of this.sources.values()) source.lines?.(this.state.doc, from, to, out)
  }

  /** The marks every source has between offsets `from` and `to`. @internal */
  collectMarks(from: number, to: number, out: MarkSpec[]): void {
    for (const source of this.sources.values()) source.marks?.(this.state.doc, from, to, out)
  }

  /** Replaces the zones of `owner`: blocks of height between lines, such as the removed lines of a review hunk. */
  setZones(owner: string, zones: readonly ViewZone[]): void {
    for (const entry of this.zones) if (entry.owner === owner) this.detachZone(entry.zone)
    this.zones = this.zones.filter((entry) => entry.owner !== owner)
    const doc = this.state.doc
    for (const zone of zones) {
      const after = Math.max(0, Math.min(doc.lineCount, zone.after))
      this.zones.push({
        owner,
        zone,
        id: this.nextZoneId++,
        after,
        atStart: after === 0,
        pos: after === 0 ? 0 : doc.line(after).to,
      })
    }
    this.requestRender()
  }

  private detachZone(zone: ViewZone): void {
    if (this.attachedZones.delete(zone)) zone.dom.remove()
  }

  private mapAfterChange(changes: ChangeSet): void {
    const doc = this.state.doc
    this.decorationsVersion++
    for (const [key, source] of [...this.sources]) {
      if (!source.map) continue
      const mapped = source.map(changes, doc)
      if (mapped) this.sources.set(key, mapped)
      else this.sources.delete(key)
    }
    for (const entry of this.zones) {
      if (entry.atStart) continue
      entry.pos = changes.mapPos(entry.pos, -1)
      entry.after = doc.lineAt(Math.min(entry.pos, doc.length)).number
    }
    this.bracketCache = null
    this.find.documentChanged()
  }

  // ----------------------------------------------------------------- scheduling

  requestRender(): void {
    if (this.destroyed || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  /** Draws now instead of at the next frame. */
  flush(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    this.render()
  }

  private scheduleIdleWork(): void {
    if (this.remoteUsable()) return this.pumpRemote()
    if (this.idleWork || this.destroyed || this.highlighter.done) return
    const run = (deadline?: IdleDeadline) => {
      this.idleWork = 0
      const budget = deadline ? Math.min(12, deadline.timeRemaining()) : 8
      const more = this.highlighter.work(performance.now() + Math.max(2, budget))
      // Lines drawn from a guessed state are drawn again once the lines above them are known.
      if (this.rendered.last >= this.rendered.first && [...this.lineEls.values()].some((el) => !el.exact)) {
        this.requestRender()
      }
      if (more) this.scheduleIdleWork()
    }
    this.idleWork =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 500 })
        : (setTimeout(run, 16) as unknown as number)
  }

  /** The highlighting thread can read this document: it is alive and knows the language by its id. */
  private remoteUsable(): boolean {
    if (!this.highlighting || this.remoteFailed) return false
    const language = this.state.config.language
    return languageById(language.id)?.tokenizer === language.tokenizer
  }

  /** Sends the next batch to the highlighting thread, one at a time, and stores what comes back. */
  private pumpRemote(): void {
    if (this.remoteBusy || this.destroyed || this.highlighter.done) return
    const highlighter = this.highlighter
    const batch = highlighter.nextBatch(this.state.config.language.id, this.batchLines)
    if (!batch) return
    this.remoteBusy = true
    void this.highlighting!.run(batch).then(
      (result) => this.batchDone(highlighter, result),
      () => this.batchDone(highlighter, null),
    )
  }

  private batchDone(highlighter: Highlighter, result: HighlightResult | null): void {
    this.remoteBusy = false
    if (this.destroyed) return
    if (highlighter === this.highlighter) {
      if (!result) {
        highlighter.dropBatch()
        this.remoteFailed = true
      } else if (highlighter.acceptBatch(result)) {
        this.batchLines = Math.min(MAX_BATCH_LINES, this.batchLines * 4)
        if (this.rendered.last >= this.rendered.first && [...this.lineEls.values()].some((el) => !el.exact)) this.requestRender()
      }
    }
    this.scheduleIdleWork()
  }

  // ----------------------------------------------------------------- measuring

  /**
   * Reads the font metrics from the probe. True when they changed. A line is a whole number of device pixels high, so
   * at 125% or 150% every line starts on a pixel: the text stays sharp and evenly spaced, and selections meet without
   * a seam.
   */
  private measure(): boolean {
    const a = this.probeA.getBoundingClientRect()
    const b = this.probeB.getBoundingClientRect()
    const row = this.probeA.parentElement!.getBoundingClientRect()
    if (!a.width || !row.height) return false
    const charWidth = a.width / PROBE_CHARS
    const ratio = pixelRatio()
    this.measuredRatio = ratio
    const lineHeight = Math.max(1, Math.round(row.height * ratio)) / ratio
    const monospace = Math.abs(a.width - b.width) < 0.5
    const padding = parseFloat(getComputedStyle(this.root).getPropertyValue('--enc-editor-padding-x'))
    const paddingX = Number.isFinite(padding) ? padding : 12
    const next: ViewMetrics = { charWidth, lineHeight, paddingX, monospace }
    const old = this.metrics
    if (old.charWidth === next.charWidth && old.lineHeight === next.lineHeight && old.paddingX === next.paddingX && old.monospace === next.monospace) {
      return false
    }
    this.metrics = next
    this.root.style.setProperty('--enc-line-h', `${lineHeight}px`)
    this.root.style.setProperty('--enc-pad-x', `${paddingX}px`)
    this.root.style.setProperty('--enc-char-w', `${charWidth}px`)
    return true
  }

  /**
   * Measures again when the device pixel ratio changes: the window moved to a screen with another scale, the scale
   * changed, or the page was zoomed. The minimap and the line heights follow.
   */
  private watchPixelRatio(retries = 3): void {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(`(resolution: ${pixelRatio()}dppx)`)
    let frame = 0
    const changed = (again: boolean): void => {
      query.removeEventListener('change', told)
      cancelAnimationFrame(frame)
      if (this.destroyed) return
      this.watchPixelRatio(again ? retries - 1 : 3)
      this.onProbeResize()
      this.requestRender()
    }
    const told = (): void => changed(false)
    query.addEventListener('change', told)
    // Read as the change is told, the ratio can still be the old one: a query made with it never matches and would
    // never be told of the next change, so it is made again a frame later (a few times at most).
    if (!query.matches && retries > 0) frame = requestAnimationFrame(() => changed(true))
    this.unwatchPixelRatio = () => {
      query.removeEventListener('change', told)
      cancelAnimationFrame(frame)
    }
  }

  private onProbeResize(): void {
    if (this.destroyed || !this.measure()) return
    this.dropLines()
    this.flush()
  }

  /** Everything depends on the metrics: positions, widths, the lines' own widths. Drawn again from nothing. */
  private dropLines(): void {
    for (const el of this.lineEls.values()) this.release(el)
    this.lineEls.clear()
    this.rendered = { first: 0, last: -1 }
  }

  private readViewport(): void {
    const width = this.scroller.clientWidth
    this.viewport = { width, height: this.scroller.clientHeight }
    if (width !== this.viewWidth) {
      this.viewWidth = width
      this.root.style.setProperty('--enc-view-w', `${width}px`)
    }
  }

  private onResize(now: boolean): void {
    if (this.destroyed) return
    this.readViewport()
    if (now) this.flush()
    else this.requestRender()
    this.emit('viewport')
  }

  private onScroll(): void {
    const { scrollTop, scrollLeft } = this.scroller
    if (scrollTop === this.lastScroll.top && scrollLeft === this.lastScroll.left) return
    const vertical = scrollTop !== this.lastScroll.top
    const sideways = scrollLeft !== this.lastScroll.left
    // Scrolled while text is held at the top for rows about to change: it is held as far from there as the view moved.
    if (vertical && this.anchor && this.lastScroll.top >= 0) this.anchor.offset += this.scale.toDoc(scrollTop) - this.scale.toDoc(this.lastScroll.top)
    this.lastScroll = { top: scrollTop, left: scrollLeft }
    if (vertical && this.scale.scaled) this.placeLayers()
    if (sideways) this.placeFixedZones()
    if (!this.coversViewport() || (scrollLeft !== 0 && this.hasLongLines()) || (sideways && this.hscale.scaled)) this.render()
    else {
      this.sticky.update()
      this.minimap.update(this.minimapWidth)
    }
    this.emit('viewport')
  }

  /**
   * In a document so tall that its scroll range is scaled down, the browser
   * would move the text by the scale factor times the wheel's distance. The
   * wheel moves it by the distance itself instead.
   */
  private onWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.defaultPrevented) return
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      // Sideways the same: in a scaled width the text moves by the wheel's distance.
      if (!this.hscale.scaled) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? this.metrics.charWidth * 3 : event.deltaMode === 2 ? this.viewport.width : 1
      this.scroller.scrollLeft += this.hscale.toScroll(event.deltaX * unit)
      return
    }
    if (!this.scale.scaled) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? this.metrics.lineHeight : event.deltaMode === 2 ? this.viewport.height : 1
    this.scrollBy(event.deltaY * unit)
  }

  private coversViewport(): boolean {
    const { first, last } = this.rendered
    if (last < first) return false
    const top = this.scale.toDoc(this.scroller.scrollTop)
    const margin = this.metrics.lineHeight * 3
    const above = first <= 1 || this.heights.top(first) <= top - margin
    const below = last >= this.heights.lineCount || this.heights.bottom(last) >= top + this.viewport.height + margin
    if (!above || !below) return false
    if (!this.partialRows) return true
    // A line drawn in part covers the view only while its drawn rows do.
    const lineHeight = this.metrics.lineHeight
    for (const el of this.lineEls.values()) {
      if (!el.wrap || el.rowTo - el.rowFrom > el.wrap.breaks.length) continue
      const lineTop = this.heights.top(el.line)
      const from = Math.max(lineTop, top - margin)
      const to = Math.min(this.heights.bottom(el.line), top + this.viewport.height + margin)
      if (from < to && (lineTop + el.rowFrom * lineHeight > from || lineTop + el.rowTo * lineHeight < to)) return false
    }
    return true
  }

  private hasLongLines(): boolean {
    for (const el of this.lineEls.values()) if (el.to - el.from < el.text.length) return true
    return false
  }

  private scanLongestLine(): void {
    const doc = this.state.doc
    if (doc.lineCount > SCAN_LIMIT) return
    let longest = 0
    for (const text of doc.lineTexts()) if (text.length > longest) longest = text.length
    this.maxCols = Math.max(this.maxCols, longest)
  }

  // ----------------------------------------------------------------- word wrap

  /** Whether long lines break into rows. */
  get wrapped(): boolean {
    return this.wrapping !== null
  }

  /** Lines wrap to the text area, so nothing scrolls sideways. */
  private get rowsFit(): boolean {
    return this.wrapping !== null && this.options.wordWrap !== 'column'
  }

  /** The breaks of a line as it is drawn: none unless lines wrap. */
  wrapOf(line: Line): LineWrap {
    return this.wrapping ? this.wrapping.wrap(line.text) : ONE_ROW
  }

  /** The rows long lines break into for the text area as it is now; null when they do not wrap. */
  private wrapSpec(): WrapSpec | null {
    const mode = this.options.wordWrap
    if (mode === 'off') return null
    const { charWidth, paddingX } = this.metrics
    // The text area less its padding and the minimap over its right side, with room for the caret after a full row.
    const room = Math.floor((this.viewport.width - this.gutterWidth - this.minimapWidth - paddingX * 2) / charWidth) - 1
    const column = Math.max(1, Math.floor(this.options.wrapColumn))
    const width = mode === 'column' ? column : mode === 'bounded' ? Math.min(room, column) : room
    return { width: Math.max(MIN_WRAP_WIDTH, width), tabSize: this.state.config.tabSize, indent: this.options.wrapIndent }
  }

  /** Lays the rows out again when wrapping was turned on or off or the width it wraps to changed, keeping the text at the top. */
  private layoutWrap(): void {
    const spec = this.wrapSpec()
    // Nothing scrolls sideways while the rows fit the text area.
    const fits = spec !== null && this.options.wordWrap !== 'column'
    if (this.root.classList.contains('enc-wrap') !== fits) this.root.classList.toggle('enc-wrap', fits)
    if (spec ? this.wrapping !== null && sameSpec(spec, this.wrapping.spec) : this.wrapping === null) return
    this.holdAnchor()
    this.wrapping = spec ? new WrapLayout(spec, this.state.doc) : null
    // Every line is drawn again, in its new rows or in one.
    for (const el of this.lineEls.values()) this.release(el)
    this.lineEls.clear()
    if (!spec) this.scanLongestLine()
    this.scheduleSettle()
  }

  /** The columns the scrollable area takes while lines wrap: none past the text area, unless they wrap at a column wider than it. */
  private wrappedColumns(): number {
    return this.options.wordWrap === 'column' && this.wrapping ? this.wrapping.spec.width + 1 : 0
  }

  /** Remembers the text at the top of the view, to keep it there while rows change above it. The first hold stands until it is used. */
  private holdAnchor(): void {
    if (this.anchor || this.rendered.last < this.rendered.first) return
    const placed = this.placed
    if (placed && placed.scrollTop === this.scroller.scrollTop) {
      this.anchor = { pos: placed.pos, offset: placed.offset }
      return
    }
    const doc = this.state.doc
    const top = this.scale.toDoc(this.scroller.scrollTop)
    const line = doc.line(Math.max(1, Math.min(doc.lineCount, this.heights.lineAt(top))))
    const wrap = this.wrapOf(line)
    const row = Math.min(wrap.breaks.length, this.heights.rowAt(line.number, top))
    this.anchor = { pos: line.from + rowStart(wrap, row), offset: top - (this.heights.top(line.number) + row * this.metrics.lineHeight) }
  }

  /** Scrolls so the text held by `holdAnchor` is where it was (moved by as much as the view was scrolled since: `onScroll`). */
  private restoreAnchor(): void {
    const anchor = this.anchor
    if (!anchor) return
    this.anchor = null
    const doc = this.state.doc
    const pos = Math.min(anchor.pos, doc.length)
    const line = doc.lineAt(pos)
    const row = rowOf(this.wrapOf(line), pos - line.from)
    const y = this.heights.top(line.number) + row * this.metrics.lineHeight + anchor.offset
    this.scroller.scrollTop = Math.max(0, this.scale.toScroll(y))
    this.placed = { pos, offset: anchor.offset, scrollTop: this.scroller.scrollTop }
  }

  /** Gives lines `first`..`last` their real rows, holding the text at the top first; true when some had others. */
  private settleWindow(first: number, last: number): boolean {
    const layout = this.wrapping!
    const from = Math.max(first, layout.frontier)
    if (from > last) return false
    const texts = this.state.doc.lineTexts(from, last)
    let changed = false
    for (let index = 0; index < texts.length; index++) {
      if (layout.settleLine(from + index, texts[index], () => this.holdAnchor())) changed = true
    }
    return changed
  }

  // ----------------------------------------------------------------- moving by rows

  /** The visual column of `offset` in row `row` of a line: from the text area's left edge, the row's indent counted. */
  private columnInRow(line: Line, wrap: LineWrap, row: number, offset: number): number {
    const start = rowStart(wrap, row)
    const text = line.text.slice(start, rowEnd(wrap, row, line.text.length))
    return (row > 0 ? wrap.indent : 0) + columnAt(text, offset - start, this.state.config.tabSize)
  }

  /** The cursor in row `row` of `line` nearest to visual column `goal`; past a row a break ends, at that row's end. */
  private cursorInRow(line: Line, wrap: LineWrap, row: number, goal: number): SelectionRange {
    const start = rowStart(wrap, row)
    const end = rowEnd(wrap, row, line.text.length)
    const column = Math.max(0, goal - (row > 0 ? wrap.indent : 0))
    const offset = start + indexAtColumn(line.text.slice(start, end), column, this.state.config.tabSize)
    return SelectionRange.cursor(line.from + offset, goal, row < wrap.breaks.length && offset >= end ? -1 : undefined)
  }

  /**
   * `range` moved `rows` rows down (negative: up), as the arrow keys move while lines wrap: to the column of the row
   * nearest the range's goal, folded lines stepped over. Past either end of the document it goes to that end, or with
   * `stop` gives null (a cursor added above the first row).
   */
  verticalMove(range: SelectionRange, rows: number, extend: boolean, stop = false): SelectionRange | null {
    const doc = this.state.doc
    const collapse = !extend && !range.empty
    const start = collapse ? (rows < 0 ? range.from : range.to) : range.head
    let line = doc.lineAt(start)
    let wrap = this.wrapOf(line)
    let row = rowOf(wrap, start - line.from, start === range.head ? range.assoc : undefined)
    const goal = !collapse && range.goalColumn !== undefined ? range.goalColumn : this.columnInRow(line, wrap, row, start - line.from)
    for (let left = rows; left !== 0; left -= Math.sign(left)) {
      if (left > 0 && row < wrap.breaks.length) row++
      else if (left < 0 && row > 0) row--
      else {
        const next = this.folding.step(line.number, Math.sign(left))
        if (next < 1 || next > doc.lineCount) return stop ? null : SelectionRange.cursor(next < 1 ? 0 : doc.length, goal)
        line = doc.line(next)
        wrap = this.wrapOf(line)
        row = left > 0 ? 0 : wrap.breaks.length
      }
    }
    return this.cursorInRow(line, wrap, row, goal)
  }

  /**
   * Home or End while lines wrap: to the start or the end of the row the head is in, and from there on to the line's,
   * Home to its first non-blank character and then its start, as without wrapping.
   */
  rowEdge(range: SelectionRange, end: boolean): SelectionRange {
    const line = this.state.doc.lineAt(range.head)
    const wrap = this.wrapOf(line)
    const offset = range.head - line.from
    const row = rowOf(wrap, offset, range.assoc)
    if (end) {
      const to = rowEnd(wrap, row, line.text.length)
      return row < wrap.breaks.length && offset !== to ? SelectionRange.cursor(line.from + to, undefined, -1) : SelectionRange.cursor(line.to)
    }
    const from = rowStart(wrap, row)
    if (row > 0 && offset !== from) return SelectionRange.cursor(line.from + from)
    const indent = leadingWhitespace(line.text).length
    return SelectionRange.cursor(line.from + (offset === indent ? 0 : indent))
  }

  /** Breaks the lines of a large document still guessed, a stretch at a time while the editor is idle. */
  private scheduleSettle(): void {
    if (this.settleWork || this.destroyed || !this.wrapping || this.wrapping.complete) return
    const run = (deadline?: IdleDeadline) => {
      this.settleWork = 0
      const layout = this.wrapping
      if (!layout || this.destroyed) return
      const budget = deadline ? Math.min(12, deadline.timeRemaining()) : 8
      let moved = false
      const more = layout.settle(this.state.doc, performance.now() + Math.max(2, budget), () => {
        this.holdAnchor()
        moved = true
      })
      if (moved) this.requestRender()
      if (more) this.scheduleSettle()
    }
    this.settleWork =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 1000 })
        : (setTimeout(run, 16) as unknown as number)
  }

  // ----------------------------------------------------------------- rendering

  /** Brings the DOM in line with the state. Usually called through the frame scheduler. */
  render(): void {
    if (this.destroyed) return
    this.readViewport()
    const { height: viewportHeight, width: viewportWidth } = this.viewport
    if (!viewportHeight || !viewportWidth || !this.root.isConnected) return
    // The screen's scale changed and nothing told the view yet: the metrics are read again first.
    if (pixelRatio() !== this.measuredRatio && this.measure()) this.dropLines()
    const { lineHeight, charWidth } = this.metrics
    const doc = this.state.doc

    // The gutter and the minimap first: what is left between them is what long lines wrap to.
    const digits = Math.max(3, String(doc.lineCount).length)
    const foldColumn = this.options.folding ? FOLD_COLUMN : 0
    const gutterWidth = (this.options.lineNumbers ? Math.ceil(GUTTER_PAD_LEFT + digits * charWidth + GUTTER_PAD_RIGHT) : 12) + foldColumn
    this.minimapWidth = this.minimap.widthFor(viewportWidth, gutterWidth)
    if (gutterWidth !== this.gutterWidth) {
      this.gutterWidth = gutterWidth
      this.gutter.style.width = `${gutterWidth}px`
      this.root.style.setProperty('--enc-gutter-w', `${gutterWidth}px`)
    }
    this.layoutWrap()

    // Layout: heights, the scroll scale and the scrollable size.
    const hidden = this.hiddenLines()
    const isHidden = (line: number) => hidden.some((range) => range.from <= line && line <= range.to)
    const zoneList: Zone[] = this.zones
      .filter((entry) => !hidden.length || !isHidden(entry.after))
      .sort((a, b) => a.after - b.after)
      .map((entry) => ({ id: entry.id, after: entry.after, height: entry.zone.height }))
    const padBottom = this.options.scrollBeyondEnd ? Math.max(0, viewportHeight - lineHeight * 2) : 0
    const layout = (): void => {
      const rows = this.wrapping?.rows ?? null
      const others =
        this.heights.lineHeight !== lineHeight ||
        this.heights.lineCount !== doc.lineCount ||
        this.heights.padBottom !== padBottom ||
        !sameZones(this.heights.zoneList, zoneList) ||
        !sameHidden(this.heights.hidden, hidden)
      if (others || this.heights.rows !== rows || (rows !== null && this.heights.rowsVersion !== rows.version)) {
        this.heights = new HeightMap(lineHeight, doc.lineCount, zoneList, padBottom, hidden, rows)
      }
      // The view moves with what changed besides the rows, so the text it was put at no longer stands.
      if (others) this.placed = null
      this.scale = new ScrollScale(this.heights.totalHeight, viewportHeight)
      const scrollHeight = `${this.scale.scrollHeight}px`
      if (this.sizer.style.height !== scrollHeight) this.sizer.style.height = scrollHeight
    }
    // The text held at the top of the view goes back there; its own line is given its real rows first.
    const anchored = (): void => {
      const anchor = this.anchor
      if (anchor && this.wrapping) {
        const line = doc.lineAt(Math.min(anchor.pos, doc.length))
        if (this.wrapping.settleLine(line.number, line.text)) layout()
      }
      this.restoreAnchor()
    }
    layout()
    this.setTextWidth(this.wrapping ? this.wrappedColumns() : this.maxCols)

    if (this.pendingScroll) {
      this.scroller.scrollTop = this.pendingScroll.top
      this.scroller.scrollLeft = this.pendingScroll.left
      this.pendingScroll = null
    }
    anchored()
    const reveal = this.pendingReveal
    if (reveal) this.applyReveal()

    const overscan = Math.max(lineHeight * 12, viewportHeight * 0.6)
    let top = this.scale.toDoc(this.scroller.scrollTop)
    let first = this.heights.lineAt(top - overscan)
    let last = this.heights.lineAt(top + viewportHeight + overscan)
    // The lines about to be drawn get their real rows (a large document starts from rows guessed by length), and the
    // text at the top of the view stays where it is while they do.
    for (let pass = 0; pass < 3 && this.wrapping && !this.wrapping.complete && this.settleWindow(first, last); pass++) {
      layout()
      anchored()
      if (reveal) {
        this.pendingReveal = reveal
        this.applyReveal()
      }
      top = this.scale.toDoc(this.scroller.scrollTop)
      first = this.heights.lineAt(top - overscan)
      last = this.heights.lineAt(top + viewportHeight + overscan)
    }

    const scrollTop = this.scroller.scrollTop
    const scrollLeft = this.scroller.scrollLeft
    this.lastScroll = { top: scrollTop, left: scrollLeft }
    const docLeft = this.hscale.toDoc(scrollLeft)
    const originX = this.hscale.scaled ? Math.max(0, Math.floor((docLeft - ORIGIN_MARGIN_X) / ORIGIN_STEP_X) * ORIGIN_STEP_X) : 0
    if (originX !== this.originX) {
      this.originX = originX
      // Every line is drawn again from the new left edge, an empty one too, and none keeps its piece.
      for (const el of this.lineEls.values()) {
        el.text = ''
        el.from = -1
      }
    }
    this.docLeft = docLeft
    this.drawWindow = { top: top - overscan, bottom: top + viewportHeight + overscan }
    const origin = this.scale.scaled ? this.heights.top(first) : 0
    if (origin !== this.origin) {
      this.origin = origin
      for (const el of this.lineEls.values()) el.top = NaN
    }
    this.placeLayers()

    this.drawLines(first, last, docLeft, viewportWidth - gutterWidth)
    this.drawZones(first, last)
    this.rendered = { first, last }
    this.drawLayers(first, last)
    this.input.positionTextarea()
    this.sticky.update()
    this.minimap.update(this.minimapWidth)
  }

  /** The lines folded away, as the heights should lay them out. */
  private hiddenLines(): readonly HiddenLines[] {
    return this.options.folding ? this.folding.hidden() : []
  }

  /** Whether line `n` is folded away in the current layout. */
  isLineHidden(n: number): boolean {
    return this.heights.isHidden(n)
  }

  /** Puts the layers where the scroll position needs them (they move with it only when the height or width is scaled). */
  private placeLayers(): void {
    const top = this.scale.toDoc(this.scroller.scrollTop)
    const layerTop = this.scroller.scrollTop + (this.origin - top)
    if (layerTop !== this.layerTop || !this.layer.style.top) {
      this.layerTop = layerTop
      this.layer.style.top = `${layerTop}px`
      this.gutterLayer.style.top = `${layerTop}px`
    }
    const layerLeft = this.hscale.scaled ? this.scroller.scrollLeft - this.docLeft + this.originX : 0
    if (layerLeft !== this.layerLeft) {
      this.layerLeft = layerLeft
      this.layer.style.left = layerLeft ? `${layerLeft}px` : ''
    }
  }

  private drawLines(first: number, last: number, docLeft: number, visibleWidth: number): void {
    const doc = this.state.doc
    const { charWidth, lineHeight } = this.metrics
    const tabSize = this.state.config.tabSize
    const heights = this.heights
    const layout = this.wrapping
    // Release what scrolled out of range or was folded away.
    for (const [number, el] of this.lineEls) {
      if (number < first || number > last || heights.isHidden(number)) {
        this.release(el)
        this.lineEls.delete(number)
      }
    }
    const active = this.activeLines()
    const whitespace = this.options.renderWhitespace
    let widest = this.maxCols
    const unmeasured: LineEl[] = []
    this.partialRows = false
    for (let number = heights.nextVisible(first); number <= last; number = heights.nextVisible(number + 1)) {
      const info = doc.line(number)
      const highlighted = this.lineTokens(number)
      let el = this.lineEls.get(number)
      if (!el) {
        el = this.acquire()
        el.line = number
        this.lineEls.set(number, el)
      }
      const lineTop = heights.top(number)
      const wrap = layout ? layout.wrap(info.text) : null
      const rows = wrap ? wrap.breaks.length + 1 : 1
      let rowFrom = 0
      let rowTo = rows
      if (rows > MAX_DRAWN_ROWS) {
        // A line of very many rows is drawn in part, the rows near the view, cut again only as the view nears their edge.
        const wantFrom = Math.max(0, Math.min(rows - 1, Math.floor((this.drawWindow.top - lineTop) / lineHeight)))
        const wantTo = Math.max(wantFrom + 1, Math.min(rows, Math.ceil((this.drawWindow.bottom - lineTop) / lineHeight)))
        const keep = el.wrap === wrap && el.text === info.text && el.rowFrom <= wantFrom && el.rowTo >= wantTo
        rowFrom = keep ? el.rowFrom : Math.max(0, wantFrom - ROW_MARGIN)
        rowTo = keep ? el.rowTo : Math.min(rows, wantTo + ROW_MARGIN)
        this.partialRows = true
      }
      const top = lineTop + rowFrom * lineHeight - this.origin
      if (el.top !== top) {
        el.top = top
        el.dom.style.top = `${top}px`
        if (el.number) el.number.style.top = `${lineTop - this.origin}px`
      }
      const long = !wrap && info.text.length > LONG_LINE
      let from = 0
      let to = info.text.length
      if (wrap) {
        from = rowStart(wrap, rowFrom)
        to = rowEnd(wrap, rowTo - 1, info.text.length)
      } else if (long) {
        const firstCol = Math.max(0, Math.floor(Math.max(0, docLeft) / charWidth) - LONG_MARGIN)
        const lastCol = Math.floor((docLeft + visibleWidth) / charWidth) + LONG_MARGIN
        // Re-cut the piece only when the viewport nears its edge.
        const keep = el.line === number && el.text === info.text && el.to - el.from < info.text.length
        if (keep && el.from <= Math.max(0, firstCol - LONG_MARGIN / 2) && el.to >= Math.min(info.text.length, lastCol + LONG_MARGIN / 2)) {
          from = el.from
          to = el.to
        } else {
          from = indexAtColumn(info.text, firstCol, tabSize)
          to = Math.min(info.text.length, indexAtColumn(info.text, lastCol, tabSize))
        }
      }
      // A long line is drawn in part, and with no hints but a composition.
      const inlays = this.hintsOf(number, long)
      const marks = whitespace === 'none' ? null : this.whitespaceIn(info, whitespace, from, to)
      const marked = marks ? marks.join(';') : ''
      const isolates = this.options.bidi && !long ? isolatesOf(info.text, highlighted.tokens, PROSE.has(this.state.config.language.id)) : NO_ISOLATES
      const isolated = isolates.length ? isolates.join(';') : ''
      if (
        el.text !== info.text ||
        !sameTokens(el.tokens, highlighted.tokens) ||
        el.from !== from ||
        el.to !== to ||
        el.exact !== highlighted.exact ||
        el.inlays !== inlays ||
        el.wrap !== wrap ||
        el.rowFrom !== rowFrom ||
        el.rowTo !== rowTo ||
        el.whitespace !== marked ||
        el.isolates !== isolated
      ) {
        if (wrap && rows > 1) {
          el.drawnInlays = fillRows(el.dom, info.text, highlighted.tokens, wrap, rowFrom, rowTo, inlays, marks, isolates)
          el.dom.style.height = `${(rowTo - rowFrom) * lineHeight}px`
        } else {
          // What comes before the drawn piece, less what lies left of the layers' edge.
          const lead = from > 0 || this.originX > 0 ? this.spacer(columnAt(info.text, from, tabSize) * charWidth - this.originX) : undefined
          el.drawnInlays = fillLine(el.dom, info.text, highlighted.tokens, from, to, lead, undefined, inlays, marks, isolates)
          if (el.dom.style.height) el.dom.style.height = ''
        }
        el.text = info.text
        el.tokens = highlighted.tokens
        el.from = from
        el.to = to
        el.exact = highlighted.exact
        el.inlays = inlays
        el.wrap = wrap
        el.rowFrom = rowFrom
        el.rowTo = rowTo
        el.whitespace = marked
        el.isolates = isolated
        // A line with hints is as wide as the browser draws it.
        el.simple = this.metrics.monospace && !inlays && (long || isSimpleText(info.text))
        // While lines wrap, the scrollable width does not follow the text.
        if (!layout) {
          if (el.simple || info.text.length > 2000) widest = Math.max(widest, columnAt(info.text, info.text.length, tabSize))
          else unmeasured.push(el)
        }
      }
      if (el.number) {
        const label = String(number)
        if (el.number.textContent !== label) el.number.textContent = label
      }
    }
    // Lines of text with wide or combining characters and markers are as wide as the browser made them; read all of them after the last write.
    for (const el of unmeasured) {
      // With right-to-left text in reading order the line's end is not its right edge.
      const bidi = el.isolates ? this.domRects(el, el.from, el.to) : null
      let x = bidi?.length ? bidi[bidi.length - 1][1] : this.domX(el, el.to)
      // A hint after the last character takes room the caret does not reach.
      const lastInlay = el.drawnInlays[el.drawnInlays.length - 1]
      if (x !== null && lastInlay?.col === el.to) x = Math.max(x, lastInlay.el.getBoundingClientRect().right - el.dom.getBoundingClientRect().left)
      if (x !== null) widest = Math.max(widest, Math.ceil((x - this.metrics.paddingX) / charWidth))
    }
    // Gutter classes (line number emphasis, review bars) and the active line number.
    const gutterSpecs: LineSpec[] = []
    for (const source of this.sources.values()) source.gutter?.(doc, first, last, gutterSpecs)
    const gutterClasses = new Map<number, string>()
    for (const spec of gutterSpecs) gutterClasses.set(spec.line, `${gutterClasses.get(spec.line) ?? ''} ${spec.className}`)
    const folding = this.options.folding
    for (const [number, el] of this.lineEls) {
      if (!el.number) continue
      const fold = !folding ? '' : this.folding.isFolded(number) ? ' enc-fold-closed' : this.folding.startsAt(number) ? ' enc-fold-open' : ''
      const name = `enc-gutter-num${active.has(number) ? ' enc-active' : ''}${fold}${gutterClasses.get(number) ?? ''}`
      if (el.number.className !== name) el.number.className = name
    }
    if (widest > this.maxCols) this.growWidth(widest)
  }

  /**
   * The stretches of `line` (offsets in it) whose spaces and tabs are drawn with a mark, within `from`..`to`: all of
   * them; those in a selection; the run at the end; or at the 'boundary', the runs at either end, runs of two or more
   * and any tab, but not the single spaces between words.
   */
  private whitespaceIn(line: Line, mode: Options['renderWhitespace'], from: number, to: number): [number, number][] | null {
    const text = line.text
    if (from >= to) return null
    if (mode === 'all') return [[from, to]]
    if (mode === 'selection') {
      const out: [number, number][] = []
      for (const range of this.state.selection.ranges) {
        const start = Math.max(range.from - line.from, from)
        const end = Math.min(range.to - line.from, to)
        if (!range.empty && start < end) out.push([start, end])
      }
      if (!out.length) return null
      out.sort((a, b) => a[0] - b[0])
      const merged: [number, number][] = [out[0]]
      for (const next of out.slice(1)) {
        const last = merged[merged.length - 1]
        if (next[0] <= last[1]) last[1] = Math.max(last[1], next[1])
        else merged.push(next)
      }
      return merged
    }
    let end = text.length
    while (end > 0 && isBlankCode(text.charCodeAt(end - 1))) end--
    if (mode === 'trailing') return end < to ? [[Math.max(end, from), to]] : null
    // The boundary: from the start of the run `from` may be inside, run by run.
    const out: [number, number][] = []
    let pos = from
    while (pos > 0 && isBlankCode(text.charCodeAt(pos - 1))) pos--
    while (pos < to) {
      if (!isBlankCode(text.charCodeAt(pos))) {
        pos++
        continue
      }
      let next = pos
      let tab = false
      while (next < text.length && isBlankCode(text.charCodeAt(next))) {
        if (text.charCodeAt(next) === 9) tab = true
        next++
      }
      if (pos === 0 || next === text.length || next - pos > 1 || tab) out.push([Math.max(pos, from), Math.min(next, to)])
      pos = next
    }
    return out.length ? out : null
  }

  /** Makes the scrollable area wide enough for `cols` columns. */
  private growWidth(cols: number): void {
    this.maxCols = cols
    this.setTextWidth(cols)
  }

  /**
   * Sizes the scrollable area for text `cols` columns wide. The minimap sits over the right of the text area, so the
   * longest line can scroll clear of it. Past MAX_CONTENT_WIDTH the scroll range is scaled.
   */
  private setTextWidth(cols: number): void {
    const visible = Math.max(1, this.viewport.width - this.gutterWidth)
    const textWidth = Math.max(visible, Math.ceil(this.metrics.paddingX * 2 + cols * this.metrics.charWidth + this.minimapWidth))
    const scaled = this.hscale.scaled
    this.hscale = new ScrollScale(textWidth, visible, MAX_CONTENT_WIDTH)
    if (this.hscale.scaled !== scaled) this.root.classList.toggle('enc-wide', this.hscale.scaled)
    const width = Math.ceil(this.hscale.scrollHeight)
    if (width !== this.contentWidth || this.sizer.style.width === '') {
      this.contentWidth = width
      this.sizer.style.width = `${this.gutterWidth + width}px`
    }
  }

  /** Room before a line's drawn text; a negative width moves the text left of the line's box. */
  private spacer(width: number): HTMLElement {
    const span = document.createElement('span')
    span.className = 'enc-pad'
    span.style.display = 'inline-block'
    if (width >= 0) span.style.width = `${width}px`
    else span.style.marginLeft = `${Math.max(-MAX_SHIFT, width)}px`
    return span
  }

  private acquire(): LineEl {
    const spare = this.spare.pop()
    if (spare) {
      this.linesEl.append(spare.dom)
      if (spare.number) this.gutterLayer.append(spare.number)
      return spare
    }
    const dom = document.createElement('div')
    dom.className = 'enc-line'
    this.linesEl.append(dom)
    const number = document.createElement('div')
    number.className = 'enc-gutter-num'
    this.gutterLayer.append(number)
    return { dom, number, line: 0, text: '', tokens: null, top: NaN, simple: true, from: 0, to: 0, exact: true, inlays: undefined, drawnInlays: [], wrap: null, rowFrom: 0, rowTo: 0, whitespace: '', isolates: '' }
  }

  private release(el: LineEl): void {
    el.dom.remove()
    el.number?.remove()
    el.text = '\0'
    el.tokens = null
    el.top = NaN
    el.inlays = undefined
    el.drawnInlays = []
    el.wrap = null
    el.rowFrom = 0
    el.rowTo = 0
    el.whitespace = ''
    if (el.dom.style.height) el.dom.style.height = ''
    if (this.spare.length < 200) this.spare.push(el)
  }

  private drawZones(first: number, last: number): void {
    const wanted = new Set<ViewZone>()
    for (const { zone, top } of this.heights.zonesBetween(Math.max(0, first - 1), last)) {
      const entry = this.zones.find((candidate) => candidate.id === zone.id)
      if (!entry) continue
      wanted.add(entry.zone)
      const dom = entry.zone.dom
      if (!this.attachedZones.has(entry.zone)) {
        this.zonesEl.append(dom)
        this.attachedZones.add(entry.zone)
      }
      dom.style.top = `${top - this.origin}px`
      dom.style.height = `${entry.zone.height}px`
    }
    for (const zone of [...this.attachedZones]) if (!wanted.has(zone)) this.detachZone(zone)
    this.placeFixedZones()
  }

  /** The fixed zones over the part of the text in sight, wherever it is scrolled sideways. */
  private placeFixedZones(): void {
    for (const zone of this.attachedZones) {
      if (!zone.fixed) continue
      zone.dom.style.left = `${this.scroller.scrollLeft - this.layerLeft}px`
      zone.dom.style.width = `${Math.max(0, this.scroller.clientWidth - this.gutterWidth - this.minimapWidth)}px`
    }
  }

  /** The line numbers with a cursor on them. */
  private activeLines(): Set<number> {
    const lines = new Set<number>()
    for (const range of this.state.selection.ranges) lines.add(this.state.doc.lineAt(range.head).number)
    return lines
  }

  /** The band line `n` takes in the layers, all its rows, cut to what is drawn: its top and height. */
  private band(n: number): { top: number; height: number } {
    const top = this.heights.top(n)
    if (!this.wrapping) return { top: top - this.origin, height: this.metrics.lineHeight }
    const from = Math.max(top, this.drawWindow.top)
    const to = Math.min(this.heights.bottom(n), this.drawWindow.bottom)
    return { top: from - this.origin, height: Math.max(0, to - from) }
  }

  private drawLayers(first: number, last: number): void {
    const doc = this.state.doc
    const { lineHeight, charWidth } = this.metrics
    const selection = this.state.selection
    const windowFrom = doc.line(first).from
    const windowTo = doc.line(last).to

    // Line backgrounds: the cursor's line, then whatever sources paint.
    this.backgrounds.begin()
    const fullWidth = this.contentWidth
    if (this.options.highlightActiveLine) {
      const lines = new Set<number>()
      for (const range of selection.ranges) {
        if (range.empty || doc.lineAt(range.from).number === doc.lineAt(range.to).number) lines.add(doc.lineAt(range.head).number)
      }
      for (const number of lines) {
        if (number < first || number > last || this.heights.isHidden(number)) continue
        const band = this.band(number)
        if (band.height > 0) this.backgrounds.rect('enc-line-active', 0, band.top, fullWidth, band.height)
      }
    }
    if (this.options.indentGuides) this.drawGuides(first, last)
    const lineSpecs: LineSpec[] = []
    for (const source of this.sources.values()) source.lines?.(doc, first, last, lineSpecs)
    for (const spec of lineSpecs) {
      if (this.heights.isHidden(spec.line)) continue
      const band = this.band(spec.line)
      if (band.height > 0) this.backgrounds.rect(spec.className, 0, band.top, fullWidth, band.height)
    }
    this.backgrounds.end()

    // A folded block's first line ends with a marker that opens it.
    this.foldPool.begin()
    if (this.options.folding) {
      for (const range of this.heights.hidden) {
        const header = range.from - 1
        if (header < first || header > last || header < 1) continue
        const line = doc.line(header)
        const { x, row } = this.place(line, line.text.length, -1)
        const el = this.foldPool.rect('', x + charWidth * 0.6, this.heights.top(header) + row * lineHeight - this.origin + 3, charWidth * 3, lineHeight - 6)
        el.dataset.line = String(header)
      }
    }
    this.foldPool.end()

    // Marks behind the text.
    this.marksPool.begin()
    const marks: MarkSpec[] = []
    for (const source of this.sources.values()) source.marks?.(doc, windowFrom, windowTo, marks)
    const pair = this.bracketPair()
    if (pair) {
      marks.push({ from: pair[0], to: pair[0] + 1, className: 'enc-mark-bracket' }, { from: pair[1], to: pair[1] + 1, className: 'enc-mark-bracket' })
    }
    let budget = 4000
    for (const mark of marks) {
      if (budget <= 0) break
      budget -= this.drawRange(this.marksPool, mark.from, mark.to, mark.className, first, last, false, budget)
    }
    this.marksPool.end()

    // Selections.
    this.selectionPool.begin()
    for (const range of selection.ranges) {
      if (range.empty) continue
      this.drawRange(this.selectionPool, range.from, range.to, '', first, last, true, 2000)
    }
    this.selectionPool.end()

    // Cursors.
    this.cursorPool.begin()
    const style = this.options.cursorStyle
    if (this.focused || this.input.composing) {
      selection.ranges.forEach((range, index) => {
        const line = doc.lineAt(range.head)
        if (line.number < first || line.number > last || this.heights.isHidden(line.number)) return
        const { x, row } = this.place(line, range.head - line.from, range.assoc)
        const top = this.heights.top(line.number) + row * lineHeight - this.origin
        const main = index === selection.mainIndex ? ' enc-cursor-main' : ''
        if (style === 'block') this.cursorPool.rect(`enc-cursor-block${main}`, x, top, charWidth, lineHeight)
        else if (style === 'underline') this.cursorPool.rect(`enc-cursor-underline${main}`, x, top + lineHeight - 2, charWidth, 2)
        else this.cursorPool.rect(`enc-cursor-line${main}`, x, top, 2, lineHeight)
      })
    }
    this.cursorPool.end()
  }

  /** Draws `from`..`to` as one rectangle per line in view, or per row when lines wrap; returns how many it drew. */
  private drawRange(pool: RectPool, from: number, to: number, className: string, first: number, last: number, selection: boolean, limit: number): number {
    const doc = this.state.doc
    const { lineHeight, charWidth, paddingX } = this.metrics
    const startLine = Math.max(first, doc.lineAt(from).number)
    const endLine = Math.min(last, doc.lineAt(to).number)
    const heights = this.heights
    let drawn = 0
    for (let number = heights.nextVisible(startLine); number <= endLine && drawn < limit; number = heights.nextVisible(number + 1)) {
      const line = doc.line(number)
      const start = Math.max(from, line.from) - line.from
      const end = Math.min(to, line.to) - line.from
      if (this.wrapping) {
        const wrap = this.wrapOf(line)
        const lineTop = heights.top(number)
        // The rows the range covers, of those drawn.
        const firstRow = Math.max(rowOf(wrap, start), Math.floor((this.drawWindow.top - lineTop) / lineHeight))
        const lastRow = Math.min(rowOf(wrap, end, -1), Math.ceil((this.drawWindow.bottom - lineTop) / lineHeight))
        // A row the selection runs on from reaches the edge the rows wrap at.
        const edge = paddingX + this.wrapping.spec.width * charWidth - this.originX
        const el = this.lineEls.get(number)
        const bidi = el?.isolates && el.text === line.text && el.wrap === wrap ? el : null
        for (let row = Math.max(0, firstRow); row <= lastRow && drawn < limit; row++) {
          const rowTo = rowEnd(wrap, row, line.text.length)
          const a = Math.max(start, rowStart(wrap, row))
          const b = Math.min(end, rowTo)
          // Right-to-left text in reading order: the parts of the range where they are drawn.
          const parts = bidi && b > a && row >= bidi.rowFrom && row < bidi.rowTo ? this.domRects(bidi, a, b, row) : null
          if (parts) {
            const top = lineTop + row * lineHeight - this.origin
            for (const [left, right] of parts) {
              if (drawn >= limit) break
              pool.rect(className, left, top, right - left, lineHeight)
              drawn++
            }
            const last = row === wrap.breaks.length
            if (selection && (last ? to > line.to : to > line.from + rowTo)) {
              const right = parts.length ? parts[parts.length - 1][1] : this.xInRow(line, wrap, row, b)
              pool.rect(className, right, top, last ? charWidth * SHORT : Math.max(0, edge - right), lineHeight)
            }
            continue
          }
          const left = this.xInRow(line, wrap, row, a)
          let right = b === a ? left : this.xInRow(line, wrap, row, b)
          const last = row === wrap.breaks.length
          if (selection && (last ? to > line.to : to > line.from + rowTo)) right = last ? right + charWidth * SHORT : Math.max(right, edge)
          else if (!selection && right === left) right = left + 2
          if (right <= left) continue
          pool.rect(className, left, lineTop + row * lineHeight - this.origin, right - left, lineHeight)
          drawn++
        }
        continue
      }
      const el = this.lineEls.get(number)
      const parts = el?.isolates && el.text === line.text && end > start ? this.domRects(el, start, end) : null
      if (parts) {
        // Right-to-left text in reading order: the parts of the range where they are drawn, then the line break.
        const top = this.heights.top(number) - this.origin
        for (const [left, right] of parts) {
          if (drawn >= limit) break
          pool.rect(className, left, top, right - left, lineHeight)
          drawn++
        }
        if (selection && to > line.to) {
          const ends = this.domRects(el!, el!.from, el!.to)
          const right = ends?.length ? ends[ends.length - 1][1] : parts[parts.length - 1][1]
          pool.rect(className, right, top, charWidth * SHORT, lineHeight)
        }
        continue
      }
      let left = this.xOf(line, start)
      let right = end === start ? left : this.xOf(line, end)
      // A selection that runs on past the line's end shows the line break.
      if (selection && to > line.to) right += charWidth * SHORT
      else if (!selection && right === left) right = left + 2
      if (this.hscale.scaled) {
        // In a scaled width a rectangle can run millions of pixels past the view; only the part near it is drawn.
        const near = this.docLeft - this.originX
        left = Math.max(left, near - this.viewport.width)
        right = Math.min(right, near + this.viewport.width * 2)
      }
      if (right <= left) continue
      pool.rect(className, left, this.heights.top(number) - this.origin, right - left, lineHeight)
      drawn++
    }
    return drawn
  }

  /** Indent guides: a faint vertical line at every indentation level of a line (and of blank lines between indented ones). */
  private drawGuides(first: number, last: number): void {
    const doc = this.state.doc
    const { tabSize, indentUnit } = this.state.config
    const unit = Math.max(1, unitWidth(indentUnit, tabSize))
    const { charWidth, lineHeight, paddingX } = this.metrics
    const indents = new Map<number, number>()
    const indentOf = (number: number): number => {
      let known = indents.get(number)
      if (known === undefined) {
        const text = doc.line(number).text
        known = text.trim() === '' ? -1 : indentWidth(leadingWhitespace(text), tabSize)
        indents.set(number, known)
      }
      return known
    }
    for (let number = this.heights.nextVisible(first); number <= last; number = this.heights.nextVisible(number + 1)) {
      let width = indentOf(number)
      if (width < 0) {
        // A blank line carries the guides common to the code around it.
        let before = -1
        let after = -1
        for (let n = number - 1; n >= Math.max(1, number - 40) && before < 0; n--) before = indentOf(n)
        for (let n = number + 1; n <= Math.min(doc.lineCount, number + 40) && after < 0; n++) after = indentOf(n)
        width = Math.min(before < 0 ? 0 : before, after < 0 ? 0 : after)
      }
      const levels = Math.floor((width - 1) / unit)
      if (levels < 1 && width <= unit) continue
      const count = Math.max(0, Math.ceil(width / unit) - 1)
      if (count < 1) continue
      // A wrapped line's guides run down all its rows.
      const band = this.band(number)
      if (band.height <= 0) continue
      const el = this.backgrounds.rect('enc-guides', paddingX - this.originX, band.top, count * unit * charWidth, band.height)
      el.style.backgroundSize = `${unit * charWidth}px 100%`
    }
  }

  private bracketPair(): [number, number] | null {
    const selection = this.state.selection
    if (selection.ranges.length !== 1 || !selection.main.empty) return null
    const head = selection.main.head
    const cache = this.bracketCache
    if (cache && cache.version === this.state.version && cache.head === head) return cache.pair
    const skip = (offset: number) => {
      const kind = this.highlighter.kindAt(offset)
      return kind === T.string || kind === T.comment || kind === T.regexp
    }
    const found = bracketAt(this.state.doc, head, this.state.config.language, skip)
    const pair: [number, number] | null = found && found.match >= 0 ? [found.at, found.match] : null
    this.bracketCache = { version: this.state.version, head, pair }
    return pair
  }

  // ----------------------------------------------------------------- coordinates

  /** x of an offset in a line, from the left edge of the editor's text area (padding included). */
  xOf(line: Line, offset: number): number {
    if (this.wrapping) return this.place(line, offset).x
    const { charWidth, paddingX } = this.metrics
    const el = this.lineEls.get(line.number)
    if (el && !el.simple && el.text === line.text) {
      const x = this.domX(el, offset)
      if (x !== null) return x
    }
    return paddingX + columnAt(line.text, offset, this.state.config.tabSize) * charWidth - this.originX
  }

  /**
   * Where offset `offset` of `line` is drawn: x in the layers, and the row of the line it is in (0 unless it wraps).
   * At a break `assoc` -1 is the end of the row before it, otherwise the start of the row after it.
   */
  place(line: Line, offset: number, assoc?: -1 | 1): { x: number; row: number } {
    const wrap = this.wrapOf(line)
    if (!wrap.breaks.length) return { x: this.wrapping ? this.xInRow(line, wrap, 0, offset) : this.xOf(line, offset), row: 0 }
    const row = rowOf(wrap, offset, assoc)
    return { x: this.xInRow(line, wrap, row, offset), row }
  }

  /** x in the layers of `offset`, which is in row `row` of a wrapped line (or at its end). */
  private xInRow(line: Line, wrap: LineWrap, row: number, offset: number): number {
    const el = this.lineEls.get(line.number)
    if (el && !el.simple && el.text === line.text && el.wrap === wrap && row >= el.rowFrom && row < el.rowTo) {
      const x = this.domX(el, offset, row)
      if (x !== null) return x
    }
    const { charWidth, paddingX } = this.metrics
    const start = rowStart(wrap, row)
    const text = line.text.slice(start, rowEnd(wrap, row, line.text.length))
    const indent = row > 0 ? wrap.indent : 0
    return paddingX + (indent + columnAt(text, offset - start, this.state.config.tabSize)) * charWidth - this.originX
  }

  private range: Range | null = null

  /**
   * x of `offset` measured in the DOM, relative to the line element; null when it cannot be. In a wrapped line it is
   * measured in row `row`, whose own end it may be.
   */
  private domX(el: LineEl, offset: number, row?: number): number | null {
    if (offset < el.from || offset > el.to) return null
    // At a type's hint the caret stays with the text before it: the hint's left edge.
    for (const inlay of el.drawnInlays) {
      if (inlay.col === offset && inlay.caretBefore) return inlay.el.getBoundingClientRect().left - el.dom.getBoundingClientRect().left
      if (inlay.col > offset) break
    }
    let host: Node = el.dom
    let position = el.from
    if (row !== undefined && el.wrap?.breaks.length) {
      const rowEl = el.dom.children[row - el.rowFrom]
      if (!rowEl) return null
      host = rowEl
      position = rowStart(el.wrap, row)
      if (offset < position || offset > rowEnd(el.wrap, row, el.text.length)) return null
    }
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const end = position + node.data.length
      if (offset < end) {
        // After right-to-left text the caret stays at its end, its left edge, so typing on reads on leftwards.
        if (el.isolates && offset > position) {
          const after = this.rtlEnd(el, node, offset - position - 1)
          if (after !== null) return after
        } else if (el.isolates && last?.data.length) {
          const after = this.rtlEnd(el, last, last.data.length - 1)
          if (after !== null) return after
        }
        return this.measureAt(el, node, offset - position)
      }
      position = end
      last = node
    }
    if (last) return this.measureAt(el, last, last.data.length)
    // An empty line; a row always has text.
    return host === el.dom ? this.metrics.paddingX : null
  }

  private measureAt(el: LineEl, node: Text, index: number): number {
    const range = (this.range ??= document.createRange())
    const base = el.dom.getBoundingClientRect().left
    // A control character is drawn as a marker wider than its glyph: it spans the marker.
    const marker = node.parentElement
    if (marker && marker.className.startsWith('enc-ctrl')) {
      const box = marker.getBoundingClientRect()
      return (index === 0 ? box.left : box.right) - base
    }
    const length = node.data.length
    if (length === 0) return node.parentElement?.getBoundingClientRect().left! - base
    // In a run of right-to-left text a character starts at its right edge and ends at its left.
    if (index < length) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const box = range.getBoundingClientRect()
      return (el.isolates && this.rightToLeft(node, index, box) ? box.right : box.left) - base
    }
    range.setStart(node, index - 1)
    range.setEnd(node, index)
    const box = range.getBoundingClientRect()
    return (el.isolates && this.rightToLeft(node, index - 1, box) ? box.left : box.right) - base
  }

  /** The left edge of the character at `index` of a drawn text node when it is laid out right to left: where it ends. */
  private rtlEnd(el: LineEl, node: Text, index: number): number | null {
    if (node.parentElement?.className.startsWith('enc-ctrl')) return null
    const range = (this.range ??= document.createRange())
    range.setStart(node, index)
    range.setEnd(node, index + 1)
    const box = range.getBoundingClientRect()
    return this.rightToLeft(node, index, box) ? box.left - el.dom.getBoundingClientRect().left : null
  }

  /**
   * Whether the character at `index` of a drawn text node is laid out right to left: only inside a stretch shown in
   * reading order, where a right-to-left letter is, a left-to-right one is not, and a digit, space or mark goes the way
   * the character beside it was drawn.
   */
  private rightToLeft(node: Text, index: number, box: DOMRect): boolean {
    if (!node.parentElement?.closest('.enc-bidi')) return false
    const char = String.fromCodePoint(node.data.codePointAt(index) ?? 32)
    if (hasRtl(char)) return true
    if (LETTER.test(char)) return false
    const near = index + 1 < node.data.length ? index + 1 : index - 1
    if (near < 0) return false
    const range = this.range!
    range.setStart(node, near)
    range.setEnd(node, near + 1)
    const other = range.getBoundingClientRect()
    return near > index ? other.left < box.left - 0.5 : other.left > box.left + 0.5
  }

  /** The text node and the index in it of `offset` in a drawn line (in row `row` when it wraps); null when it is not drawn. */
  private domPoint(el: LineEl, offset: number, row?: number): { node: Text; index: number } | null {
    if (offset < el.from || offset > el.to) return null
    let host: Node = el.dom
    let position = el.from
    if (row !== undefined && el.wrap?.breaks.length) {
      const rowEl = el.dom.children[row - el.rowFrom]
      if (!rowEl) return null
      host = rowEl
      position = rowStart(el.wrap, row)
      if (offset < position || offset > rowEnd(el.wrap, row, el.text.length)) return null
    }
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const end = position + node.data.length
      if (offset < end) return { node, index: offset - position }
      position = end
      last = node
    }
    return last ? { node: last, index: last.data.length } : null
  }

  /**
   * The stretches `from`..`to` of a drawn line takes on screen (in row `row` when it wraps), left to right, as x
   * relative to the line element: more than one where right-to-left text is shown in reading order. Null when that
   * part is not drawn.
   */
  private domRects(el: LineEl, from: number, to: number, row?: number): [number, number][] | null {
    const start = this.domPoint(el, from, row)
    const end = this.domPoint(el, to, row)
    if (!start || !end) return null
    const range = document.createRange()
    range.setStart(start.node, start.index)
    range.setEnd(end.node, end.index)
    const base = el.dom.getBoundingClientRect().left
    const boxes = [...range.getClientRects()].filter((box) => box.width > 0).map((box): [number, number] => [box.left - base, box.right - base])
    boxes.sort((a, b) => a[0] - b[0])
    const out: [number, number][] = []
    for (const box of boxes) {
      const last = out[out.length - 1]
      if (last && box[0] <= last[1] + 0.5) last[1] = Math.max(last[1], box[1])
      else out.push(box)
    }
    return out
  }

  /** The offset in `line` nearest to x (measured as in `xOf`); in a wrapped line, in its first row. */
  offsetAtX(line: Line, x: number): number {
    if (this.wrapping) return this.offsetInRow(line, this.wrapOf(line), 0, x)
    const { charWidth, paddingX } = this.metrics
    const tabSize = this.state.config.tabSize
    const el = this.lineEls.get(line.number)
    if (!el || el.simple || el.text !== line.text) {
      return indexAtColumn(line.text, Math.max(0, (x + this.originX - paddingX) / charWidth), tabSize)
    }
    return this.measuredOffset(el, line.text, el.from, el.to, x)
  }

  /** The offset in row `row` of `line` nearest to x; past the row's end, its end. */
  private offsetInRow(line: Line, wrap: LineWrap, row: number, x: number): number {
    const text = line.text
    const start = rowStart(wrap, row)
    const end = rowEnd(wrap, row, text.length)
    const el = this.lineEls.get(line.number)
    if (!el || el.simple || el.text !== text || el.wrap !== wrap || row < el.rowFrom || row >= el.rowTo) {
      const { charWidth, paddingX } = this.metrics
      const column = Math.max(0, (x + this.originX - paddingX) / charWidth - (row > 0 ? wrap.indent : 0))
      return start + indexAtColumn(text.slice(start, end), column, this.state.config.tabSize)
    }
    return this.measuredOffset(el, text, start, end, x, wrap.breaks.length ? row : undefined)
  }

  /** The offset between `from` and `to` of a drawn line (in row `row` when it wraps) nearest to x, measured in the DOM. */
  private measuredOffset(el: LineEl, text: string, from: number, to: number, x: number, row?: number): number {
    // A point on a hint is its column: the hint is no text to put the caret inside.
    if (el.drawnInlays.length) {
      const base = el.dom.getBoundingClientRect().left
      for (const inlay of el.drawnInlays) {
        if (inlay.col < from || inlay.col > to) continue
        const box = inlay.el.getBoundingClientRect()
        if (x >= box.left - base && x < box.right - base) return inlay.col
      }
    }
    if (el.isolates && to - from <= 4000) {
      // Right-to-left text in reading order: positions do not grow with x, so every boundary is measured; past the
      // text's ends are its ends.
      const drawn = this.domRects(el, from, to, row)
      if (drawn?.length && x >= drawn[drawn.length - 1][1]) return to
      if (drawn?.length && x <= drawn[0][0]) return from
      let best = from
      let distance = Infinity
      for (let offset = from; offset <= to; offset = offset < to ? nextCluster(text, offset) : to + 1) {
        const at = this.domX(el, offset, row)
        if (at !== null && Math.abs(at - x) < distance) {
          distance = Math.abs(at - x)
          best = offset
        }
      }
      return best
    }
    let low = from
    let high = to
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((this.domX(el, mid, row) ?? Infinity) < x) low = mid + 1
      else high = mid
    }
    // `low` is the first offset at or right of x. The caret goes to the character boundary there or to the one before it, whichever is nearer.
    const after = low <= from ? from : low >= to ? to : nextCluster(text, previousCluster(text, low))
    const before = after <= from ? from : previousCluster(text, after)
    const afterX = this.domX(el, after, row) ?? x
    const beforeX = this.domX(el, before, row) ?? x
    return x - beforeX < afterX - x ? before : after
  }

  /**
   * Where `pos` is inside the editor's layers: x from the text area's left edge, y from the top of the drawn window
   * (the top of its row when lines wrap; at a break, `assoc` -1 is the end of the row before it).
   */
  layerCoords(pos: number, assoc?: -1 | 1): { x: number; y: number } {
    const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length))
    const { x, row } = this.place(line, pos - line.from, assoc)
    return { x, y: this.heights.top(line.number) + row * this.metrics.lineHeight - this.origin }
  }

  /**
   * The document position at client coordinates. When lines wrap, `out.assoc` is set to -1 for a point past the end
   * of a row that a break ends, where the caret is drawn at that row's end.
   */
  posAtCoords(clientX: number, clientY: number, out?: { assoc?: -1 | 1 }): number {
    const doc = this.state.doc
    const scrollerRect = this.scroller.getBoundingClientRect()
    const docY = this.scale.toDoc(this.scroller.scrollTop) + (clientY - scrollerRect.top)
    if (out) out.assoc = undefined
    // Above the first line and below the last are the start and the end of the document, whatever x is.
    if (docY < 0) return 0
    if (docY >= this.heights.contentHeight) return doc.length
    const number = Math.min(doc.lineCount, Math.max(1, this.heights.lineAt(docY)))
    const line = doc.line(number)
    const x = this.layerX(clientX)
    if (!this.wrapping) return line.from + this.offsetAtX(line, x)
    const wrap = this.wrapOf(line)
    const row = Math.min(wrap.breaks.length, this.heights.rowAt(number, docY))
    const offset = this.offsetInRow(line, wrap, row, x)
    if (out && row < wrap.breaks.length && offset === wrap.breaks[row]) out.assoc = -1
    return line.from + offset
  }

  /** The client x of the gutter's right edge. */
  gutterRight(): number {
    return this.gutter.getBoundingClientRect().right
  }

  /** The line (1-based) at a client y. */
  lineAtClientY(clientY: number): number {
    const scrollerRect = this.scroller.getBoundingClientRect()
    const docY = this.scale.toDoc(this.scroller.scrollTop) + (clientY - scrollerRect.top)
    return Math.min(this.state.doc.lineCount, Math.max(1, this.heights.lineAt(docY)))
  }

  /** Client coordinates of the caret position `pos`: where a popup would anchor. At a break, `assoc` as in `layerCoords`. */
  coordsAtPos(pos: number, assoc?: -1 | 1): { left: number; top: number; bottom: number } {
    const doc = this.state.doc
    const line = doc.lineAt(pos)
    const scrollerRect = this.scroller.getBoundingClientRect()
    const { x, row } = this.place(line, pos - line.from, assoc)
    const top = scrollerRect.top + (this.heights.top(line.number) + row * this.metrics.lineHeight - this.scale.toDoc(this.scroller.scrollTop))
    return { left: this.layer.getBoundingClientRect().left + x, top, bottom: top + this.metrics.lineHeight }
  }

  /** A client x as x in the layers (what `xOf` gives). */
  private layerX(clientX: number): number {
    return clientX - this.layer.getBoundingClientRect().left
  }

  /** The document x (from the text area's left edge, padding included, as if the text were never scaled) at a client x. */
  docXAt(clientX: number): number {
    return this.layerX(clientX) + this.originX
  }

  /** The document x at the left edge of the text in sight: the scroll offset, unless the width is scaled. */
  get scrollLeftInDoc(): number {
    return this.hscale.toDoc(this.scroller.scrollLeft)
  }

  /** Whether `pos` is on screen. */
  isVisible(pos: number, assoc?: -1 | 1): boolean {
    const line = this.state.doc.lineAt(pos)
    const top = this.heights.top(line.number) + rowOf(this.wrapOf(line), pos - line.from, assoc) * this.metrics.lineHeight
    const view = this.scale.toDoc(this.scroller.scrollTop)
    return top >= view && top + this.metrics.lineHeight <= view + this.viewport.height
  }

  get viewportLines(): { first: number; last: number } {
    const top = this.scale.toDoc(this.scroller.scrollTop)
    return { first: this.heights.lineAt(top), last: this.heights.lineAt(top + this.viewport.height - 1) }
  }

  get lineCapacity(): number {
    return Math.max(1, Math.floor(this.viewport.height / this.metrics.lineHeight))
  }

  /** The layout of the lines, zones and folds as last drawn. @internal */
  get heightMap(): HeightMap {
    return this.heights
  }

  /** The document offset (in layout pixels) at the top of the view. */
  get scrollTopInDoc(): number {
    return this.scale.toDoc(this.scroller.scrollTop)
  }

  get viewportHeight(): number {
    return this.viewport.height
  }

  /** The gutter's width in pixels. */
  get gutterWidthPx(): number {
    return this.gutterWidth
  }

  /** The width of the text that shows, between the gutter and the minimap. */
  get textAreaWidth(): number {
    return Math.max(0, this.scroller.clientWidth - this.gutterWidth - this.minimapWidth)
  }

  /** How far the highlighter has read with known states: the minimap draws again as it goes. @internal */
  get highlightFrontier(): number {
    return this.highlighter.frontier
  }

  /** The line that shows at layout offset `y`. */
  lineAtDocY(y: number): number {
    return this.heights.lineAt(y)
  }

  /** The top of line `n` in layout pixels. */
  lineTop(n: number): number {
    return this.heights.top(n)
  }

  /** The bottom of line `n`'s last row in layout pixels. */
  lineBottom(n: number): number {
    return this.heights.bottom(n)
  }

  /** Scrolls so layout offset `y` is at the top of the view. */
  scrollToDocY(y: number): void {
    this.scroller.scrollTop = Math.max(0, this.scale.toScroll(y))
  }

  // ----------------------------------------------------------------- scrolling

  /** Scrolls so `pos` is on screen, opening a folded block it is in; `center` puts it in the middle when it was not visible. */
  scrollToPos(pos: number, center = false): void {
    this.folding.reveal(pos)
    this.pendingReveal = { pos, center }
    this.requestRender()
  }

  /** Scrolls by document pixels (a scroll offset is a scaled height in a very tall document). */
  scrollBy(pixels: number): void {
    this.scroller.scrollTop += this.scale.toScroll(pixels)
  }

  scrollToLine(line: number, center = true): void {
    const doc = this.state.doc
    this.scrollToPos(doc.line(Math.max(1, Math.min(doc.lineCount, line))).from, center)
  }

  private applyReveal(): void {
    const request = this.pendingReveal!
    this.pendingReveal = null
    const doc = this.state.doc
    const pos = Math.min(request.pos, doc.length)
    const line = doc.lineAt(pos)
    const { lineHeight, charWidth } = this.metrics
    const view = this.scale.toDoc(this.scroller.scrollTop)
    const height = this.viewport.height
    // The row the position is in, when lines wrap; the main cursor's side of a break.
    const main = this.state.selection.main
    const assoc = main.head === pos ? main.assoc : undefined
    const wrap = this.wrapOf(line)
    const row = rowOf(wrap, pos - line.from, assoc)
    const lineTop = this.heights.top(line.number) + row * lineHeight
    const marginY = Math.min(lineHeight * 3, Math.max(0, (height - lineHeight) / 2))
    // Lines pinned at the top cover the text under them: a line revealed upward stops below them.
    const pinned = Math.min(this.sticky.height, Math.max(0, height / 3))
    let target = view
    if (request.center && (lineTop < view + pinned || lineTop + lineHeight > view + height)) {
      target = lineTop - (height - lineHeight) / 2
    } else if (lineTop - marginY - pinned < view) target = lineTop - marginY - pinned
    else if (lineTop + lineHeight + marginY > view + height) target = lineTop + lineHeight + marginY - height
    if (target !== view) this.scroller.scrollTop = Math.max(0, this.scale.toScroll(target))

    // Horizontally: keep the position clear of both edges of the text area. The line may never have been drawn, so the scrollable width may not reach it yet.
    if (this.rowsFit) return
    let x: number
    if (this.wrapping) x = this.xInRow(line, wrap, row, pos - line.from) + this.originX
    else {
      const cols = columnAt(line.text, line.text.length, this.state.config.tabSize)
      if (cols > this.maxCols) this.growWidth(cols)
      x = this.metrics.paddingX + columnAt(line.text, pos - line.from, this.state.config.tabSize) * charWidth
    }
    const visible = this.viewport.width - this.gutterWidth - this.minimapWidth
    const marginX = Math.min(charWidth * 6, visible / 4)
    const left = this.hscale.toDoc(this.scroller.scrollLeft)
    if (x - marginX < left) this.scroller.scrollLeft = Math.max(0, this.hscale.toScroll(x - marginX))
    else if (x + marginX > left + visible) this.scroller.scrollLeft = this.hscale.toScroll(x + marginX - visible)
  }

  // ----------------------------------------------------------------- focus

  focus(): void {
    this.textarea.focus({ preventScroll: true })
  }

  get hasFocus(): boolean {
    return this.focused
  }

  private setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.root.classList.toggle('enc-focused', focused)
    if (focused) this.restartBlink()
    this.requestRender()
    this.emit(focused ? 'focus' : 'blur')
  }

  private restartBlink(): void {
    this.blink?.cancel()
    this.blink = null
    if (!this.options.cursorBlink || typeof this.cursorsEl.animate !== 'function') return
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    this.blink = this.cursorsEl.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }], {
      duration: 1100,
      iterations: Infinity,
    })
  }

  // ----------------------------------------------------------------- queries for tests and hosts

  /** The number of lines currently in the DOM. */
  get renderedLineCount(): number {
    return this.lineEls.size
  }

  /** The tokenizer work is done up to the end of the document. */
  get highlightDone(): boolean {
    return this.highlighter.done
  }

  /** Whether every line has its real rows (always, when lines do not wrap). */
  get wrapDone(): boolean {
    return !this.wrapping || this.wrapping.complete
  }

  /** Selects a range and scrolls to it. */
  select(anchor: number, head = anchor): void {
    this.dispatch({ selection: EditorSelection.create([new SelectionRange(anchor, head)]), origin: 'select', scrollIntoView: true })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    for (const work of [this.idleWork, this.settleWork]) {
      if (!work) continue
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(work)
      else clearTimeout(work)
    }
    this.blink?.cancel()
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.find.destroy()
    this.review.destroy()
    this.pointer.destroy()
    this.sticky.destroy()
    this.minimap.destroy()
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const entry of this.zones) this.detachZone(entry.zone)
    this.root.remove()
    // A long line counted for this editor is not kept after it.
    forgetColumnIndexes()
  }
}

function isBlankCode(code: number): boolean {
  return code === 32 || code === 9
}

function sameZones(a: readonly Zone[], b: readonly Zone[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index].id !== b[index].id || a[index].after !== b[index].after || a[index].height !== b[index].height) return false
  }
  return true
}
