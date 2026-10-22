import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { SETTLE_MS, useFind } from './find'

const find = () => useFind.getState()

describe('the find bar', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
    find().close()
    find().setQuery('')
  })
  afterEach(() => mock.timers.reset())

  it('searches once typing settles, and at once for an empty field', () => {
    find().show()
    find().setQuery('Ca')
    find().setQuery('Cache  key')
    assert.equal(find().query, 'Cache  key')
    assert.equal(find().needle, '', 'not while typing')
    mock.timers.tick(SETTLE_MS)
    assert.equal(find().needle, 'cache key')
    find().setCount(0, 3, false)
    find().setQuery('  ')
    assert.deepEqual([find().needle, find().index, find().total], ['', -1, 0])
  })

  it('keeps the words when it closes, searches nothing while closed, and searches them again when it opens', () => {
    find().show()
    find().setQuery('error')
    mock.timers.tick(SETTLE_MS)
    find().close()
    assert.deepEqual([find().open, find().needle, find().query], [false, '', 'error'])
    find().show()
    assert.deepEqual([find().open, find().needle], [true, 'error'])
  })

  it('drops a search still settling when the bar closes', () => {
    find().show()
    find().setQuery('late')
    find().close()
    mock.timers.tick(SETTLE_MS)
    assert.equal(find().needle, '')
  })

  it('opens on words selected in the thread, and asks for the focus at every Ctrl+F', () => {
    const focus = find().focusId
    find().show('Selected words')
    assert.deepEqual([find().query, find().needle], ['Selected words', 'selected words'])
    find().show()
    assert.equal(find().query, 'Selected words', 'no selection keeps what is typed')
    assert.equal(find().focusId, focus + 2)
  })

  it('counts a new search only when the bar opens anew, so a fold closed by hand stays closed for that search only', () => {
    find().show()
    const first = find().openId
    find().show()
    assert.equal(find().openId, first, 'Ctrl+F on an open bar is the same search')
    find().close()
    find().show()
    assert.equal(find().openId, first + 1)
  })

  it('moves between matches, but searches at once instead when typing has not settled, so Enter does not skip the first', () => {
    find().show()
    find().setQuery('step')
    find().move(1)
    assert.equal(find().needle, 'step')
    assert.equal(find().step, null, 'the search lands on the first match')
    find().move(1)
    find().move(-1)
    assert.deepEqual(find().step, { direction: -1, id: 2 })
    find().setQuery('Step')
    find().move(1)
    assert.deepEqual(find().step, { direction: 1, id: 3 }, 'the same search folded: nothing to wait for')
  })

  it('tells the count only when it changed', () => {
    let heard = 0
    const stop = useFind.subscribe(() => void heard++)
    find().setCount(1, 4, false)
    find().setCount(1, 4, false)
    find().setCount(2, 4, false)
    stop()
    assert.equal(heard, 2)
  })
})
