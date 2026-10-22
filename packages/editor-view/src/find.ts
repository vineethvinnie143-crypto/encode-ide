import {
  EditorSelection,
  SelectionRange,
  compileSearch,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  searchMatches,
  type CompiledSearch,
  type SearchQuery,
} from '@encode/editor'
import type { Text } from '@encode/text'
import type { DecorationSource, MarkSpec } from './decorations'
import type { EditorView } from './view'

/** Matches counted for the "3 of 12" label before it says "10000+". */
const COUNT_LIMIT = 10_000
/** Matches drawn per screenful. */
const DRAW_LIMIT = 1500
const SOURCE = 'find'

const ICONS = {
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
  right: 'M6 4l4 4-4 4',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  replace: 'M3 8h8M8 5l3 3-3 3',
  replaceAll: 'M3 5.5h8M8.5 3l2.5 2.5-2.5 2.5M3 10.5h8M8.5 8l2.5 2.5-2.5 2.5',
} as const

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  return svg
}

interface Widget {
  root: HTMLDivElement
  find: HTMLInputElement
  replace: HTMLInputElement
  count: HTMLSpanElement
  options: Record<'case' | 'word' | 'regexp', HTMLButtonElement>
  expand: HTMLButtonElement
}

/**
 * Find and replace: the box in the editor's corner, the highlights of every
 * match on screen (computed for the lines being drawn, so a huge file costs
 * nothing), and the count.
 */
export class FindController {
  private widget: Widget | null = null
  private isOpen = false
  private query: SearchQuery = { search: '' }
  private compiledSearch: CompiledSearch | null = null
  private replaceOpen = false
  private counting = 0
  private countJob: Generator<void> | null = null
  private total: number | null = null
  private position = 0
  private overLimit = false

  constructor(private readonly view: EditorView) {}

  get opened(): boolean {
    return this.isOpen
  }

  get search(): CompiledSearch | null {
    return this.compiledSearch
  }

  // ------------------------------------------------------------ opening and closing

  open(replace: boolean): void {
    const widget = (this.widget ??= this.build())
    if (!this.isOpen) {
      this.view.widgets.append(widget.root)
      this.isOpen = true
      this.view.root.classList.add('enc-find-open')
    }
    if (replace) this.replaceOpen = true
    widget.root.classList.toggle('enc-replace-open', this.replaceOpen)
    widget.expand.setAttribute('aria-expanded', String(this.replaceOpen))
    const seed = this.seedFromSelection()
    if (seed !== null) {
      this.query = { ...this.query, search: seed }
      widget.find.value = seed
    }
    this.syncOptions()
    this.recompile()
    this.view.setSource(SOURCE, this.source)
    const target = replace && widget.find.value ? widget.replace : widget.find
    target.focus()
    target.select()
    this.startCount()
  }

  /** Closes the box. True when it was open, so Escape can fall through to the next binding otherwise. */
  close(): boolean {
    if (!this.isOpen) return false
    this.isOpen = false
    this.widget?.root.remove()
    this.view.root.classList.remove('enc-find-open')
    this.view.setSource(SOURCE, null)
    this.cancelCount()
    this.view.focus()
    return true
  }

  private seedFromSelection(): string | null {
    const main = this.view.state.selection.main
    if (main.empty) return null
    const text = this.view.state.sliceDoc(main.from, main.to)
    return text.length <= 200 && !text.includes('\n') ? text : null
  }

  // ------------------------------------------------------------ searching

  private recompile(): void {
    this.compiledSearch = this.query.search ? compileSearch(this.query, this.view.state.config.language.wordChars) : null
  }

  setQuery(query: Partial<SearchQuery>, jump = true): void {
    this.query = { ...this.query, ...query }
    this.recompile()
    this.syncOptions()
    this.view.setSource(SOURCE, this.isOpen ? this.source : null)
    if (jump && this.compiledSearch?.regex) this.jumpFrom(this.view.state.selection.main.from)
    this.startCount()
  }

  /** Selects the first match at or after `pos`. */
  private jumpFrom(pos: number): boolean {
    const search = this.compiledSearch
    if (!search?.regex) return false
    const match = findNext(this.view.state.doc, search, pos)
    if (!match) return false
    this.select(match.from, match.to)
    return true
  }

  private select(from: number, to: number): void {
    const view = this.view
    view.dispatch({ selection: new SelectionRange(from, to), origin: 'select' })
    view.scrollToPos(from, true)
  }

  next(): boolean {
    const search = this.compiledSearch
    if (!search?.regex) return false
    const main = this.view.state.selection.main
    const doc = this.view.state.doc
    const onMatch = this.selectedMatch()
    const from = onMatch ? Math.min(doc.length, main.to + (main.empty ? 1 : 0)) : main.from
    const match = findNext(doc, search, from)
    if (!match) return false
    this.select(match.from, match.to)
    this.updatePosition()
    return true
  }

