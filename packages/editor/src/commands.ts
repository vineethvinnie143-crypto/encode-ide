import { ChangeSet, type ChangeSpec, type Text } from '@encode/text'
import { findMatching, bracketAt } from './brackets'
import { compileSearch, searchMatches } from './search'
import { EditorSelection, SelectionRange } from './selection'
import { mapAutoClosed, type EditorState, type Transaction } from './state'
import {
  CharClass,
  charClass,
  columnAt,
  indentWidth,
  indexAtColumn,
  leadingWhitespace,
  makeIndent,
  nextCluster,
  previousCluster,
  unitWidth,
  wordAround,
  wordEndAfter,
  wordStartBefore,
} from './text-utils'

/**
 * Editing commands. A command reads a state and describes what a key does
 * to it as a transaction, or returns null when it does not apply (the view
 * then lets the next binding try). Commands never touch the DOM.
 */
export type Command = (state: EditorState) => Transaction | null

/** Characters an opening bracket or quote may be typed in front of and still get its partner. */
const AUTO_CLOSE_BEFORE = ';:.,=}])>` \t'

// ---------------------------------------------------------------- helpers

/** What one selection range turns into: its changes, and the range afterwards. */
export interface RangeEdit {
  changes?: ChangeSpec | readonly ChangeSpec[]
  /** The range afterwards, counted in the document with only this range's changes applied. */
  range: SelectionRange
  /** Auto-inserted closing characters, counted the same way. */
  closers?: readonly number[]
}

/**
 * Runs `edit` for every selection range and combines the results. Each
 * range's changes and new range are written as if it were alone; the offsets
 * are shifted by what the ranges before it inserted and deleted. Should two
 * ranges' changes interleave, the selection falls back to plain mapping.
 */
export function changeByRange(
  state: EditorState,
  edit: (range: SelectionRange, index: number) => RangeEdit,
): { changes: ChangeSet; selection: EditorSelection; closers: number[] } {
  const length = state.doc.length
  const specs: ChangeSpec[] = []
  const ranges: SelectionRange[] = []
  const closers: number[] = []
  let delta = 0
  let reach = 0
  let ordered = true
  state.selection.ranges.forEach((range, index) => {
    const result = edit(range, index)
    const own = result.changes === undefined ? null : ChangeSet.of(result.changes, length)
    if (own && !own.empty) {
      if (own.changes[0].from < reach) ordered = false
      reach = Math.max(reach, own.changes[own.changes.length - 1].to)
      specs.push(...own.changes)
    }
    const shift = (pos: number) => pos + delta
    ranges.push(new SelectionRange(shift(result.range.anchor), shift(result.range.head), result.range.goalColumn))
    for (const pos of result.closers ?? []) closers.push(shift(pos))
    if (own) delta += own.newLength - length
  })
  const changes = ChangeSet.of(specs, length)
  if (!ordered) {
    const mapped = state.selection.ranges.map((range) => SelectionRange.cursor(changes.mapPos(range.head, 1)))
    return { changes, selection: EditorSelection.create(mapped, state.selection.mainIndex), closers: [] }
  }
  return { changes, selection: EditorSelection.create(ranges, state.selection.mainIndex), closers }
}

function editable(state: EditorState): boolean {
  return !state.config.readOnly
}

/** The character at `pos`: "\n" at a line end, "" at the end of the document. */
function charAt(doc: Text, pos: number): string {
  if (pos < 0 || pos >= doc.length) return ''
  const line = doc.lineAt(pos)
  return pos < line.to ? line.text[pos - line.from] : '\n'
}

function select(state: EditorState, ranges: readonly SelectionRange[], mainIndex = state.selection.mainIndex): Transaction | null {
  const selection = EditorSelection.create(ranges, mainIndex)
  if (selection.eq(state.selection) && selection.ranges.every((range, index) => range.goalColumn === state.selection.ranges[index].goalColumn)) {
    return null
  }
  return state.update({ selection, scrollIntoView: true, origin: 'select' })
}

/** Moves every range with `move`; when extending, only the head moves. */
function moveBy(state: EditorState, extend: boolean, move: (range: SelectionRange) => SelectionRange): Transaction | null {
  return select(
    state,
    state.selection.ranges.map((range) => {
      const moved = move(range)
      return extend ? range.extend(moved.head, moved.goalColumn) : moved
    }),
  )
}

/** Line numbers covered by the selection, as merged blocks. A selection ending at a line start leaves that line out. */
interface LineBlock {
  first: number
  last: number
  ranges: SelectionRange[]
}

function lineBlocks(state: EditorState): LineBlock[] {
  const blocks: LineBlock[] = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    let last = state.doc.lineAt(range.to).number
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last--
    const previous = blocks[blocks.length - 1]
    if (previous && first <= previous.last + 1) {
      previous.last = Math.max(previous.last, last)
      previous.ranges.push(range)
    } else {
      blocks.push({ first, last, ranges: [range] })
    }
  }
  return blocks
}

/** Maps a range through changes, choosing per end whether text inserted right at it goes before (-1) or after (1). */
function mapRange(range: SelectionRange, changes: ChangeSet, assoc: (pos: number) => -1 | 1): SelectionRange {
  return new SelectionRange(changes.mapPos(range.anchor, assoc(range.anchor)), changes.mapPos(range.head, assoc(range.head)))
}

