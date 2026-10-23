import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { ChangeSet, Text } from '@encode/text'
import {
  Highlighter,
  allFoldRanges,
  enclosingIndentRanges,
  foldDepths,
  foldRangeAt,
  languageById,
  mapFoldRanges,
  mapFolded,
  normalizeFoldRanges,
  rangeStartingAt,
  rangesContaining,
} from './index'

const doc = (lines: string[]) => Text.of(lines.join('\n'))

const TS = doc([
  'import a from "a"', // 1
  'function f() {', // 2
  '  if (x) {', // 3
  '    a()', // 4
  '', // 5
  '    b()', // 6
  '  }', // 7
  '', // 8
  '}', // 9
  '// #region helpers', // 10
  'const c = 1', // 11
  '// #endregion', // 12
  'class K {', // 13
  '  m() {}', // 14
  '}', // 15
])

describe('fold ranges from the text', () => {
  it('folds a block by its indentation, leaving the closing bracket and trailing blank lines out', () => {
    assert.deepEqual(foldRangeAt(TS, 2, 4), { start: 2, end: 7 })
    assert.deepEqual(foldRangeAt(TS, 3, 4), { start: 3, end: 6 })
    assert.equal(foldRangeAt(TS, 4, 4), null, 'a line with nothing more indented after it')
    assert.equal(foldRangeAt(TS, 5, 4), null, 'a blank line')
    assert.equal(foldRangeAt(TS, 15, 4), null, 'the last line')
  })

  it('folds a region marker to its end marker, nested regions included', () => {
    assert.deepEqual(foldRangeAt(TS, 10, 4), { start: 10, end: 12, kind: 'region' })
    const nested = doc(['# region outer', 'a = 1', '#region inner', 'b = 2', '#endregion', '# endregion', 'region = 5'])
    assert.deepEqual(foldRangeAt(nested, 1, 4), { start: 1, end: 6, kind: 'region' })
    assert.deepEqual(foldRangeAt(nested, 3, 4), { start: 3, end: 5, kind: 'region' })
    assert.equal(foldRangeAt(doc(['region = 5', 'x']), 1, 4), null, 'a variable named region is no marker')
    assert.deepEqual(foldRangeAt(doc(['<!-- #region -->', '<p>', '<!-- #endregion -->']), 1, 4), { start: 1, end: 3, kind: 'region' })
  })

  it('reads the whole document in one pass, a region once, sorted by start', () => {
    assert.deepEqual(allFoldRanges(TS, 4), [
      { start: 2, end: 7 },
      { start: 3, end: 6 },
      { start: 10, end: 12, kind: 'region' },
      { start: 13, end: 14 },
    ])
    const python = doc(['def f():', '    if x:', '        a', '    b', '', 'c'])
    assert.deepEqual(allFoldRanges(python, 4), [
      { start: 1, end: 4 },
      { start: 2, end: 3 },
    ])
    assert.equal(allFoldRanges(TS, 4, 2).length, 2, 'stops at the limit')
  })

  it('agrees with the one-line reading for every line', () => {
    const all = allFoldRanges(TS, 4)
    for (let line = 1; line <= TS.lineCount; line++) {
      assert.deepEqual(foldRangeAt(TS, line, 4), rangeStartingAt(all, line), `line ${line}`)
    }
  })

  it('finds the blocks a line is in, outermost first, for sticky scroll', () => {
    assert.deepEqual(enclosingIndentRanges(TS, 6, 4), [
      { start: 2, end: 7 },
      { start: 3, end: 6 },
    ])
    assert.deepEqual(enclosingIndentRanges(TS, 5, 4), [
      { start: 2, end: 7 },
      { start: 3, end: 6 },
    ], 'a blank line belongs to the block of the next line with text')
    assert.deepEqual(enclosingIndentRanges(TS, 2, 4), [])
    assert.deepEqual(enclosingIndentRanges(TS, 6, 4, 1), [{ start: 3, end: 6 }], 'keeps the innermost when capped')
  })
})

