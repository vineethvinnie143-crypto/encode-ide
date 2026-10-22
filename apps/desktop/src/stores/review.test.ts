import '../testing/bridge'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { ReviewAskOutcome, ReviewFinding, ReviewLoad } from '@shared/types'
import { answer, calls } from '../testing/bridge'
import { usePanels } from './panels'
import { useReview } from './review'
import { useUi } from './ui'
import { useWorkspace } from './workspace'

answer('review.load', async () => ({ ok: false, message: 'not a repository' }))

const review = () => useReview.getState()
const saved = () => JSON.parse(localStorage.getItem('eNCode.review.v1') ?? '{}') as { kind?: string }
const reviewTabs = () => usePanels.getState().side.tabs.filter((tab) => tab.kind === 'review')
const closeReview = () => {
  for (const tab of reviewTabs()) usePanels.getState().close(tab.id)
}

describe('the scope the Review tab opens on', () => {
  it('goes back to the scope the person chose once the tab a change card opened is closed', () => {
    assert.equal(review().kind, 'unstaged')
    review().showTurn('turn-1', 'src/a.ts')
    assert.equal(review().kind, 'turn')
    assert.equal(review().turn, 'turn-1')
    assert.equal(reviewTabs().length, 1)
    assert.notEqual(saved().kind, 'turn')

    closeReview()
    assert.equal(review().kind, 'unstaged')
    assert.equal(review().turn, null)
    assert.equal(saved().kind ?? 'unstaged', 'unstaged')
  })

  it('keeps what a card showed while the tab stays open, behind other tabs too', () => {
    review().showTurn('turn-2')
    usePanels.getState().open('new')
    assert.equal(reviewTabs().length, 1)
    assert.equal(review().kind, 'turn')
    assert.equal(review().turn, 'turn-2')
    closeReview()
    assert.equal(review().kind, 'unstaged')
  })

  it('keeps the scope picked from the menu, which a file shown from a step does not change', () => {
    review().setKind('staged')
    assert.equal(saved().kind, 'staged')
    review().showFile('src/a.ts', 'folder')
    assert.equal(review().kind, 'unstaged')
    assert.equal(saved().kind, 'staged')
    closeReview()
    assert.equal(review().kind, 'staged')
    review().setKind('unstaged')
  })

  it('makes Last turn the chosen scope when it is picked from the menu over a request a card showed', () => {
    review().showTurn('turn-3')
    review().setKind('turn')
    assert.equal(review().turn, null)
    assert.equal(saved().kind, 'turn')
    closeReview()
    assert.equal(review().kind, 'turn')
    assert.equal(review().turn, null)
    review().setKind('unstaged')
    assert.equal(saved().kind, 'unstaged')
  })
})

