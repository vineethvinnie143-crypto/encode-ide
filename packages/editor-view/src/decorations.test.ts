import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, type Gen } from '@encode/testkit'
import { ChangeSet, Text } from '@encode/text'
import { DecorationSet, type LineSpec, type MarkSpec } from './decorations'

function query(set: DecorationSet, doc: Text, from: number, to: number): MarkSpec[] {
  const out: MarkSpec[] = []
  set.marks(doc, from, to, out)
  return out
}

function overlaps(mark: MarkSpec, from: number, to: number): boolean {
  return mark.from < to && (mark.to > from || (mark.from === mark.to && mark.from >= from))
}

const scenario: Gen<{ doc: string; marks: MarkSpec[]; from: number; to: number }> = (random, size) => {
  const length = Math.floor(random() * (size * 40 + 1))
  const doc = 'x'.repeat(length)
  const marks: MarkSpec[] = []
  const count = Math.floor(random() * (size * 3 + 1))
  for (let index = 0; index < count; index++) {
    const from = Math.floor(random() * (length + 1))
    const to = Math.min(length, from + (random() < 0.15 ? 0 : Math.floor(random() * 30)))
    marks.push({ from, to, className: `m${index}` })
  }
  const a = Math.floor(random() * (length + 1))
  const b = Math.floor(random() * (length + 1))
  return { doc, marks, from: Math.min(a, b), to: Math.max(a, b) }
}

describe('DecorationSet', () => {
  it('finds the marks that overlap a window', async () => {
    await check(scenario, ({ doc, marks, from, to }) => {
      const set = DecorationSet.of(Text.of(doc), { marks })
      const found = query(set, Text.of(doc), from, to)
        .map((mark) => mark.className)
        .sort()
      const expected = marks
        .filter((mark) => overlaps(mark, from, to))
        .map((mark) => mark.className)
        .sort()
      assert.deepEqual(found, expected)
    })
  })

  it('keeps marks that start together in the order they were given', () => {
    const doc = Text.of('abcdefghij')
    const set = DecorationSet.of(doc, {
      marks: [
        { from: 2, to: 5, className: 'first' },
        { from: 2, to: 4, className: 'second' },
        { from: 1, to: 3, className: 'before' },
      ],
    })
    assert.deepEqual(
      query(set, doc, 0, 10).map((mark) => mark.className),
      ['before', 'first', 'second'],
    )
  })

  it('reports lines and gutter marks within a range of lines', () => {
    const doc = Text.of('one\ntwo\nthree\nfour\nfive')
    const set = DecorationSet.of(doc, {
      lines: [
        { line: 2, className: 'added' },
        { line: 4, className: 'added' },
      ],
      gutter: [{ line: 3, className: 'bar' }],
    })
    const lines: LineSpec[] = []
    set.lines(doc, 1, 3, lines)
    assert.deepEqual(lines, [{ line: 2, className: 'added' }])
    lines.length = 0
    set.lines(doc, 3, 5, lines)
    assert.deepEqual(lines, [{ line: 4, className: 'added' }])
    lines.length = 0
    set.gutter(doc, 1, 5, lines)
    assert.deepEqual(lines, [{ line: 3, className: 'bar' }])
  })

  it('ignores lines that are not in the document', () => {
    const doc = Text.of('a\nb')
    const set = DecorationSet.of(doc, { lines: [{ line: 0, className: 'x' }, { line: 9, className: 'y' }] })
    assert.equal(set.size, 0)
  })

  it('follows document changes', () => {
    const before = Text.of('one\ntwo\nthree')
    const set = DecorationSet.of(before, {
      marks: [
        { from: 4, to: 7, className: 'two' },
        { from: 8, to: 13, className: 'three' },
      ],
      lines: [{ line: 3, className: 'line' }],
    })
    // Insert a line above everything.
    const changes = ChangeSet.of({ from: 0, insert: 'zero\n' }, before.length)
    const after = changes.apply(before)
    const mapped = set.map(changes, after)!
    assert.deepEqual(
      query(mapped, after, 0, after.length).map((mark) => [mark.from, mark.to, mark.className]),
      [
        [9, 12, 'two'],
        [13, 18, 'three'],
      ],
    )
    const lines: LineSpec[] = []
    mapped.lines(after, 1, after.lineCount, lines)
    assert.deepEqual(lines, [{ line: 4, className: 'line' }])
  })

  it('drops marks whose text was deleted and keeps those it was typed next to', () => {
    const before = Text.of('hello world')
    const set = DecorationSet.of(before, { marks: [{ from: 6, to: 11, className: 'world' }, { from: 0, to: 5, className: 'hello' }] })
    const deleted = ChangeSet.of({ from: 5, to: 11 }, before.length)
    const afterDelete = deleted.apply(before)
    assert.deepEqual(
      query(set.map(deleted, afterDelete)!, afterDelete, 0, afterDelete.length).map((mark) => mark.className),
      ['hello'],
    )
    // Text typed at the edge of a mark is not taken in.
    const typed = ChangeSet.of({ from: 5, insert: '!!' }, before.length)
    const afterTyped = typed.apply(before)
    const kept = query(set.map(typed, afterTyped)!, afterTyped, 0, afterTyped.length)
    assert.deepEqual(
      kept.map((mark) => [mark.from, mark.to, mark.className]),
      [
        [0, 5, 'hello'],
        [8, 13, 'world'],
      ],
    )
  })
})
