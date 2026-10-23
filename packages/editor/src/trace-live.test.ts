import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { ChangeSet } from '@encode/text'
import {
  EditRecorder,
  EditorSelection,
  EditorState,
  SelectionRange,
  TRACE_COMMANDS,
  TraceReplayer,
  actionsOf,
  insertText,
  languageById,
  paste,
  reload,
  scrambleTrace,
  withHistoryClock,
  type EditorTrace,
  type Transaction,
} from './index'

const NAMES = Object.keys(TRACE_COMMANDS) as (keyof typeof TRACE_COMMANDS)[]

/** One thing a person or the app does to a live editor. */
type Act =
  | { kind: 'command'; name: number }
  | { kind: 'type'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'select'; anchor: number; head: number; add: boolean }
  | { kind: 'server'; at: number; remove: number; text: string }
  | { kind: 'reload'; at: number; remove: number; text: string }

const text = gen.string('ab (){}\n\t"é😀', 0, 6)
const act: (random: () => number, size: number) => Act = gen.weighted<Act>(
  [5, gen.map(gen.int(0, NAMES.length - 1), (name) => ({ kind: 'command', name }))],
  [4, gen.map(text, (value) => ({ kind: 'type', text: value }))],
  [1, gen.map(text, (value) => ({ kind: 'paste', text: value }))],
  [2, gen.map(gen.tuple(gen.int(0, 400), gen.int(0, 400), gen.int(0, 3)), ([anchor, head, add]) => ({ kind: 'select', anchor, head, add: add === 0 }))],
  [1, gen.map(gen.tuple(gen.int(0, 400), gen.int(0, 6), text), ([at, remove, value]) => ({ kind: 'server', at, remove, text: value }))],
  [1, gen.map(gen.tuple(gen.int(0, 400), gen.int(0, 6), text), ([at, remove, value]) => ({ kind: 'reload', at, remove, text: value }))],
)

/** Does `act` to `state` the way the app would, if it applies. */
function apply(state: EditorState, step: Act): Transaction | null {
  const length = state.doc.length
  switch (step.kind) {
    case 'command':
      return TRACE_COMMANDS[NAMES[step.name]](state)
    case 'type':
      return step.text ? insertText(state, step.text) : null
    case 'paste':
      return paste(state, step.text, false)
    case 'select': {
      const range = new SelectionRange(step.anchor % (length + 1), step.head % (length + 1))
      return state.update({ selection: step.add ? state.selection.addRange(range) : EditorSelection.create([range]), origin: 'select' })
    }
    case 'server': {
      const from = step.at % (length + 1)
      const to = Math.min(length, from + step.remove)
      return state.update({ changes: ChangeSet.of([{ from, to, insert: step.text }], length), origin: 'server', isolateHistory: true })
    }
    case 'reload': {
      const now = state.doc.toString()
      const from = step.at % (length + 1)
      return reload(state, now.slice(0, from) + step.text + now.slice(Math.min(length, from + step.remove)))
    }
  }
}

