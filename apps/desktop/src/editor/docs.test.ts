import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { EditorSelection, undo, type EditorState, type Transaction } from '@encode/editor'
import {
  applyExternal,
  applyServerEdits,
  attach,
  changesFromEdits,
  currentDoc,
  closeDoc,
  closeDocsUnder,
  docState,
  hasDoc,
  indentLabel,
  eolOf,
  foldsOf,
  isDirty,
  markSaved,
  matchesSaved,
  openDoc,
  recordState,
  renameDocs,
  revertServerEdits,
  saveFolds,
  scrollOf,
  saveScroll,
  snapshotForSave,
} from './docs'

const path = '/work/a.ts'
afterEach(() => closeDoc(path))

/** A host that behaves like the view: it applies the transaction and reports the new state, as the editor does for the tab's "unsaved" mark. */
function host(initial: EditorState) {
  const view = {
    state: initial,
    reported: [] as boolean[],
    dispatch(tr: Transaction) {
      view.state = tr.state
      view.reported.push(recordState(path, tr.state))
    },
  }
  return view
}

describe('open documents', () => {
  it('opens with the language and indentation of the file, and normalises line endings', () => {
    const state = openDoc(path, 'function f() {\r\n    return 1\r\n}\r\n')
    assert.equal(state.doc.toString(), 'function f() {\n    return 1\n}\n')
    assert.equal(state.config.language.id, 'typescript')
    assert.equal(state.config.indentUnit, '    ')
    assert.equal(state.config.lineSeparator, '\r\n')
    assert.equal(eolOf('a\nb'), '\n')
    assert.equal(openDoc(path, 'something else'), state, 'opening again gives the open document')
  })

  it('names its indentation for the status bar', () => {
    assert.equal(indentLabel(openDoc(path, 'a {\n    b\n}')), 'Spaces: 4')
    closeDoc(path)
    assert.equal(indentLabel(openDoc(path, 'a {\n\tb {\n\t\tc\n\t}\n}')), 'Tab Size: 4')
  })

  it('is unsaved exactly when the text differs from the file', () => {
    const state = openDoc(path, 'one')
    assert.equal(isDirty(path), false)
    const typed = state.update({ changes: { from: 3, insert: '!' }, origin: 'input.type' })
    assert.equal(recordState(path, typed.state), true)
    const deleted = typed.state.update({ changes: { from: 3, to: 4 }, origin: 'input.delete' })
    assert.equal(recordState(path, deleted.state), false, 'typed and deleted again is the saved text')
    const undone = undo(typed.state)!
    assert.equal(recordState(path, undone.state), false)
  })

  it('writes the text with the file\'s line endings, and a save marks what it wrote', () => {
    const state = openDoc(path, 'a\r\nb')
    const edited = state.update({ changes: { from: 1, insert: 'x' }, origin: 'input.type' })
    recordState(path, edited.state)
    const snapshot = snapshotForSave(path)!
    assert.equal(snapshot.text, 'ax\r\nb')
    // Typing while the write is in flight stays unsaved.
    const more = edited.state.update({ changes: { from: 2, insert: 'y' }, origin: 'input.type' })
    recordState(path, more.state)
    markSaved(path, snapshot)
    assert.equal(isDirty(path), true)
    assert.equal(snapshotForSave(path)!.text, 'axy\r\nb')
    markSaved(path, snapshotForSave(path)!)
    assert.equal(isDirty(path), false)
  })

  it('remembers the scroll position of a closed view', () => {
    openDoc(path, 'x')
    assert.equal(scrollOf(path), null)
    saveScroll(path, { top: 120, left: 8 })
    assert.deepEqual(scrollOf(path), { top: 120, left: 8 })
  })

  it('remembers what was folded, moved with changes made while no view showed it', () => {
    const state = openDoc(path, 'a {\n  b\n}\nc {\n  d\n}')
    assert.deepEqual(foldsOf(path), [])
    saveFolds(path, state.doc, [
      { start: 1, end: 2 },
      { start: 4, end: 5, kind: 'region' },
    ])
    assert.deepEqual(foldsOf(path), [
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ])
    // The agent writes a line at the top, then into the first block: the second block moves, the first opens.
    applyExternal(path, 'top\na {\n  b\n}\nc {\n  d\n}')
    assert.deepEqual(foldsOf(path), [
      { start: 2, end: 3 },
      { start: 5, end: 6 },
    ])
    applyExternal(path, 'top\na {\n  b2\n}\nc {\n  d\n}')
    assert.deepEqual(foldsOf(path), [{ start: 5, end: 6 }])
    // Text a view typed without saying what it folded: the folds kept are for another text, and are let go.
    recordState(path, docState(path)!.update({ changes: { from: 0, insert: 'x\n' } }).state)
    assert.deepEqual(foldsOf(path), [])
    saveFolds(path, docState(path)!.doc, [])
    assert.deepEqual(foldsOf(path), [])
  })
})

