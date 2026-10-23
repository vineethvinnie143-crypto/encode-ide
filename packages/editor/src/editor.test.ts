import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import {
  EditorSelection,
  EditorState,
  SelectionRange,
  addCursorBelow,
  compileSearch,
  copyLineDown,
  copyText,
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineStart,
  cursorWordLeft,
  deleteCharBackward,
  deleteLine,
  findPrevious,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  insertTab,
  insertTyped,
  languageById,
  moveLineDown,
  moveBy,
  moveLineUp,
  paste,
  redo,
  replaceAll,
  searchMatches,
  selectAllOccurrences,
  selectNextOccurrence,
  toggleBlockComment,
  toggleLineComment,
  undo,
  type Command,
  type Transaction,
} from './index'

/** A state from text with `|` marking cursors and `[`…`]` marking selections (anchor at `[`). */
function stateOf(marked: string, language = 'typescript', extra: Partial<Parameters<typeof EditorState.create>[0]> = {}): EditorState {
  const ranges: SelectionRange[] = []
  let text = ''
  let anchor = -1
  for (const char of marked) {
    if (char === '|') ranges.push(SelectionRange.cursor(text.length))
    else if (char === '[') anchor = text.length
    else if (char === ']') {
      ranges.push(new SelectionRange(anchor, text.length))
      anchor = -1
    } else text += char
  }
  return EditorState.create({
    doc: text,
    selection: ranges.length ? EditorSelection.create(ranges) : undefined,
    language: languageById(language),
    ...extra,
  })
}

/** The document with cursors and selections marked the same way. */
function show(state: EditorState): string {
  const text = state.doc.toString()
  const marks: { pos: number; mark: string }[] = []
  for (const range of state.selection.ranges) {
    if (range.empty) marks.push({ pos: range.head, mark: '|' })
    else {
      marks.push({ pos: range.from, mark: '[' })
      marks.push({ pos: range.to, mark: ']' })
    }
  }
  marks.sort((a, b) => b.pos - a.pos || (a.mark === '[' ? 1 : -1))
  let out = text
  for (const { pos, mark } of marks) out = out.slice(0, pos) + mark + out.slice(pos)
  return out
}

function run(state: EditorState, command: Command): EditorState {
  const tr = command(state)
  return tr ? tr.state : state
}

function type(state: EditorState, text: string): EditorState {
  for (const char of text) {
    const tr: Transaction | null = char === '\n' ? insertNewlineAndIndent(state) : insertTyped(state, char)
    if (tr) state = tr.state
  }
  return state
}

describe('typing', () => {
  it('closes brackets and quotes, and types over what it inserted', () => {
    assert.equal(show(type(stateOf('|'), '(')), '(|)')
    assert.equal(show(type(stateOf('|'), '(a)')), '(a)|')
    assert.equal(show(type(stateOf('|'), "'x'")), "'x'|")
    assert.equal(show(type(stateOf('|'), '[{')), '[{|}]')
  })

  it('does not auto-close before a word or inside one', () => {
    assert.equal(show(type(stateOf('|foo'), '(')), '(|foo')
    assert.equal(show(type(stateOf("don|"), "'")), "don'|")
  })

  it('types a closer normally once the cursor has left it', () => {
    let state = type(stateOf('|'), '(')
    state = run(state, cursorCharRight)
    state = run(state, cursorCharLeft)
    assert.equal(show(type(state, ')')), '()|)')
  })

  it('surrounds a selection', () => {
    assert.equal(show(type(stateOf('[abc]'), '(')), '([abc])')
    assert.equal(show(type(stateOf('[abc]'), '"')), '"[abc]"')
  })

  it('lines a closing bracket up with its opening line', () => {
    const state = stateOf('function f() {\n  x()\n  |')
    assert.equal(show(type(state, '}')), 'function f() {\n  x()\n}|')
  })

  it('splits a bracket pair on Enter and indents inside it', () => {
    assert.equal(show(type(stateOf('  if (x) {|}'), '\n')), '  if (x) {\n    |\n  }')
    assert.equal(show(type(stateOf('foo(|'), '\n')), 'foo(\n  |')
  })

  it('indents after a Python colon and dedents else', () => {
    let state = stateOf('if x:|', 'python', { indentUnit: '    ' })
    state = type(state, '\npass\nelse:')
    assert.equal(show(state), 'if x:\n    pass\nelse:|')
  })

  it('dedents Lua block ends as they are typed', () => {
    let state = stateOf('function f()|', 'lua', { indentUnit: '    ' })
    state = type(state, '\nif x then\nprint(1)\nend\nend')
    assert.equal(show(state), 'function f()\n    if x then\n        print(1)\n    end\nend|')
  })

  it('deletes an auto-inserted pair and indentation stops with Backspace', () => {
    assert.equal(show(run(type(stateOf('|'), '('), deleteCharBackward)), '|')
    assert.equal(show(run(stateOf('      |x', 'typescript', { indentUnit: '  ' }), deleteCharBackward)), '    |x')
    assert.equal(show(run(stateOf('a😀|b'), deleteCharBackward)), 'a|b')
    assert.equal(show(run(stateOf('a\n|b'), deleteCharBackward)), 'a|b')
  })

  it('types at every cursor', () => {
    assert.equal(show(type(stateOf('a|\nb|\nc|'), 'x')), 'ax|\nbx|\ncx|')
    assert.equal(show(type(stateOf('|\n|'), '(')), '(|)\n(|)')
  })
})

