import { EditorSelection, Highlighter, acceptHunk, rejectHunks, reviewHunks, reviewStats, wordChanges, type ReviewHunk } from '@encode/editor'
import { Text } from '@encode/text'
import { DecorationSet, type LineSpec, type MarkSpec } from './decorations'
import { fillLine } from './line'
import type { EditorView, ViewZone } from './view'

/** Removed lines drawn per hunk; a rewrite of a whole file would otherwise put thousands of rows in the DOM. */
const MAX_REMOVED_SHOWN = 300
/** Origins of edits made by typing: the hunks are not recomputed for every one of them. */
const TYPING = new Set(['input.type', 'input.delete', 'input.newline'])
/** How long after the last keystroke the hunks are worked out again. */
const RECOMPUTE_DELAY = 90
const SOURCE = 'review'

export interface ReviewChange {
  hunks: readonly ReviewHunk[]
  added: number
  removed: number
  /** The diff ran out of time: the hunks are correct but coarser than they could be. */
  approximate: boolean
}

export interface ReviewLabels {
  keep: string
  undo: string
}

const DEFAULT_LABELS: ReviewLabels = { keep: 'Keep', undo: 'Undo' }

/**
 * Review of the document against a baseline, in the editor: added lines are
 * tinted, removed lines show above them with the words that changed marked,
 * and every hunk has Keep and Undo. Keeping a hunk moves it into the
 * baseline; undoing it puts the baseline's lines back as one undo step.
 */
export class ReviewController {
  private baselineLines: string[] | null = null
  private current: ReviewHunk[] = []
  private approximate = false
  private timer = 0
  private baselineHighlighter: Highlighter | null = null
  private highlighterLanguage: unknown = null
  private zoneDom = new Map<string, HTMLElement>()
  private listeners = new Set<(change: ReviewChange) => void>()
  labels: ReviewLabels = DEFAULT_LABELS

  constructor(private readonly view: EditorView) {
    view.on('transaction', (tr) => {
      if (!this.baselineLines || !tr.docChanged) return
      // Keystrokes wait for a pause; everything else (undo, a button, an edit from outside) shows at once.
      if (tr.origin && TYPING.has(tr.origin)) this.schedule()
      else this.compute()
    })
  }

  get active(): boolean {
    return this.baselineLines !== null
  }

  get hunks(): readonly ReviewHunk[] {
    return this.current
  }

  get baseline(): readonly string[] {
    return this.baselineLines ?? []
  }

