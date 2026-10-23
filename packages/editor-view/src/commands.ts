import * as core from '@encode/editor'
import type { EditorView } from './view'

/** A command the keymap can name. Returns false when it does not apply, so the next binding of the key can try. */
export type ViewCommand = (view: EditorView) => boolean

function run(command: core.Command): ViewCommand {
  return (view) => {
    const transaction = command(view.state)
    if (!transaction) return false
    view.dispatch(transaction)
    return true
  }
}

/**
 * A command that moves or selects. It always counts as handled, and when
 * nothing moved the view still brings the cursor back on screen, as it does
 * after any other movement.
 */
function move(command: core.Command): ViewCommand {
  return (view) => {
    const transaction = command(view.state)
    if (transaction) view.dispatch(transaction)
    else view.scrollToPos(view.state.selection.main.head)
    return true
  }
}

/** Every range moved `rows` rows, as the view counts them while lines wrap. */
function byRows(view: EditorView, rows: number, extend: boolean): core.Command {
  return (state) => core.moveBy(state, extend, (range) => view.verticalMove(range, rows, extend)!)
}

/**
 * A page up or down: the view scrolls by a screen and the cursors move the same distance, folded blocks not counted
 * (rows, while lines wrap).
 */
function page(direction: 1 | -1, extend: boolean): ViewCommand {
  return (view) => {
    const lines = Math.max(1, view.lineCapacity - 1) * direction
    const transaction = (view.wrapped ? byRows(view, lines, extend) : core.cursorPage(lines, extend, view.folding.step))(view.state)
    view.scrollBy(lines * view.metrics.lineHeight)
    if (transaction) view.dispatch(transaction)
    return true
  }
}

/** The arrow keys: a line up or down, stepping over a folded block; a row while lines wrap. */
function vertical(lines: -1 | 1, extend: boolean): ViewCommand {
  return (view) => move(view.wrapped ? byRows(view, lines, extend) : core.cursorVertical(lines, extend, view.folding.step))(view)
}

/** Home or End: while lines wrap, to the edge of the row first. */
function lineEdge(end: boolean, extend: boolean, command: core.Command): ViewCommand {
  return (view) => move(view.wrapped ? (state) => core.moveBy(state, extend, (range) => view.rowEdge(range, end)) : command)(view)
}

/** A cursor added on the line above or below, or the row while lines wrap; none past the document's ends. */
function addCursor(direction: -1 | 1): ViewCommand {
  return (view) => move(view.wrapped ? (state) => addCursorByRow(view, state, direction) : core.addCursorVertical(direction, view.folding.step))(view)
}

function addCursorByRow(view: EditorView, state: core.EditorState, direction: -1 | 1): core.Transaction | null {
  const ranges = state.selection.ranges.slice()
  let main = state.selection.mainIndex
  for (const [index, range] of state.selection.ranges.entries()) {
    const added = view.verticalMove(core.SelectionRange.cursor(range.head, range.goalColumn, range.assoc), direction, false, true)
    if (!added) continue
    ranges.push(added)
    if (index === state.selection.mainIndex) main = ranges.length - 1
  }
  if (ranges.length === state.selection.ranges.length) return null
  return state.update({ selection: core.EditorSelection.create(ranges, main), scrollIntoView: true, origin: 'select' })
}

/**
 * A folding command: it applies only where folding is on, and takes its key there even when there is nothing to fold.
 * A screen reader is told what folded or opened, which the text it reads does not show.
 */
function folding(run: (view: EditorView) => boolean): ViewCommand {
  return (view) => {
    if (!view.options.folding) return false
    const before = view.folding.folded.length
    run(view)
    const after = view.folding.folded.length
    if (after > before) view.announce(after - before === 1 ? 'Folded.' : `Folded ${after - before} blocks.`)
    else if (after < before) view.announce(before - after === 1 ? 'Unfolded.' : `Unfolded ${before - after} blocks.`)
    return true
  }
}

/** A command that adds cursors; a screen reader is told how many there are now. */
function counted(command: ViewCommand): ViewCommand {
  return (view) => {
    const before = view.state.selection.ranges.length
    const handled = command(view)
    const after = view.state.selection.ranges.length
    if (after !== before && after > 1) view.announce(`${after} cursors.`)
    return handled
  }
}

/**
 * The commands of the default key map by name. `gotoLine` is left out on
 * purpose: the view cannot ask for a line number itself, so an unknown name
 * is passed to the host as a `request` event.
 */
