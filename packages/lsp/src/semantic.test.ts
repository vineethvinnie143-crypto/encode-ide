import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readInlayHints, MAX_INLAY_HINTS, MAX_INLAY_LABEL } from './inlay'
import { MAX_SEMANTIC_TOKENS, readLegend, readSemanticTokens, SEMANTIC_DEPRECATED, SEMANTIC_KINDS } from './semantic'

const kind = (name: (typeof SEMANTIC_KINDS)[number]) => SEMANTIC_KINDS.indexOf(name)

describe('a server\'s semantic tokens', () => {
  const legend = { tokenTypes: ['class', 'parameter', 'function', 'lifetime', 'mystery', 'enumMember'], tokenModifiers: ['declaration', 'deprecated'] }

  it('are turned from relative places into absolute ones, in the editor\'s kinds', () => {
    // class at 0:6 (5 long), parameter at 0:14, function at 2:2 deprecated, enum member at 2:12.
    const data = [0, 6, 5, 0, 1, 0, 8, 3, 1, 0, 2, 2, 4, 2, 2, 0, 10, 3, 5, 0]
    assert.deepEqual(readSemanticTokens({ data }, legend)!.data, [
      0, 6, 5, kind('type'), 0,
      0, 14, 3, kind('variable'), 0,
      2, 2, 4, kind('function'), SEMANTIC_DEPRECATED,
      2, 12, 3, kind('constant'), 0,
    ])
  })

  it('skip a type the editor has no kind for, yet count the next one from it', () => {
    // A `mystery` token at 1:4, then a function 3 further on the same line.
    const data = [1, 4, 2, 4, 0, 0, 3, 5, 2, 0]
    assert.deepEqual(readSemanticTokens({ data }, legend)!.data, [1, 7, 5, kind('function'), 0])
    // A type past the legend's end, and an empty token, are skipped the same way.
    assert.deepEqual(readSemanticTokens({ data: [0, 1, 2, 99, 0, 0, 2, 0, 0, 0, 0, 3, 1, 0, 0] }, legend)!.data, [0, 6, 1, kind('type'), 0])
  })

  it('stop where the numbers stop making sense', () => {
    assert.deepEqual(readSemanticTokens({ data: [0, 1, 2, 0, 0, 0, -3, 2, 0, 0, 1, 0, 2, 0, 0] }, legend)!.data, [0, 1, 2, kind('type'), 0])
    assert.deepEqual(readSemanticTokens({ data: [0, 1, 2, 0, 0, 1.5, 0, 2, 0, 0] }, legend)!.data, [0, 1, 2, kind('type'), 0])
    assert.deepEqual(readSemanticTokens({ data: [0, 1, 2, 0, 0, 1, 0] }, legend)!.data, [0, 1, 2, kind('type'), 0])
    assert.deepEqual(readSemanticTokens({ data: [0, 1, '2', 0, 0] }, legend)!.data, [])
    assert.equal(readSemanticTokens(null, legend), null)
    assert.equal(readSemanticTokens({ data: 'x' }, legend), null)
  })

  it('are capped', () => {
    const data: number[] = []
    for (let index = 0; index < MAX_SEMANTIC_TOKENS + 10; index++) data.push(1, 0, 1, 0, 0)
    assert.equal(readSemanticTokens({ data }, legend)!.data.length, MAX_SEMANTIC_TOKENS * 5)
  })

  it('have a legend only when the server declared one that can be read', () => {
    assert.deepEqual(readLegend({ legend: { tokenTypes: ['class', 7], tokenModifiers: ['deprecated'] }, full: true }), { tokenTypes: ['class', ''], tokenModifiers: ['deprecated'] })
    assert.deepEqual(readLegend({ legend: { tokenTypes: ['class'] } }), { tokenTypes: ['class'], tokenModifiers: [] })
    assert.equal(readLegend({ legend: { tokenTypes: 'class' } }), null)
    assert.equal(readLegend({ full: true }), null)
    assert.equal(readLegend(true), null)
    // A name like `constructor` or `__proto__` is no kind of the editor's.
    assert.deepEqual(readSemanticTokens({ data: [0, 0, 3, 0, 0, 0, 4, 3, 1, 0] }, { tokenTypes: ['constructor', '__proto__'], tokenModifiers: [] })!.data, [])
  })
})

describe('a server\'s inlay hints', () => {
  it('are read field by field and sorted by place', () => {
    assert.deepEqual(
      readInlayHints([
        { position: { line: 4, character: 9 }, label: ': number', kind: 1, paddingLeft: false },
        { position: { line: 2, character: 12 }, label: [{ value: 'count' }, { value: ':' }, { nope: 1 }], kind: 2, paddingRight: true },
        { position: { line: 2, character: 3 }, label: 'x', kind: 7 },
        { position: { line: -1, character: 0 }, label: 'bad' },
        { position: { line: 1 }, label: 'bad' },
        { position: { line: 1, character: 0 }, label: '   ' },
        { label: 'no place' },
        null,
      ]),
      [
        { line: 2, character: 3, label: 'x' },
        { line: 2, character: 12, label: 'count:', kind: 'parameter', paddingRight: true },
        { line: 4, character: 9, label: ': number', kind: 'type' },
      ],
    )
    assert.equal(readInlayHints(null), null)
    assert.equal(readInlayHints({ position: { line: 0, character: 0 }, label: 'x' }), null)
  })

  it('show no control, bidi or zero-width characters, and are cut when long', () => {
    const rlo = String.fromCodePoint(0x202e)
    const zwsp = String.fromCodePoint(0x200b)
    const [hint] = readInlayHints([{ position: { line: 0, character: 0 }, label: `a\n\tb${rlo}c${zwsp}d` }])!
    assert.equal(hint.label, 'a b c d')
    const [long] = readInlayHints([{ position: { line: 0, character: 0 }, label: 'x'.repeat(500) }])!
    assert.equal(long.label.length, MAX_INLAY_LABEL)
    assert.equal(long.label.at(-1), String.fromCodePoint(0x2026))
  })

  it('are capped', () => {
    const many = Array.from({ length: MAX_INLAY_HINTS + 5 }, (_, index) => ({ position: { line: index, character: 0 }, label: 'x' }))
    assert.equal(readInlayHints(many)!.length, MAX_INLAY_HINTS)
  })
})
