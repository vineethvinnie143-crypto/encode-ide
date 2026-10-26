import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DebugFolderBreakpoint, DebugFrame, DebugRun, DebugState, DebugThread } from '@shared/types'
import {
  addAt,
  breakpointClass,
  breakpointWords,
  chooseFrame,
  currentRun,
  firstFrame,
  hoverExpression,
  moveLines,
  pauseWords,
  placeOf,
  plain,
  runTitle,
  stackRows,
  toggleAt,
  toolbarMode,
} from './debug'

const frame = (id: number, patch: Partial<DebugFrame> = {}): DebugFrame => ({ id, name: `f${id}`, line: id, column: 1, source: { path: `/w/src/f${id}.js`, name: `f${id}.js`, rel: `src/f${id}.js` }, ...patch })
const node = (id: number): DebugFrame => frame(id, { source: { path: null, name: 'node:internal/modules/cjs/loader' }, skipped: true })
const thread = (patch: Partial<DebugThread> = {}): DebugThread => ({ id: 1, name: 'main', state: 'paused', reason: 'breakpoint', frames: [frame(1), frame(2)], ...patch })
const run = (id: string, patch: Partial<DebugRun> = {}): DebugRun => ({ id, name: 'app.js', kind: 'launch', state: 'running', threads: [thread()], stops: 1, config: 'file', detail: 'node app.js', by: 'person', ...patch })
const state = (...runs: DebugRun[]): DebugState => ({ trusted: true, breakpoints: {}, exceptions: { uncaught: true, all: false }, runs })
const ids = (() => {
  let n = 0
  return () => `b${++n}`
})

