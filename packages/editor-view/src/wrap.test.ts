import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { columnAt, nextCluster } from '@encode/editor'
import { check, gen } from '@encode/testkit'
import { ChangeSet, Text } from '@encode/text'
import { RowMap, WrapLayout, rewrapLine, rowEnd, rowOf, rowStart, wrapLine, type WrapSpec } from './wrap'

const char = (...points: number[]) => String.fromCodePoint(...points)
const pieces = gen.oneOf(
  'word',
  'longerword',
  ' ',
  '  ',
  '\t',
  ',',
  '(',
  ')',
  '.',
  'x'.repeat(30),
  `e${char(0x301)}`,
  char(0x4e2d, 0x6587),
  char(0x1f600),
  '{"key":[1,2]},',
  '-',
  '/',
)
const lineGen = gen.map(gen.array(pieces, 0, 60), (parts) => parts.join(''))
const specGen = gen.map(gen.tuple(gen.int(8, 60), gen.oneOf(2, 4, 8), gen.oneOf(true, false)), ([width, tabSize, indent]): WrapSpec => ({ width, tabSize, indent }))

/** Whether the clusters of `text`, walked from the start, have a boundary at `pos`. */
function onBoundary(text: string, pos: number): boolean {
  let at = 0
  while (at < pos) at = nextCluster(text, at)
  return at === pos
}

/** Breaks counted one cluster at a time over the whole line, as the rules read: what the quicker paths must give. */
function reference(text: string, spec: WrapSpec): { breaks: number[]; indent: number } {
  const width = Math.max(8, Math.floor(spec.width))
  const after = new Set([...' \t})]?|/&.,;:!%>-'])
  const before = new Set([...'([{<+'])
  let lead = 0
  for (const char of text) {
    if (char === ' ') lead++
    else if (char === '\t') lead += spec.tabSize - (lead % spec.tabSize)
    else break
  }
  const indent = spec.indent && lead <= width / 2 ? lead : 0
  const breaks: number[] = []
  let rowStart = 0
  let rowWidth = width
  let column = 0
  let opportunity = -1
  let pos = 0
  while (pos < text.length) {
    const char = text[pos]
    const next = nextCluster(text, pos)
    const cells = char === '\t' ? spec.tabSize - (column % spec.tabSize) : columnAt(text.slice(pos, next), next - pos, spec.tabSize)
    const wide = cells > 1 && char !== '\t'
    if (pos > rowStart && (before.has(char) || wide)) opportunity = pos
    const space = char === ' ' || char === '\t'
    if (pos > rowStart && column + cells > rowWidth && (!space || column + cells > rowWidth * 2)) {
      const at = opportunity > rowStart ? opportunity : pos
      breaks.push(at)
      rowStart = at
      rowWidth = Math.max(8, width - indent)
      column = 0
      opportunity = -1
      pos = at
      continue
    }
    column += cells
    if (after.has(char) || wide) opportunity = next
    pos = next
  }
  return breaks.length ? { breaks, indent } : { breaks: [], indent: 0 }
}