export const viewCommands: Readonly<Record<string, ViewCommand>> = {
  cursorCharLeft: move(core.cursorCharLeft),
  selectCharLeft: move(core.selectCharLeft),
  cursorCharRight: move(core.cursorCharRight),
  selectCharRight: move(core.selectCharRight),
  cursorWordLeft: move(core.cursorWordLeft),
  selectWordLeft: move(core.selectWordLeft),
  cursorWordRight: move(core.cursorWordRight),
  selectWordRight: move(core.selectWordRight),
  cursorLineUp: vertical(-1, false),
  selectLineUp: vertical(-1, true),
  cursorLineDown: vertical(1, false),
  selectLineDown: vertical(1, true),
  cursorLineStart: lineEdge(false, false, core.cursorLineStart),
  selectLineStart: lineEdge(false, true, core.selectLineStart),
  cursorLineEnd: lineEdge(true, false, core.cursorLineEnd),
  selectLineEnd: lineEdge(true, true, core.selectLineEnd),
  cursorDocStart: move(core.cursorDocStart),
  selectDocStart: move(core.selectDocStart),
  cursorDocEnd: move(core.cursorDocEnd),
  selectDocEnd: move(core.selectDocEnd),
  cursorPageUp: page(-1, false),
  selectPageUp: page(-1, true),
  cursorPageDown: page(1, false),
  selectPageDown: page(1, true),
  scrollLineUp: (view) => (view.scrollBy(-view.metrics.lineHeight), true),
  scrollLineDown: (view) => (view.scrollBy(view.metrics.lineHeight), true),
  addCursorAbove: counted(addCursor(-1)),
  addCursorBelow: counted(addCursor(1)),
  moveLineUp: run(core.moveLineUp),
  moveLineDown: run(core.moveLineDown),
  copyLineUp: run(core.copyLineUp),
  copyLineDown: run(core.copyLineDown),
  selectAll: move(core.selectAll),
  selectLine: move(core.selectLine),
  selectNextOccurrence: counted(move(core.selectNextOccurrence)),
  selectAllOccurrences: counted(move(core.selectAllOccurrences)),
  jumpToBracket: move(core.jumpToBracket),
  collapseSelection: run(core.collapseSelection),

  insertNewlineAndIndent: run(core.insertNewlineAndIndent),
  insertLineAfter: run(core.insertLineAfter),
  insertLineBefore: run(core.insertLineBefore),
  deleteCharBackward: run(core.deleteCharBackward),
  deleteCharForward: run(core.deleteCharForward),
  deleteWordBackward: run(core.deleteWordBackward),
  deleteWordForward: run(core.deleteWordForward),
  deleteLine: run(core.deleteLine),
  insertTab: run(core.insertTab),
  indentLess: run(core.indentLess),
  indentMore: run(core.indentMore),
  toggleLineComment: run(core.toggleLineComment),
  toggleBlockComment: run(core.toggleBlockComment),
  undo: run(core.undo),
  redo: run(core.redo),
  toggleTabMovesFocus: (view) => {
    const on = !view.options.tabMovesFocus
    view.setOptions({ tabMovesFocus: on })
    view.announce(on ? 'Tab now moves the focus.' : 'Tab now inserts a tab.')
    return true
  },

  openFind: (view) => (view.find.open(false), true),
  openReplace: (view) => (view.find.open(true), true),
  findNext: (view) => view.find.next(),
  findPrevious: (view) => view.find.previous(),
  selectAllMatches: (view) => view.find.selectAllMatches(),
  closeFind: (view) => view.find.close(),

  nextSnippetStop: (view) => view.snippet.next(),
  previousSnippetStop: (view) => view.snippet.previous(),
  exitSnippet: (view) => view.snippet.exit(),

  fold: folding((view) => view.folding.fold()),
  unfold: folding((view) => view.folding.unfold()),
  toggleFold: folding((view) => view.folding.toggle()),
  foldRecursively: folding((view) => view.folding.foldRecursively()),
  unfoldRecursively: folding((view) => view.folding.unfoldRecursively()),
  foldAll: folding((view) => view.folding.foldAll()),
  unfoldAll: folding((view) => view.folding.unfoldAll()),
  foldAllComments: folding((view) => view.folding.foldKind('comment')),
  foldAllRegions: folding((view) => view.folding.foldKind('region')),
  unfoldAllRegions: folding((view) => view.folding.unfoldKind('region')),
  foldImports: folding((view) => view.folding.foldKind('imports')),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((level) => [`foldLevel${level}`, folding((view: EditorView) => view.folding.foldLevel(level))]),
  ),

  reviewNextChange: (view) => view.review.next(),
  reviewPreviousChange: (view) => view.review.previous(),
  reviewAcceptAll: (view) => (view.review.acceptAll(), view.review.active),
  reviewRejectAll: (view) => (view.review.rejectAll(), view.review.active),
}
