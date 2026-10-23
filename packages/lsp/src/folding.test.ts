import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_FOLD_RANGES, readFoldingRanges } from './folding'

describe('a server\'s folding ranges', () => {
  it('are read field by field, skipping what is no range', () => {
    assert.equal(readFoldingRanges(null), null)
    assert.equal(readFoldingRanges({ startLine: 0, endLine: 2 }), null)
    assert.deepEqual(
      readFoldingRanges([
        { startLine: 0, endLine: 3, endCharacter: 1, kind: 'region' },
        { startLine: 4, endLine: 4 },
        { startLine: 6, endLine: 5 },
        { startLine: -1, endLine: 2 },
        { startLine: 1.5, endLine: 2 },
        { startLine: '1', endLine: 2 },
        { startLine: 7, endLine: 9, endCharacter: -2, kind: 'shape' },
        null,
        'x',
      ]),
      [
        { startLine: 0, endLine: 3, endCharacter: 1, kind: 'region' },
        { startLine: 7, endLine: 9 },
      ],
    )
  })

  it('are capped', () => {
    const many = Array.from({ length: MAX_FOLD_RANGES + 50 }, (_, index) => ({ startLine: index, endLine: index + 1 }))
    assert.equal(readFoldingRanges(many)!.length, MAX_FOLD_RANGES)
  })
})
