import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EditorSelection } from '@encode/editor'
import { applyExternal, closeDoc, closeDocsUnder, markSaved, openDoc, recordState, renameDocs, snapshotForSave } from './docs'
import { MAX_DOCUMENT_CHARS, startLanguageSync } from './language'

/** The servers as the editor's side sees them, and a clock moved by hand. */
function setup() {
  const sent: string[] = []
  const timers: { run: () => void; ms: number }[] = []
  const stop = startLanguageSync(
    {
      open: (path, text, dirty) => sent.push(`open ${path} ${JSON.stringify(text)}${dirty ? '*' : ''}`),
      change: (path, text, dirty) => sent.push(`change ${path} ${JSON.stringify(text)}${dirty ? '*' : ''}`),
      close: (path) => sent.push(`close ${path}`),
    },
    {
      setTimer: (run, ms) => {
        const timer = { run, ms }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as (typeof timers)[number])
        if (index >= 0) timers.splice(index, 1)
      },
    },
  )
  const tick = () => {
    for (const timer of timers.splice(0)) timer.run()
  }
  return { sent, timers, stop, tick }
}

let current: ReturnType<typeof setup>
beforeEach(() => {
  current = setup()
})
afterEach(() => {
  current.stop()
  closeDocsUnder('src')
  closeDocsUnder('lib')
})

const type = (path: string, text: string) => {
  const state = openDoc(path, '')
  return recordState(path, state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state)
}

describe('the language servers follow the editor', () => {
  it('get a file when it opens, typing after a pause, and nothing for a move of the cursor', () => {
    const { sent, timers, tick } = current
    const state = openDoc('src/a.ts', 'let a = 1\r\n')
    assert.deepEqual(sent.splice(0), ['open src/a.ts "let a = 1\\r\\n"'], 'with the line endings it has on disk')
    const typed = state.update({ changes: { from: 8, to: 9, insert: '2' } }).state
    recordState('src/a.ts', typed)
    const third = typed.update({ changes: { from: 8, to: 9, insert: '3' } }).state
    recordState('src/a.ts', third)
    assert.equal(sent.length, 0)
    assert.equal(timers.length, 1, 'one change waits, the newest')
    tick()
    assert.deepEqual(sent.splice(0), ['change src/a.ts "let a = 3\\r\\n"*'])
    recordState('src/a.ts', third.update({ selection: EditorSelection.cursor(2) }).state)
    assert.equal(timers.length, 0)
  })

  it('get a save and a reload from the disk at once, as saved', () => {
    const { sent, timers } = current
    type('src/b.ts', 'x')
    const snapshot = snapshotForSave('src/b.ts')!
    markSaved('src/b.ts', snapshot)
    assert.equal(timers.length, 0, 'the save took the place of the typing')
    assert.deepEqual(sent.splice(0), ['open src/b.ts ""', 'change src/b.ts "x"'])
    applyExternal('src/b.ts', 'y')
    assert.deepEqual(sent.splice(0), ['change src/b.ts "y"'])
  })

  it('let go of a file that closes or moves, and follow it to its new name', () => {
    const { sent } = current
    openDoc('src/c.ts', 'c')
    openDoc('src/d.ts', 'd')
    sent.splice(0)
    renameDocs('src', 'lib')
    assert.deepEqual(sent.splice(0), ['close src/c.ts', 'open lib/c.ts "c"', 'close src/d.ts', 'open lib/d.ts "d"'])
    closeDoc('lib/c.ts')
    closeDocsUnder('lib')
    assert.deepEqual(sent.splice(0), ['close lib/c.ts', 'close lib/d.ts'])
  })

  it('never get a document too large for a server, and let go of one that grew too large', () => {
    const { sent, tick } = current
    const big = 'x'.repeat(MAX_DOCUMENT_CHARS + 1)
    openDoc('src/big.ts', big)
    assert.deepEqual(sent.splice(0), [])
    const state = openDoc('src/e.ts', 'e')
    recordState('src/e.ts', state.update({ changes: { from: 0, insert: big } }).state)
    tick()
    assert.deepEqual(sent.splice(0), ['open src/e.ts "e"', 'close src/e.ts'])
    closeDoc('src/big.ts')
    assert.deepEqual(sent.splice(0), [], 'nothing to let go of')
  })
})
