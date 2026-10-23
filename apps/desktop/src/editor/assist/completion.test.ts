import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EditorSelection, EditorState, SelectionRange, languageForPath } from '@encode/editor'
import type { CompletionEntry } from '@shared/types'
import { Since, firstSelected, indentText, isWordText, planCompletion, rankEntries, wordEnd, wordStart } from './completion'

const entry = (label: string, more: Partial<CompletionEntry> = {}): CompletionEntry => ({
  id: 0,
  label,
  sortText: label,
  filterText: label,
  insertText: label,
  snippet: false,
  resolved: true,
  ...more,
})

const ts = (doc: string, cursor: number | number[]) =>
  EditorState.create({
    doc,
    language: languageForPath('a.ts'),
    selection: EditorSelection.create((Array.isArray(cursor) ? cursor : [cursor]).map((pos) => new SelectionRange(pos, pos))),
  })

describe('the suggestion list', () => {
  it('keeps the items that match what was typed, best first, then in the server\'s order', () => {
    const items = [entry('createElement', { sortText: '2' }), entry('console', { sortText: '3' }), entry('const', { sortText: '1' }), entry('Math', { sortText: '0' })]
    assert.deepEqual(
      rankEntries(items, () => 'con').map((item) => item.entry.label),
      ['const', 'console'],
    )
    assert.deepEqual(
      rankEntries(items, () => '').map((item) => item.entry.label),
      ['Math', 'const', 'createElement', 'console'],
      'with nothing typed, the server\'s order',
    )
    assert.deepEqual(rankEntries(items, () => 'cE')[0].matches, [0, 6])
  })

  it('matches on the filter text and marks the letters of the label', () => {
    const [found] = rankEntries([entry('#private', { filterText: 'private' })], () => 'pri')
    assert.equal(found.entry.label, '#private')
    assert.deepEqual(found.matches, [1, 2, 3])
  })

  it('selects what the server asked for only while nothing is typed', () => {
    const ranked = rankEntries([entry('a'), entry('b', { preselect: true })], () => '')
    assert.equal(firstSelected(ranked, true), 1)
    assert.equal(firstSelected(ranked, false), 0)
  })
})

describe('accepting a suggestion', () => {
  it('puts its text in place of what was typed of the word, or of the whole word', () => {
    const state = ts('let x = consXole', 12)
    const since = new Since(state.doc)
    const item = entry('console')
    const start = wordStart(state, 12)
    assert.equal(start, 8)
    assert.equal(wordEnd(state, 12), 16)
    assert.deepEqual(planCompletion(state, item, since, start).ranges, [{ from: 8, to: 12 }])
    assert.deepEqual(planCompletion(state, item, since, start, 'replace').ranges, [{ from: 8, to: 16 }])
  })

  it('takes the server\'s range, followed through what was typed since it answered', () => {
    const asked = ts('obj.le', 6)
    const since = new Since(asked.doc)
    const typed = asked.update({ changes: { from: 6, insert: 'n' }, selection: EditorSelection.cursor(7) })
    since.add(typed.changes)
    const item = entry('length', { insert: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } }, replace: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } } })
    const plan = planCompletion(typed.state, item, since, 4)
    assert.deepEqual(plan.ranges, [{ from: 4, to: 7 }])
  })

  it('refuses a change that does not follow from the text as the changes before it left it', () => {
    const asked = ts('obj.le', 6)
    const since = new Since(asked.doc)
    const taken = asked.update({ changes: { from: 4, to: 6, insert: 'length' }, selection: EditorSelection.cursor(10) })
    const typed = taken.state.update({ changes: { from: 10, insert: ';' }, selection: EditorSelection.cursor(11) })
    // The item's own text, missed: what was typed after it cannot be followed from the asked-of text.
    assert.throws(() => since.add(typed.changes), /one was missed/)
    since.add(taken.changes)
    assert.throws(() => since.add(taken.changes), /one was missed/)
    since.add(typed.changes)
    assert.equal(since.map(6, 1), 11)
  })

  it('goes in at every cursor that has the same text before it', () => {
    const state = ts('a.pu\nb.pu\nc.po', [4, 9, 14])
    const plan = planCompletion(state, entry('push'), new Since(state.doc), 2)
    assert.deepEqual(plan.ranges, [
      { from: 2, to: 4 },
      { from: 7, to: 9 },
    ])
  })

  it('brings its edits elsewhere, such as an import, unless they overlap where it goes', () => {
    const state = ts('\nhel', 4)
    const since = new Since(state.doc)
    const item = entry('helper', {
      additionalEdits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import { helper } from './helpers'\r\n" },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'nope' },
      ],
    })
    const plan = planCompletion(state, item, since, 1)
    assert.deepEqual(plan.changes, [{ from: 0, to: 0, insert: "import { helper } from './helpers'\n" }])
  })

  it('indents the lines of a text of several lines like the line it goes on', () => {
    assert.equal(indentText('a {\n  b\n}', '    '), 'a {\n      b\n    }')
    assert.equal(indentText('one line', '  '), 'one line')
  })

  it('counts letters, digits, _ and $ as a word in code', () => {
    const state = ts('', 0)
    assert.equal(isWordText(state, 'a1_$'), true)
    assert.equal(isWordText(state, '.'), false)
    assert.equal(isWordText(state, ''), false)
  })
})
