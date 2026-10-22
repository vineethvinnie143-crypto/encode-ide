import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { Text } from '@encode/text'
import { EditorSelection, EditorState, SelectionRange, detectIndent, reload, reloadChanges, undo } from './index'

const lines = (...text: string[]) => text.join('\n')

describe('reload', () => {
  it('turns the document into the new text and nothing else', () => {
    const state = EditorState.create({ doc: lines('a', 'b', 'c', 'd') })
    const tr = reload(state, lines('a', 'B', 'c', 'd', 'e'))!
    assert.equal(tr.state.doc.toString(), lines('a', 'B', 'c', 'd', 'e'))
    assert.equal(tr.origin, 'external')
    assert.equal(tr.scrollIntoView, false)
  })

  it('is null when nothing differs', () => {
    const state = EditorState.create({ doc: 'same\ntext' })
    assert.equal(reload(state, 'same\ntext'), null)
  })

  it('keeps the cursor where it was, moving it only for changes before it', () => {
    const state = EditorState.create({ doc: lines('one', 'two', 'three'), selection: EditorSelection.cursor(lines('one', 'two', 'th').length) })
    const above = reload(state, lines('zero', 'one', 'two', 'three'))!
    assert.equal(above.state.selection.main.head, lines('zero', 'one', 'two', 'th').length)
    const below = reload(state, lines('one', 'two', 'three', 'four'))!
    assert.equal(below.state.selection.main.head, lines('one', 'two', 'th').length)
  })

  it('is one undo step that brings the old text back', () => {
    const state = EditorState.create({ doc: lines('a', 'b', 'c') })
    const tr = reload(state, lines('a', 'x', 'c', 'd'))!
    const back = undo(tr.state)!
    assert.equal(back.state.doc.toString(), lines('a', 'b', 'c'))
  })

  it('handles deleting everything, emptying and growing from nothing', () => {
    const state = EditorState.create({ doc: lines('a', 'b') })
    assert.equal(reload(state, '')!.state.doc.toString(), '')
    const empty = EditorState.create({ doc: '' })
    assert.equal(reload(empty, lines('x', 'y'))!.state.doc.toString(), lines('x', 'y'))
  })

  it('reaches any text from any text', async () => {
    const text = gen.map(gen.array(gen.string('ab \n', 0, 6), 0, 12), (parts) => parts.join('\n'))
    await check(gen.tuple(text, text), ([before, after]) => {
      const doc = Text.of(before)
      const changes = reloadChanges(doc, after)
      assert.equal(changes.apply(doc).toString(), after)
      const state = EditorState.create({ doc: before, selection: EditorSelection.create([new SelectionRange(0, Math.min(2, before.length))]) })
      const tr = reload(state, after)
      assert.equal((tr ? tr.state : state).doc.toString(), after)
    })
  })
})

describe('detectIndent', () => {
  it('finds the step between indentation levels', () => {
    assert.equal(detectIndent(lines('function f() {', '  if (x) {', '    y()', '  }', '}')).indentUnit, '  ')
    assert.equal(detectIndent(lines('class A {', '    m() {', '        return 1', '    }', '}')).indentUnit, '    ')
  })

  it('finds tabs', () => {
    assert.equal(detectIndent(lines('a {', '\tb {', '\t\tc', '\t}', '}')).indentUnit, '\t')
  })

  it('falls back when there is nothing to go by, and ignores alignment spaces', () => {
    assert.deepEqual(detectIndent('one line'), { indentUnit: '  ', tabSize: 4 })
    assert.deepEqual(detectIndent('a', { indentUnit: '    ', tabSize: 8 }), { indentUnit: '    ', tabSize: 8 })
    assert.equal(detectIndent(lines('x', ' aligned', 'y', ' aligned')).indentUnit, '  ')
  })

  it('reads a Text as well as a string', () => {
    assert.equal(detectIndent(Text.of(lines('a:', '    b: 1', '    c:', '        d: 2'))).indentUnit, '    ')
  })
})