describe('undo history', () => {
  it('groups consecutive typing into one step and restores the selection', () => {
    let state = stateOf('|')
    state = type(state, 'hello')
    assert.equal(state.doc.toString(), 'hello')
    const undone = undo(state)!.state
    assert.equal(show(undone), '|')
    const redone = redo(undone)!.state
    assert.equal(show(redone), 'hello|')
  })

  it('starts a new step after the cursor moves', () => {
    let state = type(stateOf('|'), 'ab')
    state = run(state, cursorCharLeft)
    state = type(state, 'X')
    assert.equal(show(undo(state)!.state), 'a|b')
  })

  it('identifies equal documents by history point after undo and redo', () => {
    const saved = type(stateOf('|'), 'abc')
    let state = type(run(saved, cursorCharLeft), 'Z')
    assert.notEqual(state.history.point, saved.history.point)
    state = undo(state)!.state
    assert.equal(state.history.point, saved.history.point)
    state = redo(state)!.state
    assert.notEqual(state.history.point, saved.history.point)
    assert.equal(undo(state)!.state.history.point, saved.history.point)
  })

  it('undoes and redoes random edits back to every earlier document', async () => {
    await check(
      gen.array(gen.tuple(gen.int(0, 3), gen.int(0, 1000), gen.string('ab\n', 0, 3)), 1, 30),
      (edits) => {
        let state = EditorState.create({ doc: 'start\ntext' })
        const docs = [state.doc.toString()]
        for (const [kind, at, text] of edits) {
          const length = state.doc.length
          const from = at % (length + 1)
          const to = Math.min(length, from + (kind === 0 ? 0 : kind))
          const tr = state.update({ changes: { from, to, insert: text }, origin: 'command', isolateHistory: true })
          state = tr.state
          if (tr.docChanged) docs.push(state.doc.toString())
        }
        for (let index = docs.length - 1; index > 0; index--) {
          assert.equal(state.doc.toString(), docs[index])
          state = undo(state)!.state
        }
        assert.equal(state.doc.toString(), docs[0])
        for (let index = 1; index < docs.length; index++) {
          state = redo(state)!.state
          assert.equal(state.doc.toString(), docs[index])
        }
      },
    )
  })
})