describe('word wrap', () => {
  it('breaks lines as the rules read, plain text a row at a time and any other a character at a time', async () => {
    // Mostly plain text with indentation, so rows of plain text meet rows that are not.
    const plainPieces = gen.oneOf('word', 'longerword', ' ', '  ', ',', '(', ')', '.', '-', 'x'.repeat(30), '{"key":[1,2]},', '/', '+')
    const plainLine = gen.map(gen.tuple(gen.oneOf('', '  ', '\t', '\t\t', ' \t'), gen.array(plainPieces, 0, 80)), ([lead, parts]) => lead + parts.join(''))
    await check(gen.tuple(gen.pick(plainLine, lineGen), specGen), ([text, spec]) => {
      assert.deepEqual(wrapLine(text, spec), reference(text, spec))
    })
  })

  it('breaks a line into rows that fit, at cluster boundaries, with spaces left at the ends of rows', async () => {
    await check(gen.tuple(lineGen, specGen), ([text, spec]) => {
      const { breaks, indent } = wrapLine(text, spec)
      const starts = [0, ...breaks]
      for (let index = 0; index < starts.length; index++) {
        const from = starts[index]
        const to = index + 1 < starts.length ? starts[index + 1] : text.length
        assert.ok(to > from || text.length === 0, `row ${index} is not empty`)
        if (index > 0) assert.ok(onBoundary(text, from), `row ${index} starts on a cluster boundary`)
        const row = text.slice(from, to)
        const width = index === 0 ? spec.width : Math.max(8, spec.width - indent)
        const trimmed = row.replace(/[ \t]+$/, '')
        const single = nextCluster(row, 0) >= trimmed.length
        assert.ok(single || columnAt(trimmed, trimmed.length, spec.tabSize) <= width, `row ${index} ${JSON.stringify(row)} fits ${width} columns`)
      }
      assert.ok(indent <= spec.width / 2)
    })
  })

  it('breaks after spaces and punctuation and before an opening bracket where it can', () => {
    const spec: WrapSpec = { width: 20, tabSize: 4, indent: false }
    const text = 'the quick brown fox jumps over the lazy dog'
    const { breaks } = wrapLine(text, spec)
    const rows = [0, ...breaks].map((from, index, all) => text.slice(from, all[index + 1] ?? text.length))
    assert.deepEqual(rows, ['the quick brown fox ', 'jumps over the lazy ', 'dog'])
    const call = 'someFunction(argument, another)'
    const cut = wrapLine(call, { width: 16, tabSize: 4, indent: false }).breaks
    assert.deepEqual(cut, [12, 23], 'before the bracket, after the comma and space')
    // A word longer than a row is cut between characters.
    assert.deepEqual(wrapLine('x'.repeat(25), spec).breaks, [20])
    // One column over is a row more; a space over is not.
    assert.deepEqual(wrapLine('x'.repeat(21), spec).breaks, [20])
    assert.deepEqual(wrapLine(`${'x'.repeat(20)} `, spec).breaks, [])
    // Around wide characters: after the last one, before the letters.
    const wide = char(0x4e2d)
    assert.deepEqual(wrapLine(`${wide}${wide}abcdefghij`, { width: 8, tabSize: 4, indent: false }).breaks, [2, 10])
    // Spaces past the end of a row stay on it, up to a second row's width of them.
    assert.deepEqual(wrapLine(`abc${' '.repeat(10)}def`, { width: 8, tabSize: 4, indent: false }).breaks, [13])
    assert.deepEqual(wrapLine(`a${' '.repeat(30)}b`, { width: 8, tabSize: 4, indent: false }).breaks, [16, 31])
  })

  it('indents the rows after the first as the line is, unless that takes over half the row', () => {
    const text = `    ${'word '.repeat(10)}`
    assert.equal(wrapLine(text, { width: 20, tabSize: 4, indent: true }).indent, 4)
    assert.equal(wrapLine(text, { width: 20, tabSize: 4, indent: false }).indent, 0)
    assert.equal(wrapLine(`${' '.repeat(12)}${'word '.repeat(10)}`, { width: 20, tabSize: 4, indent: true }).indent, 0)
  })

  it('breaks an edited line again as breaking it from the start would', async () => {
    const insertGen = gen.map(gen.array(pieces, 0, 3), (parts) => parts.join(''))
    const longGen = gen.map(gen.array(pieces, 40, 160), (parts) => parts.join(''))
    await check(gen.tuple(longGen, specGen, gen.int(0, 1_000_000), gen.int(0, 40), insertGen), ([text, spec, at, length, insert]) => {
      const from = at % (text.length + 1)
      const to = Math.min(text.length, from + length)
      // Edits land on cluster boundaries, as the editor makes them.
      if (!onBoundary(text, from) || !onBoundary(text, to)) return
      const after = text.slice(0, from) + insert + text.slice(to)
      const carried = rewrapLine(wrapLine(text, spec), after, from, to, from + insert.length, spec)
      assert.deepEqual(carried, wrapLine(after, spec))
    })
  })
})

describe('RowMap', () => {
  it('counts rows as a plain list would, through sets, inserts and removals across chunks', async () => {
    const op = gen.tuple(gen.int(0, 2), gen.int(0, 1_000_000), gen.int(0, 3000), gen.int(0, 2500), gen.int(1, 9))
    await check(gen.tuple(gen.int(1, 5000), gen.array(op, 1, 12), gen.array(gen.int(0, 1_000_000), 1, 6)), ([size, ops, picks]) => {
      const model = Array.from({ length: size }, (_, index) => 1 + (index % 3))
      const map = new RowMap(model)
      for (const [kind, at, removeCount, insertCount, rows] of ops) {
        const line = 1 + (at % model.length)
        if (kind === 0) {
          map.set(line, rows)
          model[line - 1] = rows
        } else {
          const remove = Math.min(model.length - line + 1, kind === 1 ? removeCount : 0, model.length - 1)
          const inserted = Array.from({ length: kind === 1 ? insertCount % 200 : insertCount }, (_, index) => 1 + ((index + rows) % 4))
          if (model.length - remove + inserted.length < 1) continue
          map.replace(line, line + remove - 1, inserted)
          model.splice(line - 1, remove, ...inserted)
        }
      }
      assert.equal(map.lineCount, model.length)
      const total = model.reduce((a, b) => a + b, 0)
      assert.equal(map.total, total)
      for (const pick of picks) {
        const line = 1 + (pick % model.length)
        assert.equal(map.rows(line), model[line - 1], `rows of ${line}`)
        const before = model.slice(0, line - 1).reduce((a, b) => a + b, 0)
        assert.equal(map.before(line), before, `rows before ${line}`)
        const row = pick % total
        const found = map.lineAtRow(row)
        assert.ok(map.before(found.line) + found.row === row && found.row < model[found.line - 1], `row ${row} is in line ${found.line}`)
      }
      assert.equal(map.before(model.length + 1), total)
    })
  })
})