describe('changes from outside', () => {
  it('replace only what differs and leave the document unchanged in the eyes of "unsaved"', () => {
    const state = openDoc(path, 'a\nb\nc')
    const withCursor = state.update({ selection: EditorSelection.cursor(5) }).state
    recordState(path, withCursor)
    assert.equal(applyExternal(path, 'a\nB\nc\nd'), true)
    const now = docState(path)!
    assert.equal(now.doc.toString(), 'a\nB\nc\nd')
    assert.equal(now.selection.main.head, 5)
    assert.equal(isDirty(path), false)
    assert.equal(applyExternal(path, 'a\nB\nc\nd'), false, 'the same text again changes nothing')
  })

  it('go through the view that shows the document', () => {
    const view = host(openDoc(path, 'one\ntwo'))
    attach(path, view)
    applyExternal(path, 'one\ntwo\nthree')
    assert.equal(view.state.doc.toString(), 'one\ntwo\nthree')
    assert.equal(docState(path)!.doc.toString(), 'one\ntwo\nthree')
    assert.equal(isDirty(path), false)
    assert.deepEqual(view.reported, [false], 'the view is never told the document is edited')
    attach(path, null)
  })

  it('leave an edited document edited, and one that already has the new text saved', () => {
    const view = host(openDoc(path, 'one'))
    attach(path, view)
    const typed = view.state.update({ changes: { from: 3, insert: '!' }, origin: 'input.type' })
    view.dispatch(typed)
    assert.equal(isDirty(path), true)
    // The file now holds exactly what was typed (the agent wrote the same text).
    assert.equal(applyExternal(path, 'one!'), false)
    assert.equal(isDirty(path), false)
    attach(path, null)
  })

  it('can be undone, and then count as unsaved', () => {
    const view = host(openDoc(path, 'one'))
    attach(path, view)
    applyExternal(path, 'one\ntwo')
    const back = undo(view.state)!
    view.dispatch(back)
    assert.equal(view.state.doc.toString(), 'one')
    assert.equal(isDirty(path), true)
  })

  it('on a document that is not open do nothing', () => {
    assert.equal(applyExternal('/work/other.ts', 'x'), false)
  })
})

describe('whether the file is still the one that was read', () => {
  it('compares the file with the text last read or written, whatever its line endings', () => {
    openDoc(path, 'one\r\ntwo\r\n')
    assert.equal(matchesSaved(path, 'one\r\ntwo\r\n'), true)
    assert.equal(matchesSaved(path, 'one\ntwo\n'), true, 'line endings are not content')
    assert.equal(matchesSaved(path, 'one\r\ntwo\r\nthree\r\n'), false)
    assert.equal(matchesSaved(path, ''), false)
  })

  it('follows what a save wrote and what a reload brought in, not what has been typed', () => {
    const view = host(openDoc(path, 'one'))
    attach(path, view)
    view.dispatch(view.state.update({ changes: { from: 3, insert: '!' }, origin: 'input.type' }))
    assert.equal(matchesSaved(path, 'one'), true, 'typing does not change what the file is expected to hold')
    assert.equal(matchesSaved(path, 'one!'), false)
    markSaved(path, snapshotForSave(path)!)
    assert.equal(matchesSaved(path, 'one!'), true)
    assert.equal(matchesSaved(path, 'one'), false)
    applyExternal(path, 'one!\ntwo')
    assert.equal(matchesSaved(path, 'one!\ntwo'), true)
    attach(path, null)
  })

  it('has nothing to say about a document that is not open', () => {
    assert.equal(matchesSaved('/work/other.ts', 'x'), true)
  })
})