describe('commands', () => {
  it('moves by grapheme clusters and words', () => {
    assert.equal(show(run(stateOf('a👍🏽|b'), cursorCharLeft)), 'a|👍🏽b')
    assert.equal(show(run(stateOf('foo.bar baz|'), cursorWordLeft)), 'foo.bar |baz')
    assert.equal(show(run(stateOf('foo.bar |baz'), cursorWordLeft)), 'foo.|bar baz')
  })

  it('keeps the goal column through short lines', () => {
    let state = stateOf('abcdef|\nab\nabcdefgh')
    state = run(state, cursorLineDown)
    assert.equal(show(state), 'abcdef\nab|\nabcdefgh')
    state = run(state, cursorLineDown)
    assert.equal(show(state), 'abcdef\nab\nabcdef|gh')
  })

  it('keeps which side of a wrapped row break a cursor is on, through a move that extends it, until an edit', () => {
    const state = EditorState.create({ doc: 'one two three', selection: EditorSelection.create([SelectionRange.cursor(4, undefined, -1)]) })
    const at = state.selection.main
    assert.equal(at.assoc, -1)
    assert.ok(!at.eq(SelectionRange.cursor(4)), 'the end of a row is not the start of the next')
    assert.ok(at.eq(SelectionRange.cursor(4, 7, -1)))
    const extended = moveBy(state, true, () => SelectionRange.cursor(8, undefined, -1))!.state.selection.main
    assert.deepEqual([extended.anchor, extended.head, extended.assoc], [4, 8, -1])
    const typed = state.update({ changes: { from: 0, insert: 'x' } }).state.selection.main
    assert.deepEqual([typed.head, typed.assoc], [5, undefined])
  })

  it('goes to the first non-blank character, then to the line start', () => {
    let state = stateOf('    foo|')
    state = run(state, cursorLineStart)
    assert.equal(show(state), '    |foo')
    state = run(state, cursorLineStart)
    assert.equal(show(state), '|    foo')
  })

  it('indents and outdents lines', () => {
    const state = stateOf('[a\nb]', 'typescript', { indentUnit: '  ' })
    assert.equal(show(run(state, indentMore)), '[  a\n  b]')
    assert.equal(show(run(stateOf('   |x', 'typescript', { indentUnit: '  ' }), indentLess)), '  |x')
    assert.equal(show(run(stateOf('ab|', 'typescript', { indentUnit: '    ' }), insertTab)), 'ab  |')
  })

  it('toggles line comments at the shallowest indentation', () => {
    const state = stateOf('  [a\n    b\n\n  c]')
    const commented = run(state, toggleLineComment)
    assert.equal(commented.doc.toString(), '  // a\n  //   b\n\n  // c')
    assert.equal(run(commented, toggleLineComment).doc.toString(), '  a\n    b\n\n  c')
  })

  it('uses block comments where a language has no line comments', () => {
    const state = stateOf('a { color: red; }|', 'css')
    const commented = run(state, toggleLineComment)
    assert.equal(commented.doc.toString(), '/* a { color: red; } */')
    assert.equal(run(commented, toggleLineComment).doc.toString(), 'a { color: red; }')
    assert.equal(show(run(stateOf('x [y] z'), toggleBlockComment)), 'x /* [y] */ z')
    assert.equal(show(run(stateOf('x /* [y] */ z'), toggleBlockComment)), 'x [y] z')
  })

  it('moves, copies and deletes lines', () => {
    assert.equal(show(run(stateOf('a\nb|\nc'), moveLineUp)), 'b|\na\nc')
    assert.equal(show(run(stateOf('a|\nb\nc'), moveLineDown)), 'b\na|\nc')
    assert.equal(moveLineUp(stateOf('a|\nb')), null)
    assert.equal(show(run(stateOf('a|b\nc'), copyLineDown)), 'ab\na|b\nc')
    assert.equal(show(run(stateOf('one\ntw|o\nthree'), deleteLine)), 'one\nth|ree')
    assert.equal(show(run(stateOf('one\ntwo|'), deleteLine)), 'one|')
  })

  it('selects occurrences', () => {
    let state = stateOf('foo bar fo|o foo')
    state = run(state, selectNextOccurrence)
    assert.equal(show(state), 'foo bar [foo] foo')
    state = run(state, selectNextOccurrence)
    assert.equal(show(state), 'foo bar [foo] [foo]')
    state = run(state, selectNextOccurrence)
    assert.equal(show(state), '[foo] bar [foo] [foo]')
    assert.equal(run(state, selectNextOccurrence), state)
    assert.equal(show(run(stateOf('a| b a'), selectAllOccurrences)), '[a] b [a]')
  })

  it('adds cursors below at the same column', () => {
    assert.equal(show(run(stateOf('ab|c\nd\nefg'), addCursorBelow)), 'ab|c\nd|\nefg')
  })

  it('copies whole lines without a selection and pastes them above', () => {
    const state = stateOf('one|\ntwo')
    const clipboard = copyText(state)
    assert.deepEqual(clipboard, { text: 'one\n', linewise: true })
    const pasted = paste(stateOf('one\nt|wo'), clipboard.text, clipboard.linewise)!.state
    assert.equal(show(pasted), 'one\none\nt|wo')
  })

  it('spreads pasted lines over the cursors', () => {
    assert.equal(show(paste(stateOf('|\n|\n|'), 'a\nb\nc')!.state), 'a|\nb|\nc|')
    assert.equal(show(paste(stateOf('|'), 'a\r\nb')!.state), 'a\nb|')
  })

  it('refuses to edit a read-only document', () => {
    const state = stateOf('a|', 'typescript', { readOnly: true })
    assert.equal(insertTyped(state, 'x'), null)
    assert.equal(deleteCharBackward(state), null)
    assert.notEqual(cursorCharLeft(state), null)
  })
})

describe('search', () => {
  it('finds literal, case-insensitive, whole-word and regular expression matches', () => {
    const doc = EditorState.create({ doc: 'Foo foo food\nfoo' }).doc
    const all = (query: Parameters<typeof compileSearch>[0]) => [...searchMatches(doc, compileSearch(query))].map((match) => [match.from, match.to])
    assert.deepEqual(all({ search: 'foo' }), [
      [0, 3],
      [4, 7],
      [8, 11],
      [13, 16],
    ])
    assert.deepEqual(all({ search: 'foo', caseSensitive: true, wholeWord: true }), [
      [4, 7],
      [13, 16],
    ])
    assert.deepEqual(all({ search: 'fo+d', regexp: true }), [[8, 12]])
    assert.deepEqual(all({ search: 'food\\nfoo', regexp: true }), [[8, 16]])
    assert.equal(compileSearch({ search: '(', regexp: true }).regex, null)
  })

  it('finds backwards and wraps', () => {
    const doc = EditorState.create({ doc: 'a1 a2 a3' }).doc
    const search = compileSearch({ search: 'a\\d', regexp: true })
    assert.equal(findPrevious(doc, search, 5)!.from, 3)
    assert.equal(findPrevious(doc, search, 3)!.from, 0)
    assert.equal(findPrevious(doc, search, 0)!.from, 6)
    assert.equal(findPrevious(doc, search, 0, false), null)
  })

  it('replaces with groups', () => {
    const state = EditorState.create({ doc: 'let a = 1; let b = 2' })
    const spec = replaceAll(state, compileSearch({ search: 'let (\\w)', regexp: true }), 'const $1')!
    assert.equal(state.update(spec).state.doc.toString(), 'const a = 1; const b = 2')
  })
})
