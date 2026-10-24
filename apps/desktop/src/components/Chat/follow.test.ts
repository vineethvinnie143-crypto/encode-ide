import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FOLLOW_WITHIN, followsAfterScroll } from './follow'

describe('the thread following new text', () => {
  it('keeps following when text lands below before the browser reports the scroll to the end', () => {
    // Scrolled to 1000, the end; 400 px of a diff came before the scroll event, so the end is now 1400.
    assert.equal(followsAfterScroll(true, 1000, 1000, 1400, false), true)
    assert.equal(followsAfterScroll(true, 1000, 1000, 1000 + FOLLOW_WITHIN * 10, false), true)
  })

  it('stops when you scroll up, even a little', () => {
    assert.equal(followsAfterScroll(true, 1000, 960, 1000, true), false)
    assert.equal(followsAfterScroll(true, 1000, 400, 1000, true), false)
  })

  it('keeps following when the page moves the list up on its own', () => {
    // Something above what is in view got shorter and the browser kept the view in place, 337 px up from the end.
    assert.equal(followsAfterScroll(true, 1000, 663, 1000, false), true)
    // The window got wider, the text wrapped less, and the list came up while the end went further.
    assert.equal(followsAfterScroll(true, 1000, 700, 1400, false), true)
  })

  it('keeps following when the browser moves the list up to keep the end in view, yours or not', () => {
    // A log folded or a card opened under the thread: the end came up from 1000 to 700, and the list with it.
    assert.equal(followsAfterScroll(true, 1000, 700, 700, false), true)
    assert.equal(followsAfterScroll(true, 1000, 699.5, 700, true), true)
  })

  it('starts again when you scroll back near the end, and not before', () => {
    assert.equal(followsAfterScroll(false, 400, 900, 1000, true), false)
    assert.equal(followsAfterScroll(false, 900, 1000 - FOLLOW_WITHIN + 1, 1000, true), true)
    assert.equal(followsAfterScroll(false, 900, 1000, 1000, true), true)
  })

  it('stays where you left it when the page moves the list near the end on its own', () => {
    // You read back; a log above opened and the browser kept your place, which came to 40 px from the end.
    assert.equal(followsAfterScroll(false, 800, 960, 1000, false), false)
    // At the very end it follows again, whoever moved it there.
    assert.equal(followsAfterScroll(false, 800, 1000, 1000, false), true)
  })

  it('stays as it was for a move down short of the end', () => {
    assert.equal(followsAfterScroll(false, 100, 500, 1000, true), false)
    assert.equal(followsAfterScroll(true, 100, 500, 1000, true), true)
  })
})
