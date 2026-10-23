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

/** A page up or down: the view scrolls by a screen and the cursors move the same distance. */
function page(direction: 1 | -1, extend: boolean): ViewCommand {
  return (view) => {
    const lines = Math.max(1, view.lineCapacity - 1) * direction
    const transaction = core.cursorPage(lines, extend)(view.state)
    view.scrollBy(lines * view.metrics.lineHeight)
    if (transaction) view.dispatch(transaction)
    return true
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
  cursorLineUp: move(core.cursorLineUp),
  selectLineUp: move(core.selectLineUp),
  cursorLineDown: move(core.cursorLineDown),
  selectLineDown: move(core.selectLineDown),
  cursorLineStart: move(core.cursorLineStart),
  selectLineStart: move(core.selectLineStart),
  cursorLineEnd: move(core.cursorLineEnd),
  selectLineEnd: move(core.selectLineEnd),
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
  addCursorAbove: move(core.addCursorAbove),
  addCursorBelow: move(core.addCursorBelow),
  moveLineUp: run(core.moveLineUp),
  moveLineDown: run(core.moveLineDown),
  copyLineUp: run(core.copyLineUp),
  copyLineDown: run(core.copyLineDown),
  selectAll: move(core.selectAll),
  selectLine: move(core.selectLine),
  selectNextOccurrence: move(core.selectNextOccurrence),
  selectAllOccurrences: move(core.selectAllOccurrences),
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

  openFind: (view) => (view.find.open(false), true),
  openReplace: (view) => (view.find.open(true), true),
  findNext: (view) => view.find.next(),
  findPrevious: (view) => view.find.previous(),
  selectAllMatches: (view) => view.find.selectAllMatches(),
  closeFind: (view) => view.find.close(),

  nextSnippetStop: (view) => view.snippet.next(),
  previousSnippetStop: (view) => view.snippet.previous(),
  exitSnippet: (view) => view.snippet.exit(),

  reviewNextChange: (view) => view.review.next(),
  reviewPreviousChange: (view) => view.review.previous(),
  reviewAcceptAll: (view) => (view.review.acceptAll(), view.review.active),
  reviewRejectAll: (view) => (view.review.rejectAll(), view.review.active),
}
