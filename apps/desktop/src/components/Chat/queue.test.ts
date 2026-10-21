import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dequeue, enqueue, mergeDraft, moveQueued, removeQueued, takeQueued, type Queued } from './queue'

const ids = (queue: readonly Queued[]) => queue.map((item) => item.id)

describe('message queue', () => {
  it('queues trimmed messages in order and ignores blank ones', () => {
    let queue: Queued[] = []
    queue = enqueue(queue, '  first  ', 'a')
    queue = enqueue(queue, '   ', 'b')
    queue = enqueue(queue, 'second', 'c')
    assert.deepEqual(queue, [
      { id: 'a', text: 'first' },
      { id: 'c', text: 'second' },
    ])
  })

  it('hands out the oldest message and keeps the rest', () => {
    const queue = enqueue(enqueue([], 'one', 'a'), 'two', 'b')
    const { next, rest } = dequeue(queue)
    assert.equal(next?.text, 'one')
    assert.deepEqual(ids(rest), ['b'])
    assert.deepEqual(dequeue([]), { next: undefined, rest: [] })
  })

  it('removes and takes a message by id', () => {
    const queue = enqueue(enqueue(enqueue([], 'one', 'a'), 'two', 'b'), 'three', 'c')
    assert.deepEqual(ids(removeQueued(queue, 'b')), ['a', 'c'])
    const { taken, rest } = takeQueued(queue, 'b')
    assert.equal(taken?.text, 'two')
    assert.deepEqual(ids(rest), ['a', 'c'])
    assert.equal(takeQueued(queue, 'zzz').taken, undefined)
  })

  it('puts a message back after what is already typed', () => {
    assert.equal(mergeDraft('', 'queued'), 'queued')
    assert.equal(mergeDraft('   ', 'queued'), 'queued')
    assert.equal(mergeDraft('typing so far  ', 'queued'), 'typing so far\nqueued')
  })

  it('moves a message earlier or later, and stops at the ends', () => {
    const queue = enqueue(enqueue(enqueue([], 'one', 'a'), 'two', 'b'), 'three', 'c')
    assert.deepEqual(ids(moveQueued(queue, 'c', -1)), ['a', 'c', 'b'])
    assert.deepEqual(ids(moveQueued(queue, 'a', 1)), ['b', 'a', 'c'])
    assert.deepEqual(ids(moveQueued(queue, 'a', -1)), ['a', 'b', 'c'])
    assert.deepEqual(ids(moveQueued(queue, 'c', 1)), ['a', 'b', 'c'])
    assert.deepEqual(ids(moveQueued(queue, 'x', 1)), ['a', 'b', 'c'])
  })
})