describe('asking the Reviewer', () => {
  const notes: string[] = []
  const shown: ReviewLoad = {
    ok: true,
    undo: null,
    snapshot: {
      scope: { kind: 'unstaged' },
      repo: { root: '/w', folder: '', branch: 'main', head: 'abc' },
      files: [
        {
          path: 'src/a.ts',
          change: 'modified',
          kind: 'text',
          added: 1,
          removed: 0,
          hunks: [{ id: '1', oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, added: 1, removed: 0, lines: [{ kind: 'ctx', text: 'a', old: 10, new: 10 }, { kind: 'add', text: 'B', new: 11 }] }],
          hunkActions: true,
          fingerprint: '0'.repeat(40),
        },
      ],
      added: 1,
      removed: 0,
      counts: { unstaged: 1, staged: 0 },
      skipped: 0,
      readOnly: false,
      options: { context: 3, ignoreWhitespace: false },
    },
  }
  const finding = (patch: Partial<ReviewFinding> = {}): ReviewFinding => ({ path: 'src/a.ts', side: 'new', line: 11, priority: 'P1', title: 'Breaks on empty input', body: 'B throws on an empty list.', ...patch })
  const found = (findings: ReviewFinding[], summary = 'One bug.'): ReviewAskOutcome => ({ ok: true, summary, findings, files: 1, left: 0 })
  const asked = () => calls.filter((call) => call.path === 'review.ask')

  beforeEach(async () => {
    notes.length = 0
    useUi.setState({ notify: (_kind, text) => void notes.push(text) })
    useWorkspace.setState({ workspace: { root: '/w', name: 'w' } })
    answer('review.load', async () => shown)
    answer('review.ask', async () => found([finding()]))
    review().setKind('unstaged')
    await review().refresh()
  })

  it('says to open a folder first', async () => {
    useWorkspace.setState({ workspace: null })
    const before = asked().length
    await review().askReviewer()
    assert.deepEqual(notes, ['Open a folder to review its changes.'])
    assert.equal(asked().length, before)
  })

  it('leaves its findings as comments on the view it read, beside the person\'s own, and replaces its earlier ones', async () => {
    review().startComment({ path: 'src/a.ts', side: 'new', line: 10 })
    review().saveComment('Rename a.', 'a')
    await review().askReviewer()
    assert.deepEqual(asked().at(-1)?.args, [{ kind: 'unstaged' }, { context: 3, ignoreWhitespace: false }])
    const comments = () => review().comments.unstaged ?? []
    assert.deepEqual(
      comments().map((comment) => [comment.by ?? 'person', comment.line, comment.text, comment.excerpt]),
      [
        ['person', 10, 'Rename a.', 'a'],
        ['reviewer', 11, 'B throws on an empty list.', 'B'],
      ],
    )
    assert.deepEqual(review().verdicts.unstaged, { summary: 'One bug.', findings: 1, files: 1, left: 0 })
    assert.equal(review().asking, null)

    answer('review.ask', async () => found([finding({ title: 'Leaks a handle', body: 'Close it.', priority: 'P2' })], 'Another look.'))
    await review().askReviewer()
    assert.deepEqual(
      comments().map((comment) => [comment.by ?? 'person', comment.title ?? '', comment.priority ?? '']),
      [
        ['person', '', ''],
        ['reviewer', 'Leaks a handle', 'P2'],
      ],
    )
    review().dismissVerdict()
    assert.equal(review().verdicts.unstaged, undefined)
    assert.equal(comments().length, 2, 'closing the verdict keeps the comments')
  })

  it('says what went wrong, and leaves the comments as they were', async () => {
    answer('review.ask', async () => ({ ok: false, message: 'Choose a model in Settings first.' }))
    const before = review().comments.unstaged ?? []
    await review().askReviewer()
    assert.deepEqual(notes, ['Choose a model in Settings first.'])
    assert.deepEqual(review().comments.unstaged ?? [], before)
    assert.equal(review().asking, null)
  })

  it('asks once at a time', async () => {
    let finish: (outcome: ReviewAskOutcome) => void = () => undefined
    answer('review.ask', () => new Promise<ReviewAskOutcome>((resolve) => (finish = resolve)))
    const first = review().askReviewer()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(review().asking, 'unstaged')
    await review().askReviewer()
    assert.deepEqual(notes, ['The Reviewer is still reading the last change it was asked about.'])
    finish(found([]))
    await first
    assert.equal(review().asking, null)
    assert.deepEqual(review().verdicts.unstaged, { summary: 'One bug.', findings: 0, files: 1, left: 0 })
  })

  it('drops an answer that comes after another folder was opened', async () => {
    let finish: (outcome: ReviewAskOutcome) => void = () => undefined
    answer('review.ask', () => new Promise<ReviewAskOutcome>((resolve) => (finish = resolve)))
    const asking = review().askReviewer()
    await new Promise((resolve) => setImmediate(resolve))
    useWorkspace.setState({ workspace: { root: '/other', name: 'other' } })
    finish(found([finding()]))
    await asking
    assert.deepEqual(review().comments, {})
    assert.deepEqual(review().verdicts, {})
    assert.equal(review().asking, null)
  })

  it('reads the view it is told, and opens the tab on it', async () => {
    await review().askReviewer('staged')
    assert.equal(review().kind, 'staged')
    assert.equal(usePanels.getState().side.tabs.filter((tab) => tab.kind === 'review').length, 1)
    assert.deepEqual(asked().at(-1)?.args[0], { kind: 'staged' })
    for (const tab of usePanels.getState().side.tabs.filter((item) => item.kind === 'review')) usePanels.getState().close(tab.id)
    review().setKind('unstaged')
  })
})
