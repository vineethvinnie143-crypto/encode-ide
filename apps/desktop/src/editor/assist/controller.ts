import { EditorSelection, SelectionRange, parseSnippet, type Transaction } from '@encode/editor'
import { DecorationSet, type EditorView, type MarkSpec } from '@encode/editor-view'
import { ChangeSet } from '@encode/text'
import type { CompletionEntry, EditorTriggers, SignatureHelp } from '@shared/types'
import { create } from '../../store'
import { applyServerEdits } from '../docs'
import { positionOf } from '../marks'
import { askServers, lspAt, triggersFor } from './ask'
import { Since, commitCharactersOf, editsElsewhere, firstSelected, indentAt, indentText, isWordText, itemStart, planCompletion, rankEntries, wordStart, type Ranked } from './completion'
import { indentOf } from './format'
import { snippetVariable } from './variables'

/** Where a widget belongs on screen: the client box of a place in the text. */
export interface Anchor {
  left: number
  top: number
  bottom: number
}

export interface SuggestView {
  items: Ranked[]
  selected: number
  anchor: Anchor
  /** Asked for and not answered yet. */
  loading: boolean
  /** Asked for by the person, and nothing came: the list says so instead of not opening. */
  empty: boolean
  /** The selected item's details are shown beside the list. */
  details: boolean
}

export interface SignatureView {
  help: SignatureHelp
  /** The signature shown, of `help.signatures`. */
  active: number
  anchor: Anchor
}

interface AssistState {
  suggest: SuggestView | null
  signature: SignatureView | null
}

/** What the editor's widgets show; one editor, so one store. */
export const useAssist = create<AssistState>(() => ({ suggest: null, signature: null }))

/** Typing more of a word waits this long before asking for suggestions, so a fast typist sends one question, not one per key. */
const QUICK_MS = 40
/** The other places of the symbol at the cursor are asked for once the cursor rests. */
const HIGHLIGHT_MS = 250
/** A call's parameters are asked for again after the cursor moved or the text changed in it. */
const SIGNATURE_MS = 80
/** How long a late answer of the server still fills in an accepted item's edits elsewhere (an import). */
const LATE_EDITS_MS = 3_000
/** Rows the list moves by on Page Up and Page Down. */
const PAGE = 8

/** Whether the list shows the selected item's details: Ctrl+Space with the list open turns them on or off, for every list after it. */
let showDetails = false

interface CompletionSession {
  list: number
  incomplete: boolean
  entries: CompletionEntry[]
  since: Since
  /** The start of the word the list was asked for, in the document now. */
  start: number
  /** The line it is on, 1-based. */
  line: number
  explicit: boolean
  /** The id of the selected item, kept through filtering. */
  selectedId: number | null
  details: boolean
}

interface PendingCompletion {
  token: number
  since: Since
  start: number
  line: number
  explicit: boolean
}

/** A taken item the server had not filled in yet, whose edits elsewhere (an import) go in once its answer comes. */
interface LateEdits {
  /** The changes since its list was asked for: the item's own text, and what was typed after it. */
  since: Since
  list: number
  id: number
  /** How many edits elsewhere the item had when taken, which went in with it. */
  had: number
  until: number
}

/** The text typed by the last transaction just before the cursor: one character, or what an input method committed. */
function typedText(tr: Transaction): string | null {
  if (tr.origin !== 'input.type' || !tr.docChanged) return null
  const main = tr.state.selection.main
  if (!main.empty) return null
  const head = main.head
  for (const change of tr.changes.changes) {
    const start = tr.changes.mapPos(change.from, -1)
    if (head > start && head <= start + change.insert.length) {
      const before = tr.state.doc.sliceString(Math.max(start, head - 2), head)
      // One character, which may take two UTF-16 units.
      const last = Array.from(before).pop() ?? ''
      return last
    }
  }
  return null
}

/**
 * What the language servers add to the editor as it is used: suggestions while typing (and on Ctrl+Space), with
 * snippets, edits elsewhere such as imports, and the characters that accept one; the parameters of the call the
 * cursor is in; and the other places of the symbol at the cursor. One per editor view; the file it shows is set
 * with `show`. The widgets read `useAssist`.
 */
