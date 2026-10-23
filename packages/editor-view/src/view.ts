import {
  EditorSelection,
  EditorState,
  Highlighter,
  SelectionRange,
  T,
  Transaction,
  bracketAt,
  columnAt,
  indentWidth,
  indexAtColumn,
  leadingWhitespace,
  nextCluster,
  previousCluster,
  unitWidth,
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
import { DEPRECATED, fillLine, isSimpleText, withBrackets, withSemantic, type DrawnInlay, type InlaySpec, type SemanticSpan } from './line'
import { LineItems } from './line-items'
import { MinimapController } from './minimap'
import { PointerHandler } from './pointer'
import { RectPool } from './rects'
import { ReviewController } from './review-view'
import { SnippetController } from './snippet'
import { StickyController } from './sticky'

/** Lines longer than this are drawn in part: the piece around the viewport. */
export const LONG_LINE = 4000
/** Characters kept on either side of the viewport in a long line. */
const LONG_MARGIN = 800
/** The widest the scrollable area is made, in pixels. */
const MAX_CONTENT_WIDTH = 16_000_000
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
  private viewport = { width: 0, height: 0 }
  private gutterWidth = 0
  private viewWidth = -1
  private contentWidth = 0
  private maxCols = 0
  private origin = 0
  private layerTop = 0
  private rendered: { first: number; last: number } = { first: 0, last: -1 }
  private frame = 0
  private pendingReveal: { pos: number; center: boolean } | null = null
  /** A scroll position asked for by `setState`: set once the scrollable area has the new document's size. */
  private pendingScroll: { top: number; left: number } | null = null
  private bracketCache: { version: number; head: number; pair: [number, number] | null } | null = null
  private blink: Animation | null = null
  private idleWork = 0
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
  /** A server's inlay hints, by line, followed through edits until it answers again. */
  private readonly inlays = new LineItems<InlaySpec>((inlay, from, to) => ({ ...inlay, from, to }))

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
    }
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
    this.disposers.push(() => probeObserver.disconnect())
    if (typeof document !== 'undefined' && document.fonts) {
      const fonts = () => this.onProbeResize()
      document.fonts.addEventListener('loadingdone', fonts)
      this.disposers.push(() => document.fonts.removeEventListener('loadingdone', fonts))
    }

    if (config.parent) config.parent.append(this.root)
    this.measure()
    this.readViewport()
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
    if (set) for (const listener of [...set]) (listener as (...a: Parameters<ViewEvents[K]>) => void)(...args)
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
      this.highlighter.update(tr.changes, tr.state.doc)
      this.folding.documentChanged(tr.changes, before.doc, tr.state.doc)
      this.semantic.map(tr.changes, before.doc)
      this.inlays.map(tr.changes, before.doc)
      this.mapAfterChange(tr.changes)
    }
    // A cursor that reached into a folded block (a search, an undo, Go to line) opens it.
    if (tr.docChanged || tr.selectionChanged) for (const range of tr.state.selection.ranges) this.folding.reveal(range.head)
    if (tr.state.config.language !== before.config.language) {
      this.highlighter.setTokenizer(tr.state.config.language.tokenizer)
      this.highlighter.setBrackets(this.options.bracketColors ? tr.state.config.language.brackets : null)
      this.tokenCache.clear()
    }
    if (tr.state.config.readOnly !== before.config.readOnly) this.root.classList.toggle('enc-readonly', tr.state.config.readOnly)
    if (tr.state.config.tabSize !== before.config.tabSize) this.root.style.setProperty('--enc-tab-size', String(tr.state.config.tabSize))
    if (tr.scrollIntoView) this.pendingReveal = { pos: tr.state.selection.main.head, center: false }
    if (tr.docChanged || tr.selectionChanged) this.restartBlink()
    this.requestRender()
    this.emit('transaction', tr)
  }

  /** Replaces the whole state (another file in the same editor), optionally restoring a scroll position. */
  setState(state: EditorState, scroll?: { top: number; left: number }): void {
    this.state = state
    this.highlighter = this.createHighlighter()
    this.root.classList.toggle('enc-readonly', state.config.readOnly)
    this.sources.clear()
    for (const zone of [...this.attachedZones]) this.detachZone(zone)
    this.zones = []
    this.bracketCache = null
    this.maxCols = 0
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
    Object.assign(this.options, options)
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

  // ----------------------------------------------------------------- measuring

  /** Reads the font metrics from the probe. True when they changed. */
  private measure(): boolean {
    const a = this.probeA.getBoundingClientRect()
    const b = this.probeB.getBoundingClientRect()
    const row = this.probeA.parentElement!.getBoundingClientRect()
    if (!a.width || !row.height) return false
    const charWidth = a.width / PROBE_CHARS
    const lineHeight = row.height
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

  private onProbeResize(): void {
    if (this.destroyed || !this.measure()) return
    // Everything depends on the metrics: positions, widths, the lines' own widths.
    for (const el of this.lineEls.values()) this.release(el)
    this.lineEls.clear()
    this.rendered = { first: 0, last: -1 }
    this.flush()
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
    this.lastScroll = { top: scrollTop, left: scrollLeft }
    if (vertical && this.scale.scaled) this.placeLayers()
    if (sideways) this.placeFixedZones()
    if (!this.coversViewport() || (scrollLeft !== 0 && this.hasLongLines())) this.render()
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
    if (!this.scale.scaled || event.ctrlKey || event.defaultPrevented || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
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
    return above && below
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

  // ----------------------------------------------------------------- rendering

  /** Brings the DOM in line with the state. Usually called through the frame scheduler. */
  render(): void {
    if (this.destroyed) return
    this.readViewport()
    const { height: viewportHeight, width: viewportWidth } = this.viewport
    if (!viewportHeight || !viewportWidth || !this.root.isConnected) return
    const { lineHeight, charWidth } = this.metrics
    const doc = this.state.doc

    // Layout: heights, the scroll scale, the gutter and the scrollable size.
    const hidden = this.hiddenLines()
    const isHidden = (line: number) => hidden.some((range) => range.from <= line && line <= range.to)
    const zoneList: Zone[] = this.zones
      .filter((entry) => !hidden.length || !isHidden(entry.after))
      .sort((a, b) => a.after - b.after)
      .map((entry) => ({ id: entry.id, after: entry.after, height: entry.zone.height }))
    const padBottom = this.options.scrollBeyondEnd ? Math.max(0, viewportHeight - lineHeight * 2) : 0
    if (
      this.heights.lineHeight !== lineHeight ||
      this.heights.lineCount !== doc.lineCount ||
      this.heights.padBottom !== padBottom ||
      !sameZones(this.heights.zoneList, zoneList) ||
      !sameHidden(this.heights.hidden, hidden)
    ) {
      this.heights = new HeightMap(lineHeight, doc.lineCount, zoneList, padBottom, hidden)
    }
    this.scale = new ScrollScale(this.heights.totalHeight, viewportHeight)
    const digits = Math.max(3, String(doc.lineCount).length)
    const foldColumn = this.options.folding ? FOLD_COLUMN : 0
    const gutterWidth = (this.options.lineNumbers ? Math.ceil(GUTTER_PAD_LEFT + digits * charWidth + GUTTER_PAD_RIGHT) : 12) + foldColumn
    this.minimapWidth = this.minimap.widthFor(viewportWidth, gutterWidth)
    // The minimap sits over the right of the text area: the longest line can scroll clear of it.
    const textWidth = this.metrics.paddingX * 2 + this.maxCols * charWidth + this.minimapWidth
    const contentWidth = Math.min(MAX_CONTENT_WIDTH, Math.max(viewportWidth - gutterWidth, Math.ceil(textWidth)))
    if (gutterWidth !== this.gutterWidth) {
      this.gutterWidth = gutterWidth
      this.gutter.style.width = `${gutterWidth}px`
      this.root.style.setProperty('--enc-gutter-w', `${gutterWidth}px`)
    }
    if (contentWidth !== this.contentWidth) {
      this.contentWidth = contentWidth
      this.sizer.style.width = `${gutterWidth + contentWidth}px`
    } else if (this.sizer.style.width === '') {
      this.sizer.style.width = `${gutterWidth + contentWidth}px`
    }
    const scrollHeight = `${this.scale.scrollHeight}px`
    if (this.sizer.style.height !== scrollHeight) this.sizer.style.height = scrollHeight

    if (this.pendingScroll) {
      this.scroller.scrollTop = this.pendingScroll.top
      this.scroller.scrollLeft = this.pendingScroll.left
      this.pendingScroll = null
    }
    if (this.pendingReveal) this.applyReveal()

    const scrollTop = this.scroller.scrollTop
    const scrollLeft = this.scroller.scrollLeft
    this.lastScroll = { top: scrollTop, left: scrollLeft }
    const top = this.scale.toDoc(scrollTop)
    const overscan = Math.max(lineHeight * 12, viewportHeight * 0.6)
    const first = this.heights.lineAt(top - overscan)
    const last = this.heights.lineAt(top + viewportHeight + overscan)
    const origin = this.scale.scaled ? this.heights.top(first) : 0
    if (origin !== this.origin) {
      this.origin = origin
      for (const el of this.lineEls.values()) el.top = NaN
    }
    this.placeLayers()

    this.drawLines(first, last, scrollLeft, viewportWidth - gutterWidth)
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

  /** Puts the layers where the scroll position needs them (they move with it only when the height is scaled). */
  private placeLayers(): void {
    const top = this.scale.toDoc(this.scroller.scrollTop)
    const layerTop = this.scroller.scrollTop + (this.origin - top)
    if (layerTop === this.layerTop && this.layer.style.top) return
    this.layerTop = layerTop
    this.layer.style.top = `${layerTop}px`
    this.gutterLayer.style.top = `${layerTop}px`
  }

  private drawLines(first: number, last: number, scrollLeft: number, visibleWidth: number): void {
    const doc = this.state.doc
    const { charWidth } = this.metrics
    const tabSize = this.state.config.tabSize
    const heights = this.heights
    // Release what scrolled out of range or was folded away.
    for (const [number, el] of this.lineEls) {
      if (number < first || number > last || heights.isHidden(number)) {
        this.release(el)
        this.lineEls.delete(number)
      }
    }
    const active = this.activeLines()
    let widest = this.maxCols
    const unmeasured: LineEl[] = []
    for (let number = heights.nextVisible(first); number <= last; number = heights.nextVisible(number + 1)) {
      const info = doc.line(number)
      const highlighted = this.lineTokens(number)
      let el = this.lineEls.get(number)
      if (!el) {
        el = this.acquire()
        el.line = number
        this.lineEls.set(number, el)
      }
      const top = this.heights.top(number) - this.origin
      if (el.top !== top) {
        el.top = top
        el.dom.style.top = `${top}px`
        if (el.number) el.number.style.top = `${top}px`
      }
      const long = info.text.length > LONG_LINE
      let from = 0
      let to = info.text.length
      if (long) {
        const firstCol = Math.max(0, Math.floor(Math.max(0, scrollLeft) / charWidth) - LONG_MARGIN)
        const lastCol = Math.floor((scrollLeft + visibleWidth) / charWidth) + LONG_MARGIN
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
      // A long line is drawn in part, and with no hints.
      const inlays = long ? undefined : this.inlays.line(number)
      if (el.text !== info.text || !sameTokens(el.tokens, highlighted.tokens) || el.from !== from || el.to !== to || el.exact !== highlighted.exact || el.inlays !== inlays) {
        const lead = from > 0 ? this.spacer(columnAt(info.text, from, tabSize) * charWidth) : undefined
        el.drawnInlays = fillLine(el.dom, info.text, highlighted.tokens, from, to, lead, undefined, inlays)
        el.text = info.text
        el.tokens = highlighted.tokens
        el.from = from
        el.to = to
        el.exact = highlighted.exact
        el.inlays = inlays
        // A line with hints is as wide as the browser draws it.
        el.simple = this.metrics.monospace && !inlays && (long || isSimpleText(info.text))
        if (el.simple || info.text.length > 2000) widest = Math.max(widest, columnAt(info.text, info.text.length, tabSize))
        else unmeasured.push(el)
      }
      if (el.number) {
        const label = String(number)
        if (el.number.textContent !== label) el.number.textContent = label
      }
    }
    // Lines of text with wide or combining characters and markers are as wide as the browser made them; read all of them after the last write.
    for (const el of unmeasured) {
      let x = this.domX(el, el.to)
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

  /** Makes the scrollable area wide enough for `cols` columns. */
  private growWidth(cols: number): void {
    this.maxCols = cols
    const width = Math.min(
      MAX_CONTENT_WIDTH,
      Math.max(this.viewport.width - this.gutterWidth, Math.ceil(this.metrics.paddingX * 2 + cols * this.metrics.charWidth + this.minimapWidth)),
    )
    if (width !== this.contentWidth) {
      this.contentWidth = width
      this.sizer.style.width = `${this.gutterWidth + width}px`
    }
  }

  private spacer(width: number): HTMLElement {
    const span = document.createElement('span')
    span.className = 'enc-pad'
    span.style.display = 'inline-block'
    span.style.width = `${width}px`
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
    return { dom, number, line: 0, text: '', tokens: null, top: NaN, simple: true, from: 0, to: 0, exact: true, inlays: undefined, drawnInlays: [] }
  }

  private release(el: LineEl): void {
    el.dom.remove()
    el.number?.remove()
    el.text = '\0'
    el.tokens = null
    el.top = NaN
    el.inlays = undefined
    el.drawnInlays = []
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
      zone.dom.style.left = `${this.scroller.scrollLeft}px`
      zone.dom.style.width = `${Math.max(0, this.scroller.clientWidth - this.gutterWidth - this.minimapWidth)}px`
    }
  }

  /** The line numbers with a cursor on them. */
  private activeLines(): Set<number> {
    const lines = new Set<number>()
    for (const range of this.state.selection.ranges) lines.add(this.state.doc.lineAt(range.head).number)
    return lines
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
        this.backgrounds.rect('enc-line-active', 0, this.heights.top(number) - this.origin, fullWidth, lineHeight)
      }
    }
    if (this.options.indentGuides) this.drawGuides(first, last)
    const lineSpecs: LineSpec[] = []
    for (const source of this.sources.values()) source.lines?.(doc, first, last, lineSpecs)
    for (const spec of lineSpecs) {
      if (this.heights.isHidden(spec.line)) continue
      this.backgrounds.rect(spec.className, 0, this.heights.top(spec.line) - this.origin, fullWidth, lineHeight)
    }
    this.backgrounds.end()

    // A folded block's first line ends with a marker that opens it.
    this.foldPool.begin()
    if (this.options.folding) {
      for (const range of this.heights.hidden) {
        const header = range.from - 1
        if (header < first || header > last || header < 1) continue
        const line = doc.line(header)
        const el = this.foldPool.rect('', this.xOf(line, line.text.length) + charWidth * 0.6, this.heights.top(header) - this.origin + 3, charWidth * 3, lineHeight - 6)
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
        const x = this.xOf(line, range.head - line.from)
        const top = this.heights.top(line.number) - this.origin
        const main = index === selection.mainIndex ? ' enc-cursor-main' : ''
        if (style === 'block') this.cursorPool.rect(`enc-cursor-block${main}`, x, top, charWidth, lineHeight)
        else if (style === 'underline') this.cursorPool.rect(`enc-cursor-underline${main}`, x, top + lineHeight - 2, charWidth, 2)
        else this.cursorPool.rect(`enc-cursor-line${main}`, x, top, 2, lineHeight)
      })
    }
    this.cursorPool.end()
  }

  /** Draws `from`..`to` as one rectangle per line in view; returns how many it drew. */
  private drawRange(pool: RectPool, from: number, to: number, className: string, first: number, last: number, selection: boolean, limit: number): number {
    const doc = this.state.doc
    const { lineHeight, charWidth } = this.metrics
    const startLine = Math.max(first, doc.lineAt(from).number)
    const endLine = Math.min(last, doc.lineAt(to).number)
    const heights = this.heights
    let drawn = 0
    for (let number = heights.nextVisible(startLine); number <= endLine && drawn < limit; number = heights.nextVisible(number + 1)) {
      const line = doc.line(number)
      const start = Math.max(from, line.from) - line.from
      const end = Math.min(to, line.to) - line.from
      const left = this.xOf(line, start)
      let right = end === start ? left : this.xOf(line, end)
      // A selection that runs on past the line's end shows the line break.
      if (selection && to > line.to) right += charWidth * SHORT
      else if (!selection && right === left) right = left + 2
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
      const el = this.backgrounds.rect('enc-guides', paddingX, this.heights.top(number) - this.origin, count * unit * charWidth, lineHeight)
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
    const { charWidth, paddingX } = this.metrics
    const el = this.lineEls.get(line.number)
    if (el && !el.simple && el.text === line.text) {
      const x = this.domX(el, offset)
      if (x !== null) return x
    }
    return paddingX + columnAt(line.text, offset, this.state.config.tabSize) * charWidth
  }

  private range: Range | null = null

  /** x of `offset` measured in the DOM, relative to the line element; null when it cannot be. */
  private domX(el: LineEl, offset: number): number | null {
    if (offset < el.from || offset > el.to) return null
    // At a type's hint the caret stays with the text before it: the hint's left edge.
    for (const inlay of el.drawnInlays) {
      if (inlay.col === offset && inlay.caretBefore) return inlay.el.getBoundingClientRect().left - el.dom.getBoundingClientRect().left
      if (inlay.col > offset) break
    }
    const walker = document.createTreeWalker(el.dom, NodeFilter.SHOW_TEXT)
    let position = el.from
    let last: Text | null = null
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const end = position + node.data.length
      if (offset < end) return this.measureAt(el, node, offset - position)
      position = end
      last = node
    }
    return last ? this.measureAt(el, last, last.data.length) : this.metrics.paddingX
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
    if (index < length) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return range.getBoundingClientRect().left - base
    }
    range.setStart(node, index - 1)
    range.setEnd(node, index)
    return range.getBoundingClientRect().right - base
  }

  /** The offset in `line` nearest to x (measured as in `xOf`). */
  offsetAtX(line: Line, x: number): number {
    const { charWidth, paddingX } = this.metrics
    const tabSize = this.state.config.tabSize
    const el = this.lineEls.get(line.number)
    if (!el || el.simple || el.text !== line.text) {
      return indexAtColumn(line.text, Math.max(0, (x - paddingX) / charWidth), tabSize)
    }
    const text = line.text
    // A point on a hint is its column: the hint is no text to put the caret inside.
    if (el.drawnInlays.length) {
      const base = el.dom.getBoundingClientRect().left
      for (const inlay of el.drawnInlays) {
        const box = inlay.el.getBoundingClientRect()
        if (x >= box.left - base && x < box.right - base) return inlay.col
      }
    }
    let low = el.from
    let high = el.to
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((this.domX(el, mid) ?? Infinity) < x) low = mid + 1
      else high = mid
    }
    // `low` is the first offset at or right of x. The caret goes to the character boundary there or to the one before it, whichever is nearer.
    const after = low <= 0 ? 0 : low >= text.length ? text.length : nextCluster(text, previousCluster(text, low))
    const before = after <= 0 ? 0 : previousCluster(text, after)
    const afterX = this.domX(el, after) ?? x
    const beforeX = this.domX(el, before) ?? x
    return x - beforeX < afterX - x ? before : after
  }

  /** Where `pos` is inside the editor's layers: x from the text area's left edge, y from the top of the drawn window. */
  layerCoords(pos: number): { x: number; y: number } {
    const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length))
    return { x: this.xOf(line, pos - line.from), y: this.heights.top(line.number) - this.origin }
  }

  /** The document position at client coordinates. */
  posAtCoords(clientX: number, clientY: number): number {
    const doc = this.state.doc
    const scrollerRect = this.scroller.getBoundingClientRect()
    const docY = this.scale.toDoc(this.scroller.scrollTop) + (clientY - scrollerRect.top)
    // Above the first line and below the last are the start and the end of the document, whatever x is.
    if (docY < 0) return 0
    if (docY >= this.heights.contentHeight) return doc.length
    const number = Math.min(doc.lineCount, Math.max(1, this.heights.lineAt(docY)))
    const line = doc.line(number)
    const x = clientX - this.content.getBoundingClientRect().left
    return line.from + this.offsetAtX(line, x)
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

  /** Client coordinates of the caret position `pos`: where a popup would anchor. */
  coordsAtPos(pos: number): { left: number; top: number; bottom: number } {
    const doc = this.state.doc
    const line = doc.lineAt(pos)
    const scrollerRect = this.scroller.getBoundingClientRect()
    const x = this.xOf(line, pos - line.from)
    const top = scrollerRect.top + (this.heights.top(line.number) - this.scale.toDoc(this.scroller.scrollTop))
    return { left: this.content.getBoundingClientRect().left + x, top, bottom: top + this.metrics.lineHeight }
  }

  /** Whether `pos` is on screen. */
  isVisible(pos: number): boolean {
    const line = this.state.doc.lineAt(pos)
    const top = this.heights.top(line.number)
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
    const lineTop = this.heights.top(line.number)
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
    const cols = columnAt(line.text, line.text.length, this.state.config.tabSize)
    if (cols > this.maxCols) this.growWidth(cols)
    const x = this.metrics.paddingX + columnAt(line.text, pos - line.from, this.state.config.tabSize) * charWidth
    const visible = this.viewport.width - this.gutterWidth - this.minimapWidth
    const marginX = Math.min(charWidth * 6, visible / 4)
    const left = this.scroller.scrollLeft
    if (x - marginX < left) this.scroller.scrollLeft = Math.max(0, x - marginX)
    else if (x + marginX > left + visible) this.scroller.scrollLeft = x + marginX - visible
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

  /** Selects a range and scrolls to it. */
  select(anchor: number, head = anchor): void {
    this.dispatch({ selection: EditorSelection.create([new SelectionRange(anchor, head)]), origin: 'select', scrollIntoView: true })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.idleWork) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.idleWork)
      else clearTimeout(this.idleWork)
    }
    this.blink?.cancel()
    this.find.destroy()
    this.review.destroy()
    this.pointer.destroy()
    this.sticky.destroy()
    this.minimap.destroy()
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const entry of this.zones) this.detachZone(entry.zone)
    this.root.remove()
  }
}

function sameZones(a: readonly Zone[], b: readonly Zone[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index].id !== b[index].id || a[index].after !== b[index].after || a[index].height !== b[index].height) return false
  }
  return true
}