describe('renames', () => {
  const root = '/work/rename'
  afterEach(() => closeDocsUnder(root))

  it('move the open documents under a folder with it, and leave a path that only starts alike', () => {
    openDoc(`${root}/src/a.ts`, 'one')
    openDoc(`${root}/src/deep/b.ts`, 'two')
    openDoc(`${root}/srcs/c.ts`, 'three')
    renameDocs(`${root}/src`, `${root}/lib`)
    assert.equal(hasDoc(`${root}/src/a.ts`), false)
    assert.equal(docState(`${root}/lib/a.ts`)!.doc.toString(), 'one')
    assert.equal(docState(`${root}/lib/deep/b.ts`)!.doc.toString(), 'two')
    assert.equal(hasDoc(`${root}/srcs/c.ts`), true)
  })

  it('keep what is unsaved and the undo history, and give the new name\'s language', () => {
    const state = openDoc(`${root}/a.ts`, 'let a = 1')
    const typed = state.update({ changes: { from: 9, insert: '!' }, origin: 'input.type' }).state
    recordState(`${root}/a.ts`, typed)
    renameDocs(`${root}/a.ts`, `${root}/a.py`)
    const renamed = docState(`${root}/a.py`)!
    assert.equal(renamed.config.language.id, 'python')
    assert.equal(renamed.doc.toString(), 'let a = 1!')
    assert.equal(isDirty(`${root}/a.py`), true)
    const undone = undo(renamed)!
    assert.equal(undone.state.doc.toString(), 'let a = 1')
    assert.equal(recordState(`${root}/a.py`, undone.state), false)
  })

  it('go through the view that shows the document', () => {
    const view = host(openDoc(`${root}/a.ts`, 'x'))
    attach(`${root}/a.ts`, view)
    renameDocs(`${root}/a.ts`, `${root}/a.md`)
    assert.equal(view.state.config.language.id, 'markdown')
    assert.equal(docState(`${root}/a.md`)!.config.language.id, 'markdown')
  })
})

describe("a server's edits", () => {
  const edit = (line: number, character: number, endLine: number, endCharacter: number, newText: string) => ({ range: { start: { line, character }, end: { line: endLine, character: endCharacter } }, newText })

  it('become changes in the order of the text, their line breaks the document\'s, and none when two overlap', () => {
    const doc = openDoc(path, 'let a = 1\nlet b = a\n').doc
    const specs = changesFromEdits(doc, [edit(1, 8, 1, 9, 'c'), edit(0, 4, 0, 5, 'c'), edit(1, 9, 1, 9, '\r\n// end')])
    assert.deepEqual(specs, [
      { from: 4, to: 5, insert: 'c' },
      { from: 18, to: 19, insert: 'c' },
      { from: 19, to: 19, insert: '\n// end' },
    ])
    // Past the end of a line is its end; past the last line is the end of the text.
    assert.deepEqual(changesFromEdits(doc, [edit(0, 99, 7, 0, '')]), [{ from: 9, to: doc.length, insert: '' }])
    assert.equal(changesFromEdits(doc, [edit(0, 0, 0, 5, 'x'), edit(0, 3, 0, 6, 'y')]), null)
  })

  it('go in as one step of the undo history, through the view, and come back out while the text is what they left', () => {
    const view = host(openDoc(path, 'let a = 1\nlet b = a\n'))
    attach(path, view)
    const done = applyServerEdits(path, [edit(0, 4, 0, 5, 'total'), edit(1, 8, 1, 9, 'total')])!
    assert.equal(view.state.doc.toString(), 'let total = 1\nlet b = total\n')
    assert.equal(currentDoc(path), view.state.doc)
    assert.equal(isDirty(path), true)
    const undone = undo(view.state)!
    assert.equal(undone.state.doc.toString(), 'let a = 1\nlet b = a\n', 'Ctrl+Z takes back both edits at once')
    view.dispatch(undone)
    assert.equal(revertServerEdits(done), false, 'the text is no longer what the edits left')
    assert.equal(applyServerEdits('/work/none.ts', [edit(0, 0, 0, 0, 'x')]), null)
  })

  it('leave the document saved when the file on disk has them already', () => {
    const view = host(openDoc(path, 'a\n'))
    attach(path, view)
    const done = applyServerEdits(path, [edit(0, 0, 0, 1, 'b')], { saved: true })!
    assert.equal(isDirty(path), false)
    assert.equal(view.reported.at(-1), false)
    assert.equal(revertServerEdits(done, { saved: true }), true)
    assert.equal(view.state.doc.toString(), 'a\n')
    assert.equal(isDirty(path), false)
  })
})
