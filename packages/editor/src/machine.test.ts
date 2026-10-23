/**
 * The editor as a machine: random runs of everything a person can do (every command, typing with the editor's
 * conveniences, input method commits, selections and several cursors, copy, cut and paste, changes from elsewhere,
 * replace all, a file changing on disk, undo and redo, at random speeds), in every kind of file, each step checked:
 *
 * - `editorProblems`: the document's structure, the selection, the characters the editor closed by itself, every
 *   undo and redo step fitting the document it applies to, and each transaction leading from its start to its end;
 * - the same place in history always holds the same text, and a read-only editor never changes;
 * - replaying the steps as a trace gives the same document, selection and history;
 * - undoing everything gives the document the run started from, and redoing everything the one it ended with.
 *
 * A failure is reported as the smallest trace that still fails, ready to be saved in test/traces.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { Text } from '@encode/text'
import {
  EditorSelection,
  EditorState,
  SelectionRange,
  TRACE_COMMANDS,
  TraceReplayer,
  copyText,
  cursorCharLeft,
  cursorCharRight,
  cutText,
  deleteCharBackward,
  indentLess,
  indentMore,
  insertText,
  insertTyped,
  languageById,
  moveLineDown,
  moveLineUp,
  paste,
  redo,
  replayTrace,
  selectAll,
  toggleLineComment,
  undo,
  type Command,
  type EditorTrace,
  type TraceCommand,
  type TraceStep,
} from './index'

const COMMANDS = Object.keys(TRACE_COMMANDS) as TraceCommand[]

/** Files people edit, small enough that a run reaches every part of them. */
const SAMPLES: Record<string, string[]> = {
  typescript: [
    'function add(a: number, b: number) {\n  return a + b\n}\n',
    "const list = [1, 2, 3]\nfor (const item of list) {\n\tif (item > 1) console.log(`item ${item}`)\n}\n",
    "export class Box<T> {\n  constructor(private value: T) {}\n  get(): T { return this.value } // read\n}\n/* block\n   comment */\n",
  ],
  python: ['def greet(name):\n    if name:\n        return f"hi {name}"\n    else:\n        pass\n', 'class A:\n    x = [1,\n         2]\n'],
  lua: ['local function tick()\n  for i = 1, 10 do\n    print(i)\n  end\nend\n', "Citizen.CreateThread(function()\n  while true do Wait(0) end\nend)\n-- note\n"],
  markdown: ['# Title\n\nSome *text* with `code`.\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n'],
  json: ['{\n  "name": "x",\n  "list": [1, 2, {"a": null}]\n}\n'],
  css: ['.box {\n  color: red; /* note */\n}\n@media (max-width: 10px) { .a { b: c } }\n'],
  html: ['<div class="a">\n  <p>Hi <b>there</b></p>\n  <!-- note -->\n</div>\n'],
  shellscript: ['#!/bin/sh\nif [ -f "$1" ]; then\n  echo "$1"\nfi\n'],
  plaintext: ['', 'plain text\nwith lines\n\n', 'é😀 a\u0301 漢字\ttab', 'x'],
}
const LANGUAGES = Object.keys(SAMPLES)

/** Characters typing reaches for: brackets and quotes (which close themselves), Enter, Tab, wide and joined characters. */
const TYPED = 'ab_ (){}[]"\'`<>\n\t;:.,=/*#-éx😀\u0301'
/** Text from elsewhere: a paste, a server's edit, a commit from an input method. */
const PIECES = 'ab\n  \t(){}"é😀\u0301x\r'

/** A step before it is fitted to the document: positions are thousandths of its length. */
type Draft =
  | { kind: 'command'; index: number }
  | { kind: 'type'; text: string }
  | { kind: 'insert'; text: string }
  | { kind: 'select'; ranges: [number, number][]; main: number }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'pasteText'; text: string; linewise: boolean }
  | { kind: 'changes'; changes: [number, number, string][] }
  | { kind: 'replaceAll'; search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }
  | { kind: 'reload'; at: number; span: number; text: string }

