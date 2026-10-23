import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EditorCallFunction, EditorLocation } from '@shared/types'
import { callRows, placeOfNode, type CallChildren, type CallNode } from './calls'

const at = (path: string, line: number): EditorLocation => ({ path, file: `/root/${path}`, line, character: 0, endLine: line, endCharacter: 4 })
const fn = (id: number, name: string, path = 'a.ts', line = 0): EditorCallFunction => ({ id, name, kind: 'function', at: at(path, line) })

describe('the call hierarchy tree', () => {
  const root: CallNode = { key: '0', fn: fn(1, 'area'), sites: [] }
  const caller: CallNode = { key: '0/0', fn: fn(2, 'report', 'b.ts', 9), sites: [at('b.ts', 12), at('b.ts', 15)] }

  it('shows the function asked about, closed, until it is opened', () => {
    const rows = callRows([root], new Set(), new Map(), 'incoming')
    assert.equal(rows.length, 1)
    assert.ok(rows[0].kind === 'node' && !rows[0].open && rows[0].known === undefined)
  })

  it('says it is asking, then what came back: the callers, none, or why not', () => {
    const open = new Set(['0'])
    const loading = callRows([root], open, new Map<string, CallChildren>([['0', { state: 'loading' }]]), 'incoming')
    assert.ok(loading[1].kind === 'note' && loading[1].loading)
    const ready = callRows([root], open, new Map<string, CallChildren>([['0', { state: 'ready', nodes: [caller] }]]), 'incoming')
    assert.deepEqual(
      ready.map((row) => (row.kind === 'node' ? `${row.depth}:${row.node.fn.name}:${row.parent}` : row.text)),
      ['0:area:null', '1:report:0'],
    )
    const none = callRows([root], open, new Map<string, CallChildren>([['0', { state: 'ready', nodes: [] }]]), 'outgoing')
    assert.ok(none[1].kind === 'note' && none[1].text === 'No calls found.')
    const noCallers = callRows([root], open, new Map<string, CallChildren>([['0', { state: 'ready', nodes: [] }]]), 'incoming')
    assert.ok(noCallers[1].kind === 'note' && noCallers[1].text === 'No callers found.')
    const failed = callRows([root], open, new Map<string, CallChildren>([['0', { state: 'failed', reason: 'That call hierarchy is out of date. Open it again.' }]]), 'incoming')
    assert.ok(failed[1].kind === 'note' && failed[1].text.startsWith('That call hierarchy'))
  })

  it('keeps what a closed level found out of sight, and back when it opens again', () => {
    const known = new Map<string, CallChildren>([['0', { state: 'ready', nodes: [caller] }]])
    assert.equal(callRows([root], new Set(), known, 'incoming').length, 1)
    assert.equal(callRows([root], new Set(['0']), known, 'incoming').length, 2)
  })

  it('goes to the first call of a caller, and to the function itself at the top', () => {
    assert.deepEqual(placeOfNode(caller), at('b.ts', 12))
    assert.deepEqual(placeOfNode(root), root.fn.at)
  })
})