  previous(): boolean {
    const search = this.compiledSearch
    if (!search?.regex) return false
    const main = this.view.state.selection.main
    const match = findPrevious(this.view.state.doc, search, main.from)
    if (!match) return false
    this.select(match.from, match.to)
    this.updatePosition()
    return true
  }

  selectAllMatches(): boolean {
    const search = this.compiledSearch
    if (!search?.regex) return false
    const ranges: SelectionRange[] = []
    for (const match of searchMatches(this.view.state.doc, search)) {
      ranges.push(new SelectionRange(match.from, match.to))
      if (ranges.length >= COUNT_LIMIT) break
    }
    if (!ranges.length) return false
    this.view.dispatch({ selection: EditorSelection.create(ranges, 0), origin: 'select', scrollIntoView: true })
    return true
  }

  replaceCurrent(): boolean {
    const search = this.compiledSearch
    const widget = this.widget
    if (!search?.regex || !widget) return false
    const spec = replaceNext(this.view.state, search, widget.replace.value)
    if (!spec) return false
    this.view.dispatch(spec)
    return true
  }

  replaceEverything(): boolean {
    const search = this.compiledSearch
    const widget = this.widget
    if (!search?.regex || !widget) return false
    const spec = replaceAll(this.view.state, search, widget.replace.value)
    if (!spec) return false
    this.view.dispatch({ ...spec, isolateHistory: true })
    return true
  }

  /** Whether the main selection is exactly a match. */
  private selectedMatch(): boolean {
    const search = this.compiledSearch
    if (!search?.regex) return false
    const main = this.view.state.selection.main
    const found = findNext(this.view.state.doc, search, main.from, false)
    return !!found && found.from === main.from && found.to === main.to
  }

  // ------------------------------------------------------------ highlights

  private readonly source: DecorationSource = {
    marks: (doc: Text, from: number, to: number, out: MarkSpec[]) => {
      const search = this.compiledSearch
      if (!search?.regex) return
      const main = this.view.state.selection.main
      let drawn = 0
      for (const match of searchMatches(doc, search, from, to)) {
        if (match.from === match.to) continue
        const active = match.from === main.from && match.to === main.to
        out.push({ from: match.from, to: match.to, className: active ? 'enc-mark-find enc-mark-find-active' : 'enc-mark-find' })
        if (++drawn >= DRAW_LIMIT) break
      }
    },
  }

  // ------------------------------------------------------------ count

  /** Called when the document changed: the highlights follow by themselves, the count is redone. */
  documentChanged(): void {
    if (this.isOpen) this.startCount()
  }

  stateReplaced(): void {
    this.recompile()
    if (this.isOpen) {
      this.view.setSource(SOURCE, this.source)
      this.startCount()
    }
  }

  private cancelCount(): void {
    if (this.counting) clearTimeout(this.counting)
    this.counting = 0
    this.countJob = null
  }

  private startCount(): void {
    this.cancelCount()
    this.total = null
    this.overLimit = false
    this.renderCount()
    const search = this.compiledSearch
    if (!search?.regex) return
    const doc = this.view.state.doc
    const main = this.view.state.selection.main
    const job = (function* (self: FindController): Generator<void> {
      let total = 0
      let before = 0
      let deadline = performance.now() + 8
      for (const match of searchMatches(doc, search)) {
        if (match.from === match.to) continue
        if (match.from < main.from || (match.from === main.from && match.to < main.to)) before++
        total++
        if (total >= COUNT_LIMIT) {
          self.overLimit = true
          break
        }
        if (performance.now() > deadline) {
          yield
          deadline = performance.now() + 8
        }
      }
      self.total = total
      self.position = before
    })(this)
    this.countJob = job
    const step = () => {
      this.counting = 0
      if (this.countJob !== job) return
      const result = job.next()
      if (result.done) {
        this.renderCount()
        return
      }
      this.counting = window.setTimeout(step, 0)
    }
    step()
  }

  private updatePosition(): void {
    // The label is recomputed; a counted total only needs its index moved.
    this.startCount()
  }

  private renderCount(): void {
    const widget = this.widget
    if (!widget) return
    const search = this.compiledSearch
    let label: string
    let state = ''
    if (!this.query.search) label = ''
    else if (search?.error) {
      label = 'Invalid pattern'
      state = 'error'
    } else if (this.total === null) label = '…'
    else if (this.total === 0) {
      label = 'No results'
      state = 'empty'
    } else {
      const on = this.selectedMatch()
      label = on ? `${this.position + 1} of ${this.total}${this.overLimit ? '+' : ''}` : `${this.total}${this.overLimit ? '+' : ''} found`
    }
    widget.count.textContent = label
    widget.root.dataset.state = state
    widget.find.setAttribute('aria-invalid', String(state === 'error'))
    if (search?.error) widget.count.title = search.error
    else widget.count.removeAttribute('title')
  }

  // ------------------------------------------------------------ widget

