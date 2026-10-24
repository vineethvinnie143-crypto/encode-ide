import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FOLLOW_WITHIN, followsAfterScroll } from './follow'

describe('the thread following new text', () => {
  it('keeps following when text lands below before the browser reports the scroll to the end', () => {
    // Scrolled to 1000, the end; 400 px of a diff came before the scroll event, so the end is now 1400.
    assert.equal(followsAfterScroll(true, 1000, 1000, 1400), true)
    assert.equal(followsAfterScroll(true, 1000, 1000, 1000 + FOLLOW_WITHIN * 10), true)
  })

  it('stops when you scroll up, even a little', () => {
    assert.equal(followsAfterScroll(true, 1000, 960, 1000), false)
    assert.equal(followsAfterScroll(true, 1000, 400, 1000), false)
  })

  it('keeps following when the browser moves the list up to keep the end in view', () => {
    // A log folded or a card opened under the thread: the end came up from 1000 to 700, and the list with it.
    assert.equal(followsAfterScroll(true, 1000, 700, 700), true)
    assert.equal(followsAfterScroll(true, 1000, 699.5, 700), true)
  })

  it('starts again when you scroll back near the end, and not before', () => {
    assert.equal(followsAfterScroll(false, 400, 900, 1000), false)
    assert.equal(followsAfterScroll(false, 900, 1000 - FOLLOW_WITHIN + 1, 1000), true)
    assert.equal(followsAfterScroll(false, 900, 1000, 1000), true)
  })

  it('stays as it was for a move down short of the end', () => {
    assert.equal(followsAfterScroll(false, 100, 500, 1000), false)
    assert.equal(followsAfterScroll(true, 100, 500, 1000), true)
  })
})