const per = gen.int(0, 1000)
const draft: Gen<Draft> = gen.weighted<Draft>(
  [16, gen.map(gen.int(0, COMMANDS.length - 1), (index) => ({ kind: 'command', index }))],
  [8, gen.map(gen.string(TYPED, 1, 6), (text) => ({ kind: 'type', text }))],
  [2, gen.map(gen.string(PIECES, 1, 8), (text) => ({ kind: 'insert', text }))],
  [5, gen.map(gen.tuple(gen.array(gen.tuple(per, per), 1, 4), gen.int(0, 3)), ([ranges, main]) => ({ kind: 'select', ranges, main }))],
  [2, () => ({ kind: 'copy' })],
  [2, () => ({ kind: 'cut' })],
  [3, () => ({ kind: 'paste' })],
  [1, gen.map(gen.tuple(gen.string(PIECES, 0, 10), gen.int(0, 1)), ([text, linewise]) => ({ kind: 'pasteText', text, linewise: linewise === 1 }))],
  [2, gen.map(gen.array(gen.tuple(per, gen.int(0, 40), gen.string(PIECES, 0, 5)), 1, 3), (changes) => ({ kind: 'changes', changes }))],
  [
    1,
    gen.map(gen.tuple(gen.oneOf('a', 'x', ' ', '(', 'é', '\\w+', '^', '$', 'a|b', '(a)'), gen.oneOf('', 'Z', '$1', '\n'), gen.int(0, 7)), ([search, replace, flags]) => ({
      kind: 'replaceAll',
      search,
      replace,
      caseSensitive: (flags & 1) === 1,
      wholeWord: (flags & 2) === 2,
      regexp: (flags & 4) === 4,
    })),
  ],
  [1, gen.map(gen.tuple(per, gen.int(0, 30), gen.string(PIECES, 0, 6)), ([at, span, text]) => ({ kind: 'reload', at, span, text }))],
)

/** How long after the last a step comes: in a burst of typing, or after a pause that starts a new undo step. */
const pause = gen.weighted([6, gen.int(1, 60)], [2, gen.int(100, 400)], [2, gen.int(600, 3000)])

interface Run {
  header: Omit<EditorTrace, 'steps'>
  drafts: [number, Draft][]
}

const runs: Gen<Run> = (random, size) => {
  const language = gen.oneOf(...LANGUAGES)(random, size)
  const doc = gen.oneOf(...SAMPLES[language])(random, size)
  const indent = gen.oneOf('  ', '    ', '\t')(random, size)
  const header: Omit<EditorTrace, 'steps'> = {
    version: 1,
    doc,
    language,
    tabSize: gen.oneOf(2, 4, 8)(random, size),
    indentUnit: indent,
    lineSeparator: gen.oneOf('\n' as const, '\r\n' as const)(random, size),
    readOnly: random() < 0.05,
    selection: [[Math.floor(random() * (doc.length + 1)), Math.floor(random() * (doc.length + 1))]],
  }
  return { header, drafts: gen.array(gen.tuple(pause, draft), 1, 4 + size * 2)(random, size) }
}

const at = (thousandths: number, length: number) => Math.round((thousandths / 1000) * length)

/** The step a draft becomes in this state. */
function fit(draft: Draft, state: EditorState, t: number): TraceStep {
  const length = state.doc.length
  switch (draft.kind) {
    case 'command':
      return { command: COMMANDS[draft.index], t }
    case 'type':
      return { type: draft.text, t }
    case 'insert':
      return { insert: draft.text, t }
    case 'select':
      return { select: draft.ranges.map(([anchor, head]) => [at(anchor, length), at(head, length)] as const), main: draft.main, t }
    case 'copy':
      return { copy: true, t }
    case 'cut':
      return { cut: true, t }
    case 'paste':
      return { paste: true, t }
    case 'pasteText':
      return { paste: draft.text, linewise: draft.linewise, t }
    case 'changes':
      return {
        changes: draft.changes.map(([where, span, insert]) => {
          const from = at(where, length)
          return [from, Math.min(length, from + span), insert] as const
        }),
        t,
      }
    case 'replaceAll':
      return { replaceAll: { search: draft.search, caseSensitive: draft.caseSensitive, wholeWord: draft.wholeWord, regexp: draft.regexp }, with: draft.replace, t }
    case 'reload': {
      const text = state.doc.toString()
      const from = at(draft.at, length)
      return { reload: text.slice(0, from) + draft.text + text.slice(Math.min(length, from + draft.span)), t }
    }
  }
}

/** Fails with the trace as it was taken, so the failure can be replayed and kept. */
function fail(problem: string, trace: EditorTrace): never {
  throw new Error(`${problem}\nTrace: ${JSON.stringify(trace)}`)
}

