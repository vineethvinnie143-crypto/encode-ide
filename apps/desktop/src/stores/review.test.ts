import '../testing/bridge'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answer } from '../testing/bridge'
import { usePanels } from './panels'
import { useReview } from './review'

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
