import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EditorSelection, EditorState, SelectionRange, languageForPath } from '@encode/editor'
import { Text } from '@encode/text'
import { INLINE_PREFIX_CHARS, INLINE_SNIPPETS, INLINE_SUFFIX_CHARS } from '@shared/inline'
import { GhostCache, contextAt, followGhost, ghostFooter, nextWord, pickSnippets, suggestibleAt } from './ghost-text'

const ts = (doc: string, ...cursors: (number | [number, number])[]) =>
  EditorState.create({
    doc,
    language: languageForPath('a.ts'),
    selection: EditorSelection.create(cursors.map((at) => (Array.isArray(at) ? new SelectionRange(at[0], at[1]) : new SelectionRange(at, at)))),
  })

describe('what a suggestion is asked with', () => {
  it('sends the text around the cursor, and says whether the rest of the line is empty', () => {
    const doc = 'function add(a, b) {\n  return \n}\n'
    const at = doc.indexOf('return ') + 'return '.length
    assert.deepEqual(contextAt(ts(doc, at), at), { prefix: doc.slice(0, at), suffix: doc.slice(at), multiline: true })
    const mid = doc.indexOf('(a')
    assert.equal(contextAt(ts(doc, mid), mid).multiline, false, 'text after the cursor on its line keeps the suggestion to that line')
  })

  it('cuts a long file at whole lines, within what the main process takes', () => {
    const line = `${'x'.repeat(79)}\n`
    const doc = line.repeat(200)
    const at = doc.length / 2
    const { prefix, suffix } = contextAt(ts(doc, at), at)
    assert.ok(prefix.length <= INLINE_PREFIX_CHARS && prefix.length >= INLINE_PREFIX_CHARS - line.length)
    assert.ok(suffix.length <= INLINE_SUFFIX_CHARS && suffix.length >= INLINE_SUFFIX_CHARS - line.length)
    assert.ok(doc.slice(0, at).endsWith(prefix) && prefix.startsWith('x'), 'the prefix starts at the start of a line')
    assert.ok(doc.slice(at).startsWith(suffix) && suffix.endsWith('x'), 'the suffix ends at the end of a line')
  })
})

describe('where a suggestion fits', () => {
  it('fits one empty cursor that is not in the middle of a word', () => {
    assert.equal(suggestibleAt(ts('const a = ', 10)), true)
    assert.equal(suggestibleAt(ts('foo()', 4)), true, 'before a closing bracket')
    assert.equal(suggestibleAt(ts('foo bar', 4)), false, 'just before a word')
    assert.equal(suggestibleAt(ts('a\nb', 1, 3)), false, 'two cursors')
    assert.equal(suggestibleAt(ts('const a', [0, 5])), false, 'a selection')
  })

  it('does not fit a file that cannot be typed in, or a line too long to draw', () => {
    assert.equal(suggestibleAt(EditorState.create({ doc: 'x = ', readOnly: true, selection: EditorSelection.cursor(4) })), false)
    const long = `${'y'.repeat(5_000)} `
    assert.equal(suggestibleAt(ts(long, long.length)), false)
  })
})

describe('the parts of other files that go with it', () => {
  const make = (lines: string[]) => Text.of(lines.join('\n').split('\n'))

  it('picks the part of each file most like the code before the cursor, best first', () => {
    const prefix = 'const user = await fetchUser(userId)\nif (!user.active) return null\n'
    const near = make(['export async function fetchUser(userId: string) {', '  const user = await db.users.find(userId)', '  if (!user) throw new Error()', '  return user', '}'])
    const far = make(['body { color: red }', 'h1 { margin: 0 }'])
    const some = make(['// settings', 'const active = true'])
    const picked = pickSnippets(prefix, [
      { path: 'far.css', doc: far },
      { path: 'some.ts', doc: some },
      { path: 'users.ts', doc: near },
    ])
    assert.deepEqual(
      picked.map((part) => part.path),
      ['users.ts', 'some.ts'],
    )
    assert.ok(picked[0].text.includes('fetchUser'))
  })

  it('sends at most a few, and none for an empty prefix', () => {
    const doc = make(['alpha beta gamma delta'])
    const others = Array.from({ length: 6 }, (_, n) => ({ path: `f${n}.ts`, doc }))
    assert.equal(pickSnippets('alpha beta gamma delta', others).length, INLINE_SNIPPETS)
    assert.deepEqual(pickSnippets('  \n', others), [])
  })
})

