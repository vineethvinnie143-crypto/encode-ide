import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EditorSymbolMatch } from '@shared/types'
import { MAX_FOLDER_SYMBOLS, parseLine, quickOpenMode, rankFolderSymbols } from './quick-open'

describe('what Go to file is asked for', () => {
  it('reads a file name, with a line and column after it', () => {
    assert.deepEqual(quickOpenMode('utils'), { kind: 'file', text: 'utils' })
    assert.deepEqual(quickOpenMode('  src/app.ts  '), { kind: 'file', text: 'src/app.ts' })
    assert.deepEqual(quickOpenMode('app.ts:12'), { kind: 'file', text: 'app.ts', at: { line: 12 } })
    assert.deepEqual(quickOpenMode('app.ts:12:5'), { kind: 'file', text: 'app.ts', at: { line: 12, column: 5 } })
    assert.deepEqual(quickOpenMode('a:b'), { kind: 'file', text: 'a:b' }, 'what follows the colon is no line')
    assert.deepEqual(quickOpenMode('app.ts:0'), { kind: 'file', text: 'app.ts:0' }, 'there is no line 0')
  })

  it('reads @ as the file’s symbols, # as the folder’s and : as a line', () => {
    assert.deepEqual(quickOpenMode('@'), { kind: 'symbol', text: '' })
    assert.deepEqual(quickOpenMode('@ area '), { kind: 'symbol', text: 'area' })
    assert.deepEqual(quickOpenMode('#Shape'), { kind: 'folderSymbol', text: 'Shape' })
    assert.deepEqual(quickOpenMode(':40'), { kind: 'line', text: '40', at: { line: 40 } })
    assert.deepEqual(quickOpenMode(':40:3'), { kind: 'line', text: '40:3', at: { line: 40, column: 3 } })
    assert.deepEqual(quickOpenMode(':'), { kind: 'line', text: '' })
    assert.deepEqual(quickOpenMode(':forty'), { kind: 'line', text: 'forty' })
  })

  it('takes a line as 12, 12:5 or 12,5, and nothing else', () => {
    assert.deepEqual(parseLine('12'), { line: 12 })
    assert.deepEqual(parseLine(' 12 , 5 '), { line: 12, column: 5 })
    assert.deepEqual(parseLine('12:0'), { line: 12 }, 'column 0 is the start of the line')
    assert.equal(parseLine('0'), undefined)
    assert.equal(parseLine('-3'), undefined)
    assert.equal(parseLine('1e3'), undefined)
    assert.equal(parseLine('9999999999'), undefined, 'longer than any file')
  })
})

describe('the folder’s symbols', () => {
  const match = (name: string, container?: string): EditorSymbolMatch => ({ name, kind: 'function', path: 'a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, ...(container ? { container } : {}) })

  it('puts the best spelled name first and keeps what the server found that the query does not spell, last', () => {
    const ranked = rankFolderSymbols([match('makeShape'), match('Shape'), match('fuzzyThing'), match('area', 'Shape')], 'shape')
    assert.deepEqual(
      ranked.map((item) => item.name),
      ['Shape', 'makeShape', 'area', 'fuzzyThing'],
    )
  })

  it('keeps the server’s order for no query, and shows at most the cap', () => {
    const many = Array.from({ length: MAX_FOLDER_SYMBOLS + 5 }, (_, index) => match(`f${index}`))
    const ranked = rankFolderSymbols(many, '')
    assert.equal(ranked.length, MAX_FOLDER_SYMBOLS)
    assert.equal(ranked[0].name, 'f0')
  })
})
