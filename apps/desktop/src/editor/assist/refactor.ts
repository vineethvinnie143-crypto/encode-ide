import type { Transaction } from '@encode/editor'
import type { EditorView } from '@encode/editor-view'
import type { CodeRange, EditorAction, EditorChangeFile } from '@shared/types'
import { noAnswerReason } from '../../panels/code'
import { create } from '../../store'
import { useCode } from '../../stores/code'
import { useUi } from '../../stores/ui'
import { tooLargeForServers } from '../language'
import { marksAt, marksOf, marksOnLine, onMarksChanged, positionOf, rangeOf } from '../marks'
import { askServers, lspAt } from './ask'
import { canUndoChange, count, discardPreview, makeChange, undoChange, type ChangeAsk, type ChangeOutcome } from './changes'
import { wordEnd, wordStart } from './completion'
import type { Anchor } from './controller'
import { formatDoc } from './format'

/** The box F2 opens over a symbol: the name to give it, typed over the one it has. */
export interface RenameView {
  path: string
  /** Where the rename was asked for, as the servers count. */
  line: number
  character: number
  /** The symbol's text in the document. */
  from: number
  to: number
  initial: string
  anchor: Anchor
  busy: boolean
  /** Why the server refused the last name; the box stays for another. */
  error: string | null
}

/** The menu of actions the servers offer for a range (Ctrl+. and the lightbulb). */
export interface ActionsView {
  path: string
  list: number
  actions: EditorAction[]
  anchor: Anchor
  /** "Quick fixes", "Refactorings", "Source actions": what was asked for. */
  title: string
}

/** The lightbulb beside a line with a problem a server can fix. */
export interface BulbView {
  path: string
  /** 1-based. */
  line: number
  left: number
  top: number
  size: number
}

/** A change shown before it is made: every file it would touch and its lines before and after. */
export interface PreviewView {
  id: number
  title: string
  files: EditorChangeFile[]
  busy: boolean
}

interface RefactorState {
  rename: RenameView | null
  actions: ActionsView | null
  bulb: BulbView | null
  preview: PreviewView | null
}

/** What the editor's rename box, action menu, lightbulb and change preview show; one editor, so one store. */
export const useRefactor = create<RefactorState>(() => ({ rename: null, actions: null, bulb: null, preview: null }))

/** The cursor rests this long on a line with a problem before the servers are asked whether they can fix it. */
const BULB_MS = 250
/** The lightbulb's size, and the room it needs in a line's indentation to sit there rather than in the gutter. */
const BULB_SIZE = 16

/** What each kind of question is called, in the menu's title and when there is nothing to offer. */
const ASKED = {
  quickfix: { title: 'Quick fixes', none: 'No quick fixes here.', feature: 'quick fixes' },
  refactor: { title: 'Refactorings', none: 'No refactorings for this selection.', feature: 'refactorings' },
  source: { title: 'Source actions', none: 'No source actions for this file.', feature: 'source actions' },
} as const

const notify = (kind: 'info' | 'success' | 'error', text: string, action?: { label: string; run: () => void }) => useUi.getState().notify(kind, text, action)

/** Why nothing could be asked of the file's servers, with what to do about it. */
async function tellNoServer(path: string, feature: string): Promise<void> {
  if (!useCode.getState().report) await useCode.getState().refresh()
  notify('info', noAnswerReason(useCode.getState().report, path, feature, tooLargeForServers(path)))
}

const fileName = (path: string): string => path.split('/').pop() ?? path

/** "a.ts", "a.ts and b.ts", "a.ts, b.ts and 3 more". */
function names(paths: readonly string[]): string {
  const shown = paths.slice(0, 2).map(fileName)
  if (paths.length <= 2) return shown.join(' and ')
  return `${shown.join(', ')} and ${paths.length - 2} more`
}

/**
 * The changes the language servers make on request in the editor: renaming a symbol across the folder (F2, with a
 * preview on Shift+Enter), the actions they offer (Ctrl+. and the lightbulb, refactorings, source actions, organizing
 * the imports, fixing all), and formatting. One per editor view; the file it shows is set with `show`. The widgets
 * read `useRefactor`.
 */
export class EditorRefactor {
  private path: string | null = null
  private bulbTimer: number | undefined
  private bulbToken = 0
  private actionsToken = 0
  private renameToken = 0
  private readonly stops: (() => void)[] = []

