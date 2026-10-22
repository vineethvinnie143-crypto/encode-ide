import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RewindFile, RewindOutcome, RewindPlan } from '@shared/types'
import { actionLabel, changes, choicesFor, conflicts, defaultChoice, leftAlone, outcomeNote, requestFor, requestPreview, summaryOf } from './rewind'

const file = (path: string, action: RewindFile['action'], patch: Partial<RewindFile> = {}): RewindFile => ({ path, action, conflict: false, ...patch })
const plan = (files: RewindFile[], patch: Partial<RewindPlan> = {}): RewindPlan => ({ kind: 'rewind', turn: 't1', known: true, files, fingerprint: 'fp', ...patch })

describe('what a rewind offers', () => {
  it('lists the files it would change apart from the ones it leaves alone', () => {
    const p = plan([file('a.ts', 'restore'), file('b.ts', 'delete'), file('c.ts', 'unchanged'), file('/etc/x', 'skip', { reason: 'outside the workspace' })])
    assert.deepEqual(changes(p).map((item) => item.path), ['a.ts', 'b.ts'])
    assert.deepEqual(leftAlone(p).map((item) => item.path), ['/etc/x'])
    assert.deepEqual(changes(null), [])
  })

  it('names the files that changed since the agent wrote them', () => {
    const p = plan([file('a.ts', 'restore', { conflict: true }), file('b.ts', 'restore')])
    assert.deepEqual(conflicts(p).map((item) => item.path), ['a.ts'])
  })

  it('offers all three ways when there are files to put back, and the conversation alone when there are none', () => {
    assert.deepEqual(choicesFor(plan([file('a.ts', 'restore')])), ['both', 'code', 'conversation'])
    assert.equal(defaultChoice(plan([file('a.ts', 'restore')])), 'both')
    for (const empty of [plan([]), plan([file('a.ts', 'unchanged')]), plan([], { known: false }), null]) {
      assert.deepEqual(choicesFor(empty), ['conversation'])
      assert.equal(defaultChoice(empty), 'conversation')
    }
  })
})

describe('the request a choice makes', () => {
  const p = plan([file('a.ts', 'restore')])

  it('goes back in the conversation too only for "code and conversation"', () => {
    assert.deepEqual(requestFor(p, 'both', false), { kind: 'rewind', turn: 't1', fingerprint: 'fp', conversation: true })
    assert.deepEqual(requestFor(p, 'code', false), { kind: 'rewind', turn: 't1', fingerprint: 'fp' })
  })

  it('overwrites files that changed since only when asked to', () => {
    assert.deepEqual(requestFor(p, 'code', true), { kind: 'rewind', turn: 't1', fingerprint: 'fp', force: true })
  })

  it('needs no plan for the conversation alone', () => {
    assert.equal(requestFor(p, 'conversation', true), null)
  })

  it('never cuts the conversation when undoing a rewind', () => {
    assert.deepEqual(requestFor(plan([file('a.ts', 'restore')], { kind: 'redo' }), 'both', false), { kind: 'redo', turn: 't1', fingerprint: 'fp' })
  })
})

describe('the words of the dialog', () => {
  it('say what happens to each file', () => {
    assert.equal(actionLabel(file('a', 'restore')), 'Put back')
    assert.equal(actionLabel(file('a', 'delete')), 'Delete')
    assert.equal(actionLabel(file('a', 'unchanged')), 'Already as it was')
    assert.equal(actionLabel(file('a', 'skip', { reason: 'saved copy missing' })), 'Left alone: saved copy missing')
    assert.equal(actionLabel(file('a', 'skip')), 'Left alone')
  })

  it('sum the plan up in a sentence', () => {
    assert.equal(summaryOf(plan([file('a', 'restore'), file('b', 'restore'), file('c', 'delete')])), 'Will put back 2 files and delete 1 file the agent created.')
    assert.equal(summaryOf(plan([file('a', 'restore')], { kind: 'redo' })), 'Will bring back 1 file.')
    assert.equal(summaryOf(plan([file('a', 'unchanged')])), 'Every file is already as it was.')
    assert.equal(summaryOf(plan([])), 'This request changed no files.')
    assert.equal(summaryOf(plan([], { known: false })), 'Nothing was recorded for this request.')
    assert.equal(summaryOf(null), '')
  })

  it('tell what a rewind did, and what it left alone', () => {
    const done = (patch: Partial<Extract<RewindOutcome, { ok: true }>> = {}): RewindOutcome => ({ ok: true, restored: 0, deleted: 0, skipped: [], failed: [], ...patch })
    assert.deepEqual(outcomeNote(done({ restored: 2, deleted: 1 }), 'rewind'), { tone: 'success', text: 'Put back 2 files and deleted 1 file.' })
    assert.deepEqual(outcomeNote(done({ restored: 1 }), 'redo'), { tone: 'success', text: 'Brought back 1 file.' })
    assert.deepEqual(outcomeNote(done({ deleted: 1 }), 'rewind'), { tone: 'success', text: 'Deleted 1 file.' })
    assert.deepEqual(outcomeNote(done({ restored: 1, text: 'fix the bug' }), 'rewind'), { tone: 'success', text: 'Put back 1 file. Went back in the conversation.' })
    assert.deepEqual(outcomeNote(done({ text: 'fix the bug' }), 'rewind'), { tone: 'success', text: 'Went back in the conversation.' })
    assert.deepEqual(outcomeNote(done(), 'rewind'), { tone: 'success', text: 'No file needed to change.' })
    assert.deepEqual(
      outcomeNote(done({ restored: 1, skipped: [{ path: 'a.ts', reason: 'changed since the agent last wrote it' }, { path: 'b.ts', reason: 'x' }] }), 'rewind'),
      { tone: 'success', text: 'Put back 1 file. 2 files left alone (a.ts: changed since the agent last wrote it, and 1 more).' },
    )
    assert.deepEqual(outcomeNote(done({ restored: 1, failed: [{ path: 'c.ts', error: 'EPERM' }] }), 'rewind'), { tone: 'error', text: 'Put back 1 file. Could not change 1 file (c.ts: EPERM).' })
  })

  it('pass a refusal on in its own words', () => {
    assert.deepEqual(outcomeNote({ ok: false, reason: 'busy', message: 'eNCode is working on this session. Stop it first.' }, 'rewind'), {
      tone: 'error',
      text: 'eNCode is working on this session. Stop it first.',
    })
  })

  it('shorten a long request to one line for the heading', () => {
    assert.equal(requestPreview('  fix\n\nthe   bug  '), 'fix the bug')
    const long = requestPreview('x'.repeat(500))
    assert.equal(long.length, 160)
    assert.ok(long.endsWith('…'))
  })
})
