import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rewindRequestOf } from './rewind-request'

describe('the rewind a window may ask for', () => {
  it('keeps the kind, the request, the plan and the two choices, and nothing else', () => {
    assert.deepEqual(rewindRequestOf({ kind: 'rewind', turn: 't1', fingerprint: 'abc', force: true, conversation: true, files: ['/etc/passwd'] }), {
      kind: 'rewind',
      turn: 't1',
      fingerprint: 'abc',
      force: true,
      conversation: true,
    })
    assert.deepEqual(rewindRequestOf({ kind: 'redo', turn: 't1', fingerprint: 'abc' }), { kind: 'redo', turn: 't1', fingerprint: 'abc' })
  })

  it('takes only a plain yes for a choice', () => {
    assert.deepEqual(rewindRequestOf({ kind: 'rewind', turn: 't1', fingerprint: 'abc', force: 'yes', conversation: 1 }), { kind: 'rewind', turn: 't1', fingerprint: 'abc' })
  })

  it('refuses what does not name a kind, a request and a plan', () => {
    const named = { turn: 't1', fingerprint: 'abc' }
    for (const value of [
      null,
      undefined,
      'x',
      7,
      {},
      named,
      { kind: 'delete everything', ...named },
      { kind: 'rewind', turn: 't1' },
      { kind: 'rewind', fingerprint: 'abc' },
      { kind: 'rewind', turn: '', fingerprint: 'abc' },
      { kind: 'rewind', turn: 5, fingerprint: 'abc' },
      { kind: 'rewind', turn: 't1', fingerprint: ['abc'] },
    ]) {
      assert.throws(() => rewindRequestOf(value), /not a rewind/, JSON.stringify(value))
    }
  })
})