  constructor(private readonly view: EditorView) {
    this.stops.push(view.on('transaction', (tr) => this.onTransaction(tr)))
    this.stops.push(view.on('viewport', () => this.reposition()))
    this.stops.push(
      onMarksChanged((path) => {
        if (path === this.path) this.scheduleBulb()
      }),
    )
  }

  /** The editor shows another file, or none. */
  show(path: string | null): void {
    this.closeRename()
    this.closeActions()
    this.hideBulb()
    const preview = useRefactor.getState().preview
    if (preview && !preview.busy) {
      discardPreview(preview.id)
      useRefactor.setState({ preview: null })
    }
    this.path = path
    if (path) this.scheduleBulb()
  }

  dispose(): void {
    this.show(null)
    window.clearTimeout(this.bulbTimer)
    for (const stop of this.stops.splice(0)) stop()
  }

  // ------------------------------------------------------------ rename

  /** F2: the box over the symbol at the cursor, once its server says it can be renamed. */
  async rename(): Promise<void> {
    const path = this.path
    const view = this.view
    if (!path || view.state.config.readOnly) return
    const token = ++this.renameToken
    const state = view.state
    const head = state.selection.main.head
    const at = lspAt(state.doc, head)
    const answer = await askServers({ kind: 'prepareRename', path, ...at })
    if (token !== this.renameToken || this.path !== path || view.state.doc !== state.doc) return
    if (answer === null) return tellNoServer(path, 'rename')
    if (!answer.ok) return notify('info', answer.reason)
    let from: number
    let to: number
    if (answer.range) {
      from = positionOf(state.doc, answer.range.start.line, answer.range.start.character)
      to = Math.max(from, positionOf(state.doc, answer.range.end.line, answer.range.end.character))
    } else {
      from = wordStart(state, head)
      to = wordEnd(state, head)
    }
    const initial = answer.placeholder ?? state.doc.sliceString(from, to)
    if (!initial.trim()) return notify('info', 'Put the cursor on a name to rename it.')
    this.closeActions()
    this.hideBulb()
    useRefactor.setState({ rename: { path, ...at, from, to, initial, anchor: this.anchorOf(from), busy: false, error: null } })
  }

  /** Enter in the box renames, Shift+Enter shows what would change first. The same name, or none, just closes it. */
  async finishRename(newName: string, preview: boolean): Promise<void> {
    const box = useRefactor.getState().rename
    if (!box || box.busy) return
    const name = newName.trim()
    if (!name || name === box.initial) return this.closeRename(true)
    useRefactor.setState({ rename: { ...box, busy: true, error: null } })
    const outcome = await makeChange({ kind: 'rename', path: box.path, line: box.line, character: box.character, newName: name, preview })
    const now = useRefactor.getState().rename
    if (!outcome.ok) {
      // The name may be what the server refused: the box stays, so another can be typed.
      if (now === null || now.path !== box.path) return notify('error', outcome.reason)
      useRefactor.setState({ rename: { ...now, busy: false, error: outcome.reason } })
      return
    }
    this.closeRename(true)
    this.report(outcome)
  }

  /** Typing another name puts away the reason the last one was refused. */
  renameEdited(): void {
    const box = useRefactor.getState().rename
    if (box?.error) useRefactor.setState({ rename: { ...box, error: null } })
  }

  /** Closes the box; `refocus` hands the keyboard back to the text, as after Escape. */
  closeRename(refocus = false): void {
    this.renameToken++
    if (useRefactor.getState().rename) useRefactor.setState({ rename: null })
    if (refocus) this.view.focus()
  }

  // ------------------------------------------------------------ code actions

  /** Ctrl+.: the fixes and refactorings for the selection, or for the problem the cursor is on or nearest to on its line. */
  quickFix(): Promise<void> {
    const { range, pos } = this.fixRange()
    // Source actions act on the whole file, not on the place: they have their own menu and keys.
    return this.openActions(range, pos, ASKED.quickfix, undefined, (action) => !action.kind?.startsWith('source'))
  }

  /** The refactorings for the selection, or the symbol at the cursor. */
  refactor(): Promise<void> {
    return this.openActions(this.selectionRange(), this.view.state.selection.main.from, ASKED.refactor, ['refactor'])
  }

