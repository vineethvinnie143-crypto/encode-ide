import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Text } from '@encode/text'
import type { CodeDiagnostic } from '@shared/types'
import { clearMarks, decorationsOf, marksAt, marksOf, marksOnLine, onMarksChanged, positionOf, rangeOf, setMarks, sourceOf, useProblems } from './marks'

const mark = (line: number, character: number, endLine: number, endCharacter: number, severity: CodeDiagnostic['severity'] = 'error', message = 'bad'): CodeDiagnostic => ({ line, character, endLine, endCharacter, severity, message })

afterEach(() => clearMarks())

const doc = Text.of('const a = 1\nlet b\n\nend')

describe('the editor\'s marks', () => {
  it('turn lines and columns into places in the text, holding to the line and the end', () => {
    assert.equal(positionOf(doc, 0, 6), 6)
    assert.equal(positionOf(doc, 1, 99), doc.line(2).to)
    assert.equal(positionOf(doc, 9, 0), doc.length)
    assert.deepEqual(rangeOf(doc, mark(0, 6, 0, 6)), { from: 6, to: 7 }, 'an empty range covers the character after it')
    assert.deepEqual(rangeOf(doc, mark(1, 5, 1, 5)), { from: doc.line(2).from + 4, to: doc.line(2).to }, 'or the one before at the end of a line')
    assert.deepEqual(rangeOf(doc, mark(2, 0, 2, 0)), { from: doc.line(3).from, to: doc.line(3).from }, 'an empty line has nothing to cover')
  })

  it('draw a wavy line under each problem but a hint, and mark the line number with the worst', () => {
    const items = [mark(0, 6, 0, 7, 'warning'), mark(0, 10, 0, 11), mark(1, 4, 1, 5, 'warning'), mark(3, 0, 3, 3, 'hint')]
    const set = decorationsOf(doc, items)
    const spans: { from: number; to: number; className: string }[] = []
    set.marks(doc, 0, doc.length, spans)
    assert.deepEqual(spans.map((span) => span.className), ['enc-squiggle-warning', 'enc-squiggle-error', 'enc-squiggle-warning'])
    const gutter: { line: number; className: string }[] = []
    set.gutter(doc, 1, doc.lineCount, gutter)
    assert.deepEqual(gutter, [{ line: 1, className: 'enc-gutter-error' }, { line: 2, className: 'enc-gutter-warning' }])
  })

  it('find the problems under a place and on a line, worst first', () => {
    const items = [mark(0, 0, 0, 11, 'warning', 'whole line'), mark(0, 6, 0, 7, 'error', 'the name')]
    assert.deepEqual(marksAt(doc, items, 6).map((item) => item.message), ['the name', 'whole line'])
    assert.deepEqual(marksAt(doc, items, 9).map((item) => item.message), ['whole line'])
    assert.deepEqual(marksOnLine(doc, items, 1).map((item) => item.message), ['the name', 'whole line'])
    assert.deepEqual(marksOnLine(doc, items, 2), [])
    assert.equal(sourceOf({ ...items[0], source: 'ts', code: '2304' }), 'ts(2304)')
    assert.equal(sourceOf({ ...items[0], source: 'pyright' }), 'pyright')
  })

  it('keep what the servers said per file, count it for the footer, and go with the folder', () => {
    const heard: string[] = []
    const stop = onMarksChanged((path) => heard.push(path))
    setMarks({ path: 'src/a.ts', diagnostics: [mark(0, 0, 0, 1), mark(1, 0, 1, 1, 'warning'), mark(2, 0, 2, 1, 'info')] })
    assert.equal(marksOf('src/a.ts').length, 3)
    assert.deepEqual(useProblems.getState().counts['src/a.ts'], { errors: 1, warnings: 1, others: 1 })
    setMarks({ path: 'src/b.ts', diagnostics: [] })
    assert.deepEqual(heard, ['src/a.ts'], 'nothing for a file that had nothing and still has nothing')
    setMarks({ path: 'src/a.ts', diagnostics: [] })
    assert.equal(useProblems.getState().counts['src/a.ts'], undefined)
    setMarks({ path: 'src/c.ts', diagnostics: [mark(0, 0, 0, 1)] })
    clearMarks()
    assert.deepEqual(marksOf('src/c.ts'), [])
    assert.deepEqual(useProblems.getState().counts, {})
    assert.deepEqual(heard, ['src/a.ts', 'src/a.ts', 'src/c.ts', 'src/c.ts'])
    stop()
  })
})
