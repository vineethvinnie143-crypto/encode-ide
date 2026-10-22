import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ReviewFile, ReviewFinding, ReviewLine, ReviewSnapshot } from '@shared/types'
import { commentsMessage } from './comments'
import { findingComments, nearestAnchor } from './reviewer'

const line = (kind: ReviewLine['kind'], old: number | undefined, now: number | undefined, text: string): ReviewLine => ({
  kind,
  text,
  ...(old !== undefined ? { old } : {}),
  ...(now !== undefined ? { new: now } : {}),
})

/** Lines 10 to 13 of src/a.ts, line 11 replaced; and lines 40 to 41 further down. */
const file: ReviewFile = {
  path: 'src/a.ts',
  change: 'modified',
  kind: 'text',
  added: 1,
  removed: 1,
  hunks: [
    { id: '1', oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, added: 1, removed: 1, lines: [line('ctx', 10, 10, 'a'), line('del', 11, undefined, 'b'), line('add', undefined, 11, 'B'), line('ctx', 12, 12, 'c')] },
    { id: '2', oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, added: 0, removed: 0, lines: [line('ctx', 40, 40, 'x'), line('ctx', 41, 41, 'y')] },
  ],
  hunkActions: true,
  fingerprint: '0'.repeat(40),
}

const snapshot = { files: [file] } as unknown as ReviewSnapshot
const finding = (patch: Partial<ReviewFinding> = {}): ReviewFinding => ({ path: 'src/a.ts', side: 'new', line: 11, priority: 'P1', title: 'Breaks on empty input', body: 'B throws when the list is empty.', ...patch })
let ids = 0
const newId = () => `c${++ids}`

describe("the Reviewer's findings as comments", () => {
  it('sit on the line they name, quote it, and keep their priority and title', () => {
    const [comment] = findingComments([finding()], snapshot, newId)
    assert.deepEqual(comment, { id: comment.id, path: 'src/a.ts', side: 'new', line: 11, text: 'B throws when the list is empty.', excerpt: 'B', by: 'reviewer', priority: 'P1', title: 'Breaks on empty input' })
    const [removed] = findingComments([finding({ side: 'old', line: 11 })], snapshot, newId)
    assert.deepEqual([removed.side, removed.line, removed.excerpt], ['old', 11, 'b'])
  })

  it('go to the nearest line the view shows when theirs is not in it, and say which line they were about', () => {
    const [near] = findingComments([finding({ line: 15 })], snapshot, newId)
    assert.deepEqual([near.side, near.line, near.excerpt], ['new', 12, 'c'])
    assert.equal(near.text, 'About line 15: B throws when the list is empty.')
    const [far] = findingComments([finding({ line: 38 })], snapshot, newId)
    assert.equal(far.line, 40)
  })

  it('stay as they are on a file the view does not show, or without a view', () => {
    const [other] = findingComments([finding({ path: 'src/b.ts', line: 3 })], snapshot, newId)
    assert.deepEqual([other.path, other.line, other.excerpt, other.text], ['src/b.ts', 3, '', 'B throws when the list is empty.'])
    const [unseen] = findingComments([finding({ line: 99 })], null, newId)
    assert.deepEqual([unseen.line, unseen.excerpt], [99, ''])
  })

  it('take the title as their text when the body is empty', () => {
    assert.equal(findingComments([finding({ body: '  ' })], snapshot, newId)[0].text, 'Breaks on empty input')
  })

  it('find the nearest line on the other side when theirs has none', () => {
    const onlyRemoved: ReviewFile = { ...file, hunks: [{ ...file.hunks[0], lines: [line('del', 11, undefined, 'b')] }] }
    assert.deepEqual(nearestAnchor(onlyRemoved, 'new', 30), { path: 'src/a.ts', side: 'old', line: 11 })
    assert.equal(nearestAnchor({ ...file, hunks: [] }, 'new', 3), null)
  })

  it('go to the agent marked as the Reviewer\'s, with their priority and title', () => {
    const [comment] = findingComments([finding()], snapshot, newId)
    const own = { id: 'own', path: 'src/a.ts', side: 'new' as const, line: 10, text: 'Rename a.', excerpt: 'a' }
    assert.equal(
      commentsMessage([comment, own], 'the staged changes'),
      'Review comments on the staged changes. Address each one:\n\n1. src/a.ts:10\n> a\nRename a.\n\n2. src/a.ts:11 (the Reviewer, P1: Breaks on empty input)\n> B\nB throws when the list is empty.',
    )
  })
})
