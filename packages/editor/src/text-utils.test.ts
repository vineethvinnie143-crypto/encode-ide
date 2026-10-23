import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { ChangeSet, Text, codePointWidth } from '@encode/text'
import { carryColumnIndexes, columnAt, forgetColumnIndexes, indexAtColumn, nextCluster } from './text-utils'

/** Columns counted one character at a time, as the editor always did. */
function slowColumnAt(text: string, index: number, tabSize: number): number {
  let column = 0
  for (let pos = 0; pos < index && pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 9) column += tabSize - (column % tabSize)
    else if (code < 0x7f) column++
    else {
      const point = text.codePointAt(pos)!
      if (point > 0xffff) pos++
      column += codePointWidth(point)
    }
  }
  return column
}

/** The offset nearest a column, one cluster at a time. */
function slowIndexAtColumn(text: string, column: number, tabSize: number): number {
  let current = 0
  let pos = 0
  while (pos < text.length) {
    const next = nextCluster(text, pos)
    const width = text.charCodeAt(pos) === 9 ? tabSize - (current % tabSize) : slowColumnAt(text.slice(pos, next), next - pos, tabSize)
    if (current + width > column) return column - current <= current + width - column ? pos : next
    current += width
    pos = next
  }
  return text.length
}

const char = (...points: number[]) => String.fromCodePoint(...points)
const pieces = gen.oneOf('a', 'xyz ', '{"k":1},', 'a'.repeat(70), ' '.repeat(90), '\t', char(0xe9), `e${char(0x301)}`, char(0x4e2d, 0x6587), char(0x1f600), char(0x200d), '\r', char(0x7f), 'b'.repeat(200))
const line = gen.map(gen.array(pieces, 0, 30), (parts) => parts.join(''))

describe('visual columns', () => {
  it('are the same counted in runs as one character at a time, in short lines and long ones', async () => {
    await check(gen.tuple(line, gen.int(0, 3000), gen.oneOf(2, 4, 8)), ([text, at, tabSize]) => {
      const index = at % (text.length + 2)
      assert.equal(columnAt(text, index, tabSize), slowColumnAt(text, index, tabSize), `column of ${index}`)
      const column = at % (slowColumnAt(text, text.length, tabSize) + 3)
      assert.equal(indexAtColumn(text, column, tabSize), slowIndexAtColumn(text, column, tabSize), `index at ${column}`)
    })
  })

  it('are the same counted from the points of a long line\'s index as from its start', async () => {
    // Pieces in the hundreds make lines past the length from which an index is kept, with tabs and wide characters in them.
    const longPieces = gen.oneOf(
      'xyz ',
      '\t',
      'a'.repeat(500),
      '{"k":[1,2]},'.repeat(200),
      '\t'.repeat(30),
      // Stretches where an index point placed anywhere would split a letter from its accent, or a surrogate pair.
      `xe${char(0x301)}`.repeat(400),
      `x${char(0x1f600)}`.repeat(400),
      `x${char(0x4e2d)}\t`.repeat(300),
    )
    const long = gen.map(gen.array(longPieces, 20, 120), (parts) => parts.join(''))
    let past = 0
    await check(gen.tuple(long, gen.array(gen.int(0, 1_000_000), 1, 6), gen.oneOf(2, 4, 8)), ([text, picks, tabSize]) => {
      const width = slowColumnAt(text, text.length, tabSize)
      if (text.length > 20_000) past++
      for (const pick of picks) {
        const index = pick % (text.length + 2)
        assert.equal(columnAt(text, index, tabSize), slowColumnAt(text, index, tabSize), `column of ${index} of ${text.length}`)
        const column = pick % (width + 3)
        assert.equal(indexAtColumn(text, column, tabSize), slowIndexAtColumn(text, column, tabSize), `index at ${column} of ${width}`)
      }
    })
    assert.ok(past > 10, `${past} lines long enough for an index`)
  })

  it('are right after edits carried into a long line\'s index, through tabs, accents and wide characters', async () => {
    const longPieces = gen.oneOf('xyz ', '\t', 'a'.repeat(700), '{"k":[1,2]},'.repeat(150), `xe${char(0x301)}`.repeat(300), `x${char(0x1f600)}`.repeat(300), `x${char(0x4e2d)}\t`.repeat(200))
    const insertPieces = gen.oneOf('a', '\t', 'ab\tc', char(0x301), char(0x1f600), char(0x4e2d), 'x'.repeat(3000), '')
    const edit = gen.tuple(gen.int(0, 1_000_000), gen.int(0, 4000), gen.array(insertPieces, 0, 3))
    await check(gen.tuple(gen.array(longPieces, 30, 80), gen.array(edit, 1, 6), gen.oneOf(2, 4, 8), gen.array(gen.int(0, 1_000_000), 1, 4)), ([parts, edits, tabSize, picks]) => {
      let doc = Text.of(['first line', parts.join(''), 'last line'])
      columnAt(doc.line(2).text, doc.line(2).text.length, tabSize)
      for (const [at, length, insert] of edits) {
        const line = doc.line(2)
        const from = line.from + (at % (line.text.length + 1))
        const changes = ChangeSet.of({ from, to: Math.min(line.to, from + length), insert: insert.join('') }, doc.length)
        const next = changes.apply(doc)
        carryColumnIndexes(changes, doc, next)
        doc = next
        const text = doc.line(2).text
        const width = slowColumnAt(text, text.length, tabSize)
        assert.equal(columnAt(text, text.length, tabSize), width, 'the width of the line')
        for (const pick of picks) {
          const index = pick % (text.length + 1)
          assert.equal(columnAt(text, index, tabSize), slowColumnAt(text, index, tabSize), `column of ${index} of ${text.length}`)
          const column = pick % (width + 2)
          assert.equal(indexAtColumn(text, column, tabSize), slowIndexAtColumn(text, column, tabSize), `index at ${column} of ${width}`)
        }
      }
    })
  })

  it('keep the index of one line apart from another and from another tab size', () => {
    const tabs = '\tx'.repeat(10_000)
    const plain = 'x'.repeat(40_000)
    const cases: [string, number][] = [[tabs, 4], [plain, 4], [tabs, 8], [tabs, 4], [plain, 2]]
    for (const [at, [text, tabSize]] of [...cases, ...cases].entries()) {
      assert.equal(columnAt(text, text.length, tabSize), slowColumnAt(text, text.length, tabSize))
      assert.equal(columnAt(text, 30_001, tabSize), slowColumnAt(text, 30_001, tabSize))
      assert.equal(indexAtColumn(text, 20_003, tabSize), slowIndexAtColumn(text, 20_003, tabSize))
      if (at === cases.length - 1) forgetColumnIndexes()
    }
  })

  it('cost little in a line of millions of characters', () => {
    const text = '{"key":"value","n":12345},'.repeat(400_000)
    const started = performance.now()
    for (let round = 0; round < 20; round++) {
      assert.equal(columnAt(text, text.length - round, 4), text.length - round)
      assert.equal(indexAtColumn(text, text.length - round, 4), text.length - round)
    }
    assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`)
  })
})
