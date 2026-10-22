import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEntry } from '@shared/types'
import { appendTexts, createDeltaBuffer, type Batch, type Scheduler } from './deltas'

/** A scheduler the test runs by hand, like a frame that has not come yet. */
function manualFrames() {
  const queue: Array<() => void> = []
  let cancelled = 0
  const schedule: Scheduler = (run) => {
    queue.push(run)
    return () => {
      cancelled++
      const at = queue.indexOf(run)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  return {
    schedule,
    pending: () => queue.length,
    cancelled: () => cancelled,
    frame: () => queue.splice(0).forEach((run) => run()),
  }
}

const entry = (id: string, text = ''): ConversationEntry => ({ id, kind: 'assistant', text, createdAt: 1 })

describe('delta buffer', () => {
  it('holds the pieces until the frame and hands them over once, in order', () => {
    const frames = manualFrames()
    const batches: Batch[] = []
    const buffer = createDeltaBuffer((batch) => batches.push(batch), frames.schedule, () => 1000)
    buffer.push('a', 'Hel')
    buffer.push('a', 'lo, ')
    buffer.push('b', 'x')
    buffer.push('a', 'world')
    assert.equal(batches.length, 0)
    assert.equal(frames.pending(), 1, 'one frame is asked for however many pieces come')
    frames.frame()
    assert.equal(batches.length, 1)
    assert.deepEqual([...batches[0].texts], [['a', 'Hello, world'], ['b', 'x']])
    assert.equal(batches[0].chars, 'Hello, world'.length + 1)
    assert.equal(batches[0].firstAt, 1000)
  })

  it('asks for a new frame for the pieces after a batch', () => {
    const frames = manualFrames()
    const batches: Batch[] = []
    const buffer = createDeltaBuffer((batch) => batches.push(batch), frames.schedule)
    buffer.push('a', '1')
    frames.frame()
    buffer.push('a', '2')
    assert.equal(frames.pending(), 1)
    frames.frame()
    assert.deepEqual(batches.map((batch) => [...batch.texts]), [[['a', '1']], [['a', '2']]])
  })

  it('flushes at once, and its frame then has nothing to do', () => {
    const frames = manualFrames()
    const batches: Batch[] = []
    const buffer = createDeltaBuffer((batch) => batches.push(batch), frames.schedule)
    buffer.push('a', 'text')
    buffer.flush()
    assert.equal(batches.length, 1)
    assert.equal(frames.pending(), 0, 'the frame that was waiting is cancelled')
    assert.equal(frames.cancelled(), 1)
    buffer.flush()
    assert.equal(batches.length, 1, 'flushing an empty buffer hands over nothing')
  })

  it('forgets what it holds when discarded', () => {
    const frames = manualFrames()
    const batches: Batch[] = []
    const buffer = createDeltaBuffer((batch) => batches.push(batch), frames.schedule)
    buffer.push('a', 'text')
    buffer.discard()
    frames.frame()
    buffer.flush()
    assert.equal(batches.length, 0)
    buffer.push('a', 'more')
    buffer.flush()
    assert.deepEqual([...batches[0].texts], [['a', 'more']])
  })
})

describe('appending streamed text', () => {
  it('adds text to its entry and leaves the others as they were', () => {
    const entries = [entry('u'), entry('a', 'One '), entry('b', 'Two')]
    const next = appendTexts(entries, new Map([['b', ' and more']]))
    assert.equal(next[2].text, 'Two and more')
    assert.equal(next[0], entries[0])
    assert.equal(next[1], entries[1])
    assert.equal(entries[2].text, 'Two', 'the old list is not changed')
  })

  it('hands back the same list when no entry is touched, and skips entries that are gone', () => {
    const entries = [entry('a', 'x')]
    assert.equal(appendTexts(entries, new Map()), entries)
    assert.equal(appendTexts(entries, new Map([['missing', 'y']])), entries)
  })

  it('starts the text of an entry that had none', () => {
    const empty: ConversationEntry = { id: 'a', kind: 'assistant', createdAt: 1, streaming: true }
    assert.equal(appendTexts([empty], new Map([['a', 'Hi']]))[0].text, 'Hi')
  })

  it('adds to several entries in one pass', () => {
    const next = appendTexts([entry('a', '1'), entry('b', '2')], new Map([['a', 'x'], ['b', 'y']]))
    assert.deepEqual(next.map((item) => item.text), ['1x', '2y'])
  })
})