  on(listener: (change: ReviewChange) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Starts reviewing against `baseline`: the file as it was before the changes under review. */
  start(baseline: string | readonly string[]): void {
    this.baselineLines = typeof baseline === 'string' ? baseline.replace(/\r\n?/g, '\n').split('\n') : [...baseline]
    this.baselineHighlighter = null
    this.compute()
  }

  stop(): void {
    if (!this.baselineLines) return
    this.baselineLines = null
    this.baselineHighlighter = null
    this.current = []
    this.cancel()
    this.view.setSource(SOURCE, null)
    this.view.setZones(SOURCE, [])
    this.zoneDom.clear()
    this.emit()
  }

  /** The view replaced its whole state: nothing carries over. */
  stateReplaced(): void {
    this.cancel()
    this.baselineLines = null
    this.baselineHighlighter = null
    this.current = []
    this.zoneDom.clear()
    this.emit()
  }

  // ------------------------------------------------------------ actions

  accept(hunk: ReviewHunk): void {
    if (!this.baselineLines) return
    this.refresh()
    const target = this.find(hunk)
    if (!target) return
    this.baselineLines = acceptHunk(this.baselineLines, target, this.view.state.doc)
    this.baselineHighlighter = null
    this.compute()
  }

  reject(hunk: ReviewHunk): void {
    if (!this.baselineLines) return
    this.refresh()
    const target = this.find(hunk)
    if (!target) return
    const tr = rejectHunks(this.view.state, [target])
    if (tr) this.view.dispatch(tr)
  }

  acceptAll(): void {
    if (!this.baselineLines) return
    this.baselineLines = this.view.state.doc.lineTexts()
    this.baselineHighlighter = null
    this.compute()
  }

  rejectAll(): void {
    if (!this.baselineLines) return
    this.refresh()
    const tr = rejectHunks(this.view.state, this.current)
    if (tr) this.view.dispatch(tr)
  }

  /** Moves to the next hunk after the cursor (the first when there is none), true when there is one. */
  next(): boolean {
    return this.go(1)
  }

  previous(): boolean {
    return this.go(-1)
  }

  private go(direction: 1 | -1): boolean {
    this.refresh()
    if (!this.current.length) return false
    const doc = this.view.state.doc
    const line = doc.lineAt(this.view.state.selection.main.head).number
    const lineOf = (hunk: ReviewHunk) => Math.min(doc.lineCount, hunk.fromB + 1)
    let target: ReviewHunk | undefined
    if (direction === 1) target = this.current.find((hunk) => lineOf(hunk) > line) ?? this.current[0]
    else target = [...this.current].reverse().find((hunk) => lineOf(hunk) < line) ?? this.current[this.current.length - 1]
    const pos = doc.line(lineOf(target)).from
    this.view.dispatch({ selection: EditorSelection.cursor(pos), origin: 'select' })
    this.view.scrollToPos(pos, true)
    return true
  }

  private find(hunk: ReviewHunk): ReviewHunk | undefined {
    return this.current.find((candidate) => candidate.key === hunk.key) ?? undefined
  }

  // ------------------------------------------------------------ recomputing

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = 0
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.compute()
    }, RECOMPUTE_DELAY)
  }

  /** Brings the hunks up to date when an edit is still waiting to be diffed. */
  private refresh(): void {
    if (!this.timer) return
    this.cancel()
    this.compute()
  }

  private compute(): void {
    this.cancel()
    if (!this.baselineLines) return
    const doc = this.view.state.doc
    const result = reviewHunks(this.baselineLines, doc, { timeoutMs: 250 })
    this.current = result.hunks
    this.approximate = result.approximate
    this.render()
    this.emit()
  }

  private emit(): void {
    const { added, removed } = reviewStats(this.current)
    const change: ReviewChange = { hunks: this.current, added, removed, approximate: this.approximate }
    for (const listener of [...this.listeners]) listener(change)
  }

  // ------------------------------------------------------------ drawing

  private render(): void {
    const view = this.view
    const doc = view.state.doc
    const marks: MarkSpec[] = []
    const lines: LineSpec[] = []
    const gutter: LineSpec[] = []
    const zones: ViewZone[] = []
    const alive = new Set<string>()
    for (const hunk of this.current) {
      const added = hunk.toB - hunk.fromB
      for (let number = hunk.fromB + 1; number <= hunk.toB; number++) {
        lines.push({ line: number, className: 'enc-line-inserted' })
        gutter.push({ line: number, className: hunk.removed.length ? 'enc-gutter-modified' : 'enc-gutter-inserted' })
      }
      if (!added) gutter.push({ line: Math.min(doc.lineCount, hunk.fromB + 1), className: 'enc-gutter-deleted' })
      const words = wordChanges(hunk, doc)
      const removedMarks = new Map<number, [number, number][]>()
      if (words) {
        const starts: number[] = []
        let offset = 0
        for (const text of hunk.removed) {
          starts.push(offset)
          offset += text.length + 1
        }
        for (const change of words) {
          if (change.toB > change.fromB) marks.push({ from: change.fromB, to: change.toB, className: 'enc-mark-inserted' })
          if (change.toA > change.fromA) addRemovedRange(removedMarks, starts, hunk.removed, change.fromA, change.toA)
        }
      }
      const signature = JSON.stringify([view.metrics.lineHeight, hunk.removed, [...removedMarks]])
      alive.add(signature)
      const shown = Math.min(hunk.removed.length, MAX_REMOVED_SHOWN)
      const rows = shown + (hunk.removed.length > shown ? 1 : 0)
      const height = rows * view.metrics.lineHeight
      let dom = this.zoneDom.get(signature)
      if (!dom) {
        dom = this.buildZone(hunk, shown, removedMarks, height)
        this.zoneDom.set(signature, dom)
      }
      this.bindActions(dom, hunk)
      zones.push({ after: hunk.fromB, height, dom })
    }
    for (const key of [...this.zoneDom.keys()]) if (!alive.has(key)) this.zoneDom.delete(key)
    view.setSource(SOURCE, DecorationSet.of(doc, { marks, lines, gutter }))
    view.setZones(SOURCE, zones)
  }

  private buildZone(hunk: ReviewHunk, shown: number, marks: Map<number, [number, number][]>, height: number): HTMLElement {
    const lineHeight = this.view.metrics.lineHeight
    const dom = document.createElement('div')
    dom.className = height ? 'enc-zone enc-zone-removed' : 'enc-zone'
    const pin = document.createElement('div')
    pin.className = 'enc-zone-pin'
    const actions = document.createElement('div')
    actions.className = 'enc-hunk-actions'
    actions.style.top = `${height}px`
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', 'Review this change')
    for (const [kind, label] of [['undo', this.labels.undo], ['keep', this.labels.keep]] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `enc-hunk-action enc-hunk-action-${kind}`
      button.textContent = label
      button.dataset.action = kind
      // Do not move the editor's focus or start a selection.
      button.addEventListener('mousedown', (event) => event.preventDefault())
      actions.append(button)
    }
    pin.append(actions)
    dom.append(pin)
    if (shown) {
      const highlighter = this.removedHighlighter()
      for (let index = 0; index < shown; index++) {
        const text = hunk.removed[index]
        const row = document.createElement('div')
        row.className = 'enc-zone-line'
        row.style.height = `${lineHeight}px`
        const tokens = highlighter ? highlighter.line(hunk.fromA + index + 1).tokens : []
        fillLine(row, text, tokens, 0, text.length, undefined, marks.get(index))
        dom.append(row)
      }
      if (hunk.removed.length > shown) {
        const more = document.createElement('div')
        more.className = 'enc-zone-line enc-zone-more'
        more.textContent = `${hunk.removed.length - shown} more removed lines`
        dom.append(more)
      }
    }
    return dom
  }

  /** Points the buttons of a (possibly reused) zone at the hunk it now stands for. */
  private bindActions(dom: HTMLElement, hunk: ReviewHunk): void {
    for (const button of dom.querySelectorAll<HTMLButtonElement>('.enc-hunk-action')) {
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (button.dataset.action === 'keep') this.accept(hunk)
        else this.reject(hunk)
      }
    }
  }

  /** Highlights the baseline's lines with the document's language. */
  private removedHighlighter(): Highlighter | null {
    const language = this.view.state.config.language
    if (!this.baselineLines) return null
    if (!this.baselineHighlighter || this.highlighterLanguage !== language) {
      this.baselineHighlighter = new Highlighter(language.tokenizer, Text.of(this.baselineLines.join('\n')))
      this.highlighterLanguage = language
      this.zoneDom.clear()
    }
    return this.baselineHighlighter
  }
}

/** Splits a range of the removed text (lines joined with "\n") into per-line ranges. */
function addRemovedRange(into: Map<number, [number, number][]>, starts: readonly number[], lines: readonly string[], from: number, to: number): void {
  for (let index = 0; index < lines.length; index++) {
    const start = starts[index]
    const end = start + lines[index].length
    if (to <= start || from > end) continue
    const a = Math.max(from, start) - start
    const b = Math.min(to, end) - start
    if (b <= a) continue
    const list = into.get(index) ?? []
    list.push([a, b])
    into.set(index, list)
  }
}