// ---------------------------------------------------------------- motion

function charBefore(doc: Text, pos: number): number {
  const line = doc.lineAt(pos)
  if (pos === line.from) return Math.max(0, pos - 1)
  return line.from + previousCluster(line.text, pos - line.from)
}

function charAfter(doc: Text, pos: number): number {
  const line = doc.lineAt(pos)
  if (pos === line.to) return Math.min(doc.length, pos + 1)
  return line.from + nextCluster(line.text, pos - line.from)
}

function wordBefore(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  if (pos === line.from) return Math.max(0, pos - 1)
  return line.from + wordStartBefore(line.text, pos - line.from, state.language.wordChars)
}

function wordAfter(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  if (pos === line.to) return Math.min(state.doc.length, pos + 1)
  return line.from + wordEndAfter(line.text, pos - line.from, state.language.wordChars)
}

/** `lines` up (negative) or down, aiming for the range's goal column. Past either end lands on the document's edge. */
function vertical(state: EditorState, range: SelectionRange, lines: number, extend: boolean): SelectionRange {
  const { doc } = state
  const tabSize = state.config.tabSize
  const collapse = !extend && !range.empty
  const start = collapse ? (lines < 0 ? range.from : range.to) : range.head
  const line = doc.lineAt(start)
  const goal = !collapse && range.goalColumn !== undefined ? range.goalColumn : columnAt(line.text, start - line.from, tabSize)
  const target = line.number + lines
  if (target < 1) return SelectionRange.cursor(0, goal)
  if (target > doc.lineCount) return SelectionRange.cursor(doc.length, goal)
  const next = doc.line(target)
  return SelectionRange.cursor(next.from + indexAtColumn(next.text, goal, tabSize), goal)
}

export const cursorCharLeft: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(range.empty ? charBefore(state.doc, range.head) : range.from))
export const selectCharLeft: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(charBefore(state.doc, range.head)))
export const cursorCharRight: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(range.empty ? charAfter(state.doc, range.head) : range.to))
export const selectCharRight: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(charAfter(state.doc, range.head)))

export const cursorWordLeft: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(wordBefore(state, range.head)))
export const selectWordLeft: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(wordBefore(state, range.head)))
export const cursorWordRight: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(wordAfter(state, range.head)))
export const selectWordRight: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(wordAfter(state, range.head)))

export const cursorLineUp: Command = (state) => moveBy(state, false, (range) => vertical(state, range, -1, false))
export const selectLineUp: Command = (state) => moveBy(state, true, (range) => vertical(state, range, -1, true))
export const cursorLineDown: Command = (state) => moveBy(state, false, (range) => vertical(state, range, 1, false))
export const selectLineDown: Command = (state) => moveBy(state, true, (range) => vertical(state, range, 1, true))

/** Page motion; the view knows how many lines a page holds. */
export function cursorPage(lines: number, extend = false): Command {
  return (state) => moveBy(state, extend, (range) => vertical(state, range, lines, extend))
}

/** Home: to the first non-blank character, or to the line start when already there. */
function lineStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const indent = line.from + leadingWhitespace(line.text).length
  return pos === indent ? line.from : indent
}

export const cursorLineStart: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(lineStart(state, range.head)))
export const selectLineStart: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(lineStart(state, range.head)))
export const cursorLineEnd: Command = (state) =>
  moveBy(state, false, (range) => SelectionRange.cursor(state.doc.lineAt(range.head).to))
export const selectLineEnd: Command = (state) =>
  moveBy(state, true, (range) => SelectionRange.cursor(state.doc.lineAt(range.head).to))

export const cursorDocStart: Command = (state) => select(state, [SelectionRange.cursor(0)], 0)
export const selectDocStart: Command = (state) => select(state, [state.selection.main.extend(0)], 0)
export const cursorDocEnd: Command = (state) => select(state, [SelectionRange.cursor(state.doc.length)], 0)
export const selectDocEnd: Command = (state) => select(state, [state.selection.main.extend(state.doc.length)], 0)

export const selectAll: Command = (state) => select(state, [new SelectionRange(0, state.doc.length)], 0)

/** Escape: drops the extra cursors, then collapses the selection. */
export const collapseSelection: Command = (state) => {
  const { selection } = state
  if (selection.ranges.length > 1) return select(state, [selection.main], 0)
  if (!selection.main.empty) return select(state, [SelectionRange.cursor(selection.main.head)], 0)
  return null
}

/** The word at `pos` for a double click: a word, a run of whitespace, or a run of punctuation. */
export function wordRangeAt(state: EditorState, pos: number): SelectionRange {
  const line = state.doc.lineAt(pos)
  const index = pos - line.from
  const wordChars = state.language.wordChars
  const word = wordAround(line.text, index, wordChars)
  if (word) return new SelectionRange(line.from + word.from, line.from + word.to)
  if (index >= line.text.length) return SelectionRange.cursor(pos)
  const kind = charClass(line.text[index], wordChars)
  let from = index
  let to = index
  while (from > 0 && charClass(line.text[from - 1], wordChars) === kind) from--
  while (to < line.text.length && charClass(line.text[to], wordChars) === kind) to++
  return new SelectionRange(line.from + from, line.from + to)
}

