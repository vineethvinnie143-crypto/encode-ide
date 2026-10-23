/**
 * The regression suite of real edits: every trace in packages/editor/test/traces (eNCode's own files edited
 * through their git history, see scripts/edit-traces.mjs) and every trace the fuzzer found a bug with, replayed with
 * every invariant checked after every step, each version reached exactly, then all of it undone and redone. Each is
 * replayed scrambled too, as a bug report would carry it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { Text } from '@encode/text'
import { expectOf, redo, replayTrace, scrambleTrace, TraceRecorder, undo, EditorState, insertText, type EditorTrace } from './index'
import { editsBetween } from './trace-history'

const DIR = path.join(process.cwd(), 'packages', 'editor', 'test', 'traces')

function load(): { file: string; trace: EditorTrace }[] {
  return fs
    .readdirSync(DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, trace: JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as EditorTrace }))
}

/** Traces that once broke an invariant, as the fuzzer made them smaller. */
const FOUND: EditorTrace[] = [
  {
    version: 1,
    name: 'undo in a read-only file takes back what came from disk',
    doc: 'function add(a: number, b: number) {\n  return a + b\n}\n',
    language: 'typescript',
    readOnly: true,
    steps: [
      { reload: 'unction add(a: number, b: number) {\n  return a + b\n}\n' },
      { command: 'undo' },
      { expect: expectOf(Text.of('unction add(a: number, b: number) {\n  return a + b\n}\n')) },
      { command: 'redo' },
      { expect: expectOf(Text.of('unction add(a: number, b: number) {\n  return a + b\n}\n')) },
    ],
  },
]

/** Replays a trace and walks its history to both ends, failing on anything that does not hold. */
function exercise(trace: EditorTrace, deep: boolean): EditorState {
  const places = new Map<number, string>()
  const { state, problems } = replayTrace(trace, {
    history: deep,
    onStep: (index, at) => {
      const text = at.doc.toString()
      const known = places.get(at.history.point)
      assert.ok(known === undefined || known === text, `step ${index}: history point ${at.history.point} came back with other text`)
      places.set(at.history.point, text)
    },
  })
  assert.deepEqual(problems, [])
  if (trace.readOnly) return state
  const all = (from: EditorState, step: typeof undo) => {
    let at = from
    for (let tr = step(at); tr; tr = step(at)) at = tr.state
    return at
  }
  const top = all(state, redo)
  const bottom = all(top, undo)
  // The oldest steps of a long trace fall off the history; the earliest kept place still holds its own text.
  const oldest = places.get(bottom.history.point) ?? trace.doc
  assert.equal(bottom.doc.toString(), bottom.history.point === 0 ? trace.doc : oldest)
  assert.ok(all(bottom, redo).doc.eq(top.doc), 'redoing everything gives the newest text again')
  return state
}

describe('real edits', () => {
  const traces = load()

  it('has traces to replay', () => {
    assert.ok(traces.length >= 8, `${traces.length} traces in ${DIR}`)
  })

  for (const { file, trace } of traces) {
    it(`replays ${file} (${trace.steps.length} steps) through every version, then undoes and redoes all of it`, () => {
      exercise(trace, trace.doc.length < 8000 && trace.steps.length < 300)
    })

    it(`replays ${file} scrambled, to the same shape`, () => {
      const scrambled = scrambleTrace(trace, 7)
      assert.notEqual(scrambled.doc, trace.doc)
      const original = replayTrace(trace, { check: false }).state.doc
      const replayed = exercise(scrambled, false).doc
      assert.equal(replayed.length, original.length)
      assert.equal(replayed.lineCount, original.lineCount)
    })
  }

  for (const trace of FOUND) {
    it(`no longer breaks: ${trace.name}`, () => {
      exercise(trace, true)
    })
  }
})

describe('traces', () => {
  it('the edits between two versions turn one into the other', async () => {
    const lines = gen.array(gen.string('ab {}\t😀é', 0, 8), 0, 12)
    await check(gen.tuple(lines, gen.array(gen.tuple(gen.int(0, 12), gen.int(0, 3), lines), 0, 4), gen.int(0, 3)), ([base, edits, ends]) => {
      const a = base.join('\n') + (ends & 1 ? '\n' : '')
      const changed = base.slice()
      for (const [at, remove, add] of edits) changed.splice(Math.min(at, changed.length), remove, ...add)
      const b = changed.join('\n') + (ends & 2 ? '\n' : '')
      let text = a
      let delta = 0
      for (const edit of editsBetween(a, b)) {
        assert.ok(edit.from <= edit.to && edit.to <= a.length, JSON.stringify(edit))
        text = text.slice(0, edit.from + delta) + edit.insert + text.slice(edit.to + delta)
        delta += edit.insert.length - (edit.to - edit.from)
      }
      assert.equal(text, b)
    }, { runs: 500 })
  })

  it('a recorded session replays to the same document, its times kept', () => {
    let now = 1000
    let state = EditorState.create({ doc: 'one\ntwo' })
    const recorder = new TraceRecorder(state, () => now, 'session')
    for (const word of ['a', 'b', 'c']) {
      now += 50
      state = insertText(state, word)!.state
      recorder.record({ insert: word })
    }
    const trace = recorder.trace(state)
    assert.deepEqual(trace.steps.map((step) => step.t), [50, 100, 150, 150])
    const { state: replayed, problems } = replayTrace(trace)
    assert.deepEqual(problems, [])
    assert.ok(replayed.doc.eq(state.doc))
    // Typed within half a second of each other, the three are one undo step, as they were.
    assert.equal(undo(replayed)!.state.doc.toString(), 'one\ntwo')
  })

  it('scrambling keeps keywords, punctuation, lengths and the same word for the same word', () => {
    const trace: EditorTrace = { version: 1, doc: 'local value = value + 1 -- count\nreturn value', language: 'lua', steps: [{ insert: 'value' }] }
    const scrambled = scrambleTrace(trace, 3)
    const words = scrambled.doc.split(/[^A-Za-z0-9_]+/)
    assert.equal(scrambled.doc.length, trace.doc.length)
    assert.equal(words[0], 'local')
    assert.equal(words[1], words[2])
    assert.notEqual(words[1], 'value')
    assert.ok(scrambled.doc.includes(' = ') && scrambled.doc.includes(' -- ') && scrambled.doc.includes('\nreturn '))
    assert.equal((scrambled.steps[0] as { insert: string }).insert, words[1])
  })
})
