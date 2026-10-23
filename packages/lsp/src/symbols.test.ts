import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import type { Range } from './protocol'
import { fromDocumentSymbols, holds, nestSymbols, type EditorSymbol } from './symbols'

const range = (startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range => ({ start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } })
const flat = (name: string, at: Range): EditorSymbol => ({ name, kind: 'function', range: at, selection: at })
const shape = (symbols: readonly EditorSymbol[]): unknown[] => symbols.map((item) => (item.children ? [item.name, shape(item.children)] : item.name))

describe('a document\'s symbols', () => {
  it('nest a flat list by range, in the order of the text', () => {
    const nested = nestSymbols([
      flat('method', range(2, 2, 4, 3)),
      flat('Second', range(6, 0, 8, 1)),
      flat('Shape', range(0, 0, 5, 1)),
      flat('field', range(1, 2, 1, 10)),
      flat('local', range(3, 4, 3, 20)),
    ])
    assert.deepEqual(shape(nested), [['Shape', ['field', ['method', ['local']]]], 'Second'])
  })

  it('keep two symbols with the same range in the order given, the second under the first', () => {
    assert.deepEqual(shape(nestSymbols([flat('get', range(1, 0, 3, 0)), flat('set', range(1, 0, 3, 0))])), [['get', ['set']]])
  })

  it('take a server\'s tree as it is, with a name outside its symbol put at its start', () => {
    const tree = fromDocumentSymbols([
      { name: 'A', kind: 5, range: range(0, 0, 9, 0), selectionRange: range(0, 6, 0, 7), children: [{ name: 'b', kind: 6, range: range(1, 0, 2, 0), selectionRange: range(5, 0, 5, 1) }] },
      { name: 'odd', kind: 99, range: range(10, 0, 10, 4), selectionRange: range(10, 0, 10, 3), detail: '(x)' },
    ])
    assert.deepEqual(tree[0].selection, range(0, 6, 0, 7))
    assert.deepEqual(tree[0].children?.[0].selection, range(1, 0, 1, 0))
    assert.equal(tree[0].kind, 'class')
    assert.deepEqual([tree[1].kind, tree[1].detail], ['symbol', '(x)'])
  })

  it('nest any list so that every symbol holds the ones under it and none is lost', async () => {
    const at = gen.map(gen.tuple(gen.int(0, 30), gen.int(0, 6), gen.int(0, 10), gen.int(0, 6)), ([line, character, length, width]) => range(line, character, line + length, width))
    await check(gen.array(at, 0, 25), (ranges) => {
      const nested = nestSymbols(ranges.map((item, index) => flat(`s${index}`, item)))
      let seen = 0
      const walk = (items: readonly EditorSymbol[], parent: EditorSymbol | null) => {
        for (const item of items) {
          seen++
          if (parent) assert.ok(holds(parent.range, item.range), `${parent.name} holds ${item.name}`)
          if (item.children) walk(item.children, item)
        }
      }
      walk(nested, null)
      assert.equal(seen, ranges.length)
    })
  })
})
