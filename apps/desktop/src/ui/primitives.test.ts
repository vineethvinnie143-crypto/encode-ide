import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { phaseFor } from './Collapse'
import { cx } from './cx'
import { weight } from './icon-weight'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'
import { place } from './place'
import { shortcutKeys, shortcutLabel, tooltipDelay } from './shortcut'

describe('keyboard movement', () => {
  const disabled = new Set([1, 3])
  const isDisabled = (index: number) => disabled.has(index)

  it('maps keys by orientation', () => {
    assert.equal(keyToMove('ArrowDown', 'vertical'), 'next')
    assert.equal(keyToMove('ArrowUp', 'vertical'), 'prev')
    assert.equal(keyToMove('ArrowRight', 'vertical'), null)
    assert.equal(keyToMove('ArrowRight', 'horizontal'), 'next')
    assert.equal(keyToMove('ArrowLeft', 'horizontal'), 'prev')
    assert.equal(keyToMove('Home', 'horizontal'), 'first')
    assert.equal(keyToMove('End', 'vertical'), 'last')
    assert.equal(keyToMove('Enter', 'vertical'), null)
  })

  it('skips disabled items and wraps at both ends', () => {
    assert.equal(moveIndex(0, 'next', 5, isDisabled), 2)
    assert.equal(moveIndex(2, 'prev', 5, isDisabled), 0)
    assert.equal(moveIndex(4, 'next', 5, isDisabled), 0)
    assert.equal(moveIndex(0, 'prev', 5, isDisabled), 4)
    assert.equal(moveIndex(2, 'first', 5, () => false), 0)
    assert.equal(moveIndex(2, 'last', 4, isDisabled), 2)
  })

  it('starts from the right end when nothing is active', () => {
    assert.equal(moveIndex(-1, 'next', 5), 0)
    assert.equal(moveIndex(-1, 'prev', 5), 4)
    assert.equal(moveIndex(9, 'prev', 5), 4)
  })

  it('returns -1 when nothing can take focus', () => {
    assert.equal(moveIndex(0, 'next', 0), -1)
    assert.equal(moveIndex(0, 'next', 3, () => true), -1)
  })

  it('finds the next label that starts with what was typed', () => {
    const labels = ['Copy', 'Cut', 'Paste', 'Close', 'cancel']
    assert.equal(typeaheadIndex(labels, 'c', 0), 1)
    assert.equal(typeaheadIndex(labels, 'c', 1), 3)
    assert.equal(typeaheadIndex(labels, 'C', 3), 4)
    assert.equal(typeaheadIndex(labels, 'cl', 4), 3)
    assert.equal(typeaheadIndex(labels, 'c', 0, (index) => index === 1), 3)
    assert.equal(typeaheadIndex(labels, 'zz', 0), -1)
    assert.equal(typeaheadIndex(labels, ' ', 0), -1)
  })
})

describe('floating placement', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 200, height: 100 }

  it('sits under the anchor, aligned as asked', () => {
    const anchor = { left: 100, top: 100, width: 40, height: 20 }
    assert.deepEqual(place(anchor, size, viewport, { align: 'start', gap: 4 }), { left: 100, top: 124, side: 'bottom' })
    assert.deepEqual(place(anchor, size, viewport, { align: 'end', gap: 4 }), { left: 8, top: 124, side: 'bottom' })
    assert.equal(place(anchor, size, viewport, { align: 'center', gap: 4 }).left, 20)
  })

  it('flips to the other side when its own side is too short', () => {
    const nearBottom = { left: 400, top: 740, width: 40, height: 20 }
    assert.deepEqual(place(nearBottom, size, viewport, { gap: 6 }), { left: 320, top: 634, side: 'top' })
    const nearTop = { left: 400, top: 10, width: 40, height: 20 }
    assert.equal(place(nearTop, size, viewport, { side: 'top' }).side, 'bottom')
    const nearRight = { left: 900, top: 300, width: 40, height: 20 }
    assert.equal(place(nearRight, size, viewport, { side: 'right' }).side, 'left')
  })

  it('stays inside the window', () => {
    const corner = { left: 990, top: 790, width: 10, height: 10 }
    const spot = place(corner, size, viewport, {})
    assert.ok(spot.left >= 8 && spot.left + size.width <= viewport.width - 8)
    assert.ok(spot.top >= 8 && spot.top + size.height <= viewport.height - 8)
    const huge = place(corner, { width: 2000, height: 2000 }, viewport, {})
    assert.deepEqual([huge.left, huge.top], [8, 8])
  })
})

describe('shortcuts', () => {
  it('splits a chord into keys', () => {
    assert.deepEqual(shortcutKeys('Ctrl+Shift+P'), ['Ctrl', 'Shift', 'P'])
    assert.deepEqual(shortcutKeys('Ctrl++'), ['Ctrl', '+'])
    assert.deepEqual(shortcutKeys('Ctrl+Plus'), ['Ctrl', '+'])
    assert.deepEqual(shortcutKeys('Ctrl+='), ['Ctrl', '='])
    assert.deepEqual(shortcutKeys('Ctrl+Shift+]'), ['Ctrl', 'Shift', ']'])
    assert.deepEqual(shortcutKeys(' Esc '), ['Esc'])
    assert.deepEqual(shortcutKeys('+'), ['+'])
    assert.deepEqual(shortcutKeys(''), [])
    assert.equal(shortcutLabel('Ctrl+`'), 'Ctrl `')
  })

  it('opens tooltips at once while another has just closed', () => {
    assert.equal(tooltipDelay(10_000, 0), 400)
    assert.equal(tooltipDelay(10_000, 9_900), 0)
    assert.equal(tooltipDelay(10_000, 9_600), 400)
  })
})

describe('cx', () => {
  it('joins only real class names', () => {
    assert.equal(cx('btn', false, 'primary', null, undefined, '', 'sm'), 'btn primary sm')
    assert.equal(cx(), '')
  })
})

describe('icon weight', () => {
  const onScreen = (px: number) => (weight(px) * px) / 24

  it('draws the same line at every size from 16 px up, a little finer below', () => {
    for (const px of [16, 18, 20, 24]) assert.ok(Math.abs(onScreen(px) - 1.5) < 0.01, `${px} px`)
    assert.ok(Math.abs(onScreen(14) - 1.4) < 0.01)
    assert.ok(Math.abs(onScreen(12) - 1.3) < 0.01)
    assert.ok(onScreen(12) < onScreen(16))
  })

  it('takes a size written as a string and falls back to the old weight for nonsense', () => {
    assert.equal(weight('18'), weight(18))
    assert.equal(weight('big'), 1.75)
    assert.equal(weight(0), 1.75)
    assert.equal(weight(-4), 1.75)
  })
})

describe('collapse phases', () => {
  it('opens from closed through a start frame, and closes from wherever it is', () => {
    assert.equal(phaseFor('closed', true), 'start')
    assert.equal(phaseFor('open', false), 'closing')
    assert.equal(phaseFor('opening', false), 'closing')
    assert.equal(phaseFor('start', false), 'closing')
  })

  it('turns round in the middle of a move, and ignores what changes nothing', () => {
    assert.equal(phaseFor('closing', true), 'opening')
    assert.equal(phaseFor('open', true), 'open')
    assert.equal(phaseFor('opening', true), 'opening')
    assert.equal(phaseFor('start', true), 'start')
    assert.equal(phaseFor('closed', false), 'closed')
    assert.equal(phaseFor('closing', false), 'closing')
  })
})