  /** The actions on the whole file: organizing imports, fixing all, and what else the server offers. */
  sourceAction(): Promise<void> {
    return this.openActions(this.selectionRange(), this.view.state.selection.main.head, ASKED.source, ['source'])
  }

  /** Asks the servers for actions and opens the menu with them, under the place they are for. */
  private async openActions(range: CodeRange, pos: number, asked: (typeof ASKED)[keyof typeof ASKED], only?: string[], keep: (action: EditorAction) => boolean = () => true): Promise<void> {
    const path = this.path
    const view = this.view
    if (!path) return
    const token = ++this.actionsToken
    const doc = view.state.doc
    this.closeRename()
    this.hideBulb()
    const answer = await askServers({ kind: 'codeActions', path, range, ...(only ? { only } : {}), automatic: false })
    if (token !== this.actionsToken || this.path !== path || view.state.doc !== doc) return
    if (answer === null) return tellNoServer(path, asked.feature)
    const actions = answer.actions.filter(keep)
    if (!actions.length) return notify('info', asked.none)
    useRefactor.setState({ actions: { path, list: answer.list, actions, anchor: this.anchorOf(pos), title: asked.title } })
  }

  /** Takes an action of a menu that was open; `preview` shows what it changes first, for one whose changes are known. */
  async takeAction(menu: ActionsView, id: number, preview = false): Promise<void> {
    this.closeActions(true)
    const outcome = await makeChange({ kind: 'action', path: menu.path, list: menu.list, id, preview })
    this.report(outcome)
  }

  closeActions(refocus = false): void {
    this.actionsToken++
    if (useRefactor.getState().actions) useRefactor.setState({ actions: null })
    if (refocus) this.view.focus()
    this.scheduleBulb()
  }

  /** Shift+Alt+O: the server's way of organizing the imports, taken at once. */
  organizeImports(): Promise<void> {
    return this.runSource(['source.organizeImports'], { feature: 'organize imports', none: 'There are no imports to organize here.', unchanged: 'The imports are already in order.' })
  }

  /** The fixes the server can make all at once in the file, such as every missing semicolon. */
  fixAll(): Promise<void> {
    return this.runSource(['source.fixAll'], { feature: 'fix all', none: 'Nothing here can be fixed all at once.', unchanged: 'Nothing here needed fixing.' })
  }

  /** Asks for one kind of source action on the whole file and takes the preferred one (or the first) without a menu. */
  private async runSource(only: string[], text: { feature: string; none: string; unchanged: string }): Promise<void> {
    const path = this.path
    const view = this.view
    if (!path || view.state.config.readOnly) return
    const token = ++this.actionsToken
    const doc = view.state.doc
    const end = lspAt(doc, doc.length)
    const answer = await askServers({ kind: 'codeActions', path, range: { start: { line: 0, character: 0 }, end }, only, automatic: false })
    if (token !== this.actionsToken || this.path !== path || view.state.doc !== doc) return
    if (answer === null) return tellNoServer(path, text.feature)
    const usable = answer.actions.filter((action) => !action.disabled)
    const chosen = usable.find((action) => action.preferred) ?? usable[0]
    if (!chosen) return notify('info', answer.actions[0]?.disabled ?? text.none)
    const outcome = await makeChange({ kind: 'action', path, list: answer.list, id: chosen.id, preview: false })
    if (outcome.ok && 'applied' in outcome && outcome.applied.files === 0 && !outcome.applied.notes.length) return notify('info', text.unchanged)
    this.report(outcome)
  }

  // ------------------------------------------------------------ formatting

  /** Shift+Alt+F: the whole file, as its server formats it. */
  async formatDocument(): Promise<void> {
    const path = this.path
    if (!path || this.view.state.config.readOnly) return
    const outcome = await formatDoc(path)
    if (outcome === 'no-server') return tellNoServer(path, 'formatting')
    if (outcome === 'unchanged') notify('info', 'The file is already formatted.')
  }

  /** The selection, or the cursor's line when nothing is selected. */
  async formatSelection(): Promise<void> {
    const path = this.path
    const { state } = this.view
    if (!path || state.config.readOnly) return
    const main = state.selection.main
    const from = main.empty ? state.doc.lineAt(main.head).from : main.from
    const to = main.empty ? state.doc.lineAt(main.head).to : main.to
    const outcome = await formatDoc(path, { start: lspAt(state.doc, from), end: lspAt(state.doc, to) })
    if (outcome === 'no-server') return tellNoServer(path, 'selection formatting')
    if (outcome === 'unchanged') notify('info', main.empty ? 'The line is already formatted.' : 'The selection is already formatted.')
  }