/** The whole line at `pos`, with its line break, for a triple click. */
export function lineRangeAt(state: EditorState, pos: number): SelectionRange {
  const line = state.doc.lineAt(pos)
  const end = line.number < state.doc.lineCount ? line.to + 1 : line.to
  return new SelectionRange(line.from, end)
}

/** Ctrl+L: selects the line, or extends a line selection by the next line. */
export const selectLine: Command = (state) =>
  select(
    state,
    state.selection.ranges.map((range) => {
      const start = state.doc.lineAt(range.from).from
      const endLine = state.doc.lineAt(range.to)
      const end = endLine.number < state.doc.lineCount ? endLine.to + 1 : endLine.to
      return new SelectionRange(start, end)
    }),
  )

/** Moves to the bracket matching the one next to each cursor. */
export const jumpToBracket: Command = (state) => {
  let moved = false
  const ranges = state.selection.ranges.map((range) => {
    const pair = bracketAt(state.doc, range.head, state.language)
    if (!pair || pair.match < 0) return range
    moved = true
    return SelectionRange.cursor(pair.at === range.head ? pair.match : pair.match + 1)
  })
  return moved ? select(state, ranges) : null
}

// ---------------------------------------------------------------- multiple cursors

function addCursorVertically(state: EditorState, lines: -1 | 1): Transaction | null {
  const { doc } = state
  const tabSize = state.config.tabSize
  const ranges = state.selection.ranges.slice()
  let main = state.selection.mainIndex
  for (const [index, range] of state.selection.ranges.entries()) {
    const line = doc.lineAt(range.head)
    const target = line.number + lines
    if (target < 1 || target > doc.lineCount) continue
    const goal = range.goalColumn ?? columnAt(line.text, range.head - line.from, tabSize)
    const next = doc.line(target)
    ranges.push(SelectionRange.cursor(next.from + indexAtColumn(next.text, goal, tabSize), goal))
    if (index === state.selection.mainIndex) main = ranges.length - 1
  }
  return ranges.length === state.selection.ranges.length ? null : select(state, ranges, main)
}

export const addCursorAbove: Command = (state) => addCursorVertically(state, -1)
export const addCursorBelow: Command = (state) => addCursorVertically(state, 1)

/** Adds a cursor at `pos` (Alt+click), or removes the one already there. */
export function toggleCursorAt(state: EditorState, pos: number): Transaction | null {
  const { ranges, mainIndex } = state.selection
  const hit = ranges.findIndex((range) => range.from <= pos && pos <= range.to)
  if (hit < 0) return select(state, [...ranges, SelectionRange.cursor(pos)], ranges.length)
  if (ranges.length === 1) return null
  const rest = ranges.filter((_, index) => index !== hit)
  let main = mainIndex
  if (hit === mainIndex) main = rest.length - 1
  else if (hit < mainIndex) main--
  return select(state, rest, main)
}

/** Word ranges around empty cursors; null when no cursor touches a word. */
function wordsAtCursors(state: EditorState): SelectionRange[] | null {
  let found = false
  const ranges = state.selection.ranges.map((range) => {
    if (!range.empty) return range
    const line = state.doc.lineAt(range.head)
    const word = wordAround(line.text, range.head - line.from, state.language.wordChars)
    if (!word) return range
    found = true
    return new SelectionRange(line.from + word.from, line.from + word.to)
  })
  return found ? ranges : null
}

/** Ctrl+D: selects the word at the cursor, then adds the next occurrence of the main selection. */
export const selectNextOccurrence: Command = (state) => {
  const { doc, selection } = state
  const main = selection.main
  if (main.empty) {
    const words = wordsAtCursors(state)
    return words ? select(state, words) : null
  }
  const search = compileSearch({ search: doc.sliceString(main.from, main.to), caseSensitive: true })
  const taken = (from: number, to: number) => selection.ranges.some((range) => range.from === from && range.to === to)
  const pick = (from: number, to?: number) => {
    for (const match of searchMatches(doc, search, from, to)) if (!taken(match.from, match.to)) return match
    return null
  }
  const next = pick(main.to) ?? pick(0, main.from)
  if (!next) return null
  return select(state, [...selection.ranges, new SelectionRange(next.from, next.to)], selection.ranges.length)
}

/** Ctrl+Shift+L: a selection on every occurrence of the main selection (or the word at the cursor). */
export const selectAllOccurrences: Command = (state) => {
  let main = state.selection.main
  if (main.empty) {
    const line = state.doc.lineAt(main.head)
    const word = wordAround(line.text, main.head - line.from, state.language.wordChars)
    if (!word) return null
    main = new SelectionRange(line.from + word.from, line.from + word.to)
  }
  const search = compileSearch({ search: state.doc.sliceString(main.from, main.to), caseSensitive: true })
  const ranges: SelectionRange[] = []
  let mainIndex = 0
  for (const match of searchMatches(state.doc, search)) {
    if (match.from === main.from) mainIndex = ranges.length
    ranges.push(new SelectionRange(match.from, match.to))
  }
  return ranges.length ? select(state, ranges, mainIndex) : null
}

// ---------------------------------------------------------------- typing

