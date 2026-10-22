import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { commitRequestOf, reviewActionOf, reviewOptionsOf, reviewScopeOf } from './review-input'

const HUNK = '0123456789abcdef'
const FINGERPRINT = 'a'.repeat(40)

describe('what the Review tab may ask for', () => {
  it('takes the four scopes, and a base or commit only of a safe shape', () => {
    assert.deepEqual(reviewScopeOf({ kind: 'unstaged', extra: 1 }), { kind: 'unstaged' })
    assert.deepEqual(reviewScopeOf({ kind: 'staged' }), { kind: 'staged' })
    assert.deepEqual(reviewScopeOf({ kind: 'branch' }), { kind: 'branch' })
    assert.deepEqual(reviewScopeOf({ kind: 'branch', base: 'origin/feature/x-1.2' }), { kind: 'branch', base: 'origin/feature/x-1.2' })
    assert.deepEqual(reviewScopeOf({ kind: 'branch', base: 'release+2026/über#3' }), { kind: 'branch', base: 'release+2026/über#3' })
    assert.deepEqual(reviewScopeOf({ kind: 'commit', commit: 'ABCDEF12' }), { kind: 'commit', commit: 'abcdef12' })
    for (const base of ['--output=/tmp/x', '-p', 'a..b', 'a//b', 'main.lock', 'x y', 'a~1', 'a^', 'a:b', 'a*', 'a[1]', 'a\\b', 'main@{1}', 'a\tb', '', 'a'.repeat(201), 42]) {
      assert.throws(() => reviewScopeOf({ kind: 'branch', base }), TypeError, String(base))
    }
    for (const commit of ['HEAD', 'abc', 'xyz12345', '--all', 'a'.repeat(65)]) assert.throws(() => reviewScopeOf({ kind: 'commit', commit }), TypeError, commit)
    for (const scope of [null, 'unstaged', [], { kind: 'everything' }]) assert.throws(() => reviewScopeOf(scope), TypeError)
  })

  it('takes the Turn view of a session, at its latest request or one named by id', () => {
    const session = '8a6b2c1e-1f0d-4e57-9a51-3c2b1d0e9f87'
    assert.deepEqual(reviewScopeOf({ kind: 'turn', session, extra: 1 }), { kind: 'turn', session })
    assert.deepEqual(reviewScopeOf({ kind: 'turn', session, turn: null }), { kind: 'turn', session })
    assert.deepEqual(reviewScopeOf({ kind: 'turn', session, turn: 'u-1' }), { kind: 'turn', session, turn: 'u-1' })
    for (const bad of ['', '../x', '-rf', 'a b', 'x'.repeat(201), 5]) {
      assert.throws(() => reviewScopeOf({ kind: 'turn', session: bad }), /Not a session/, String(bad))
      assert.throws(() => reviewScopeOf({ kind: 'turn', session, turn: bad }), /Not a request/, String(bad))
    }
  })

  it('keeps options in range and falls back to three lines of context', () => {
    assert.deepEqual(reviewOptionsOf(undefined), { context: 3, ignoreWhitespace: false })
    assert.deepEqual(reviewOptionsOf({ context: 10, ignoreWhitespace: true }), { context: 10, ignoreWhitespace: true })
    assert.deepEqual(reviewOptionsOf({ context: Infinity }), { context: Infinity, ignoreWhitespace: false })
    for (const context of [-1, 1.5, 1001, '5', NaN]) assert.equal(reviewOptionsOf({ context }).context, 3, String(context))
    assert.equal(reviewOptionsOf({ ignoreWhitespace: 'yes' }).ignoreWhitespace, false)
  })

  it('takes a hunk action only with the hunk and the file as it was shown', () => {
    assert.deepEqual(reviewActionOf({ type: 'stage-hunk', path: 'src/a b.ts', hunk: HUNK, fingerprint: FINGERPRINT, extra: true }), {
      type: 'stage-hunk',
      path: 'src/a b.ts',
      hunk: HUNK,
      fingerprint: FINGERPRINT,
    })
    assert.throws(() => reviewActionOf({ type: 'revert-hunk', path: 'a.ts', hunk: HUNK }), /as it was shown/)
    assert.throws(() => reviewActionOf({ type: 'revert-hunk', path: 'a.ts', hunk: 'zz', fingerprint: FINGERPRINT }), /Not a hunk/)
    assert.deepEqual(reviewActionOf({ type: 'revert-file', path: 'a.ts' }), { type: 'revert-file', path: 'a.ts' })
    assert.deepEqual(reviewActionOf({ type: 'unstage-file', path: 'a.ts', fingerprint: 'not one' }), { type: 'unstage-file', path: 'a.ts' })
    assert.deepEqual(reviewActionOf({ type: 'revert-all', path: 'ignored' }), { type: 'revert-all' })
    for (const path of ['', 'a\0b', 'x'.repeat(4097), 7]) assert.throws(() => reviewActionOf({ type: 'stage-file', path }), /Not a file path/)
    assert.throws(() => reviewActionOf({ type: 'delete-everything', path: 'a' }), /Not a review action/)
  })

  it('takes a commit message of a sane size, and flags only when they are true', () => {
    assert.deepEqual(commitRequestOf({ message: 'Fix it', all: 1, amend: 'yes', push: true }), { message: 'Fix it', all: false, amend: false, push: true })
    assert.throws(() => commitRequestOf({ message: 'x'.repeat(64 * 1024 + 1) }), /Not a commit message/)
    assert.throws(() => commitRequestOf({ message: 5 }), /Not a commit message/)
  })
})