  private syncOptions(): void {
    const widget = this.widget
    if (!widget) return
    const states = { case: !!this.query.caseSensitive, word: !!this.query.wholeWord, regexp: !!this.query.regexp }
    for (const key of Object.keys(states) as (keyof typeof states)[]) {
      widget.options[key].setAttribute('aria-pressed', String(states[key]))
    }
  }

  private build(): Widget {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement) => {
      const el = document.createElement(tag)
      el.className = className
      parent?.append(el)
      return el
    }
    const button = (className: string, label: string, parent: HTMLElement, content: Node | string, action: () => void) => {
      const el = make('button', className, parent)
      el.type = 'button'
      el.title = label
      el.setAttribute('aria-label', label)
      // Every button has a key (Alt+C, Enter, Escape...): Tab goes from the find box to the replace box.
      el.tabIndex = -1
      el.append(content)
      // Keep the focus where it is: a click on a button must not blur the input.
      el.addEventListener('mousedown', (event) => event.preventDefault())
      el.addEventListener('click', action)
      return el
    }

    const root = make('div', 'enc-find')
    root.setAttribute('role', 'search')
    const expand = button('enc-find-expand', 'Toggle replace', root, icon(ICONS.right), () => {
      this.replaceOpen = !this.replaceOpen
      root.classList.toggle('enc-replace-open', this.replaceOpen)
      expand.setAttribute('aria-expanded', String(this.replaceOpen))
      if (this.replaceOpen) replace.focus()
    })
    const body = make('div', 'enc-find-body', root)

    const row = make('div', 'enc-find-row', body)
    const field = make('div', 'enc-find-field', row)
    const find = make('input', 'enc-find-input', field)
    find.placeholder = 'Find'
    find.setAttribute('aria-label', 'Find')
    find.spellcheck = false
    find.autocomplete = 'off'
    const toggle = (key: 'case' | 'word' | 'regexp', label: string, text: string) =>
      button('enc-find-option', label, field, text, () => {
        const map = { case: 'caseSensitive', word: 'wholeWord', regexp: 'regexp' } as const
        this.setQuery({ [map[key]]: !this.query[map[key]] })
      })
    const options = {
      case: toggle('case', 'Match case (Alt+C)', 'Aa'),
      word: toggle('word', 'Whole word (Alt+W)', 'ab'),
      regexp: toggle('regexp', 'Regular expression (Alt+R)', '.*'),
    }
    const count = make('span', 'enc-find-count', row)
    count.setAttribute('aria-live', 'polite')
    button('enc-find-button', 'Previous match (Shift+Enter)', row, icon(ICONS.up), () => this.previous())
    button('enc-find-button', 'Next match (Enter)', row, icon(ICONS.down), () => this.next())
    button('enc-find-button', 'Close (Escape)', row, icon(ICONS.close), () => this.close())

    const replaceRow = make('div', 'enc-find-row enc-find-replace-row', body)
    const replaceField = make('div', 'enc-find-field', replaceRow)
    const replace = make('input', 'enc-find-input enc-replace-input', replaceField)
    replace.placeholder = 'Replace'
    replace.setAttribute('aria-label', 'Replace')
    replace.spellcheck = false
    replace.autocomplete = 'off'
    button('enc-find-button', 'Replace (Enter)', replaceRow, icon(ICONS.replace), () => this.replaceCurrent())
    button('enc-find-button', 'Replace all (Ctrl+Alt+Enter)', replaceRow, icon(ICONS.replaceAll), () => this.replaceEverything())

    find.addEventListener('input', () => this.setQuery({ search: find.value }))
    const keys = (event: KeyboardEvent, input: HTMLInputElement) => {
      if (event.isComposing) return
      const mod = this.view.mac ? event.metaKey : event.ctrlKey
      const handled = (run: () => unknown) => {
        event.preventDefault()
        event.stopPropagation()
        run()
      }
      if (event.key === 'Escape') handled(() => this.close())
      else if (event.key === 'Enter' && input === find) handled(() => (event.altKey ? this.selectAllMatches() : event.shiftKey ? this.previous() : this.next()))
      else if (event.key === 'Enter' && input === replace) handled(() => (mod && event.altKey ? this.replaceEverything() : this.replaceCurrent()))
      else if (event.key === 'F3') handled(() => (event.shiftKey ? this.previous() : this.next()))
      else if (event.altKey && !mod && /^[cwr]$/i.test(event.key)) {
        handled(() => {
          const key = event.key.toLowerCase()
          const map = { c: 'caseSensitive', w: 'wholeWord', r: 'regexp' } as const
          const name = map[key as 'c' | 'w' | 'r']
          this.setQuery({ [name]: !this.query[name] })
        })
      } else if (mod && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'h')) {
        handled(() => this.open(event.key === 'h'))
      }
    }
    find.addEventListener('keydown', (event) => keys(event, find))
    replace.addEventListener('keydown', (event) => keys(event, replace))
    return { root, find, replace, count, options, expand }
  }

  destroy(): void {
    this.cancelCount()
    this.widget?.root.remove()
  }
}