  // ------------------------------------------------------------ the preview

  /** Makes the change the preview shows. */
  async applyPreview(): Promise<void> {
    const preview = useRefactor.getState().preview
    if (!preview || preview.busy) return
    useRefactor.setState({ preview: { ...preview, busy: true } })
    const outcome = await makeChange({ kind: 'apply', id: preview.id } satisfies ChangeAsk)
    useRefactor.setState({ preview: null })
    this.view.focus()
    this.report(outcome)
  }

  cancelPreview(): void {
    const preview = useRefactor.getState().preview
    if (!preview) return
    discardPreview(preview.id)
    useRefactor.setState({ preview: null })
    this.view.focus()
    this.scheduleBulb()
  }

  // ------------------------------------------------------------ what came of it

  /** Tells the person what a change did where it is not plain to see, with Undo for one across files. */
  private report(outcome: ChangeOutcome): void {
    if (!outcome.ok) return notify('error', outcome.reason)
    if ('preview' in outcome) {
      useRefactor.setState({ preview: { id: outcome.preview.id, title: outcome.preview.title, files: outcome.preview.files, busy: false } })
      return
    }
    const { applied, skipped } = outcome
    const notes = applied.notes.join(' ')
    if (skipped.length) {
      notify('info', `${applied.title}: ${names(skipped)} changed while it was being made, so what you typed there was kept. ${notes}`.trim())
      return
    }
    if (applied.files === 0) return notify('info', notes || `${applied.title} changed nothing.`)
    if (applied.files > 1 || applied.created.length || applied.moved.length || applied.deleted.length) {
      const where = applied.places ? `${count(applied.places, 'place')} in ${count(applied.files, 'file')}` : count(applied.files, 'file')
      const undo = canUndoChange(applied.id) ? { label: 'Undo', run: () => void this.undo(applied.id, applied.title) } : undefined
      notify('success', `${applied.title}: ${where}.${notes ? ` ${notes}` : ''}`, undo)
      return
    }
    if (notes) notify('info', notes)
  }

  /** Undo on the notice: the whole change back, in every file it touched. */
  private async undo(id: number, title: string): Promise<void> {
    const outcome = await undoChange(id)
    if (!outcome.ok) return notify('error', outcome.reason)
    if (outcome.skipped.length) notify('info', `Took back the change (${title}), except in ${names(outcome.skipped)}: they changed since.`)
    else notify('success', `Took back the change: ${title}.`)
  }

  // ------------------------------------------------------------ the lightbulb

  private onTransaction(tr: Transaction): void {
    if (!this.path) return
    if (tr.docChanged) {
      const { rename, actions } = useRefactor.getState()
      // The text moved from under them: a box or a menu for the old text would act on the wrong place.
      if (rename && !rename.busy) this.closeRename()
      if (actions) this.closeActions()
    }
    if (tr.docChanged || tr.selectionChanged) this.scheduleBulb()
  }

  private hideBulb(): void {
    window.clearTimeout(this.bulbTimer)
    this.bulbToken++
    if (useRefactor.getState().bulb) useRefactor.setState({ bulb: null })
  }

  /** Once the cursor rests on a line with a problem, the servers are asked by themselves whether they can fix it. */
  private scheduleBulb(): void {
    const path = this.path
    const { state } = this.view
    const line = state.doc.lineAt(state.selection.main.head).number
    const shown = useRefactor.getState()
    if (shown.bulb && (shown.bulb.path !== path || shown.bulb.line !== line)) useRefactor.setState({ bulb: null })
    window.clearTimeout(this.bulbTimer)
    this.bulbToken++
    if (!path || shown.rename || shown.actions || shown.preview || state.config.readOnly) return
    const items = marksOf(path)
    if (!marksOnLine(state.doc, items, line).length && !marksAt(state.doc, items, state.selection.main.head).length) {
      if (useRefactor.getState().bulb) useRefactor.setState({ bulb: null })
      return
    }
    this.bulbTimer = window.setTimeout(() => void this.askBulb(), BULB_MS)
  }

