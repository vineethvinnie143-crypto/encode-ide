import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EditorSymbol } from '@shared/types'
import { filterOutline, findSymbols, flattenSymbols, segmentsOf, sortOutline, symbolGlyph, symbolKey, symbolPath } from './symbols'

const range = (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
})
const sym = (name: string, kind: string, lines: [number, number], children?: EditorSymbol[]): EditorSymbol => ({
  name,
  kind,
  range: range(lines[0], 0, lines[1], 1),
  selection: range(lines[0], 6, lines[0], 6 + name.length),
  ...(children ? { children } : {}),
})

// class Shape { area() { … } describe() { … } }  function main() { … }  const LIMIT
const area = sym('area', 'method', [2, 4])
const describeIt = sym('describe', 'method', [5, 7])
const shape = sym('Shape', 'class', [1, 8], [area, describeIt])
const main = sym('main', 'function', [10, 14])
const limit = sym('LIMIT', 'constant', [16, 16])
const tree = [shape, main, limit]

describe('the symbols the cursor is in', () => {
  it('walks from the outermost to the innermost that holds the cursor', () => {
    assert.deepEqual(symbolPath(tree, { line: 3, character: 2 }).map((symbol) => symbol.name), ['Shape', 'area'])
    assert.deepEqual(symbolPath(tree, { line: 8, character: 0 }).map((symbol) => symbol.name), ['Shape'])
    assert.deepEqual(symbolPath(tree, { line: 9, character: 0 }), [], 'between two symbols, in none')
    assert.deepEqual(symbolPath([], { line: 0, character: 0 }), [])
  })

  it('takes the later of two that touch, the one that starts where the cursor is', () => {
    const first = sym('first', 'function', [0, 2])
    const second = { ...sym('second', 'function', [2, 4]), range: range(2, 1, 4, 1) }
    assert.deepEqual(symbolPath([first, second], { line: 2, character: 1 }).map((symbol) => symbol.name), ['second'])
  })
})

describe('the breadcrumbs', () => {
  it('lists the folders, the file, the symbols the cursor is in and what the last one holds', () => {
    const parts = segmentsOf('src/shapes/shape.ts', tree, [shape])
    assert.deepEqual(
      parts.map((part) => part.kind),
      ['folder', 'folder', 'file', 'symbol', 'children'],
    )
    assert.deepEqual(parts[0], { kind: 'folder', label: 'src', path: 'src', parent: '' })
    assert.deepEqual(parts[1], { kind: 'folder', label: 'shapes', path: 'src/shapes', parent: 'src' })
    assert.deepEqual(parts[2], { kind: 'file', label: 'shape.ts', path: 'src/shapes/shape.ts', parent: 'src/shapes' })
    const symbol = parts[3]
    assert.ok(symbol.kind === 'symbol')
    assert.equal(symbol.siblings, tree, 'a top symbol lists the file’s symbols')
    const children = parts[4]
    assert.ok(children.kind === 'children')
    assert.deepEqual(children.children, [area, describeIt])
  })

  it('lists a nested symbol beside its siblings, and the file’s symbols when the cursor is in none', () => {
    const nested = segmentsOf('a.ts', tree, [shape, area])
    const last = nested[nested.length - 1]
    assert.ok(last.kind === 'symbol')
    assert.deepEqual(last.siblings, [area, describeIt])
    const outside = segmentsOf('a.ts', tree, [])
    assert.deepEqual(
      outside.map((part) => part.kind),
      ['file', 'children'],
    )
    assert.deepEqual(segmentsOf('a.ts', null, []).map((part) => part.kind), ['file'], 'no symbols yet: the file alone')
  })
})

describe('Go to symbol', () => {
  it('flattens the tree in the order of the text, with the names each is in', () => {
    assert.deepEqual(
      flattenSymbols(tree).map((item) => [item.container, item.symbol.name, item.depth]),
      [
        ['', 'Shape', 0],
        ['Shape', 'area', 1],
        ['Shape', 'describe', 1],
        ['', 'main', 0],
        ['', 'LIMIT', 0],
      ],
    )
  })

  it('finds by name first, then by the name with what it is in; everything in order for no query', () => {
    assert.deepEqual(findSymbols(tree, '').map((item) => item.symbol.name), ['Shape', 'area', 'describe', 'main', 'LIMIT'])
    assert.deepEqual(findSymbols(tree, 'ar').map((item) => item.symbol.name)[0], 'area')
    assert.deepEqual(findSymbols(tree, 'shape area').map((item) => item.symbol.name), ['area'])
    assert.deepEqual(findSymbols(tree, 'lim').map((item) => item.symbol.name), ['LIMIT'], 'case does not matter')
    assert.deepEqual(findSymbols(tree, 'zzz'), [])
  })
})

describe('the outline', () => {
  it('sorts every level by position, by name or by kind', () => {
    const shuffled = [main, limit, { ...shape, children: [describeIt, area] }]
    const byPosition = sortOutline(shuffled, 'position')
    assert.deepEqual(byPosition.map((symbol) => symbol.name), ['Shape', 'main', 'LIMIT'])
    assert.deepEqual(byPosition[0].children?.map((symbol) => symbol.name), ['area', 'describe'])
    assert.deepEqual(sortOutline(tree, 'name').map((symbol) => symbol.name), ['LIMIT', 'main', 'Shape'])
    assert.deepEqual(sortOutline(tree, 'kind').map((symbol) => symbol.name), ['Shape', 'main', 'LIMIT'], 'types, then functions, then constants')
    assert.deepEqual(shuffled[2].children?.map((symbol) => symbol.name), ['describe', 'area'], 'the tree given is left as it was')
  })

  it('keeps what a filter finds and the symbols it is in', () => {
    const found = filterOutline(tree, 'desc')
    assert.deepEqual(found.map((symbol) => symbol.name), ['Shape'])
    assert.deepEqual(found[0].children?.map((symbol) => symbol.name), ['describe'])
    const own = filterOutline(tree, 'shape')
    assert.equal(own[0].children, undefined, 'a symbol found by its own name, none of its children matching, shows alone')
    assert.equal(filterOutline(tree, '').length, 3)
    assert.deepEqual(filterOutline(tree, 'nothing'), [])
  })

  it('keys a symbol by its names and starts, so two of one name stay apart', () => {
    const twin = { ...area, range: range(20, 0, 22, 1) }
    assert.notEqual(symbolKey([shape, area]), symbolKey([shape, twin]))
    assert.equal(symbolKey([shape, area]), symbolKey([shape, { ...area }]))
  })
})

describe('the kind tiles', () => {
  it('draws each kind as a letter in the tone of what it is', () => {
    assert.deepEqual(symbolGlyph('function'), { letter: 'f', tone: 'function' })
    assert.deepEqual(symbolGlyph('method'), { letter: 'm', tone: 'function' })
    assert.deepEqual(symbolGlyph('class'), { letter: 'C', tone: 'type' })
    assert.deepEqual(symbolGlyph('interface'), { letter: 'I', tone: 'interface' })
    assert.deepEqual(symbolGlyph('enum member'), { letter: 'e', tone: 'enum' })
    assert.deepEqual(symbolGlyph('property'), { letter: 'p', tone: 'value' })
    assert.deepEqual(symbolGlyph('constant'), { letter: 'K', tone: 'constant' })
    assert.deepEqual(symbolGlyph('namespace'), { letter: 'N', tone: 'module' })
    assert.deepEqual(symbolGlyph('something new'), { letter: '·', tone: 'other' })
  })
})
