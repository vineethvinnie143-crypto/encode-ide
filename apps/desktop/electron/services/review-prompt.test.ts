import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ReviewFile, ReviewLine, ReviewSnapshot } from '../../shared/types'
import { codeReviewInput, numberedHunks, reviewerScope } from './review-prompt'

const lines = (...spec: Array<[ReviewLine['kind'], number | undefined, number | undefined, string]>): ReviewLine[] =>
  spec.map(([kind, old, now, text]) => ({ kind, text, ...(old !== undefined ? { old } : {}), ...(now !== undefined ? { new: now } : {}) }))

function file(path: string, patch: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    change: 'modified',
    kind: 'text',
    added: 1,
    removed: 1,
    hunks: [
      {
        id: '0123456789abcdef',
        oldStart: 4,
        oldLines: 3,
        newStart: 4,
        newLines: 3,
        added: 1,
        removed: 1,
        lines: lines(['ctx', 4, 4, 'const a = 1'], ['del', 5, undefined, 'const b = a / n'], ['add', undefined, 5, 'const b = n ? a / n : 0'], ['ctx', 6, 6, 'export { b }']),
      },
    ],
    hunkActions: true,
    fingerprint: '0'.repeat(40),
    ...patch,
  }
}

function snapshot(files: ReviewFile[], patch: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    scope: { kind: 'staged' },
    repo: { root: '/repo', folder: '', branch: 'main', head: 'abc' },
    files,
    added: 0,
    removed: 0,
    counts: { unstaged: 0, staged: files.length },
    skipped: 0,
    readOnly: false,
    options: { context: 10, ignoreWhitespace: false },
    ...patch,
  }
}

describe('what the Reviewer is sent', () => {
  it('numbers each line as in its file: a removed line by its old number, the others by the new', () => {
    assert.equal(numberedHunks(file('src/a.ts')), '@@ -4,3 +4,3 @@\n 4 | const a = 1\n-5 | const b = a / n\n+5 | const b = n ? a / n : 0\n 6 | export { b }')
    const long = file('src/b.ts', { hunks: [{ ...file('x').hunks[0], lines: lines(['add', undefined, 1, 'x'.repeat(1_000)]) }] })
    assert.equal(numberedHunks(long), `@@ -4,3 +4,3 @@\n+1 | ${'x'.repeat(400)}…`)
  })

  it('sends the lines of each file that fits, names the rest by why, and counts what it left out', () => {
    const input = codeReviewInput(
      snapshot([
        file('src/a.ts'),
        file('pnpm-lock.yaml'),
        file('dist/app.min.js'),
        file('logo.png', { kind: 'binary', hunks: [] }),
        file('vendor/lib', { kind: 'submodule', hunks: [] }),
        file('src/moved.ts', { change: 'renamed', oldPath: 'src/old.ts' }),
        file('src/empty.ts', { change: 'added', hunks: [], note: 'An empty file.' }),
      ]),
    )
    assert.equal(input.read, 2)
    assert.equal(input.request.left, 0)
    assert.deepEqual(
      input.request.files.map((entry) => [entry.path, entry.text.startsWith('@@') ? 'lines' : entry.text]),
      [
        ['src/a.ts', 'lines'],
        ['pnpm-lock.yaml', '(generated or lock file: not reviewed)'],
        ['dist/app.min.js', '(generated or lock file: not reviewed)'],
        ['logo.png', '(binary file: not shown)'],
        ['vendor/lib', '(submodule: the commit it points at changed)'],
        ['src/moved.ts', 'lines'],
        ['src/empty.ts', '(An empty file.)'],
      ],
    )
    assert.equal(input.request.files[5].oldPath, 'src/old.ts')
    assert.equal(input.request.files[0].oldPath, undefined)
  })

  it('stops sending lines at the budget, and counts the files past it with those the review skipped', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => file(path))
    const one = numberedHunks(files[0]).length
    const input = codeReviewInput(snapshot(files, { skipped: 2 }), one * 2)
    assert.equal(input.read, 2)
    assert.equal(input.request.left, 3)
    assert.deepEqual(
      input.request.files.map((entry) => entry.path),
      ['src/a.ts', 'src/b.ts'],
    )
    assert.equal(codeReviewInput(snapshot(files), one - 1).read, 0, 'nothing to read when the first file is too large')
  })

  it('names the change in words', () => {
    assert.equal(reviewerScope(snapshot([])), 'the staged changes, which the next commit takes')
    assert.equal(reviewerScope(snapshot([], { scope: { kind: 'unstaged' } })), 'the unstaged changes in the working tree')
    assert.equal(reviewerScope(snapshot([], { scope: { kind: 'branch' }, base: { ref: 'origin/main', oid: null } })), 'the changes on branch main against origin/main')
    assert.equal(reviewerScope(snapshot([], { scope: { kind: 'commit', commit: 'abcdef123' } })), 'commit abcdef1')
    assert.equal(
      reviewerScope(snapshot([], { scope: { kind: 'commit', commit: 'abcdef123' }, commit: { oid: 'abcdef123', short: 'abcdef1', subject: 'Fix the mean', author: 'A', time: 0 } })),
      'commit abcdef1 ("Fix the mean")',
    )
    assert.equal(reviewerScope(snapshot([], { scope: { kind: 'turn', session: 's' } })), 'what a coding agent changed for one request')
  })
})