describe('the frame the Debug panel shows (ADR 0143)', () => {
  it('starts on the first frame of the person\'s own code', () => {
    assert.equal(firstFrame(thread({ frames: [node(9), frame(3), frame(4)] }))?.id, 3)
    // Nothing of theirs: the first that is not skipped, else the top.
    assert.equal(firstFrame(thread({ frames: [node(9), frame(5, { source: { path: null, name: 'eval' } })] }))?.id, 5)
    assert.equal(firstFrame(thread({ frames: [node(9)] }))?.id, 9)
    assert.equal(firstFrame(thread({ frames: [] })), null)
  })

  it('keeps the frame chosen while its program is paused there, and follows it when it pauses elsewhere', () => {
    const now = state(run('r1'))
    assert.deepEqual(chooseFrame(now, { run: 'r1', thread: 1, frame: 2 }), { run: 'r1', thread: 1, frame: 2 })
    const moved = state(run('r1', { threads: [thread({ frames: [frame(7), frame(8)] })] }))
    assert.deepEqual(chooseFrame(moved, { run: 'r1', thread: 1, frame: 2 }), { run: 'r1', thread: 1, frame: 7 })
  })

  it('goes to the thread that stopped, not one paused with it (a worker of Windows\'s thread pool listed first)', () => {
    const worker = thread({ id: 7, name: 'Thread 7', reason: 'pause', frames: [frame(70, { name: 'NtWaitForWorkViaWorkerFactory', source: { path: null, name: 'ntdll.dll' } })] })
    const main = thread({ id: 1, reason: 'breakpoint', frames: [frame(10), frame(11)] })
    assert.deepEqual(chooseFrame(state(run('r1', { threads: [worker, main] })), null), { run: 'r1', thread: 1, frame: 10 })
    // The worker was chosen by the person; the next stop is the main thread's.
    const next = thread({ id: 1, reason: 'step', frames: [frame(12)] })
    assert.deepEqual(chooseFrame(state(run('r1', { threads: [thread({ ...worker, frames: [frame(71)] }), next] })), { run: 'r1', thread: 7, frame: 70 }), { run: 'r1', thread: 1, frame: 12 })
    // Still where the person looks while that frame is there.
    assert.deepEqual(chooseFrame(state(run('r1', { threads: [worker, main] })), { run: 'r1', thread: 7, frame: 70 }), { run: 'r1', thread: 7, frame: 70 })
  })

  it('goes to the newest run that is paused, and to none when nothing is', () => {
    const both = state(run('r1'), run('r2', { threads: [thread({ id: 4, frames: [frame(5)] })] }))
    assert.deepEqual(chooseFrame(both, null), { run: 'r2', thread: 4, frame: 5 })
    assert.equal(chooseFrame(state(run('r1', { threads: [thread({ state: 'running', frames: undefined })] })), null), null)
    assert.equal(chooseFrame(state(run('r1', { state: 'ended' })), null), null)
    assert.equal(chooseFrame(null, { run: 'r1', thread: 1, frame: 1 }), null)
  })

  it("leaves the agent's runs alone until the person chooses one (ADR 0145)", () => {
    const agent = run('r2', { by: 'agent', threads: [thread({ id: 4, frames: [frame(5)] })] })
    // The agent's newer stop does not take the panel or the editor from the person's run.
    assert.deepEqual(chooseFrame(state(run('r1'), agent), null), { run: 'r1', thread: 1, frame: 1 })
    assert.equal(chooseFrame(state(agent), null), null)
    // Chosen, it is followed like any run.
    assert.deepEqual(chooseFrame(state(agent), { run: 'r2', thread: 4, frame: 5 }), { run: 'r2', thread: 4, frame: 5 })
    // The toolbar acts on the person's run unless the agent's is chosen.
    assert.equal(currentRun(state(run('r1'), agent), null)?.id, 'r1')
    assert.equal(currentRun(state(agent), null), null)
    assert.equal(currentRun(state(run('r1'), agent), { run: 'r2', thread: 4, frame: 5 })?.id, 'r2')
  })

  it('places the chosen frame in a file of the folder, and nowhere for code outside it', () => {
    const now = state(run('r1', { threads: [thread({ frames: [frame(1), node(2)] })] }))
    assert.deepEqual(placeOf(now, { run: 'r1', thread: 1, frame: 1 }), { path: 'src/f1.js', line: 1, top: true })
    assert.equal(placeOf(now, { run: 'r1', thread: 1, frame: 2 }), null)
    assert.equal(placeOf(now, { run: 'r1', thread: 1, frame: 99 }), null)
  })

  it('acts on the chosen run, else the newest still going, and offers what fits it', () => {
    const now = state(run('r1'), run('r2', { state: 'ended' }), run('r3', { threads: [thread({ state: 'running' })] }))
    assert.equal(currentRun(now, { run: 'r1', thread: 1, frame: 1 })?.id, 'r1')
    assert.equal(currentRun(now, null)?.id, 'r3')
    assert.equal(toolbarMode(null), 'idle')
    assert.equal(toolbarMode(run('r', { state: 'ended' })), 'idle')
    assert.equal(toolbarMode(run('r', { state: 'starting' })), 'starting')
    assert.equal(toolbarMode(run('r')), 'paused')
    assert.equal(toolbarMode(run('r', { threads: [thread({ state: 'running' })] })), 'running')
  })

  it('says how a run stands and why it stopped', () => {
    assert.equal(runTitle(run('r')), 'app.js: paused')
    assert.equal(runTitle(run('r', { state: 'ended', exitCode: 1 })), 'app.js: Exited with code 1')
    assert.equal(runTitle(run('r', { state: 'ended', message: 'Node.js could not start' })), 'app.js: Node.js could not start')
    assert.equal(pauseWords(thread({ reason: 'exception' })), 'Paused on an exception')
    assert.equal(pauseWords(thread({ state: 'running', reason: undefined })), 'Running')
  })
})

describe('the call stack as rows', () => {
  it('folds two or more frames of code the person did not write, unless one is shown', () => {
    const frames = [frame(1), node(2), node(3), node(4), frame(5), node(6)]
    const rows = stackRows(frames, 1)
    assert.deepEqual(
      rows.map((row) => (row.kind === 'frame' ? row.frame.id : row.frames.map((item) => item.id))),
      [1, [2, 3, 4], 5, 6],
    )
    assert.deepEqual(
      stackRows(frames, 3).map((row) => (row.kind === 'frame' ? row.frame.id : 'fold')),
      [1, 2, 3, 4, 5, 6],
    )
    assert.deepEqual(stackRows([], null), [])
  })
})

