import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ChangeVersion, TurnChangeSet, TurnFileChange, TurnFileWrite, TurnWriteOutcome } from '@encode/core'
import type { ReviewActOutcome, ReviewLoad, ReviewSnapshot } from '../../shared/types'
import { TurnReview, reviewFileOf, type TurnScope, type TurnSource } from './turn-review'

const OPTIONS = { context: 3, ignoreWhitespace: false }
const SCOPE: TurnScope = { kind: 'turn', session: 's1', turn: 'u-1' }
const ROOT = '/ws'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (text: string): ChangeVersion => ({ state: 'bytes', hash: hash(text), bytes: new Uint8Array(Buffer.from(text)) })
const lines = (count: number, changed: Record<number, string> = {}) => Array.from({ length: count }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join('\n') + '\n'

/**
 * One request's record over files held in memory. It writes the way the agent host does: only over the version the
 * write expects, keeping what it replaces so a later write can put it back by its hash.
 */
class FakeRecord implements TurnSource {
  readonly disk = new Map<string, string>()
  /** What the request found, by file; null: the file did not exist. */
  readonly found = new Map<string, string | null>()
  readonly kept = new Map<string, string>()
  /** Files a later request changed again, or whose earlier version is not known. */
  readonly fixed = new Map<string, Partial<TurnFileChange>>()
  busy = false
  writes = 0

  /** The request changed `name` from `before` to `after` (null: missing). */
  changed(name: string, before: string | null, after: string | null): this {
    const file = `${ROOT}/${name}`
    this.found.set(file, before)
    if (before !== null) this.kept.set(hash(before), before)
    if (after === null) this.disk.delete(file)
    else this.disk.set(file, after)
    return this
  }

  read(name: string): string | undefined {
    return this.disk.get(`${ROOT}/${name}`)
  }

  async changes(_session: string, turn?: string): Promise<TurnChangeSet> {
    if (turn && turn !== 'u-1') return { turn, root: ROOT, files: [], busy: this.busy, problem: 'That request is not in this conversation any more.' }
    const files = [...this.found].map(([file, before]): TurnFileChange => {
      const now = this.disk.get(file)
      return {
        path: file.slice(ROOT.length + 1),
        file,
        before: before === null ? { state: 'missing' } : bytes(before),
        after: now === undefined ? { state: 'missing' } : bytes(now),
        afterFrom: 'now',
        changedSince: false,
        ...this.fixed.get(file),
      }
    })
    return { turn: 'u-1', at: 1_000, root: ROOT, files, busy: this.busy }
  }

  async write(_session: string, write: TurnFileWrite): Promise<TurnWriteOutcome> {
    this.writes++
    const current = this.disk.get(write.file)
    const currentHash = current === undefined ? null : hash(current)
    if (currentHash !== write.expected) return { ok: false, reason: 'stale', message: 'The file changed.' }
    let next: string | null = null
    if (write.next && 'kept' in write.next) {
      const kept = this.kept.get(write.next.kept)
      if (kept === undefined) return { ok: false, reason: 'refused', message: 'The saved copy is gone.' }
      next = kept
    } else if (write.next) {
      assert.ok(write.next.bytes instanceof ArrayBuffer, 'bytes cross as their own ArrayBuffer')
      next = Buffer.from(write.next.bytes).toString('utf8')
    }
    if (current !== undefined) this.kept.set(currentHash!, current)
    if (next === null) this.disk.delete(write.file)
    else this.disk.set(write.file, next)
    return { ok: true, previous: currentHash, written: next === null ? null : hash(next) }
  }
}

function shown(load: ReviewLoad): ReviewSnapshot {
  assert.ok(load.ok, load.ok ? '' : load.message)
  return load.snapshot
}

function done(outcome: ReviewActOutcome): ReviewSnapshot {
  assert.ok(outcome.ok, outcome.message)
  return shown(outcome.load)
}

describe('the Turn view of the Review tab', () => {
  it('shows what one request changed that still differs, as the review draws it', async () => {
    const record = new FakeRecord().changed('src/a.ts', lines(6), lines(6, { 2: 'LINE 2' })).changed('notes.md', null, 'new\n').changed('same.ts', 'x\n', 'x\n')
    const snapshot = shown(await new TurnReview(record).load(SCOPE, OPTIONS))
    assert.deepEqual(
      snapshot.files.map((file) => [file.path, file.change, file.added, file.removed, file.hunkActions]),
      [
        ['src/a.ts', 'modified', 1, 1, true],
        ['notes.md', 'added', 1, 0, true],
      ],
    )
    assert.deepEqual(snapshot.scope, SCOPE)
    assert.deepEqual(snapshot.repo, { root: ROOT, folder: '', branch: null, head: null })
    assert.equal(snapshot.counts, null)
    assert.deepEqual(snapshot.turn, { id: 'u-1', at: 1_000, busy: false })
    assert.equal(snapshot.readOnly, false)
  })

  it('reverts one change of a file and leaves the others, then undoes it', async () => {
    const after = lines(20, { 2: 'LINE 2', 18: 'LINE 18' })
    const record = new FakeRecord().changed('a.ts', lines(20), after)
    const review = new TurnReview(record)
    const [file] = shown(await review.load(SCOPE, OPTIONS)).files
    assert.equal(file.hunks.length, 2)
    const outcome = await review.act(SCOPE, { type: 'revert-hunk', path: 'a.ts', hunk: file.hunks[0].id, fingerprint: file.fingerprint }, OPTIONS)
    assert.equal(outcome.ok && outcome.message, 'Reverted a change in a.ts')
    assert.equal(record.read('a.ts'), lines(20, { 18: 'LINE 18' }))
    assert.equal(done(outcome).files[0].hunks.length, 1)
    assert.equal(outcome.load.ok && outcome.load.undo, 'Reverted a change in a.ts')

    const undone = await review.undo(SCOPE, OPTIONS)
    assert.equal(undone.message, 'Undid: reverted a change in a.ts')
    assert.equal(record.read('a.ts'), after)
    assert.equal(undone.load.ok && undone.load.undo, null)
    assert.deepEqual(await review.undo(SCOPE, OPTIONS).then((again) => [again.ok, again.message]), [false, 'There is nothing to undo.'])
  })

  it('deletes a file the request created, and brings it back on undo', async () => {
    const record = new FakeRecord().changed('made.txt', null, 'created\n')
    const review = new TurnReview(record)
    const [file] = shown(await review.load(SCOPE, OPTIONS)).files
    const outcome = await review.act(SCOPE, { type: 'revert-file', path: 'made.txt', fingerprint: file.fingerprint }, OPTIONS)
    assert.equal(outcome.message, 'Deleted made.txt')
    assert.equal(record.read('made.txt'), undefined)
    assert.deepEqual(done(outcome).files, [])
    await review.undo(SCOPE, OPTIONS)
    assert.equal(record.read('made.txt'), 'created\n')
  })

  it('reverts everything at once, and puts it all back on undo', async () => {
    const record = new FakeRecord().changed('a.ts', 'one\n', 'two\n').changed('gone.ts', 'kept\n', null).changed('b.ts', null, 'new\n')
    const review = new TurnReview(record)
    const outcome = await review.act(SCOPE, { type: 'revert-all' }, OPTIONS)
    assert.equal(outcome.message, 'Reverted 3 files')
    assert.deepEqual([record.read('a.ts'), record.read('gone.ts'), record.read('b.ts')], ['one\n', 'kept\n', undefined])
    assert.deepEqual(done(outcome).files, [])
    const undone = await review.undo(SCOPE, OPTIONS)
    assert.equal(undone.message, 'Undid: reverted 3 files')
    assert.deepEqual([record.read('a.ts'), record.read('gone.ts'), record.read('b.ts')], ['two\n', undefined, 'new\n'])
  })

  it('refuses a change to a file that moved on since it was shown, and changes nothing', async () => {
    const record = new FakeRecord().changed('a.ts', lines(8), lines(8, { 4: 'agent' }))
    const review = new TurnReview(record)
    const [file] = shown(await review.load(SCOPE, OPTIONS)).files
    record.disk.set(`${ROOT}/a.ts`, lines(8, { 4: 'agent', 8: 'mine' }))
    for (const action of [
      { type: 'revert-hunk' as const, path: 'a.ts', hunk: file.hunks[0].id, fingerprint: file.fingerprint },
      { type: 'revert-file' as const, path: 'a.ts', fingerprint: file.fingerprint },
    ]) {
      const outcome = await review.act(SCOPE, action, OPTIONS)
      assert.equal(outcome.ok, false)
      assert.equal(!outcome.ok && outcome.stale, true)
      assert.match(outcome.message, /changed since you looked at it/)
    }
    assert.equal(record.writes, 0)
    assert.equal(record.read('a.ts'), lines(8, { 4: 'agent', 8: 'mine' }))
    // Shown again, the person's own line is part of the picture, and the revert takes the file back past it.
    const [fresh] = shown(await review.load(SCOPE, OPTIONS)).files
    assert.ok(done(await review.act(SCOPE, { type: 'revert-file', path: 'a.ts', fingerprint: fresh.fingerprint }, OPTIONS)))
    assert.equal(record.read('a.ts'), lines(8))
  })

  it('keeps a file a later request changed again read only, and says so', async () => {
    const record = new FakeRecord().changed('later.ts', 'a\n', 'b\n').changed('free.ts', 'c\n', 'd\n')
    record.fixed.set(`${ROOT}/later.ts`, { afterFrom: 'later', fixed: 'changed again by a later request' })
    const review = new TurnReview(record)
    const files = shown(await review.load(SCOPE, OPTIONS)).files
    const later = files.find((file) => file.path === 'later.ts')!
    assert.equal(later.fixed, 'This file cannot be changed from here: changed again by a later request.')
    assert.equal(later.hunkActions, false)
    assert.match(later.note ?? '', /A later request changed this file again/)
    const refused = await review.act(SCOPE, { type: 'revert-file', path: 'later.ts', fingerprint: later.fingerprint }, OPTIONS)
    assert.deepEqual([refused.ok, refused.message], [false, later.fixed])
    const all = await review.act(SCOPE, { type: 'revert-all' }, OPTIONS)
    assert.equal(all.message, 'Reverted 1 file. Left as they are: later.ts: This file cannot be changed from here: changed again by a later request.')
    assert.deepEqual([record.read('later.ts'), record.read('free.ts')], ['b\n', 'c\n'])
  })

  it('changes nothing while the agent works, and offers only reverts', async () => {
    const record = new FakeRecord().changed('a.ts', 'one\n', 'two\n')
    const review = new TurnReview(record)
    record.busy = true
    const snapshot = shown(await review.load(SCOPE, OPTIONS))
    assert.equal(snapshot.readOnly, true)
    assert.match(snapshot.files[0].fixed ?? '', /working on this session/)
    const busy = await review.act(SCOPE, { type: 'revert-all' }, OPTIONS)
    assert.deepEqual([busy.ok, busy.message], [false, 'eNCode is working on this session. Wait for it to finish, or stop it.'])
    record.busy = false
    const staged = await review.act(SCOPE, { type: 'stage-file', path: 'a.ts' }, OPTIONS)
    assert.deepEqual([staged.ok, staged.message], [false, 'In this view a change can only be reverted.'])
    const unnamed = await review.act({ kind: 'turn', session: 's1' }, { type: 'revert-all' }, OPTIONS)
    assert.deepEqual([unnamed.ok, unnamed.message], [false, 'Choose the request to act on first.'])
    assert.equal(record.writes, 0)
  })

  it('keeps each conversation’s undo to itself', async () => {
    const record = new FakeRecord().changed('a.ts', 'one\n', 'two\n')
    const review = new TurnReview(record)
    done(await review.act(SCOPE, { type: 'revert-all' }, OPTIONS))
    const other = await review.undo({ kind: 'turn', session: 's2', turn: 'u-1' }, OPTIONS)
    assert.deepEqual([other.ok, other.message], [false, 'There is nothing to undo.'])
    assert.equal(record.read('a.ts'), 'one\n')
  })

  it('stands in for a file it cannot show, and reverts it whole where the record kept it', () => {
    const large: TurnFileChange = {
      path: 'big.bin',
      file: `${ROOT}/big.bin`,
      before: { state: 'unread', hash: hash('old'), size: 9_000_000, why: 'large' },
      after: { state: 'unread', hash: hash('new'), size: 9_100_000, why: 'large' },
      afterFrom: 'now',
      changedSince: false,
    }
    const file = reviewFileOf(large, OPTIONS, false)!
    assert.deepEqual([file.kind, file.hunks.length, file.fixed, file.size], ['large', 0, undefined, { old: 9_000_000, new: 9_100_000 }])
    const unkept = reviewFileOf({ ...large, before: { state: 'unread', hash: null, size: 0, why: 'unkept' } }, OPTIONS, false)!
    assert.equal(unkept.fixed, 'The version before this request is not known, so it cannot be put back.')
    const unread = reviewFileOf({ ...large, before: { state: 'unread', hash: hash('old'), size: 10, why: 'budget' } }, OPTIONS, false)!
    assert.equal(unread.fixed, undefined, 'a kept copy the review did not read can still be put back')
    const huge = reviewFileOf({ ...large, after: { state: 'unread', hash: null, size: 30_000_000, why: 'large' } }, OPTIONS, false)!
    assert.equal(huge.fixed, 'It is too large for eNCode to keep a copy of before replacing it, so it is not changed from here.')
    assert.equal(reviewFileOf({ ...large, after: large.before }, OPTIONS, false), null, 'a file back as it was is not listed')
  })
})