/** Replaces every selection with `text` and puts the cursors after it. */
export function insertText(state: EditorState, text: string, origin = 'input.type'): Transaction | null {
  if (!editable(state)) return null
  const { changes, selection } = changeByRange(state, (range) => ({
    changes: { from: range.from, to: range.to, insert: text },
    range: SelectionRange.cursor(range.from + text.length),
  }))
  return state.update({ changes, selection, origin, scrollIntoView: true })
}

/** Odd count of unescaped `quote` characters before `index`: the cursor is probably inside a string. */
function insideString(text: string, index: number, quote: string): boolean {
  let count = 0
  for (let pos = 0; pos < index; pos++) {
    if (text[pos] === '\\') pos++
    else if (text[pos] === quote) count++
  }
  return count % 2 === 1
}

/**
 * A typed character, with the conveniences editors have: brackets and
 * quotes close themselves, typing a closer the editor inserted steps over
 * it, a bracket or quote typed over a selection surrounds it, and a closing
 * bracket typed on a blank line lines up with its opening line.
 */
export function insertTyped(state: EditorState, text: string): Transaction | null {
  if (!editable(state) || !text) return null
  if (Array.from(text).length !== 1) return insertText(state, text, 'input.type')
  const { doc, language } = state
  const opener = language.brackets.find(([open]) => open === text)
  const closer = language.brackets.find(([, close]) => close === text)
  const quote = language.quotes.includes(text)
  const typedOver = new Set(state.autoClosed)
  const consumed = new Set<number>()

  const result = changeByRange(state, (range) => {
    const head = range.head
    if (range.empty && (closer || quote) && typedOver.has(head) && charAt(doc, head) === text) {
      consumed.add(head)
      return { range: SelectionRange.cursor(head + text.length) }
    }
    if (!range.empty && (opener || quote)) {
      return {
        changes: [
          { from: range.from, insert: text },
          { from: range.to, insert: opener ? opener[1] : text },
        ],
        range: new SelectionRange(range.anchor + text.length, range.head + text.length),
      }
    }
    if (range.empty) {
      const next = charAt(doc, head)
      const freeAfter = next === '' || next === '\n' || AUTO_CLOSE_BEFORE.includes(next)
      if (opener && freeAfter) {
        return {
          changes: { from: head, insert: opener[0] + opener[1] },
          range: SelectionRange.cursor(head + text.length),
          closers: [head + text.length],
        }
      }
      if (quote && freeAfter) {
        const line = doc.lineAt(head)
        const index = head - line.from
        const previous = index > 0 ? line.text[index - 1] : ' '
        if (charClass(previous, language.wordChars) !== CharClass.Word && previous !== text && !insideString(line.text, index, text)) {
          return {
            changes: { from: head, insert: text + text },
            range: SelectionRange.cursor(head + text.length),
            closers: [head + text.length],
          }
        }
      }
      if (closer) {
        const line = doc.lineAt(head)
        const before = line.text.slice(0, head - line.from)
        if (/^[ \t]*$/.test(before)) {
          const open = findMatching(doc, head, closer[0], closer[1], -1)
          if (open >= 0) {
            const indent = leadingWhitespace(doc.lineAt(open).text)
            if (indent !== before) {
              return {
                changes: { from: line.from, to: head, insert: indent + text },
                range: SelectionRange.cursor(line.from + indent.length + text.length),
              }
            }
          }
        }
      }
    }
    return { changes: { from: range.from, to: range.to, insert: text }, range: SelectionRange.cursor(range.from + text.length) }
  })

  let changes = result.changes
  let selection = result.selection
  let autoClosed = [...mapAutoClosed(state.autoClosed.filter((pos) => !consumed.has(pos)), changes), ...result.closers]
  const dedent = changes.empty ? null : dedentClosers(state, changes.apply(doc), selection)
  if (dedent) {
    changes = changes.compose(dedent)
    selection = selection.map(dedent)
    autoClosed = mapAutoClosed(autoClosed, dedent)
  }
  return state.update({
    changes,
    selection,
    origin: 'input.type',
    scrollIntoView: true,
    autoClosed: autoClosed.sort((a, b) => a - b),
  })
}

/**
 * Lines that close a block once typed (Lua's `end`, Python's `else:`, a
 * closing HTML tag) move back to the indentation of the block's opening
 * line. `doc` is the document after typing; null when nothing moves.
 */