describe('the editor as a machine', () => {
  it('keeps every invariant through random runs of everything a person can do, and undoes and redoes all of it', async () => {
    await check(
      runs,
      ({ header, drafts }) => {
        const replayer = new TraceReplayer(header, { history: true })
        const steps: TraceStep[] = []
        const trace = (): EditorTrace => ({ ...header, steps })
        // A place in history always holds the same text.
        const places = new Map<number, string>([[0, header.doc]])
        let t = 0
        let disk = header.doc
        for (const [wait, each] of drafts) {
          t += wait
          const step = fit(each, replayer.state, t)
          steps.push(step)
          replayer.step(step)
          if (replayer.problems.length) fail(`step ${replayer.problems[0].step}: ${replayer.problems[0].problem}`, trace())
          const { state } = replayer
          const text = state.doc.toString()
          const point = state.history.point
          const known = places.get(point)
          if (known !== undefined && known !== text) fail(`history point ${point} came back with other text`, trace())
          places.set(point, text)
          // Read-only stops the person; the file changing on disk still comes in.
          if ('reload' in step) disk = text
          if (header.readOnly && text !== disk) fail('a read-only document changed', trace())
          // The text written to disk reads back as the same document.
          const written = state.serialize()
          if (!Text.of(written.split(state.config.lineSeparator)).eq(state.doc)) fail('the document does not survive a save', trace())
        }
        const end = replayer.state

        // The steps, replayed as a trace from the start, end in the same place.
        const again = replayTrace(trace())
        if (again.problems.length) fail(`replayed: ${again.problems[0].problem}`, trace())
        if (!again.state.doc.eq(end.doc)) fail('the replayed trace ends in another document', trace())
        if (!again.state.selection.eq(end.selection)) fail('the replayed trace ends with another selection', trace())
        if (again.state.history.done.length !== end.history.done.length) fail('the replayed trace grouped undo steps differently', trace())

        // Redo what the run left undone, undo everything, then redo everything.
        const all = (from: EditorState, step: typeof undo) => {
          let state = from
          for (let guard = 0; ; guard++) {
            const tr = step(state)
            if (!tr) return state
            if (guard > 2000) fail('undo or redo never ends', trace())
            state = tr.state
          }
        }
        const top = all(end, redo)
        let state = all(top, undo)
        if (state.doc.toString() !== (header.readOnly ? end.doc.toString() : header.doc)) fail('undoing everything does not give the document the run started from', trace())
        state = all(state, redo)
        if (!state.doc.eq(top.doc)) fail('redoing everything does not give the newest document again', trace())
      },
      { runs: 300, maxSize: 30 },
    )
  })

  it('cuts any selections and pastes them back in place, each cursor its own piece', async () => {
    const cases = gen.tuple(gen.string('ab \n\t(é😀', 1, 60), gen.array(gen.tuple(per, per), 1, 5))
    await check(cases, ([doc, raw]) => {
      const ranges = raw.map(([a, b]) => new SelectionRange(at(a, doc.length), at(b, doc.length)))
      const start = EditorState.create({ doc, selection: EditorSelection.create(ranges) })
      // Ranges that touch leave their cursors in one place after the cut, which then pastes the copy whole.
      const { ranges: kept } = start.selection
      if (kept.some((range, index) => range.empty || (index > 0 && range.from === kept[index - 1].to))) return
      const { clipboard, transaction } = cutText(start)
      assert.ok(transaction)
      const back = paste(transaction.state, clipboard.text, clipboard.linewise, clipboard.pieces)
      assert.equal(back?.state.doc.toString() ?? transaction.state.doc.toString(), doc)
      // Copying and pasting over the same selection changes nothing either.
      const copied = copyText(start)
      const over = paste(start, copied.text, copied.linewise, copied.pieces)
      assert.equal(over?.state.doc.toString() ?? doc, doc)
    })
  })
})