describe('fold ranges from a language server', () => {
  it('turns 0-based lines into ranges, drops empty and outside ones, keeps the widest per start', () => {
    const ranges = normalizeFoldRanges(TS, [
      { startLine: 2, endLine: 5 },
      { startLine: 1, endLine: 8, endCharacter: 1 },
      { startLine: 1, endLine: 6 },
      { startLine: 0, endLine: 0, kind: 'imports' },
      { startLine: 40, endLine: 50 },
      { startLine: 9, endLine: 11, kind: 'region' },
      { startLine: 12, endLine: 14, kind: 'nonsense' },
    ])
    assert.deepEqual(ranges, [
      // Ended just past the "}" of line 9: that line stays in sight.
      { start: 2, end: 8 },
      { start: 3, end: 6 },
      { start: 10, end: 12, kind: 'region' },
      { start: 13, end: 15 },
    ])
  })

  it('looks ranges up by line and depth', () => {
    const ranges = allFoldRanges(TS, 4)
    assert.deepEqual(rangesContaining(ranges, 4), [
      { start: 2, end: 7 },
      { start: 3, end: 6 },
    ])
    assert.deepEqual(rangesContaining(ranges, 2), [{ start: 2, end: 7 }], 'a range counts on its own first line')
    assert.deepEqual(rangesContaining(ranges, 9), [])
    assert.deepEqual(foldDepths(ranges), [1, 2, 1, 1])
  })
})

describe('folds through edits', () => {
  const text = doc(['a {', '  b', '  c', '}', 'd {', '  e', '}'])
  const folded = [
    { start: 1, end: 3 },
    { start: 5, end: 6 },
  ]
  const edit = (from: number, to: number, insert: string) => ChangeSet.of([{ from, to, insert }], text.length)
  const apply = (changes: ChangeSet) => changes.apply(text)

  it('move with lines added above them and stay folded when typed at the end of their first line', () => {
    const above = edit(0, 0, 'top\n')
    assert.deepEqual(mapFolded(folded, above, text, apply(above)), [
      { start: 2, end: 4 },
      { start: 6, end: 7 },
    ])
    const atEnd = edit(3, 3, ' // note')
    assert.deepEqual(mapFolded(folded, atEnd, text, apply(atEnd)), folded)
  })

  it('open when an edit reaches into their hidden lines, or empties them', () => {
    const inside = edit(text.line(2).from + 2, text.line(2).from + 2, 'x')
    assert.deepEqual(mapFolded(folded, inside, text, apply(inside)), [{ start: 5, end: 6 }])
    const across = edit(text.line(1).from + 1, text.line(3).to, '')
    assert.deepEqual(mapFolded(folded, across, text, apply(across)), [{ start: 3, end: 4 }])
    const none = edit(0, 0, '')
    assert.deepEqual(mapFolded([{ start: 6, end: 9 }], none, text, apply(none)), [], 'a fold past the document is dropped')
  })

  it('keep a server\'s ranges in step until new ones come, dropping emptied ones', () => {
    const ranges = [
      { start: 1, end: 3, kind: 'comment' as const },
      { start: 5, end: 6 },
    ]
    const lines = edit(text.line(2).from, text.line(3).to + 1, '')
    // The comment's lines went: what is left of it ends on the line after it, until the server says again.
    assert.deepEqual(mapFoldRanges(ranges, lines, text, apply(lines)), [
      { start: 1, end: 2, kind: 'comment' },
      { start: 3, end: 4 },
    ])
    const emptied = edit(text.line(5).to, text.line(6).to, '')
    assert.deepEqual(mapFoldRanges(ranges, emptied, text, apply(emptied)), [{ start: 1, end: 3, kind: 'comment' }])
    const added = edit(text.line(2).from, text.line(2).from, 'new\n')
    assert.deepEqual(mapFoldRanges(ranges, added, text, apply(added)), [
      { start: 1, end: 4, kind: 'comment' },
      { start: 6, end: 7 },
    ])
  })
})