function dedentClosers(state: EditorState, doc: Text, selection: EditorSelection): ChangeSet | null {
  const pattern = state.language.dedentOn
  if (!pattern) return null
  const { tabSize, indentUnit } = state.config
  const unit = unitWidth(indentUnit, tabSize)
  const specs: ChangeSpec[] = []
  let previousLine = 0
  for (const range of selection.ranges) {
    const line = doc.lineAt(range.head)
    if (!range.empty || range.head !== line.to || line.number === previousLine || !pattern.test(line.text)) continue
    previousLine = line.number
    let above = line.number - 1
    while (above > 0 && !doc.line(above).text.trim()) above--
    if (above === 0) continue
    const opener = doc.line(above).text
    const openerIndent = indentWidth(leadingWhitespace(opener), tabSize)
    const opens = Boolean(state.language.indentAfter?.test(opener)) || /[{([]\s*$/.test(opener)
    const target = opens ? openerIndent : Math.max(0, openerIndent - unit)
    const current = leadingWhitespace(line.text)
    if (indentWidth(current, tabSize) <= target) continue
    specs.push({ from: line.from, to: line.from + current.length, insert: makeIndent(target, indentUnit, tabSize) })
  }
  return specs.length ? ChangeSet.of(specs, doc.length) : null
}

/** Enter: a new line indented like this one, one level deeper after an opening bracket, and split between a bracket pair. */
export const insertNewlineAndIndent: Command = (state) => {
  if (!editable(state)) return null
  const { doc, language } = state
  const unit = state.config.indentUnit
  const { changes, selection } = changeByRange(state, (range) => {
    const line = doc.lineAt(range.from)
    const endLine = range.to <= line.to ? line : doc.lineAt(range.to)
    const before = line.text.slice(0, range.from - line.from)
    const after = endLine.text.slice(range.to - endLine.from)
    const trimmedBefore = before.replace(/[ \t]+$/, '')
    const trimmedAfter = after.replace(/^[ \t]+/, '')
    const indent = leadingWhitespace(trimmedBefore ? line.text : before)
    const last = trimmedBefore[trimmedBefore.length - 1]
    const pair = language.brackets.find(([open]) => open === last)
    const from = line.from + trimmedBefore.length
    const to = endLine.to - trimmedAfter.length
    if (pair && trimmedAfter.startsWith(pair[1])) {
      const inner = indent + unit
      return {
        changes: { from, to, insert: `\n${inner}\n${indent}` },
        range: SelectionRange.cursor(from + 1 + inner.length),
      }
    }
    const deeper = Boolean(pair) || Boolean(language.indentAfter?.test(trimmedBefore))
    const insert = `\n${deeper ? indent + unit : indent}`
    return { changes: { from, to, insert }, range: SelectionRange.cursor(from + insert.length) }
  })
  return state.update({ changes, selection, origin: 'input.newline', scrollIntoView: true })
}

/** Ctrl+Enter: a new line below the current one, keeping its indentation. */
export const insertLineAfter: Command = (state) => {
  if (!editable(state)) return null
  const { changes, selection } = changeByRange(state, (range) => {
    const line = state.doc.lineAt(range.head)
    const indent = leadingWhitespace(line.text)
    return { changes: { from: line.to, insert: `\n${indent}` }, range: SelectionRange.cursor(line.to + 1 + indent.length) }
  })
  return state.update({ changes, selection, origin: 'input.newline', scrollIntoView: true })
}

/** Ctrl+Shift+Enter: a new line above the current one. */
export const insertLineBefore: Command = (state) => {
  if (!editable(state)) return null
  const { changes, selection } = changeByRange(state, (range) => {
    const line = state.doc.lineAt(range.head)
    const indent = leadingWhitespace(line.text)
    return { changes: { from: line.from, insert: `${indent}\n` }, range: SelectionRange.cursor(line.from + indent.length) }
  })
  return state.update({ changes, selection, origin: 'input.newline', scrollIntoView: true })
}

// ---------------------------------------------------------------- deleting

function deleteBy(state: EditorState, target: (range: SelectionRange) => { from: number; to: number }): Transaction | null {
  if (!editable(state)) return null
  const { changes, selection } = changeByRange(state, (range) => {
    const { from, to } = range.empty ? target(range) : range
    return { changes: { from, to }, range: SelectionRange.cursor(from) }
  })
  if (changes.empty) return select(state, selection.ranges)
  return state.update({ changes, selection, origin: 'input.delete', scrollIntoView: true })
}

/** Backspace: a character (a whole cluster), an auto-inserted pair, or back to the previous indentation stop. */
export const deleteCharBackward: Command = (state) => {
  const { doc, language } = state
  const autoClosed = new Set(state.autoClosed)
  const spaces = state.config.indentUnit !== '\t'
  const unit = unitWidth(state.config.indentUnit, state.config.tabSize)
  return deleteBy(state, ({ head }) => {
    if (head === 0) return { from: 0, to: 0 }
    const line = doc.lineAt(head)
    const index = head - line.from
    if (index === 0) return { from: head - 1, to: head }
    const before = line.text[index - 1]
    const after = line.text[index]
    if (autoClosed.has(head) && (language.brackets.some(([open, close]) => open === before && close === after) || (before === after && language.quotes.includes(before)))) {
      return { from: head - 1, to: head + 1 }
    }
    if (spaces && before === ' ' && /^ +$/.test(line.text.slice(0, index))) {
      return { from: head - ((index % unit) || unit), to: head }
    }
    return { from: line.from + previousCluster(line.text, index), to: head }
  })
}

/** Delete: the next character (a whole cluster), or the line break. */
export const deleteCharForward: Command = (state) => deleteBy(state, ({ head }) => ({ from: head, to: charAfter(state.doc, head) }))

/** Ctrl+Backspace. */
export const deleteWordBackward: Command = (state) => deleteBy(state, ({ head }) => ({ from: wordBefore(state, head), to: head }))

/** Ctrl+Delete. */
export const deleteWordForward: Command = (state) => deleteBy(state, ({ head }) => ({ from: head, to: wordAfter(state, head) }))

/** Ctrl+Shift+K: deletes the selected lines; the cursor keeps its column on the line that takes their place. */
export const deleteLine: Command = (state) => {
  if (!editable(state)) return null
  const { doc } = state
  const tabSize = state.config.tabSize
  const specs: ChangeSpec[] = []
  const ranges: SelectionRange[] = []
  let delta = 0
  for (const block of lineBlocks(state)) {
    const head = block.ranges[block.ranges.length - 1].head
    const headLine = doc.lineAt(head)
    const column = columnAt(headLine.text, head - headLine.from, tabSize)
    const first = doc.line(block.first)
    const last = doc.line(block.last)
    let from: number
    let to: number
    let cursor: number
    if (block.last < doc.lineCount) {
      const next = doc.line(block.last + 1)
      from = first.from
      to = next.from
      cursor = from + indexAtColumn(next.text, column, tabSize)
    } else if (block.first > 1) {
      const previous = doc.line(block.first - 1)
      from = previous.to
      to = last.to
      cursor = previous.from + indexAtColumn(previous.text, column, tabSize)
    } else {
      from = 0
      to = doc.length
      cursor = 0
    }
    specs.push({ from, to })
    ranges.push(SelectionRange.cursor(cursor + delta))
    delta -= to - from
  }
  const changes = ChangeSet.of(specs, doc.length)
  if (changes.empty) return null
  return state.update({ changes, selection: EditorSelection.create(ranges), origin: 'command', scrollIntoView: true })
}

// ---------------------------------------------------------------- clipboard

export interface ClipboardText {
  text: string
  /** Copied from cursors without a selection: whole lines, which paste above the cursor's line. */
  linewise: boolean
}

/** What Ctrl+C puts on the clipboard: the selections, or the cursors' lines when nothing is selected. */
export function copyText(state: EditorState): ClipboardText {
  const ranges = state.selection.ranges
  if (ranges.every((range) => range.empty)) {
    const lines: string[] = []
    let previous = 0
    for (const range of ranges) {
      const line = state.doc.lineAt(range.head)
      if (line.number !== previous) lines.push(`${line.text}\n`)
      previous = line.number
    }
    return { text: lines.join(''), linewise: true }
  }
  return {
    text: ranges
      .filter((range) => !range.empty)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join('\n'),
    linewise: false,
  }
}

/** Ctrl+X: the clipboard text, and the transaction that removes it. */
export function cutText(state: EditorState): { clipboard: ClipboardText; transaction: Transaction | null } {
  const clipboard = copyText(state)
  if (!editable(state)) return { clipboard, transaction: null }
  if (clipboard.linewise) return { clipboard, transaction: deleteLine(state) }
  const { changes, selection } = changeByRange(state, (range) => ({
    changes: { from: range.from, to: range.to },
    range: SelectionRange.cursor(range.from),
  }))
  return { clipboard, transaction: state.update({ changes, selection, origin: 'input.cut', scrollIntoView: true }) }
}

/**
 * Ctrl+V. Line breaks are normalised; text with one line per cursor is
 * spread over the cursors; whole lines copied without a selection go above
 * each cursor's line.
 */
export function paste(state: EditorState, text: string, linewise = false): Transaction | null {
  if (!editable(state)) return null
  const normalized = text.replace(/\r\n?/g, '\n')
  const ranges = state.selection.ranges
  if (linewise && ranges.every((range) => range.empty)) {
    const { changes, selection } = changeByRange(state, (range) => {
      const line = state.doc.lineAt(range.head)
      return { changes: { from: line.from, insert: normalized }, range: SelectionRange.cursor(range.head + normalized.length) }
    })
    return state.update({ changes, selection, origin: 'input.paste', scrollIntoView: true })
  }
  let parts = normalized.split('\n')
  if (parts.length === ranges.length + 1 && parts[parts.length - 1] === '') parts = parts.slice(0, -1)
  if (ranges.length > 1 && parts.length === ranges.length) {
    const { changes, selection } = changeByRange(state, (range, index) => ({
      changes: { from: range.from, to: range.to, insert: parts[index] },
      range: SelectionRange.cursor(range.from + parts[index].length),
    }))
    return state.update({ changes, selection, origin: 'input.paste', scrollIntoView: true })
  }
  return insertText(state, normalized, 'input.paste')
}

// ---------------------------------------------------------------- indentation

function indentLines(state: EditorState, edit: (line: { from: number; text: string }) => ChangeSpec | null): Transaction | null {
  if (!editable(state)) return null
  const specs: ChangeSpec[] = []
  for (const block of lineBlocks(state)) {
    const skipBlank = block.last > block.first
    for (let number = block.first; number <= block.last; number++) {
      const line = state.doc.line(number)
      if (skipBlank && !line.text.trim()) continue
      const change = edit(line)
      if (change) specs.push(change)
    }
  }
  const changes = ChangeSet.of(specs, state.doc.length)
  if (changes.empty) return null
  const lineStarts = (pos: number): -1 | 1 => (state.doc.lineAt(pos).from === pos ? -1 : 1)
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) => (range.empty ? SelectionRange.cursor(changes.mapPos(range.head, 1)) : mapRange(range, changes, lineStarts))),
    state.selection.mainIndex,
  )
  return state.update({ changes, selection, origin: 'command', scrollIntoView: true })
}