export class EditorAssist {
  private path: string | null = null
  private triggers: EditorTriggers | null = null
  private session: CompletionSession | null = null
  private pending: PendingCompletion | null = null
  private token = 0
  private quickTimer: number | undefined
  private resolveTimer: number | undefined
  private readonly resolving = new Map<string, Promise<CompletionEntry | null>>()
  private late: LateEdits | null = null

  private signature: { help: SignatureHelp; active: number } | null = null
  private signatureToken = 0
  private signatureTimer: number | undefined

  private highlightTimer: number | undefined
  private highlightToken = 0
  private highlighted: { from: number; to: number }[] | null = null

  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    private readonly options: {
      suggestOnType?: () => boolean
      /** Whether the server formats a line as it is typed, after the characters it names (`;`, `}`, a new line). */
      formatOnType?: () => boolean
    } = {},
  ) {
    this.stops.push(view.on('transaction', (tr) => this.onTransaction(tr)))
    this.stops.push(view.on('blur', () => this.onBlur()))
    this.stops.push(view.on('viewport', () => this.reposition()))
    const onKey = (event: KeyboardEvent) => this.onKey(event)
    view.root.addEventListener('keydown', onKey, true)
    this.stops.push(() => view.root.removeEventListener('keydown', onKey, true))
  }

  /** The editor shows another file, or none. */
  show(path: string | null): void {
    this.closeSuggest()
    this.closeSignature()
    this.clearHighlights()
    this.late = null
    this.path = path
    this.triggers = null
    if (path) this.refreshTriggers()
  }

  /** A server started or stopped: what typing asks of it may have changed. */
  refreshTriggers(): void {
    const path = this.path
    if (!path) return
    void triggersFor(path).then((found) => {
      if (this.path === path) this.triggers = found
    })
  }

  dispose(): void {
    this.show(null)
    for (const stop of this.stops.splice(0)) stop()
  }

  // ------------------------------------------------------------ what the person asks for

  /** Ctrl+Space: suggestions here and now, or the details of the selected one when the list is open. */
  suggest(): void {
    if (this.session && useAssist.getState().suggest?.items.length) {
      showDetails = !showDetails
      this.session.details = showDetails
      this.publish()
      return
    }
    void this.requestCompletion(1, undefined, true)
  }

  /** Ctrl+Shift+Space: the parameters of the call the cursor is in. */
  parameterHints(): void {
    void this.requestSignature(1, undefined)
  }

  /** Accepts the item at `index` of the list as shown; `replace` puts it in place of the whole word under the cursor. */
  accept(index: number, mode: 'insert' | 'replace' = 'insert'): void {
    const session = this.session
    const shown = useAssist.getState().suggest
    const ranked = shown?.items[index]
    if (!session || !ranked) return
    const entry = session.entries.find((item) => item.id === ranked.entry.id) ?? ranked.entry
    this.closeSuggest()
    this.insert(entry, session, mode)
  }

  /** Moves the list's selection, wrapping at the ends; `page` moves a page and stops at the ends. */
  move(delta: number, page = false): void {
    const shown = useAssist.getState().suggest
    if (!shown || !shown.items.length || !this.session) return
    const count = shown.items.length
    let next = shown.selected + delta
    if (page) next = Math.max(0, Math.min(count - 1, next))
    else next = ((next % count) + count) % count
    this.select(next)
  }

  /** Selects an item of the list as shown (pointed at, or moved to). */
  select(index: number): void {
    const shown = useAssist.getState().suggest
    if (!shown || !this.session || !shown.items[index]) return
    this.session.selectedId = shown.items[index].entry.id
    useAssist.setState({ suggest: { ...shown, selected: index } })
    this.resolveSoon()
  }

  /** Closes the list, as Escape does. */
  closeSuggest(): void {
    this.token++
    this.pending = null
    this.session = null
    window.clearTimeout(this.quickTimer)
    window.clearTimeout(this.resolveTimer)
    if (useAssist.getState().suggest) useAssist.setState({ suggest: null })
  }

  closeSignature(): void {
    this.signatureToken++
    this.signature = null
    window.clearTimeout(this.signatureTimer)
    if (useAssist.getState().signature) useAssist.setState({ signature: null })
  }

  /** Shows the next or the previous signature of the call. */
  cycleSignature(delta: number): void {
    const signature = this.signature
    if (!signature) return
    const count = signature.help.signatures.length
    signature.active = (((signature.active + delta) % count) + count) % count
    this.publishSignature()
  }

  // ------------------------------------------------------------ the editor's events

  private onTransaction(tr: Transaction): void {
    if (!this.path) return
    const typed = typedText(tr)
    if (tr.docChanged) {
      const typing = tr.origin === 'input.type' || tr.origin === 'input.delete'
      for (const follow of [this.session, this.pending]) {
        if (!follow) continue
        follow.since.add(tr.changes)
        follow.start = tr.changes.mapPos(follow.start, -1)
      }
      if (this.late) {
        if (Date.now() > this.late.until) this.late = null
        else this.late.since.add(tr.changes)
      }
      if (!typing && (this.session || this.pending)) this.closeSuggest()
      this.clearHighlights()
    }
    if (this.session || this.pending) this.followSuggest(typed)
    else if (typed) this.maybeSuggest(typed)
    this.followSignature(tr, typed)
    const ended = typed ?? (tr.origin === 'input.newline' && tr.docChanged ? '\n' : null)
    if (ended && this.triggers?.format.includes(ended) && this.options.formatOnType?.()) this.formatTyped(ended)
    if (tr.docChanged || tr.selectionChanged) this.scheduleHighlights()
  }

  private onBlur(): void {
    // A click on the list keeps the focus in the editor (the list takes none), so leaving it closes everything.
    this.closeSuggest()
    this.closeSignature()
  }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return
    const shown = useAssist.getState().suggest
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (shown) {
      if (event.key === 'Escape' && plain && !event.shiftKey) return (this.closeSuggest(), handled())
      if (shown.items.length) {
        if (plain && !event.shiftKey) {
          if (event.key === 'ArrowDown') return (this.move(1), handled())
          if (event.key === 'ArrowUp') return (this.move(-1), handled())
          if (event.key === 'PageDown') return (this.move(PAGE, true), handled())
          if (event.key === 'PageUp') return (this.move(-PAGE, true), handled())
          if (event.key === 'Enter' || event.key === 'Tab') return (this.accept(shown.selected), handled())
        }
        if (plain && event.shiftKey && event.key === 'Enter') return (this.accept(shown.selected, 'replace'), handled())
        // A character that accepts the item and is then typed, as `.` after a name: the key goes on to type it.
        if (plain && event.key.length === 1 && this.session) {
          const entry = shown.items[shown.selected].entry
          if (commitCharactersOf(entry, this.triggers?.commit ?? []).includes(event.key)) this.accept(shown.selected)
        }
      }
      return
    }
    if (this.signature) {
      if (event.key === 'Escape' && plain && !event.shiftKey) return (this.closeSignature(), handled())
      if (plain && !event.shiftKey && this.signature.help.signatures.length > 1) {
        if (event.key === 'ArrowDown') return (this.cycleSignature(1), handled())
        if (event.key === 'ArrowUp') return (this.cycleSignature(-1), handled())
      }
    }
  }

  // ------------------------------------------------------------ suggestions

  /** Typing with no list open: a trigger character asks at once, a letter of a word after a short pause. */
  private maybeSuggest(typed: string): void {
    const state = this.view.state
    if (this.triggers?.completion.includes(typed)) {
      void this.requestCompletion(2, typed, false)
      return
    }
    if (!isWordText(state, typed) || this.options.suggestOnType?.() === false) return
    window.clearTimeout(this.quickTimer)
    this.quickTimer = window.setTimeout(() => {
      if (!this.session && !this.pending) void this.requestCompletion(1, undefined, false)
    }, QUICK_MS)
  }

  /** The list follows the cursor: what was typed filters it, and leaving the word closes it. */
  private followSuggest(typed: string | null): void {
    const follow = this.session ?? this.pending
    if (!follow) return
    const state = this.view.state
    const main = state.selection.main
    const cursor = main.head
    if (!main.empty || state.doc.lineAt(cursor).number !== follow.line || cursor < follow.start) return this.closeSuggest()
    if (typed !== null && !isWordText(state, typed)) {
      // A trigger character asks again (`a.b.` after `a.b`); anything else ends the word.
      if (this.triggers?.completion.includes(typed)) {
        this.closeSuggest()
        void this.requestCompletion(2, typed, false)
      } else this.closeSuggest()
      return
    }
    const word = state.doc.sliceString(follow.start, cursor)
    if (word && !isWordText(state, word)) return this.closeSuggest()
    const session = this.session
    if (!session) return
    if (session.incomplete && typed !== null) void this.requestCompletion(3, undefined, session.explicit)
    this.publish()
  }

  private async requestCompletion(triggerKind: 1 | 2 | 3, triggerCharacter: string | undefined, explicit: boolean): Promise<void> {
    const path = this.path
    if (!path) return
    const state = this.view.state
    if (state.config.readOnly) return
    const cursor = state.selection.main.head
    const token = ++this.token
    window.clearTimeout(this.quickTimer)
    const pending: PendingCompletion = { token, since: new Since(state.doc), start: wordStart(state, cursor), line: state.doc.lineAt(cursor).number, explicit }
    this.pending = pending
    if (explicit && !this.session) {
      // "Loading" only once the person asked and it takes a moment.
      window.setTimeout(() => {
        if (this.token === token && this.pending === pending && !this.session) this.publishLoading(pending)
      }, 200)
    }
    const { line, character } = lspAt(state.doc, cursor)
    const result = await askServers({ kind: 'complete', path, line, character, triggerKind, ...(triggerCharacter ? { triggerCharacter } : {}) })
    if (token !== this.token || this.path !== path || this.pending !== pending) return
    this.pending = null
    if (!result || !result.items.length) {
      // An incomplete list typed into keeps what it had; one asked for shows that nothing came.
      if (this.session && triggerKind === 3) return
      this.session = null
      if (explicit) useAssist.setState({ suggest: { items: [], selected: 0, anchor: this.anchorOf(pending.start), loading: false, empty: true, details: false } })
      else if (useAssist.getState().suggest) useAssist.setState({ suggest: null })
      return
    }
    const keep = this.session
    this.session = {
      list: result.list,
      incomplete: result.incomplete,
      entries: result.items,
      since: pending.since,
      start: pending.start,
      line: pending.line,
      explicit: explicit || (keep?.explicit ?? false),
      selectedId: null,
      details: showDetails,
    }
    this.publish()
  }

  /** The list as it stands for what is typed now. */
  private publish(): void {
    const session = this.session
    if (!session) return
    const state = this.view.state
    const cursor = state.selection.main.head
    const typedOf = (entry: CompletionEntry): string => {
      const from = itemStart(entry, session.since, session.start)
      return from < cursor ? state.doc.sliceString(from, cursor) : ''
    }
    const items = rankEntries(session.entries, typedOf)
    if (!items.length) {
      // Nothing matches what was typed: the list goes, and comes back on the next word.
      if (useAssist.getState().suggest) useAssist.setState({ suggest: null })
      return
    }
    const typedNothing = cursor <= session.start
    let selected = session.selectedId === null ? -1 : items.findIndex((item) => item.entry.id === session.selectedId)
    if (selected < 0) {
      selected = firstSelected(items, typedNothing)
      session.selectedId = items[selected].entry.id
    }
    useAssist.setState({ suggest: { items, selected, anchor: this.anchorOf(session.start), loading: false, empty: false, details: session.details } })
    this.resolveSoon()
  }

  private publishLoading(pending: PendingCompletion): void {
    useAssist.setState({ suggest: { items: [], selected: 0, anchor: this.anchorOf(pending.start), loading: true, empty: false, details: false } })
  }

  /** The selected item's documentation and edits, from the server, once the selection rests. */
  private resolveSoon(): void {
    window.clearTimeout(this.resolveTimer)
    this.resolveTimer = window.setTimeout(() => {
      const session = this.session
      const shown = useAssist.getState().suggest
      const entry = shown?.items[shown.selected]?.entry
      if (session && entry && !entry.resolved) void this.resolve(session, entry.id)
    }, 50)
  }

  /**
   * The item as the server fills it in. Asked once however often it is wanted while the answer is on its way: an item
   * taken while the list's own question about it is still out waits for that answer, and its import still comes.
   */
  private resolve(session: CompletionSession, id: number): Promise<CompletionEntry | null> {
    const path = this.path
    if (!path) return Promise.resolve(null)
    const key = `${session.list}:${id}`
    const asked = this.resolving.get(key)
    if (asked) return asked
    const answer = (async () => {
      try {
        const resolved = await askServers({ kind: 'resolve', path, list: session.list, id })
        if (!resolved) return null
        if (this.session === session) {
          session.entries = session.entries.map((item) => (item.id === id ? { ...resolved, resolved: true } : item))
          this.publish()
        }
        return { ...resolved, resolved: true }
      } finally {
        this.resolving.delete(key)
      }
    })()
    this.resolving.set(key, answer)
    return answer
  }

  private insert(entry: CompletionEntry, session: CompletionSession, mode: 'insert' | 'replace'): void {
    const view = this.view
    const state = view.state
    const path = this.path
    if (!path || state.config.readOnly) return
    const plan = planCompletion(state, entry, session.since, session.start, mode)
    const cursor = state.selection.main.head
    const indent = indentAt(state, cursor)
    // An item the server had not filled in yet may still bring an import: it goes in when the answer comes. It is
    // followed from before the item's own text goes in, so the places the answer names are mapped past that text too.
    const late: LateEdits | null = entry.resolved ? null : { since: session.since, list: session.list, id: entry.id, had: entry.additionalEdits?.length ?? 0, until: Date.now() + LATE_EDITS_MS }
    this.late = late
    if (plan.snippet) {
      const snippet = parseSnippet(plan.text, { indent, indentUnit: state.config.indentUnit, variable: (name) => snippetVariable(name, state, path, plan.ranges[0]) })
      view.snippet.insert(snippet, plan.ranges, { changes: plan.changes, origin: 'input.complete' })
    } else {
      const text = indentText(plan.text, indent)
      const changes = ChangeSet.of([...plan.ranges.map((range) => ({ ...range, insert: text })), ...plan.changes], state.doc.length)
      const ends = plan.ranges.map((range) => changes.mapPos(range.to, 1))
      view.dispatch({
        changes,
        selection: EditorSelection.create(ends.map((end) => new SelectionRange(end, end))),
        origin: 'input.complete',
        scrollIntoView: true,
        isolateHistory: true,
      })
    }
    if (late) void this.lateEdits(session, entry, late)
    if (entry.then === 'suggest') queueMicrotask(() => void this.requestCompletion(1, undefined, false))
    else if (entry.then === 'parameterHints') queueMicrotask(() => void this.requestSignature(1, undefined))
  }

  private async lateEdits(session: CompletionSession, entry: CompletionEntry, late: LateEdits): Promise<void> {
    const resolved = await this.resolve(session, entry.id)
    if (this.late !== late || !resolved) return
    this.late = null
    if (Date.now() > late.until || (resolved.additionalEdits?.length ?? 0) <= late.had) return
    // Only the edits elsewhere: the item's own text is in already, around the cursor.
    const head = this.view.state.selection.main.head
    const changes = editsElsewhere(resolved.additionalEdits!.slice(late.had), late.since, [{ from: head, to: head }])
    if (changes.length) this.view.dispatch({ changes, origin: 'input.complete' })
  }

  // ------------------------------------------------------------ a call's parameters

  private followSignature(tr: Transaction, typed: string | null): void {
    const triggers = this.triggers
    if (typed !== null && triggers?.signature.includes(typed)) {
      void this.requestSignature(2, typed)
      return
    }
    if (!this.signature) return
    if (typed !== null && triggers?.signatureRetrigger.includes(typed)) {
      void this.requestSignature(2, typed)
      return
    }
    if (tr.docChanged || tr.selectionChanged) {
      window.clearTimeout(this.signatureTimer)
      this.signatureTimer = window.setTimeout(() => void this.requestSignature(3, undefined), SIGNATURE_MS)
    }
  }

  private async requestSignature(triggerKind: 1 | 2 | 3, triggerCharacter: string | undefined): Promise<void> {
    const path = this.path
    if (!path) return
    window.clearTimeout(this.signatureTimer)
    const token = ++this.signatureToken
    const state = this.view.state
    const cursor = state.selection.main.head
    const { line, character } = lspAt(state.doc, cursor)
    const current = this.signature
    const active = current ? { ...current.help, activeSignature: current.active } : undefined
    const help = await askServers({
      kind: 'signature',
      path,
      line,
      character,
      triggerKind,
      ...(triggerCharacter ? { triggerCharacter } : {}),
      isRetrigger: Boolean(current),
      ...(active ? { active } : {}),
    })
    if (token !== this.signatureToken || this.path !== path) return
    if (!help || !help.signatures.length) return this.closeSignature()
    // The server's choice, or the one the person moved to when the same calls come back.
    const kept = current && current.help.signatures.length === help.signatures.length ? current.active : undefined
    const chosen = help.activeSignature ?? kept ?? 0
    this.signature = { help, active: Math.min(chosen, help.signatures.length - 1) }
    this.publishSignature()
  }

  private publishSignature(): void {
    const signature = this.signature
    if (!signature) return
    useAssist.setState({ signature: { help: signature.help, active: signature.active, anchor: this.anchorOf(this.view.state.selection.main.head) } })
  }

  // ------------------------------------------------------------ the other places of the symbol

  private scheduleHighlights(): void {
    window.clearTimeout(this.highlightTimer)
    const main = this.view.state.selection.main
    if (!this.path || !main.empty) return this.clearHighlights()
    // Still on the same symbol: nothing to ask.
    if (this.highlighted?.some((range) => main.head >= range.from && main.head <= range.to)) return
    this.clearHighlights()
    this.highlightTimer = window.setTimeout(() => void this.requestHighlights(), HIGHLIGHT_MS)
  }

  private async requestHighlights(): Promise<void> {
    const path = this.path
    if (!path) return
    const token = ++this.highlightToken
    const state = this.view.state
    const { line, character } = lspAt(state.doc, state.selection.main.head)
    const found = await askServers({ kind: 'highlights', path, line, character })
    // The text changed meanwhile: the places it says are not where they were.
    if (token !== this.highlightToken || this.path !== path || this.view.state.doc !== state.doc) return
    if (!found.length) return
    const marks: MarkSpec[] = []
    const ranges: { from: number; to: number }[] = []
    for (const item of found) {
      const from = positionOf(state.doc, item.range.start.line, item.range.start.character)
      const to = Math.max(from, positionOf(state.doc, item.range.end.line, item.range.end.character))
      if (to === from) continue
      ranges.push({ from, to })
      marks.push({ from, to, className: item.kind === 'write' ? 'enc-mark-symbol-write' : 'enc-mark-symbol' })
    }
    this.highlighted = ranges
    this.view.setSource('symbols', marks.length ? DecorationSet.of(state.doc, { marks: marks.sort((a, b) => a.from - b.from) }) : null)
  }

  private clearHighlights(): void {
    window.clearTimeout(this.highlightTimer)
    this.highlightToken++
    if (this.highlighted) {
      this.highlighted = null
      this.view.setSource('symbols', null)
    }
  }

  // ------------------------------------------------------------ formatting as you type

  /** The server formats what was just typed; its edits go in as their own undo step, if nothing was typed meanwhile. */
  private formatTyped(ch: string): void {
    const path = this.path
    const state = this.view.state
    // Several cursors: which of them the server should format for is not plain.
    if (!path || state.selection.ranges.length > 1) return
    const doc = state.doc
    const at = lspAt(doc, state.selection.main.head)
    void askServers({ kind: 'formatOnType', path, ...at, ch, ...indentOf(state) }).then((edits) => {
      if (!edits?.length || this.path !== path || this.view.state.doc !== doc) return
      applyServerEdits(path, edits)
    })
  }

  // ------------------------------------------------------------ where the widgets go

  private anchorOf(pos: number): Anchor {
    const view = this.view
    const clamped = Math.min(pos, view.state.doc.length)
    const box = view.coordsAtPos(clamped)
    return { left: box.left, top: box.top, bottom: box.bottom }
  }

  /** The text scrolled or the editor changed size: the widgets follow their places, or close when those leave the view. */
  private reposition(): void {
    const { suggest, signature } = useAssist.getState()
    const view = this.view
    if (suggest && this.session) {
      if (!view.isVisible(this.session.start)) this.closeSuggest()
      else useAssist.setState({ suggest: { ...suggest, anchor: this.anchorOf(this.session.start) } })
    }
    if (signature) {
      const head = view.state.selection.main.head
      if (!view.isVisible(head)) this.closeSignature()
      else useAssist.setState({ signature: { ...signature, anchor: this.anchorOf(head) } })
    }
  }
}