describe('recording a live editor', () => {
  it('replays to every document and selection the editor showed, in order', async () => {
    const start = gen.tuple(gen.string('ab (){}\n\té', 0, 40), gen.oneOf('typescript', 'lua', 'plaintext'), gen.int(0, 3))
    await check(gen.tuple(start, gen.array(act, 1, 40)), ([[doc, language, readOnly], acts]) => {
      let now = 0
      let state = EditorState.create({ doc, language: languageById(language), readOnly: readOnly === 0 })
      const recorder = new EditRecorder(state, () => now)
      const seen: { doc: string; selection: EditorSelection; actions: number }[] = []
      for (const step of acts) {
        now += step.kind === 'type' ? 40 : 700
        const tr = withHistoryClock(() => now, () => apply(state, step))
        if (!tr) continue
        recorder.record(tr)
        state = tr.state
        seen.push({ doc: state.doc.toString(), selection: state.selection, actions: actionsOf(tr).length })
      }
      const trace = recorder.trace()
      if (typeof trace === 'string') {
        assert.equal(trace, 'nothing yet')
        assert.ok(seen.every((entry) => entry.actions === 0))
        return
      }
      const replayer = new TraceReplayer(trace)
      let index = 0
      for (const entry of seen) {
        for (let n = 0; n < entry.actions; n++) replayer.step(trace.steps[index++])
        assert.equal(replayer.state.doc.toString(), entry.doc, `the document after step ${index}`)
        assert.ok(replayer.state.selection.eq(entry.selection), `the selection after step ${index}`)
      }
      replayer.step(trace.steps[index++])
      assert.equal(index, trace.steps.length, 'the trace ends with what the document is')
      assert.deepEqual(replayer.problems, [])
    })
  })

  it('keeps the origins and the times of the changes', () => {
    let now = 5_000
    const state = EditorState.create({ doc: 'let a = 1\n', language: languageById('typescript') })
    const recorder = new EditRecorder(state, () => now)
    now += 120
    const typed = withHistoryClock(() => now, () => insertText(state, 'x')!)
    recorder.record(typed)
    now += 300
    recorder.record(typed.state.update({ changes: { from: 0, to: 4, insert: 'const' }, origin: 'server' }))
    const trace = recorder.trace() as EditorTrace
    // Typing moves the cursor past what it put in, which the changes alone would not: a selection step says so.
    assert.deepEqual(trace.steps.slice(0, 3), [
      { changes: [[0, 0, 'x']], origin: 'input.type', t: 120 },
      { select: [[1, 1]], t: 120 },
      { changes: [[0, 4, 'const']], origin: 'server', t: 420 },
    ])
  })

  it('starts again from a transaction it did not see the start of, and from a new configuration', () => {
    let state = EditorState.create({ doc: 'one' })
    const recorder = new EditRecorder(state)
    state = insertText(state, 'a')!.state
    recorder.record(state.update({ selection: EditorSelection.cursor(0) }))
    // An edit the recorder never heard of, then one from there.
    const unseen = insertText(EditorState.create({ doc: 'two' }), 'b')!
    recorder.record(unseen.state.update({ selection: EditorSelection.cursor(0) }))
    let trace = recorder.trace() as EditorTrace
    assert.equal(trace.doc, 'btwo')
    const retab = unseen.state.update({ config: { tabSize: 8 } })
    recorder.record(retab)
    assert.equal(recorder.trace(), 'nothing yet')
    recorder.record(insertText(retab.state, 'c')!)
    trace = recorder.trace() as EditorTrace
    assert.equal(trace.tabSize, 8)
    assert.deepEqual(
      trace.steps.map((step) => Object.keys(step)[0]),
      ['changes', 'select', 'expect'],
    )
  })

  it('keeps only the newest steps of a long session, and nothing of a document too large', () => {
    let state = EditorState.create({ doc: '' })
    const recorder = new EditRecorder(state, Date.now, { steps: 10, chars: 1_000, doc: 50 })
    for (let n = 0; n < 25; n++) {
      const tr = insertText(state, 'x')!
      recorder.record(tr)
      state = tr.state
    }
    const trace = recorder.trace() as EditorTrace
    assert.ok(trace.steps.length <= 11)
    assert.equal(trace.doc.length + trace.steps.filter((step) => 'changes' in step).length, 25)
    assert.equal(recorder.extent.trimmed, true)

    const large = EditorState.create({ doc: 'y'.repeat(60) })
    const idle = new EditRecorder(large, Date.now, { steps: 10, chars: 1_000, doc: 50 })
    idle.record(insertText(large, 'z')!)
    assert.equal(idle.trace(), 'too large')
  })

  it('records a read-only document changing on disk as a reload', () => {
    const state = EditorState.create({ doc: 'a\nb\n', readOnly: true })
    const recorder = new EditRecorder(state)
    const tr = reload(state, 'a\nB\n')!
    recorder.record(tr)
    const trace = recorder.trace() as EditorTrace
    assert.equal('reload' in trace.steps[0] && trace.steps[0].reload, 'a\nB\n')
  })

  it('gives a trace that scrambles to the same shape', () => {
    let state = EditorState.create({ doc: 'function total(items) {\n  return items.length\n}\n', language: languageById('typescript') })
    const recorder = new EditRecorder(state)
    for (const word of ['const ', 'count', ' = 1']) {
      const tr = insertText(state, word)!
      recorder.record(tr)
      state = tr.state
    }
    const trace = recorder.trace() as EditorTrace
    const scrambled = scrambleTrace(trace, 11)
    assert.ok(!scrambled.doc.includes('total') && !JSON.stringify(scrambled.steps).includes('count'))
    const replayer = new TraceReplayer(scrambled)
    for (const step of scrambled.steps) replayer.step(step)
    assert.deepEqual(replayer.problems, [])
    assert.equal(replayer.state.doc.length, state.doc.length)
  })
})