/** Ctrl+]: one more level of indentation on every selected line. */
export const indentMore: Command = (state) => indentLines(state, (line) => ({ from: line.from, insert: state.config.indentUnit }))

/** Ctrl+[ and Shift+Tab: back to the previous indentation stop. */
export const indentLess: Command = (state) => {
  const { tabSize, indentUnit } = state.config
  const unit = unitWidth(indentUnit, tabSize)
  return indentLines(state, (line) => {
    const space = leadingWhitespace(line.text)
    if (!space) return null
    const width = indentWidth(space, tabSize)
    const target = Math.max(0, Math.ceil(width / unit) - 1) * unit
    let keep = space.length
    while (keep > 0 && indentWidth(space.slice(0, keep), tabSize) > target) keep--
    const insert = ' '.repeat(target - indentWidth(space.slice(0, keep), tabSize))
    return { from: line.from + keep, to: line.from + space.length, insert }
  })
}

/** Tab: indents a selection that spans lines, otherwise inserts indentation up to the next stop. */
export const insertTab: Command = (state) => {
  if (!editable(state)) return null
  const { doc } = state
  const multiline = state.selection.ranges.some((range) => !range.empty && doc.lineAt(range.from).number !== doc.lineAt(range.to).number)
  if (multiline) return indentMore(state)
  const { tabSize, indentUnit } = state.config
  const { changes, selection } = changeByRange(state, (range) => {
    let insert = '\t'
    if (indentUnit !== '\t') {
      const line = doc.lineAt(range.from)
      const unit = unitWidth(indentUnit, tabSize)
      insert = ' '.repeat(unit - (columnAt(line.text, range.from - line.from, tabSize) % unit))
    }
    return { changes: { from: range.from, to: range.to, insert }, range: SelectionRange.cursor(range.from + insert.length) }
  })
  return state.update({ changes, selection, origin: 'input.type', scrollIntoView: true })
}