describe('breakpoints as the editor and the panel keep them', () => {
  const bp = (patch: Partial<DebugFolderBreakpoint>): DebugFolderBreakpoint => ({ id: 'b', line: 3, enabled: true, ...patch })

  it('draws each kind with its own mark', () => {
    assert.equal(breakpointClass(bp({})), 'enc-bp')
    assert.equal(breakpointClass(bp({ condition: 'x > 1' })), 'enc-bp-cond')
    assert.equal(breakpointClass(bp({ hitCondition: '% 2' })), 'enc-bp-cond')
    assert.equal(breakpointClass(bp({ logMessage: 'x is {x}' })), 'enc-bp-log')
    assert.equal(breakpointClass(bp({ enabled: false })), 'enc-bp-off')
    assert.equal(breakpointClass(bp({ enabled: false, logMessage: 'm' })), 'enc-bp-log-off')
    assert.equal(breakpointClass(bp({ verified: false })), 'enc-bp-hollow')
  })

  it('says what a breakpoint does in words', () => {
    assert.equal(breakpointWords(bp({ logMessage: 'sum is {sum}', condition: 'sum > 9' })), 'Prints “sum is {sum}”, when sum > 9')
    assert.equal(breakpointWords(bp({ verified: false })), 'not in code that runs yet')
    assert.equal(breakpointWords(bp({ verified: false, message: 'No code on this line' })), 'No code on this line')
    assert.equal(breakpointWords(bp({ placed: 5 })), 'stops on line 5')
    assert.equal(breakpointWords(bp({ enabled: false, hitCondition: '3' })), 'on hit 3, turned off')
  })

  it('toggles one on a line, kept in line order', () => {
    const id = ids()
    const one = toggleAt([], 9, id)
    assert.deepEqual(one, [{ id: 'b1', line: 9, enabled: true }])
    const two = toggleAt(one, 2, id)
    assert.deepEqual(
      two.map((item) => item.line),
      [2, 9],
    )
    assert.deepEqual(toggleAt(two, 9, id), [{ id: 'b2', line: 2, enabled: true }])
  })

  it('adds one with a condition, or gives it to the one already on the line, and drops empty parts', () => {
    const id = ids()
    const added = addAt([], 4, { condition: ' n > 2 ', logMessage: '  ' }, id)
    assert.deepEqual(added, [{ id: 'b1', line: 4, enabled: true, condition: ' n > 2 ' }])
    const changed = addAt([{ id: 'x', line: 4, enabled: false, condition: 'old' }], 4, { logMessage: 'hi' }, id)
    assert.deepEqual(changed, [{ id: 'x', line: 4, enabled: true, logMessage: 'hi' }])
  })

  it('keeps no state of a run when it sends them back', () => {
    assert.deepEqual(plain(bp({ verified: true, placed: 4, message: 'm', condition: 'c' })), { id: 'b', line: 3, condition: 'c', enabled: true })
  })

  it('moves them with their lines, keeping the first of two that meet', () => {
    const list = [
      { id: 'a', line: 2, enabled: true },
      { id: 'b', line: 5, enabled: true },
      { id: 'c', line: 6, enabled: false },
    ]
    assert.equal(
      moveLines(list, (line) => line),
      null,
    )
    assert.deepEqual(
      moveLines(list, (line) => (line >= 4 ? line + 2 : line)),
      [
        { id: 'a', line: 2, enabled: true },
        { id: 'b', line: 7, enabled: true },
        { id: 'c', line: 8, enabled: false },
      ],
    )
    // Lines 5 and 6 deleted into one.
    assert.deepEqual(
      moveLines(list, (line) => (line >= 6 ? line - 1 : line)),
      [
        { id: 'a', line: 2, enabled: true },
        { id: 'b', line: 5, enabled: true },
      ],
    )
  })
})

describe('what a hover reads while the program is paused', () => {
  const at = (text: string, word: string, nth = 0) => {
    let start = -1
    for (let n = 0; n <= nth; n++) start = text.indexOf(word, start + 1)
    return hoverExpression(text, start, start + word.length)
  }

  it('reads a name with the names before it', () => {
    assert.equal(at('const total = item.price * item.qty', 'price'), 'item.price')
    assert.equal(at('const total = item.price * item.qty', 'item', 1), 'item')
    assert.equal(at('return user?.address.city', 'city'), 'user?.address.city')
    assert.equal(at('this.count += 1', 'count'), 'this.count')
    assert.equal(at('let $el = _private', '_private'), '_private')
  })

  it('reads nothing it would have to run, or that is not a name', () => {
    assert.equal(at('const name = list[0].name', 'name', 1), null)
    assert.equal(at('load().name', 'name'), null)
    assert.equal(at('const n = 1.5', '5'), null)
    assert.equal(at('x = 1a.b', 'b'), null)
    assert.equal(hoverExpression('a + b', 1, 2), null)
  })
})
