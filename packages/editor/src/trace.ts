/**
 * Edit traces: what someone did in an editor, step by step, in the editor's own terms (commands, typing, pastes,
 * selections, changes from elsewhere), so it can be replayed exactly. Undo grouping reads the time each step says,
 * so a replay groups typing into the same undo steps as the session it came from.
 *
 * A trace is plain JSON. The regression suite replays the traces in packages/editor/test/traces, the fuzzer makes
 * random ones (and a failing one is saved as a trace), and a bug report can carry one: `scrambleTrace` replaces the
 * words of a trace consistently so the shape of the code travels and its content does not.
 *
 * `editorProblems` is what must hold of every editor state, checked after every step of a replay.
 */
import { ChangeSet, type Text } from '@encode/text'
import { withHistoryClock } from './history'
import * as commands from './commands'
import { languageById } from './languages'
import { compileSearch, replaceAll, type SearchQuery } from './search'
import { reload } from './reload'
import { EditorSelection, SelectionRange } from './selection'
import { EditorState, type Transaction } from './state'

/** Commands a trace can name: the editor's own, each a function of the state alone. */
export const TRACE_COMMANDS = {
  cursorCharLeft: commands.cursorCharLeft,
  selectCharLeft: commands.selectCharLeft,
  cursorCharRight: commands.cursorCharRight,
  selectCharRight: commands.selectCharRight,
  cursorWordLeft: commands.cursorWordLeft,
  selectWordLeft: commands.selectWordLeft,
  cursorWordRight: commands.cursorWordRight,
  selectWordRight: commands.selectWordRight,
  cursorLineUp: commands.cursorLineUp,
  selectLineUp: commands.selectLineUp,
  cursorLineDown: commands.cursorLineDown,
  selectLineDown: commands.selectLineDown,
  cursorPageUp: commands.cursorPage(-20),
  cursorPageDown: commands.cursorPage(20),
  selectPageUp: commands.cursorPage(-20, true),
  selectPageDown: commands.cursorPage(20, true),
  cursorLineStart: commands.cursorLineStart,
  selectLineStart: commands.selectLineStart,
  cursorLineEnd: commands.cursorLineEnd,
  selectLineEnd: commands.selectLineEnd,
  cursorDocStart: commands.cursorDocStart,
  selectDocStart: commands.selectDocStart,
  cursorDocEnd: commands.cursorDocEnd,
  selectDocEnd: commands.selectDocEnd,
  selectAll: commands.selectAll,
  collapseSelection: commands.collapseSelection,
  selectLine: commands.selectLine,
  jumpToBracket: commands.jumpToBracket,
  addCursorAbove: commands.addCursorAbove,
  addCursorBelow: commands.addCursorBelow,
  selectNextOccurrence: commands.selectNextOccurrence,
  selectAllOccurrences: commands.selectAllOccurrences,
  insertNewlineAndIndent: commands.insertNewlineAndIndent,
  insertLineAfter: commands.insertLineAfter,
  insertLineBefore: commands.insertLineBefore,
  deleteCharBackward: commands.deleteCharBackward,
  deleteCharForward: commands.deleteCharForward,
  deleteWordBackward: commands.deleteWordBackward,
  deleteWordForward: commands.deleteWordForward,
  deleteLine: commands.deleteLine,
  indentMore: commands.indentMore,
  indentLess: commands.indentLess,
  insertTab: commands.insertTab,
  toggleLineComment: commands.toggleLineComment,
  toggleBlockComment: commands.toggleBlockComment,
  moveLineUp: commands.moveLineUp,
  moveLineDown: commands.moveLineDown,
  copyLineUp: commands.copyLineUp,
  copyLineDown: commands.copyLineDown,
  undo: commands.undo,
  redo: commands.redo,
} satisfies Record<string, commands.Command>

export type TraceCommand = keyof typeof TRACE_COMMANDS

/** What a step does; each may say when it happened (`t`, milliseconds from the start), else 100 ms after the last. */
export type TraceAction =
  /** A command by name. */
  | { command: TraceCommand }
  /** Characters typed one at a time, with the editor's conveniences ("\n" is Enter). */
  | { type: string }
  /** Text put in at every selection as it is: an input method's commit, a drop. */
  | { insert: string }
  /** The selection: [anchor, head] ranges, and which is the main one. */
  | { select: readonly (readonly [number, number])[]; main?: number }
  /** Copy, or cut, into the trace's clipboard. */
  | { copy: true }
  | { cut: true }
  /** Paste the trace's clipboard, or the text given (with no pieces: copied elsewhere). */
  | { paste: true }
  | { paste: string; linewise?: boolean }
  /** Changes made from elsewhere (a language server's edit, a review hunk), as [from, to, insert]. */
  | { changes: readonly (readonly [number, number, string])[]; origin?: string }
  /** Replace every match. */
  | { replaceAll: SearchQuery; with: string }
  /** The file changed on disk to this text, and the editor took it in. */
  | { reload: string }
  /** What the document must be by now: its length, line count and hash (see `hashText`). */
  | { expect: { length: number; lines: number; hash: string } }