  private async askBulb(): Promise<void> {
    const path = this.path
    const view = this.view
    if (!path) return
    const token = ++this.bulbToken
    const { doc } = view.state
    const line = doc.lineAt(view.state.selection.main.head).number
    const { range } = this.fixRange()
    const answer = await askServers({ kind: 'codeActions', path, range, only: ['quickfix'], automatic: true })
    if (token !== this.bulbToken || this.path !== path || view.state.doc !== doc) return
    const shown = useRefactor.getState()
    if (shown.rename || shown.actions || shown.preview) return
    if (!answer?.actions.some((action) => !action.disabled)) {
      if (shown.bulb) useRefactor.setState({ bulb: null })
      return
    }
    const spot = this.bulbSpot(line)
    useRefactor.setState({ bulb: spot ? { path, line, ...spot } : null })
  }

  /** The lightbulb opens the menu for its line's problem. */
  openBulb(): void {
    const bulb = useRefactor.getState().bulb
    if (!bulb) return
    const { doc, selection } = this.view.state
    if (doc.lineAt(selection.main.head).number !== bulb.line) this.view.select(doc.line(bulb.line).from)
    this.view.focus()
    void this.quickFix()
  }

  /** In the line's indentation when there is room, else just left of the text, in the gutter. */
  private bulbSpot(number: number): { left: number; top: number; size: number } | null {
    const view = this.view
    const { doc } = view.state
    if (number > doc.lineCount) return null
    const line = doc.line(number)
    if (!view.isVisible(line.from)) return null
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0
    const start = view.coordsAtPos(line.from)
    const text = view.coordsAtPos(line.from + indent)
    const roomy = text.left - start.left >= BULB_SIZE + 4
    const height = start.bottom - start.top
    return { left: roomy ? start.left : start.left - BULB_SIZE - 3, top: start.top + Math.round((height - BULB_SIZE) / 2), size: BULB_SIZE }
  }

  // ------------------------------------------------------------ places

  /** The selection, or the cursor, as the servers count. */
  private selectionRange(): CodeRange {
    const { doc, selection } = this.view.state
    const main = selection.main
    return { start: lspAt(doc, main.from), end: lspAt(doc, main.to) }
  }

  /**
   * What a quick fix is asked for: the selection; else the cursor when it is on a problem; else the problem on the
   * cursor's line nearest to it, so Ctrl+. anywhere on the line offers its fixes.
   */
  private fixRange(): { range: CodeRange; pos: number } {
    const { doc, selection } = this.view.state
    const main = selection.main
    const cursor = { range: this.selectionRange(), pos: main.from }
    if (!main.empty || !this.path) return cursor
    const items = marksOf(this.path)
    if (marksAt(doc, items, main.head).length) return cursor
    const onLine = marksOnLine(doc, items, doc.lineAt(main.head).number)
    if (!onLine.length) return cursor
    const distance = (from: number, to: number) => (main.head < from ? from - main.head : main.head > to ? main.head - to : 0)
    let nearest = onLine[0]
    let best = Infinity
    for (const item of onLine) {
      const { from, to } = rangeOf(doc, item)
      const gap = distance(from, to)
      if (gap < best) {
        best = gap
        nearest = item
      }
    }
    const { from } = rangeOf(doc, nearest)
    return { range: { start: { line: nearest.line, character: nearest.character }, end: { line: nearest.endLine, character: nearest.endCharacter } }, pos: from }
  }

  private anchorOf(pos: number): Anchor {
    const box = this.view.coordsAtPos(Math.min(pos, this.view.state.doc.length))
    return { left: box.left, top: box.top, bottom: box.bottom }
  }

  /** The text scrolled or the editor changed size: the box and the menu follow their places, the bulb its line. */
  private reposition(): void {
    const { rename, actions, bulb } = useRefactor.getState()
    const view = this.view
    if (rename) {
      if (!view.isVisible(rename.from)) this.closeRename()
      else useRefactor.setState({ rename: { ...rename, anchor: this.anchorOf(rename.from) } })
    }
    if (actions) this.closeActions()
    if (bulb) {
      const spot = this.bulbSpot(bulb.line)
      useRefactor.setState({ bulb: spot ? { ...bulb, ...spot } : null })
    }
  }
}