describe('commands that undo each other', () => {
  /** Lines indented in whole units of `unit`, with words, brackets, blanks and wide characters. */
  const indented = (unit: string): Gen<string> =>
    gen.map(gen.array(gen.tuple(gen.int(0, 3), gen.string('ab (){};é😀', 0, 10), gen.int(0, 9)), 1, 14), (lines) =>
      lines.map(([depth, text, blank]) => (blank === 0 ? '' : unit.repeat(depth) + text.trim())).join('\n'),
    )
  const selections = gen.array(gen.tuple(per, per), 1, 4)
  const stateOf = (doc: string, raw: [number, number][], language: string, unit = '  ') =>
    EditorState.create({
      doc,
      language: languageById(language),
      indentUnit: unit,
      tabSize: 4,
      selection: EditorSelection.create(raw.map(([a, b]) => new SelectionRange(at(a, doc.length), at(b, doc.length)))),
    })
  const twice = (state: EditorState, first: Command, second: Command) => {
    const one = first(state)
    if (!one) return null
    return second(one.state)?.state ?? one.state
  }

  it('commenting twice gives every line back, in every kind of comment', async () => {
    const cases = gen.tuple(indented('  '), selections, gen.oneOf('typescript', 'python', 'lua', 'shellscript', 'sql', 'css', 'html', 'markdown'))
    await check(cases, ([doc, raw, language]) => {
      const start = stateOf(doc, raw, language)
      const end = twice(start, toggleLineComment, toggleLineComment)
      if (end) assert.equal(end.doc.toString(), doc)
    }, { runs: 400 })
  })

  it('indenting then outdenting gives every line back, with spaces or tabs', async () => {
    for (const unit of ['  ', '    ', '\t']) {
      await check(gen.tuple(indented(unit), selections), ([doc, raw]) => {
        const start = stateOf(doc, raw, 'typescript', unit)
        const end = twice(start, indentMore, indentLess)
        if (end) assert.equal(end.doc.toString(), doc)
      }, { runs: 200 })
    }
  })

  it('moving lines down then up gives them back, the selection too', async () => {
    await check(gen.tuple(indented('  '), selections), ([doc, raw]) => {
      const start = stateOf(doc, raw, 'typescript')
      // A selection that takes in the line break before the last line has no line break to end after once its lines
      // are last: it ends at the end of the document, which reads as one line fewer when the last of them is empty.
      const last = start.doc.line(start.doc.lineCount)
      if (start.selection.ranges.some((range) => !range.empty && range.to === last.from && last.number > 1)) return
      const down = moveLineDown(start)
      if (!down) return
      const up = moveLineUp(down.state)
      assert.ok(up)
      assert.equal(up.state.doc.toString(), doc)
      assert.ok(up.state.selection.eq(start.selection), 'the selection comes back')
    }, { runs: 300 })
  })

  it('walking right through a line stops where walking left does: whole characters, never inside one', async () => {
    const joiner = String.fromCodePoint(0x200d)
    const family = [0x1f468, 0x1f469, 0x1f467].map((code) => String.fromCodePoint(code)).join(joiner)
    const flag = String.fromCodePoint(0x1f1ee, 0x1f1f3)
    const accent = `e${String.fromCodePoint(0x301)}`
    const pieces = ['a', ' ', '\t', '\n', 'é', '漢', '😀', family, flag, accent, `${accent}${String.fromCodePoint(0x302)}`, '\r']
    await check(gen.array(gen.oneOf(...pieces), 0, 30), (parts) => {
      const doc = parts.join('')
      const walk = (state: EditorState, command: Command) => {
        const stops = [state.selection.main.head]
        for (let guard = 0; guard <= doc.length; guard++) {
          const tr = command(state)
          if (!tr) break
          state = tr.state
          stops.push(state.selection.main.head)
        }
        return stops
      }
      const right = walk(EditorState.create({ doc }), cursorCharRight)
      const left = walk(EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) }), cursorCharLeft)
      assert.deepEqual(right, left.slice().reverse())
      // Every stop is the boundary of a piece the document was made of.
      const bounds = new Set([0])
      let pos = 0
      for (const part of parts) bounds.add((pos += part.length))
      for (const stop of right) assert.ok(bounds.has(stop) || /[\r]/.test(doc), `a stop at ${stop} inside a character of ${JSON.stringify(doc)}`)
    }, { runs: 400 })
  })

  it('typing plain words at several cursors is inserting them', async () => {
    await check(gen.tuple(indented('  '), selections, gen.string('abcXYZ019 ', 1, 8)), ([doc, raw, word]) => {
      let typed = stateOf(doc, raw, 'typescript')
      for (const char of word) typed = insertTyped(typed, char)?.state ?? typed
      const inserted = insertText(stateOf(doc, raw, 'typescript'), word)
      assert.equal(typed.doc.toString(), inserted?.state.doc.toString())
      assert.ok(typed.selection.eq(inserted!.state.selection))
    }, { runs: 300 })
  })

  it('selecting all and deleting leaves nothing, and undo brings back the text and the selection', async () => {
    await check(gen.tuple(indented('\t'), selections), ([doc, raw]) => {
      const start = stateOf(doc, raw, 'python')
      const all = selectAll(start)?.state ?? start
      const empty = deleteCharBackward(all)
      if (!doc) return assert.equal(empty, null)
      assert.equal(empty?.state.doc.length, 0)
      const back = undo(empty!.state)
      assert.equal(back?.state.doc.toString(), doc)
      assert.ok(back!.state.selection.eq(all.selection))
    }, { runs: 200 })
  })
})