export type TraceStep = TraceAction & { t?: number }

export interface EditorTrace {
  version: 1
  name?: string
  /** The document at the start. */
  doc: string
  /** A language id (see `languageById`); plain text by default. */
  language?: string
  tabSize?: number
  indentUnit?: string
  lineSeparator?: '\n' | '\r\n'
  readOnly?: boolean
  /** The selection at the start, as [anchor, head] ranges; a cursor at 0 by default. */
  selection?: readonly (readonly [number, number])[]
  steps: readonly TraceStep[]
}

/** A short, stable hash of a text (FNV-1a over its UTF-16 units), the same on every platform. */
export function hashText(text: string | Text): string {
  const source = typeof text === 'string' ? text : text.toString()
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The `expect` a trace would hold for this document. */
export function expectOf(doc: Text): { length: number; lines: number; hash: string } {
  return { length: doc.length, lines: doc.lineCount, hash: hashText(doc) }
}

export interface ProblemOptions {
  /** Also walk the whole undo and redo history, checking each step applies to the document it undoes. Slower. */
  history?: boolean
}

/**
 * What is wrong with an editor state, and with the transaction that made it when given; empty when all is well.
 * The document's structure; the selection sorted, apart and inside the document; the characters the editor closed
 * by itself still there; each undo and redo step fitting the document it applies to; and the transaction's changes
 * leading from its start to its end, both ways.
 */
export function editorProblems(state: EditorState, tr?: Transaction, options: ProblemOptions = {}): string[] {
  const problems = state.doc.checkStructure()
  const { doc } = state
  const length = doc.length
  const { ranges, mainIndex } = state.selection
  if (!ranges.length) problems.push('the selection has no ranges')
  if (!Number.isInteger(mainIndex) || mainIndex < 0 || mainIndex >= ranges.length) problems.push(`the main range ${mainIndex} is not one of the ${ranges.length}`)
  ranges.forEach((range, index) => {
    for (const pos of [range.anchor, range.head]) {
      if (!Number.isInteger(pos) || pos < 0 || pos > length) problems.push(`range ${index} reaches ${pos}, outside 0-${length}`)
    }
    const previous = ranges[index - 1]
    if (previous && (range.from < previous.to || (range.from === previous.to && (range.empty || previous.empty)))) {
      problems.push(`ranges ${index - 1} (${previous.anchor}-${previous.head}) and ${index} (${range.anchor}-${range.head}) overlap or are out of order`)
    }
  })
  const closers = [...state.language.brackets.map(([, close]) => close), ...state.language.quotes]
  for (const pos of state.autoClosed) {
    if (!Number.isInteger(pos) || pos < 0 || pos >= length) problems.push(`an auto-closed character at ${pos} is outside the document`)
    else if (!closers.some((close) => doc.sliceString(pos, Math.min(length, pos + close.length)) === close)) {
      problems.push(`the auto-closed character at ${pos} is now ${JSON.stringify(doc.sliceString(pos, pos + 1))}`)
    }
  }
  const { done, undone } = state.history
  if (options.history) {
    for (const [name, stack] of [['undo', done], ['redo', undone]] as const) {
      let at: Text = doc
      for (let index = stack.length - 1; index >= 0; index--) {
        const step = stack[index].changes
        if (step.length !== at.length) {
          problems.push(`${name} step ${stack.length - index} applies to a document of ${step.length}, not ${at.length}`)
          break
        }
        at = step.apply(at)
      }
    }
  } else {
    if (done.length && done[done.length - 1].changes.length !== length) problems.push('the newest undo step does not fit the document')
    if (undone.length && undone[undone.length - 1].changes.length !== length) problems.push('the newest redo step does not fit the document')
  }
  if (tr) {
    const start = tr.startState
    if (tr.state !== state) problems.push('the transaction is not the one that made this state')
    else if (tr.changes.length !== start.doc.length) problems.push('the changes do not fit the document they started from')
    else {
      if (!tr.changes.apply(start.doc).eq(doc)) problems.push('the changes do not lead to the document')
      if (!tr.changes.invert(start.doc).apply(doc).eq(start.doc)) problems.push('the changes, inverted, do not lead back')
    }
    const version = start.version + (tr.docChanged ? 1 : 0)
    if (state.version !== version) problems.push(`the version is ${state.version}, not ${version}`)
  }
  return problems
}

/** Where a replay stopped being right: the step (0 for the start) and what was wrong. */
export interface TraceProblem {
  step: number
  problem: string
}

export interface ReplayOptions extends ProblemOptions {
  /** Check `editorProblems` after every step (default true). */
  check?: boolean
  /** Called after every step with its index (from 1), the state, and the transaction if the step made one. */
  onStep?: (index: number, state: EditorState, tr: Transaction | null) => void
}

export interface ReplayResult {
  state: EditorState
  problems: TraceProblem[]
}

const rangesOf = (spec: readonly (readonly [number, number])[], length: number) =>
  spec.map(([anchor, head]) => new SelectionRange(Math.min(Math.max(0, anchor), length), Math.min(Math.max(0, head), length)))

/** The state a trace starts from. */
export function traceStart(trace: Omit<EditorTrace, 'steps'>): EditorState {
  const doc = trace.doc
  return EditorState.create({
    doc,
    language: trace.language ? languageById(trace.language) : undefined,
    tabSize: trace.tabSize,
    indentUnit: trace.indentUnit,
    lineSeparator: trace.lineSeparator,
    readOnly: trace.readOnly,
    selection: trace.selection?.length ? EditorSelection.create(rangesOf(trace.selection, doc.length)) : undefined,
  })
}

/**
 * Replays a trace one step at a time, with undo grouping reading the trace's times: for a replay that decides its
 * next step from the state (the fuzzer). A step that does not apply (a command with nothing to do, a paste with an
 * empty clipboard) leaves the state as it is, as in the editor.
 */
export class TraceReplayer {
  state: EditorState
  readonly problems: TraceProblem[] = []
  /** Steps taken so far. */
  count = 0
  private clipboard: commands.ClipboardText | null = null
  private now = 0

  constructor(
    trace: Omit<EditorTrace, 'steps'>,
    private readonly options: ReplayOptions = {},
  ) {
    this.state = traceStart(trace)
    if (options.check !== false) for (const problem of editorProblems(this.state, undefined, options)) this.problems.push({ step: 0, problem })
  }

  /** Takes one step; the transaction it made last, if any. */
  step(step: TraceStep): Transaction | null {
    const index = ++this.count
    this.now = step.t ?? this.now + 100
    let made: Transaction | null = null
    withHistoryClock(
      () => this.now,
      () => {
        const apply = (next: Transaction | null) => {
          if (!next) return
          if (this.options.check !== false) {
            for (const problem of editorProblems(next.state, next, this.options)) this.problems.push({ step: index, problem })
          }
          this.state = next.state
          made = next
        }
        const state = () => this.state
        if ('command' in step) {
          const command = TRACE_COMMANDS[step.command]
          if (!command) this.problems.push({ step: index, problem: `there is no command ${JSON.stringify(step.command)}` })
          else apply(command(state()))
        } else if ('type' in step) {
          for (const char of step.type) apply(char === '\n' ? commands.insertNewlineAndIndent(state()) : commands.insertTyped(state(), char))
        } else if ('insert' in step) apply(commands.insertText(state(), step.insert))
        else if ('select' in step) {
          const ranges = rangesOf(step.select, state().doc.length)
          if (ranges.length) apply(state().update({ selection: EditorSelection.create(ranges, step.main ?? 0), origin: 'select' }))
        } else if ('copy' in step) this.clipboard = commands.copyText(state())
        else if ('cut' in step) {
          const cut = commands.cutText(state())
          this.clipboard = cut.clipboard
          apply(cut.transaction)
        } else if ('paste' in step) {
          if (step.paste !== true) apply(commands.paste(state(), step.paste, step.linewise ?? false))
          else if (this.clipboard) apply(commands.paste(state(), this.clipboard.text, this.clipboard.linewise, this.clipboard.pieces))
        } else if ('changes' in step) {
          const length = state().doc.length
          const specs = step.changes.filter(([from, to]) => from >= 0 && from <= to && to <= length).map(([from, to, insert]) => ({ from, to, insert }))
          if (!state().config.readOnly) apply(state().update({ changes: ChangeSet.of(specs, length), origin: step.origin ?? 'external' }))
        } else if ('replaceAll' in step) {
          const search = compileSearch(step.replaceAll, state().language.wordChars)
          const spec = search.error || state().config.readOnly ? null : replaceAll(state(), search, step.with)
          if (spec) apply(state().update(spec))
        } else if ('reload' in step) apply(reload(state(), step.reload))
        else if ('expect' in step) {
          const actual = expectOf(state().doc)
          if (actual.hash !== step.expect.hash || actual.length !== step.expect.length || actual.lines !== step.expect.lines) {
            this.problems.push({ step: index, problem: `expected ${JSON.stringify(step.expect)}, found ${JSON.stringify(actual)}` })
          }
        }
      },
    )
    this.options.onStep?.(index, this.state, made)
    return made
  }
}

/** Replays a whole trace from its start (see `TraceReplayer`). */
export function replayTrace(trace: EditorTrace, options: ReplayOptions = {}): ReplayResult {
  const replayer = new TraceReplayer(trace, options)
  for (const step of trace.steps) replayer.step(step)
  return { state: replayer.state, problems: replayer.problems }
}

/**
 * Writes down what happens in an editor as a trace: give it the state it starts from, then each step as it is
 * taken. Times are counted from the start.
 */
export class TraceRecorder {
  private readonly steps: TraceStep[] = []
  private readonly started: number

  constructor(
    private readonly start: EditorState,
    private readonly now: () => number = Date.now,
    private readonly name?: string,
  ) {
    this.started = now()
  }

  record(action: TraceAction): void {
    this.steps.push({ ...action, t: Math.max(0, Math.round(this.now() - this.started)) })
  }

  /** The trace so far, ending with what the document must be now when `end` is given. */
  trace(end?: EditorState): EditorTrace {
    const { config, doc, selection } = this.start
    return {
      version: 1,
      ...(this.name ? { name: this.name } : {}),
      doc: doc.toString(),
      language: config.language.id,
      tabSize: config.tabSize,
      indentUnit: config.indentUnit,
      lineSeparator: config.lineSeparator,
      ...(config.readOnly ? { readOnly: true } : {}),
      selection: selection.ranges.map((range) => [range.anchor, range.head] as const),
      steps: end ? [...this.steps, { expect: expectOf(end.doc), t: Math.max(0, Math.round(this.now() - this.started)) }] : [...this.steps],
    }
  }
}

/** Words every supported language uses as keywords: kept as they are, since indentation and comments depend on them. */
const KEYWORDS = new Set(
  (
    'if else elif elseif end then do function return local for while repeat until def class const let var import export from ' +
    'true false nil null undefined None True False async await new this self try catch except finally switch case default ' +
    'break continue in of and or not is with as pass lambda yield interface type enum public private protected static void ' +
    'fn mut pub struct impl use mod match loop goto'
  ).split(' '),
)

/**
 * The trace with every word replaced by another of the same length and kinds of character (the same word always by
 * the same one), keywords, punctuation, spaces and line breaks kept: what a bug report can carry without the code in
 * it. The positions in the trace still fit. Its `expect` steps are made again from the scrambled replay.
 */
export function scrambleTrace(trace: EditorTrace, seed = 1): EditorTrace {
  const map = new Map<string, string>()
  const used = new Set<string>()
  let state = seed >>> 0 || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  /** Another word of the same length in UTF-16 units and the same kinds of character, the same one each time. */
  const swap = (word: string): string => {
    if (KEYWORDS.has(word) || /^_+$/.test(word)) return word
    const known = map.get(word)
    if (known !== undefined) return known
    let made = word
    for (let attempt = 0; attempt < 20; attempt++) {
      made = Array.from(word, (char) => {
        if (/\p{Lu}/u.test(char)) return String.fromCharCode(65 + Math.floor(next() * 26))
        if (/\p{L}/u.test(char)) return String.fromCharCode(97 + Math.floor(next() * 26))
        if (/\p{N}/u.test(char)) return String.fromCharCode(48 + Math.floor(next() * 10))
        return char
      }).join('')
      // A character outside the BMP became one inside it: pad, so every position in the trace still fits.
      made = made.padEnd(word.length, 'x')
      if (!used.has(made) && !KEYWORDS.has(made)) break
    }
    map.set(word, made)
    used.add(made)
    return made
  }
  const scramble = (text: string) => text.replace(/[\p{L}\p{N}_]+/gu, swap)
  const scrambled: EditorTrace = {
    ...trace,
    doc: scramble(trace.doc),
    steps: trace.steps.map((step): TraceStep => {
      if ('type' in step) return { ...step, type: scramble(step.type) }
      if ('insert' in step) return { ...step, insert: scramble(step.insert) }
      if ('paste' in step && typeof step.paste === 'string') return { ...step, paste: scramble(step.paste) }
      if ('changes' in step) return { ...step, changes: step.changes.map(([from, to, insert]) => [from, to, scramble(insert)] as const) }
      if ('reload' in step) return { ...step, reload: scramble(step.reload) }
      if ('replaceAll' in step) {
        const query = step.replaceAll
        return { ...step, replaceAll: { ...query, search: query.regexp ? query.search : scramble(query.search) }, with: query.regexp ? step.with : scramble(step.with) }
      }
      return step
    }),
  }
  if (trace.name) scrambled.name = scramble(trace.name)
  // The scrambled text has other hashes: take each `expect` from the scrambled replay.
  const steps = scrambled.steps.slice() as TraceStep[]
  replayTrace(scrambled, {
    check: false,
    onStep: (index, at) => {
      const original = steps[index - 1]
      if ('expect' in original) steps[index - 1] = { ...original, expect: expectOf(at.doc) }
    },
  })
  return { ...scrambled, steps }
}