/** A fresh indentation string for the configured unit (tabs or spaces). */
export function indentString(state: EditorState, columns: number): string {
  return makeIndent(columns, state.config.indentUnit, state.config.tabSize)
}

// ---------------------------------------------------------------- comments

/** Ctrl+/: comments or uncomments the selected lines; languages without line comments get a block comment. */
export const toggleLineComment: Command = (state) => {
  if (!editable(state)) return null
  const { language } = state
  if (!language.lineComment) return language.blockComment ? toggleBlockCommentLines(state) : null
  const token = language.lineComment
  const tabSize = state.config.tabSize
  const lines = lineBlocks(state).flatMap((block) =>
    Array.from({ length: block.last - block.first + 1 }, (_, offset) => state.doc.line(block.first + offset)),
  )
  const filled = lines.filter((line) => line.text.trim())
  const targets = filled.length ? filled : lines
  const commented = filled.length > 0 && filled.every((line) => line.text.slice(leadingWhitespace(line.text).length).startsWith(token))
  const specs: ChangeSpec[] = []
  if (commented) {
    for (const line of filled) {
      const start = line.from + leadingWhitespace(line.text).length
      let end = start + token.length
      if (state.doc.sliceString(end, Math.min(end + 1, line.to)) === ' ') end++
      specs.push({ from: start, to: end })
    }
  } else {
    const column = Math.min(...targets.map((line) => indentWidth(leadingWhitespace(line.text), tabSize)))
    for (const line of targets) specs.push({ from: line.from + indexAtColumn(line.text, column, tabSize), insert: `${token} ` })
  }
  const changes = ChangeSet.of(specs, state.doc.length)
  if (changes.empty) return null
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) =>
      range.empty ? SelectionRange.cursor(changes.mapPos(range.head, 1)) : mapRange(range, changes, (pos) => (pos === range.from ? -1 : 1)),
    ),
    state.selection.mainIndex,
  )
  return state.update({ changes, selection, origin: 'command', scrollIntoView: true })
}

/** Removes `open`/`close` around `from`–`to` (allowing a space inside each), or null when they are not there. */
function unwrapComment(doc: Text, from: number, to: number, open: string, close: string): ChangeSpec[] | null {
  const text = doc.sliceString(from, to)
  const start = text.length - text.trimStart().length
  const end = text.trimEnd().length
  const inner = text.slice(start, end)
  if (inner.length < open.length + close.length || !inner.startsWith(open) || !inner.endsWith(close)) return null
  const openEnd = from + start + open.length + (inner[open.length] === ' ' ? 1 : 0)
  const closeStart = from + end - close.length - (inner[inner.length - close.length - 1] === ' ' && inner.length > open.length + close.length + 1 ? 1 : 0)
  return [
    { from: from + start, to: Math.min(openEnd, closeStart) },
    { from: Math.max(openEnd, closeStart), to: from + end },
  ]
}

function toggleBlockCommentLines(state: EditorState): Transaction | null {
  const [open, close] = state.language.blockComment!
  const specs: ChangeSpec[] = []
  for (const block of lineBlocks(state)) {
    const first = state.doc.line(block.first)
    const last = state.doc.line(block.last)
    const from = first.from + leadingWhitespace(first.text).length
    const to = last.to
    if (from === to && block.first === block.last) {
      specs.push({ from, insert: `${open}  ${close}` })
      continue
    }
    specs.push(...(unwrapComment(state.doc, from, to, open, close) ?? [{ from, insert: `${open} ` }, { from: to, insert: ` ${close}` }]))
  }
  const changes = ChangeSet.of(specs, state.doc.length)
  return changes.empty ? null : state.update({ changes, origin: 'command', scrollIntoView: true })
}