describe('bracket depth for colouring', () => {
  const ts = languageById('typescript')!
  const highlighter = (text: string) => {
    const result = new Highlighter(ts.tokenizer, Text.of(text))
    result.setBrackets(ts.brackets)
    return result
  }
  const pairs = (flat: readonly number[]) => {
    const out: [number, number][] = []
    for (let index = 0; index < flat.length; index += 2) out.push([flat[index], flat[index + 1]])
    return out
  }

  it('gives each bracket its depth across lines, and skips strings and comments', () => {
    const h = highlighter(['f(a, [b, {c: "(("}]', '  // ) ]', ')', ')'].join('\n'))
    const first = h.brackets(1)
    assert.equal(first.exact, true)
    assert.deepEqual(pairs(first.brackets), [
      [1, 0],
      [5, 1],
      [9, 2],
      [17, 2],
      [18, 1],
    ])
    assert.deepEqual(h.brackets(2).brackets, [], 'brackets in a comment')
    assert.deepEqual(pairs(h.brackets(3).brackets), [[0, 0]])
    assert.deepEqual(pairs(h.brackets(4).brackets), [[0, -1]], 'a closer with nothing open')
  })

  it('follows edits: a bracket added above moves every depth below it', () => {
    let text = Text.of(['a', '{', '  b', '}'].join('\n'))
    const h = new Highlighter(ts.tokenizer, text)
    h.setBrackets(ts.brackets)
    h.work(Infinity)
    assert.deepEqual(pairs(h.brackets(4).brackets), [[0, 0]])
    const changes = ChangeSet.of({ from: 0, to: 1, insert: '(' }, text.length)
    text = changes.apply(text)
    h.update(changes, text)
    assert.deepEqual(pairs(h.brackets(2).brackets), [[0, 1]])
    assert.deepEqual(pairs(h.brackets(4).brackets), [[0, 1]])
  })

  it('is off until asked for', () => {
    const h = new Highlighter(ts.tokenizer, Text.of('f()'))
    assert.deepEqual(h.brackets(1), { brackets: [], exact: true })
    h.setBrackets(ts.brackets)
    assert.deepEqual(pairs(h.brackets(1).brackets), [
      [1, 0],
      [2, 0],
    ])
    h.setBrackets(null)
    assert.deepEqual(h.brackets(1).brackets, [])
  })

  it('follows any run of edits exactly as from scratch', async () => {
    const fragment = gen.oneOf('(', ')', '[', ']', '{', '}', '"', "'", '//', '/*', '*/', '`', '${', 'a', ' ', '\n', 'x(', ');\n')
    const source = gen.map(gen.array(fragment, 0, 40), (parts) => parts.join(''))
    const edit = gen.tuple(gen.int(0, 10_000), gen.int(0, 6), gen.array(fragment, 0, 4))
    await check(gen.tuple(source, gen.array(edit, 1, 8), gen.int(0, 2)), ([text, edits, mode]) => {
      let doc = Text.of(text)
      const h = new Highlighter(ts.tokenizer, doc)
      h.setBrackets(ts.brackets)
      for (let line = 1; line <= doc.lineCount; line++) h.brackets(line)
      for (const [at, length, insert] of edits) {
        const from = at % (doc.length + 1)
        const changes = ChangeSet.of({ from, to: Math.min(doc.length, from + length), insert: insert.join('') }, doc.length)
        doc = changes.apply(doc)
        h.update(changes, doc)
        if (mode > 0) for (let line = 1; line <= doc.lineCount; line += mode) h.brackets(line)
      }
      const fresh = new Highlighter(ts.tokenizer, doc)
      fresh.setBrackets(ts.brackets)
      for (let line = 1; line <= doc.lineCount; line++) {
        const expected = fresh.brackets(line)
        const actual = h.brackets(line)
        assert.equal(actual.exact, true)
        assert.deepEqual([...actual.brackets], [...expected.brackets], `line ${line}`)
      }
    })
  })
})