describe('WrapLayout', () => {
  const docPieces = gen.oneOf('word ', 'a', '', '\t', '(x, y)', 'x'.repeat(50), `${char(0x4e2d)}${char(0x6587)}`, 'longerword, ', '\n', '\n', '\n')
  const docGen = gen.map(gen.array(docPieces, 0, 120), (parts) => parts.join(''))
  const editGen = gen.tuple(gen.int(0, 1_000_000), gen.int(0, 60), gen.array(docPieces, 0, 6))

  /** The rows of every line, broken from scratch. */
  const fresh = (doc: Text, spec: WrapSpec) => doc.lineTexts().map((text) => wrapLine(text, spec).breaks.length + 1)
  const current = (layout: WrapLayout, doc: Text) => Array.from({ length: doc.lineCount }, (_, index) => layout.rows.rows(index + 1))

  it('follows edits, several at once, and settles a large document to the rows it would have from scratch', async () => {
    await check(gen.tuple(docGen, specGen, gen.array(gen.tuple(gen.array(editGen, 1, 3), gen.int(0, 2)), 1, 6), gen.oneOf(10, 200, 1_000_000), gen.int(1, 4)), ([source, spec, rounds, syncChars, stretch]) => {
      let doc = Text.of(source)
      const layout = new WrapLayout(spec, doc, { syncChars, stretch })
      if (syncChars >= doc.length) assert.deepEqual(current(layout, doc), fresh(doc, spec), 'a small document has its rows at once')
      for (const [edits, settles] of rounds) {
        // Settled a stretch or two at a time between edits, as idle time comes.
        for (let round = 0; round < settles; round++) layout.settle(doc, -1, () => {})
        // Changes in one transaction are sorted and apart.
        const specs: { from: number; to: number; insert: string }[] = []
        let floor = 0
        for (const [at, length, insert] of [...edits].sort((a, b) => a[0] - b[0])) {
          const from = Math.max(floor, at % (doc.length + 1))
          if (from > doc.length) break
          const to = Math.min(doc.length, from + length)
          specs.push({ from, to, insert: insert.join('') })
          floor = to + 1
        }
        const changes = ChangeSet.of(specs, doc.length)
        const next = changes.apply(doc)
        layout.update(changes, doc, next)
        doc = next
        assert.equal(layout.rows.lineCount, doc.lineCount)
        if (syncChars >= 1_000_000) assert.deepEqual(current(layout, doc), fresh(doc, spec), 'edits keep the rows')
        // Whatever settling had reached is still right.
        const known = Math.min(doc.lineCount, layout.frontier - 1)
        assert.deepEqual(current(layout, doc).slice(0, known), fresh(doc, spec).slice(0, known), `the lines before ${layout.frontier}`)
      }
      while (layout.settle(doc, -1, () => {}));
      assert.ok(layout.complete)
      assert.deepEqual(current(layout, doc), fresh(doc, spec))
    })
  })

  it('tells when settling is about to change rows, once per stretch, and not when it changes none', () => {
    const spec: WrapSpec = { width: 20, tabSize: 4, indent: false }
    const doc = Text.of(Array.from({ length: 3000 }, (_, index) => (index % 3 ? 'short' : 'aaaaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd')))
    const layout = new WrapLayout(spec, doc, { syncChars: 10 })
    let told = 0
    while (layout.settle(doc, -1, () => told++));
    assert.ok(told >= 1 && told <= 3, `told ${told} times`)
    const plainDoc = Text.of(Array.from({ length: 3000 }, () => 'short'))
    const again = new WrapLayout(spec, plainDoc, { syncChars: 10 })
    told = 0
    while (again.settle(plainDoc, -1, () => told++));
    assert.equal(told, 0)
  })

  it('finds the row of an offset, on either side of a break', () => {
    const wrap = { breaks: [10, 20], indent: 0 }
    assert.equal(rowOf(wrap, 0), 0)
    assert.equal(rowOf(wrap, 9), 0)
    assert.equal(rowOf(wrap, 10), 1)
    assert.equal(rowOf(wrap, 10, -1), 0, 'the end of the first row')
    assert.equal(rowOf(wrap, 25), 2)
    assert.equal(rowOf(wrap, 20, -1), 1)
    assert.deepEqual([rowStart(wrap, 0), rowEnd(wrap, 0, 30), rowStart(wrap, 2), rowEnd(wrap, 2, 30)], [0, 10, 20, 30])
  })
})

