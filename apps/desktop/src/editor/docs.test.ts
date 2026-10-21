import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { EditorSelection, undo, type EditorState, type Transaction } from '@encode/editor'
import {
  applyExternal,
  attach,
  closeDoc,
  docState,
  eolOf,
  isDirty,
  markSaved,
  openDoc,
  recordState,
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