/** Shift+Alt+A: wraps each selection in a block comment, or unwraps one. */
export const toggleBlockComment: Command = (state) => {
  if (!editable(state)) return null
  const pair = state.language.blockComment
  if (!pair) return null
  const [open, close] = pair
  const { doc } = state
  const { changes, selection } = changeByRange(state, (range) => {
    if (range.empty) {
      return { changes: { from: range.head, insert: `${open}  ${close}` }, range: SelectionRange.cursor(range.head + open.length + 1) }
    }
    // The selection may sit inside the markers ("/* x */" with x selected) or include them.
    const before = doc.sliceString(Math.max(0, range.from - open.length - 1), range.from)
    const after = doc.sliceString(range.to, Math.min(doc.length, range.to + close.length + 1))
    const openFrom = before.endsWith(`${open} `) ? range.from - open.length - 1 : before.endsWith(open) ? range.from - open.length : -1
    const closeTo = after.startsWith(` ${close}`) ? range.to + close.length + 1 : after.startsWith(close) ? range.to + close.length : -1
    const outside = openFrom >= 0 && closeTo >= 0
    const unwrap = outside
      ? [
          { from: openFrom, to: range.from },
          { from: range.to, to: closeTo },
        ]
      : unwrapComment(doc, range.from, range.to, open, close)
    if (unwrap) {
      const removedBefore = unwrap[0].to! - unwrap[0].from
      const removedInside = outside ? 0 : unwrap[1].to! - unwrap[1].from
      const start = outside ? openFrom : range.from
      const end = range.to - removedBefore - removedInside
      return { changes: unwrap, range: range.head >= range.anchor ? new SelectionRange(start, end) : new SelectionRange(end, start) }
    }
    const shift = open.length + 1
    return {
      changes: [
        { from: range.from, insert: `${open} ` },
        { from: range.to, insert: ` ${close}` },
      ],
      range: new SelectionRange(range.anchor + shift, range.head + shift),
    }
  })
  return state.update({ changes, selection, origin: 'command', scrollIntoView: true })
}

// ---------------------------------------------------------------- line moves

function moveLines(state: EditorState, direction: -1 | 1): Transaction | null {
  if (!editable(state)) return null
  const { doc } = state
  const blocks = lineBlocks(state)
  if (direction < 0 ? blocks[0].first === 1 : blocks[blocks.length - 1].last === doc.lineCount) return null
  const specs: ChangeSpec[] = []
  const ranges: SelectionRange[] = []
  for (const block of blocks) {
    const first = doc.line(block.first)
    const last = doc.line(block.last)
    const text = doc.sliceString(first.from, last.to)
    if (direction < 0) {
      const above = doc.line(block.first - 1)
      specs.push({ from: above.from, to: last.to, insert: `${text}\n${above.text}` })
      const shift = -(above.text.length + 1)
      for (const range of block.ranges) ranges.push(new SelectionRange(range.anchor + shift, range.head + shift, range.goalColumn))
    } else {
      const below = doc.line(block.last + 1)
      specs.push({ from: first.from, to: below.to, insert: `${below.text}\n${text}` })
      const shift = below.text.length + 1
      for (const range of block.ranges) ranges.push(new SelectionRange(range.anchor + shift, range.head + shift, range.goalColumn))
    }
  }
  const changes = ChangeSet.of(specs, doc.length)
  return state.update({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    origin: 'command',
    scrollIntoView: true,
  })
}

/** Alt+Up. */
export const moveLineUp: Command = (state) => moveLines(state, -1)
/** Alt+Down. */
export const moveLineDown: Command = (state) => moveLines(state, 1)

function copyLines(state: EditorState, direction: -1 | 1): Transaction | null {
  if (!editable(state)) return null
  const { doc } = state
  const specs: ChangeSpec[] = []
  const ranges: SelectionRange[] = []
  let delta = 0
  for (const block of lineBlocks(state)) {
    const first = doc.line(block.first)
    const last = doc.line(block.last)
    const text = doc.sliceString(first.from, last.to)
    // Copying down moves the cursors onto the copy; copying up leaves them on the new upper copy.
    specs.push(direction > 0 ? { from: last.to, insert: `\n${text}` } : { from: first.from, insert: `${text}\n` })
    const shift = delta + (direction > 0 ? text.length + 1 : 0)
    for (const range of block.ranges) ranges.push(new SelectionRange(range.anchor + shift, range.head + shift, range.goalColumn))
    delta += text.length + 1
  }
  const changes = ChangeSet.of(specs, doc.length)
  return state.update({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    origin: 'command',
    scrollIntoView: true,
  })
}

/** Shift+Alt+Up. */
export const copyLineUp: Command = (state) => copyLines(state, -1)
/** Shift+Alt+Down. */
export const copyLineDown: Command = (state) => copyLines(state, 1)

export { redo, undo } from './state'
