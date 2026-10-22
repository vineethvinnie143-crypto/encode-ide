import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countLabel, findInBlocks, firstAtOrAfter, foldCase, foldQuery, foldText, markdownHaystack, MAX_MATCHES, type TextBlock } from './text'

/** Blocks of named pieces, as the page's text nodes would be: ['a1', 'Hello '] is the piece a1 holding "Hello ". */
const blocks = (...list: [string, string][][]): TextBlock<string>[] =>
  list.map((pieces) => ({ nodes: pieces.map(([name]) => name), texts: pieces.map(([, text]) => text) }))

/** Each match as "node:offset-node:offset". */
const found = (from: TextBlock<string>[], query: string, limit?: number) =>
  findInBlocks(from, foldQuery(query), limit).matches.map((match) => `${match.start.node}:${match.start.offset}-${match.end.node}:${match.end.offset}`)

describe('what find compares', () => {
  it('folds case without moving any character', () => {
    assert.equal(foldCase('Hello WORLD'), 'hello world')
    assert.equal(foldCase('İstanbul Straße'), 'İstanbul straße', 'İ, whose lower case is two characters, stays itself')
    assert.equal(foldCase('İx').length, 2)
  })

  it('reads a query folded, with one space for any run of white space, and nothing for white space alone', () => {
    assert.equal(foldQuery('  Find   ME\tnow '), ' find me now ')
    assert.equal(foldQuery('   '), '')
    assert.equal(foldQuery(''), '')
  })

  it('folds text the same way, and finds the way back to the original positions', () => {
    const folded = foldText('a  b\n\n c d')
    assert.equal(folded.text, 'a b c d')
    assert.deepEqual(
      [...folded.text].map((_, index) => folded.original(index)),
      [0, 1, 3, 4, 7, 8, 9],
    )
    assert.equal(folded.original(folded.text.length), 10, 'the end maps to the end')
    const plain = foldText('No runs here')
    assert.equal(plain.original(5), 5)
  })

  it('searches folded markdown as written and as shown, so bold and links do not hide words', () => {
    const haystack = markdownHaystack('Clear **the cache** and see [the docs](https://example.test/x).')
    assert.ok(haystack.includes('the cache'))
    assert.ok(haystack.includes('see the docs.'))
    assert.ok(haystack.includes('**the cache**'), 'the source is searched too')
  })
})

describe('finding in blocks of text', () => {
  it('finds every match in order without overlaps, whatever the case', () => {
    assert.deepEqual(found(blocks([['p', 'Aaa aAa']]), 'aa'), ['p:0-p:2', 'p:4-p:6'])
    assert.deepEqual(found(blocks([['p', 'Cache cache CACHE']]), 'cache'), ['p:0-p:5', 'p:6-p:11', 'p:12-p:17'])
  })

  it('finds a match that runs across the pieces of a block, ending in the piece it ends', () => {
    // "the **cache** key": three text nodes of one paragraph.
    const paragraph = blocks([
      ['t1', 'the '],
      ['b', 'cache'],
      ['t2', ' key'],
    ])
    assert.deepEqual(found(paragraph, 'e cache k'), ['t1:2-t2:2'])
    assert.deepEqual(found(paragraph, 'cache'), ['b:0-b:5'], 'an end at the edge of a piece stays in that piece')
    assert.deepEqual(found(paragraph, 'the'), ['t1:0-t1:3'])
  })

  it('never runs a match from one block into the next', () => {
    assert.deepEqual(found(blocks([['a', 'Ran']], [['b', 'npm test']]), 'ran npm'), [])
    assert.deepEqual(found(blocks([['a', 'Ran']], [['b', 'npm test']]), 'npm'), ['b:0-b:3'])
  })

  it('lets a run of white space or a line break in the text match one space typed', () => {
    assert.deepEqual(found(blocks([['pre', 'const  x =\n  1']]), 'x = 1'), ['pre:7-pre:14'])
    assert.deepEqual(found(blocks([['p', 'a\u00a0b']]), 'a b'), ['p:0-p:3'], 'a no-break space is a space')
  })

  it('stops at the most it marks and says there were more', () => {
    const many = blocks([['p', 'ab '.repeat(MAX_MATCHES + 5)]])
    const result = findInBlocks(many, 'ab')
    assert.equal(result.matches.length, MAX_MATCHES)
    assert.equal(result.capped, true)
    assert.equal(findInBlocks(many, 'ab', 3).matches.length, 3)
    const exact = findInBlocks(blocks([['p', 'ab ab']]), 'ab', 2)
    assert.deepEqual([exact.matches.length, exact.capped], [2, false], 'exactly the limit is not more')
  })

  it('finds nothing for an empty needle, and keeps positions right around a character that folds long', () => {
    assert.deepEqual(findInBlocks(blocks([['p', 'text']]), ''), { matches: [], capped: false })
    assert.deepEqual(found(blocks([['p', 'İİ Straße']]), 'straße'), ['p:3-p:9'])
  })
})

describe('the count and the place to start', () => {
  it('reads as the bar shows it', () => {
    assert.equal(countLabel(-1, 0, false), 'No results')
    assert.equal(countLabel(2, 41, false), '3 of 41')
    assert.equal(countLabel(0, 1000, true), '1 of 1000+')
  })

  it('finds the first item at or after a place, or the end', () => {
    const items = [1, 3, 3, 7]
    const at = (place: number) => firstAtOrAfter(items.length, (index) => items[index] - place)
    assert.equal(at(0), 0)
    assert.equal(at(3), 1)
    assert.equal(at(4), 3)
    assert.equal(at(8), 4)
    assert.equal(firstAtOrAfter(0, () => 0), 0)
  })
})
