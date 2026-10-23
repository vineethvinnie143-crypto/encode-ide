import { ChangeSet, Text, type ChangeSpec, type Line } from '@encode/text'
import { History, historyNow } from './history'
import { plainText, type Language } from './language'
import { EditorSelection, SelectionRange } from './selection'

export interface EditorConfig {
  readonly tabSize: number
  /** What one level of indentation inserts: spaces or a tab. */
  readonly indentUnit: string
  readonly language: Language
  /** Written between lines on save; the document itself always uses "\n". */
  readonly lineSeparator: '\n' | '\r\n'
  readonly readOnly: boolean
}

export interface EditorStateSpec {
  doc?: string | Text
  selection?: EditorSelection
  tabSize?: number
  indentUnit?: string
  language?: Language
  lineSeparator?: '\n' | '\r\n'
  readOnly?: boolean
}

export interface TransactionSpec {
  changes?: ChangeSpec | readonly ChangeSpec[] | ChangeSet
  /** The selection afterwards, in the new document's offsets. Default: the old one mapped through the changes. */
  selection?: EditorSelection | SelectionRange
  /**
   * Why the change happened. Drives undo grouping ("input.type" and
   * "input.delete" merge with what came just before) and lets listeners tell
   * typing from reloads ("external"), undo ("undo", "redo") and the like.
   */
  origin?: string
  /** Default true. Only undo and redo leave the history alone. */
  addToHistory?: boolean
  scrollIntoView?: boolean
  config?: Partial<EditorConfig>
  /** Closing characters the editor inserted itself, which typing them again steps over. */
  autoClosed?: readonly number[]
  /** Start a new undo step with the next change. */
  isolateHistory?: boolean
}

export class Transaction {
  constructor(
    readonly startState: EditorState,
    readonly changes: ChangeSet,
    readonly selection: EditorSelection,
    readonly origin: string | undefined,
    readonly scrollIntoView: boolean,
    readonly state: EditorState,
  ) {}

  get docChanged(): boolean {
    return !this.changes.empty
  }

  get selectionChanged(): boolean {
    return !this.selection.eq(this.startState.selection)
  }
}

/**
 * An immutable editor state: document, selection, configuration and undo
 * history. `update` describes a change as a Transaction whose `state` is the
 * result; the view applies it, and listeners (the store, a language server)
 * read the change set from it.
 */
export class EditorState {
  private constructor(
    readonly doc: Text,
    readonly selection: EditorSelection,
    readonly config: EditorConfig,
    readonly history: History,
    /** Goes up by one with every document change. */
    readonly version: number,
    readonly autoClosed: readonly number[],
  ) {}

  static create(spec: EditorStateSpec = {}): EditorState {
    const doc = typeof spec.doc === 'string' ? Text.of(spec.doc) : (spec.doc ?? Text.empty)
    const tabSize = spec.tabSize ?? 4
    const config: EditorConfig = {
      tabSize,
      indentUnit: spec.indentUnit ?? '  ',
      language: spec.language ?? plainText,
      lineSeparator: spec.lineSeparator ?? '\n',
      readOnly: spec.readOnly ?? false,
    }
    const selection = (spec.selection ?? EditorSelection.cursor(0)).clamp(doc.length)
    return new EditorState(doc, selection, config, History.empty, 0, [])
  }

  /** `history`, when given, replaces the resulting history (undo and redo move steps between stacks). */
  update(spec: TransactionSpec, history?: History): Transaction {
    const changes =
      spec.changes instanceof ChangeSet ? spec.changes : ChangeSet.of(spec.changes ?? [], this.doc.length)
    if (changes.length !== this.doc.length) {
      throw new RangeError(`Changes for length ${changes.length} given to a document of length ${this.doc.length}`)
    }
    const doc = changes.empty ? this.doc : changes.apply(this.doc)
    let selection: EditorSelection
    if (spec.selection instanceof SelectionRange) selection = EditorSelection.create([spec.selection])
    else selection = spec.selection ?? this.selection.map(changes)
    selection = selection.clamp(doc.length)

    if (!history) {
      history = spec.isolateHistory ? this.history.isolate() : this.history
      if (!changes.empty && spec.addToHistory !== false) {
        history = history.record(changes.invert(this.doc), this.selection, selection, spec.origin ?? 'command', historyNow())
      }
    }
    let autoClosed = spec.autoClosed ?? (changes.empty ? this.autoClosed : mapAutoClosed(this.autoClosed, changes))
    if (autoClosed.length) autoClosed = keepNearCursors(doc, selection, autoClosed)
    const config = spec.config ? { ...this.config, ...spec.config } : this.config
    const state = new EditorState(doc, selection, config, history, changes.empty ? this.version : this.version + 1, autoClosed)
    return new Transaction(this, changes, selection, spec.origin, spec.scrollIntoView ?? false, state)
  }

  get language(): Language {
    return this.config.language
  }

  sliceDoc(from = 0, to = this.doc.length): string {
    return this.doc.sliceString(from, to)
  }

  lineAt(pos: number): Line {
    return this.doc.lineAt(pos)
  }

  /** The document as it is written to disk, with the configured line separator. */
  serialize(): string {
    return this.config.lineSeparator === '\n' ? this.doc.toString() : this.doc.lineTexts().join('\r\n')
  }
}

/** Auto-closed characters through a change: those it replaced are gone, text typed in front of one pushes it on. */
export function mapAutoClosed(positions: readonly number[], changes: ChangeSet): number[] {
  return positions
    .filter((pos) => !changes.changes.some((change) => pos >= change.from && pos < change.to))
    .map((pos) => changes.mapPos(pos, 1))
}

/**
 * An auto-closed character stays special only while a cursor sits before it
 * on its line; once the cursor leaves, typing the character inserts it again.
 */
function keepNearCursors(doc: Text, selection: EditorSelection, positions: readonly number[]): number[] {
  const nearest = new Map<number, number>()
  for (const range of selection.ranges) {
    const line = doc.lineAt(range.head).number
    nearest.set(line, Math.min(nearest.get(line) ?? Infinity, range.head))
  }
  return positions.filter((pos) => pos < doc.length && pos >= (nearest.get(doc.lineAt(pos).number) ?? Infinity))
}

/**
 * Undoes the newest step, restoring the selection from before it. Null when there is none, or when the document is
 * read-only (its history holds what came from disk, which undo must not take back).
 */
export function undo(state: EditorState): Transaction | null {
  const group = state.history.done[state.history.done.length - 1]
  if (!group || state.config.readOnly) return null
  const forward = group.changes.invert(state.doc)
  const popped = state.history.popUndo(forward)!
  return withHistory(state, group.changes, group.selectionBefore, 'undo', popped.history)
}

/** Redoes the newest undone step. Null when there is none, or when the document is read-only. */
export function redo(state: EditorState): Transaction | null {
  const group = state.history.undone[state.history.undone.length - 1]
  if (!group || state.config.readOnly) return null
  const inverse = group.changes.invert(state.doc)
  const popped = state.history.popRedo(inverse)!
  return withHistory(state, group.changes, group.selectionAfter, 'redo', popped.history)
}

function withHistory(
  state: EditorState,
  changes: ChangeSet,
  selection: EditorSelection,
  origin: string,
  history: History,
): Transaction {
  return state.update({ changes, selection, origin, scrollIntoView: true }, history)
}
