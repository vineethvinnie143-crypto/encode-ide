import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shortAge, isToday } from '../ui/time'
import { MAX_HISTORY, canGoBack, canGoForward, emptyHistory, forget, goBack, goForward, visit } from './history'

describe('back and forward', () => {
  it('walks back and forward over visits', () => {
    let history = emptyHistory<string>()
    assert.equal(canGoBack(history), false)
    for (const place of ['a', 'b', 'c']) history = visit(history, place)
    history = goBack(goBack(history))
    assert.equal(history.entries[history.index], 'a')
    assert.equal(canGoBack(history), false)
    history = goForward(history)
    assert.equal(history.entries[history.index], 'b')
    assert.equal(canGoForward(history), true)
  })

  it('drops what was ahead when you visit from the middle', () => {
    let history = emptyHistory<string>()
    for (const place of ['a', 'b', 'c']) history = visit(history, place)
    history = visit(goBack(goBack(history)), 'd')
    assert.deepEqual(history.entries, ['a', 'd'])
    assert.equal(canGoForward(history), false)
  })

  it('ignores a visit to where you already are, and stays bounded', () => {
    let history = visit(visit(emptyHistory<string>(), 'a'), 'a')
    assert.deepEqual(history.entries, ['a'])
    for (let n = 0; n < MAX_HISTORY + 10; n++) history = visit(history, `s${n}`)
    assert.equal(history.entries.length, MAX_HISTORY)
    assert.equal(history.index, MAX_HISTORY - 1)
  })

  it('forgets a deleted place and keeps your position', () => {
    let history = emptyHistory<string>()
    for (const place of ['a', 'b', 'c', 'd']) history = visit(history, place)
    history = goBack(history)
    history = forget(history, (place) => place === 'b')
    assert.deepEqual(history.entries, ['a', 'c', 'd'])
    assert.equal(history.entries[history.index], 'c')
    assert.equal(forget(history, () => true).index, -1)
  })
})

describe('short ages', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime()
  it('reads like a list row', () => {
    assert.equal(shortAge(now - 20_000, now), 'now')
    assert.equal(shortAge(now - 5 * 60_000, now), '5m')
    assert.equal(shortAge(now - 3 * 3_600_000, now), '3h')
    assert.equal(shortAge(new Date(2026, 9, 20, 9).getTime(), now), 'Tue')
    assert.equal(shortAge(new Date(2026, 8, 3).getTime(), now), 'Sep 3')
    assert.equal(shortAge(new Date(2025, 8, 3).getTime(), now), 'Sep 3, 2025')
    assert.equal(shortAge(now + 60_000, now), 'now', 'a clock ahead reads as now')
  })

  it('knows what today is', () => {
    assert.equal(isToday(new Date(2026, 9, 22, 0, 5).getTime(), now), true)
    assert.equal(isToday(new Date(2026, 9, 21, 23, 55).getTime(), now), false)
  })
})
