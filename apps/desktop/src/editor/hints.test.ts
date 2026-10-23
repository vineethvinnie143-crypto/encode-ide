import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { T } from '@encode/editor'
import { SEMANTIC_KINDS as HOST_KINDS } from '@encode/lsp'
import { inlayHintsToView, SEMANTIC_KINDS, semanticTokensToView } from './hints'

describe('a server\'s hints and semantic tokens as the editor draws them', () => {
  it('number semantic kinds as the host does, and name only kinds the editor has', () => {
    assert.deepEqual([...SEMANTIC_KINDS], [...HOST_KINDS])
    for (const name of SEMANTIC_KINDS) assert.equal(typeof T[name], 'number', name)
  })

  it('turn the host\'s tokens into 1-based lines and the editor\'s kinds, deprecated ones flagged', () => {
    const fn = SEMANTIC_KINDS.indexOf('function')
    const type = SEMANTIC_KINDS.indexOf('type')
    assert.deepEqual(semanticTokensToView({ data: [0, 4, 3, type, 0, 2, 0, 6, fn, 1, 3, 0, 1, 99, 0, 3, 1] }), [
      { line: 1, from: 4, to: 7, kind: T.type },
      { line: 3, from: 0, to: 6, kind: T.function, deprecated: true },
    ])
  })

  it('turn the host\'s hints into 1-based lines and columns the view draws them before', () => {
    assert.deepEqual(
      inlayHintsToView([
        { line: 0, character: 9, label: ': number', kind: 'type' },
        { line: 4, character: 2, label: 'count:', kind: 'parameter', paddingRight: true },
      ]),
      [
        { line: 1, col: 9, label: ': number', kind: 'type' },
        { line: 5, col: 2, label: 'count:', kind: 'parameter', paddingRight: true },
      ],
    )
  })
})