describe('the ghost as the text changes', () => {
  const ghost = { pos: 6, text: 'return a + b' }
  const at6 = ts('{\n    \n}', 6)

  it('stays, shorter, while what is typed is what it starts with', () => {
    const tr = at6.update({ changes: { from: 6, insert: 're' }, selection: EditorSelection.cursor(8), origin: 'input.type' })
    assert.deepEqual(followGhost(ghost, tr), { pos: 8, text: 'turn a + b' })
  })

  it('goes on other typing, a moved cursor, or once it is all typed', () => {
    assert.equal(followGhost(ghost, at6.update({ changes: { from: 6, insert: 'x' }, selection: EditorSelection.cursor(7), origin: 'input.type' })), null)
    assert.equal(followGhost(ghost, at6.update({ selection: EditorSelection.cursor(2) })), null)
    assert.equal(followGhost(ghost, at6.update({ changes: { from: 6, insert: 're' }, selection: EditorSelection.cursor(8), origin: 'input.paste' })), null)
    assert.equal(
      followGhost(ghost, at6.update({ changes: { from: 6, insert: ghost.text }, selection: EditorSelection.cursor(6 + ghost.text.length), origin: 'input.ghost' })),
      null,
    )
    assert.deepEqual(followGhost(ghost, at6.update({ config: { tabSize: 2 } })), ghost, 'a change that moves nothing keeps it')
  })
})

describe('taking a suggestion a word at a time', () => {
  it('takes the next word with the spaces before it, or a run of other characters, or a line break and its indentation', () => {
    assert.equal(nextWord('return a + b'), 'return')
    assert.equal(nextWord(' a + b'), ' a')
    assert.equal(nextWord(' + b'), ' +')
    assert.equal(nextWord('();'), '();')
    assert.equal(nextWord('\n    next()'), '\n    ')
    assert.equal(nextWord('   '), '   ')
    assert.equal(nextWord('名前 = 1'), '名前')
  })
})

describe('answers kept for the places they were asked for', () => {
  it('keeps the newest few and forgets the oldest', () => {
    const cache = new GhostCache(2)
    cache.set('a', '1')
    cache.set('b', '2')
    assert.equal(cache.get('a'), '1', 'a read makes it the newest')
    cache.set('c', '3')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('a'), '1')
    assert.equal(cache.get('c'), '3')
    cache.clear()
    assert.equal(cache.get('a'), undefined)
  })

  it('tells places apart by the file and the text near the cursor only', () => {
    const far = 'x'.repeat(5_000)
    assert.equal(GhostCache.key('a.ts', `1${far}near`, 'after'), GhostCache.key('a.ts', `2${far}near`, 'after'))
    assert.notEqual(GhostCache.key('a.ts', 'near', 'after'), GhostCache.key('b.ts', 'near', 'after'))
    assert.notEqual(GhostCache.key('a.ts', 'near', 'after'), GhostCache.key('a.ts', 'near', 'later'))
  })
})

describe('the status line', () => {
  const on = { on: true, reason: 'Suggestions come from Model.' }

  it('shows nothing while the suggestions are off', () => {
    assert.equal(ghostFooter({ kind: 'idle' }, { on: false, reason: 'Off.' }), null)
    assert.equal(ghostFooter({ kind: 'stopped', message: 'x' }, null), null)
  })

  it('says how they stand, and why when they cannot come', () => {
    assert.deepEqual(ghostFooter({ kind: 'idle' }, on), { text: '', title: 'Suggestions as you type are on. Suggestions come from Model. Alt+\\ asks at once. Click for the settings.', tone: 'idle' })
    assert.equal(ghostFooter({ kind: 'asking' }, on)?.tone, 'busy')
    assert.deepEqual(ghostFooter({ kind: 'paused', message: 'The model is busy.' }, on), { text: 'Paused', title: 'Suggestions as you type are paused. The model is busy.', tone: 'warning' })
    assert.equal(ghostFooter({ kind: 'stopped', message: 'The key was refused.' }, on)?.title, 'Suggestions as you type stopped. The key was refused. They start again once the settings change.')
  })
})
