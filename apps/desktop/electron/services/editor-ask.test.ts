import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noAnswer, readEditorAsk, readEditorChange } from './editor-ask'

/** The folder's own paths only, as the workspace service checks them. */
const relative = (path: string) => (path.startsWith('..') || path.startsWith('/') ? null : path.replace(/\\/g, '/'))

describe('a question of the editor to the language servers', () => {
  it('is rebuilt from the fields each kind has, and nothing else', () => {
    assert.deepEqual(readEditorAsk({ kind: 'complete', path: 'src\\a.ts', line: 3, character: 7, triggerKind: 2, triggerCharacter: '.', extra: 'dropped' }, relative), {
      kind: 'complete',
      path: 'src/a.ts',
      line: 3,
      character: 7,
      triggerKind: 2,
      triggerCharacter: '.',
    })
    assert.deepEqual(readEditorAsk({ kind: 'resolve', path: 'a.ts', list: 4, id: 12 }, relative), { kind: 'resolve', path: 'a.ts', list: 4, id: 12 })
    assert.deepEqual(readEditorAsk({ kind: 'triggers', path: 'a.ts', line: 'ignored' }, relative), { kind: 'triggers', path: 'a.ts' })
    assert.deepEqual(readEditorAsk({ kind: 'references', path: 'a.ts', line: 0, character: 0 }, relative), { kind: 'references', path: 'a.ts', line: 0, character: 0 })
    const active = { signatures: [{ label: 'f(a)' }], activeSignature: 0 }
    assert.deepEqual(readEditorAsk({ kind: 'signature', path: 'a.ts', line: 1, character: 2, triggerKind: 3, isRetrigger: true, active }, relative), {
      kind: 'signature',
      path: 'a.ts',
      line: 1,
      character: 2,
      triggerKind: 3,
      isRetrigger: true,
      active,
    })
  })

  it('is refused for a path outside the folder, a kind it does not know, or fields that are not what they should be', () => {
    const refused: unknown[] = [
      null,
      'hover',
      { kind: 'hover', path: '../secret.ts', line: 0, character: 0 },
      { kind: 'execute', path: 'a.ts', line: 0, character: 0 },
      { kind: 'hover', path: 'a.ts', line: -1, character: 0 },
      { kind: 'hover', path: 'a.ts', line: 1.5, character: 0 },
      { kind: 'hover', path: 'a.ts', line: 0 },
      { kind: 'complete', path: 'a.ts', line: 0, character: 0, triggerKind: 4 },
      { kind: 'complete', path: 'a.ts', line: 0, character: 0, triggerKind: 2, triggerCharacter: 'long' },
      { kind: 'signature', path: 'a.ts', line: 0, character: 0, triggerKind: 1 },
      { kind: 'signature', path: 'a.ts', line: 0, character: 0, triggerKind: 1, isRetrigger: false, active: { signatures: 'no' } },
      { kind: 'signature', path: 'a.ts', line: 0, character: 0, triggerKind: 1, isRetrigger: false, active: { signatures: [{ label: 'x'.repeat(70_000) }] } },
      { kind: 'resolve', path: 'a.ts', list: 1 },
      { kind: 'resolve', path: 'a.ts', list: 1, id: 1e9 },
      { kind: 'definition', path: 42, line: 0, character: 0 },
    ]
    for (const value of refused) assert.equal(readEditorAsk(value, relative), null, JSON.stringify(value)?.slice(0, 120))
  })

  it('takes a range, the kinds of action, how the editor indents and the character typed for the questions that need them', () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 3, character: 0 }, extra: true }
    const clean = { start: { line: 1, character: 2 }, end: { line: 3, character: 0 } }
    assert.deepEqual(readEditorAsk({ kind: 'codeActions', path: 'a.ts', range, only: ['quickfix', 'source.organizeImports'], automatic: true }, relative), { kind: 'codeActions', path: 'a.ts', range: clean, automatic: true, only: ['quickfix', 'source.organizeImports'] })
    assert.deepEqual(readEditorAsk({ kind: 'format', path: 'a.ts', tabSize: 2, insertSpaces: true }, relative), { kind: 'format', path: 'a.ts', tabSize: 2, insertSpaces: true })
    assert.deepEqual(readEditorAsk({ kind: 'format', path: 'a.ts', range, tabSize: 4, insertSpaces: false }, relative), { kind: 'format', path: 'a.ts', range: clean, tabSize: 4, insertSpaces: false })
    assert.deepEqual(readEditorAsk({ kind: 'formatOnType', path: 'a.ts', line: 0, character: 3, ch: ';', tabSize: 2, insertSpaces: true }, relative), { kind: 'formatOnType', path: 'a.ts', line: 0, character: 3, ch: ';', tabSize: 2, insertSpaces: true })
    assert.deepEqual(readEditorAsk({ kind: 'prepareRename', path: 'a.ts', line: 0, character: 3 }, relative), { kind: 'prepareRename', path: 'a.ts', line: 0, character: 3 })
    const refused: unknown[] = [
      { kind: 'codeActions', path: 'a.ts', range, automatic: 'yes' },
      { kind: 'codeActions', path: 'a.ts', range: { start: { line: 3, character: 0 }, end: { line: 1, character: 0 } }, automatic: true },
      { kind: 'codeActions', path: 'a.ts', range, automatic: true, only: [] },
      { kind: 'codeActions', path: 'a.ts', range, automatic: true, only: ['quick fix'] },
      { kind: 'codeActions', path: 'a.ts', range, automatic: true, only: Array.from({ length: 9 }, () => 'quickfix') },
      { kind: 'format', path: 'a.ts', tabSize: 0, insertSpaces: true },
      { kind: 'format', path: 'a.ts', tabSize: 2 },
      { kind: 'format', path: 'a.ts', tabSize: 2, insertSpaces: true, range: { start: { line: 0 } } },
      { kind: 'formatOnType', path: 'a.ts', line: 0, character: 3, ch: ';;;', tabSize: 2, insertSpaces: true },
    ]
    for (const value of refused) assert.equal(readEditorAsk(value, relative), null, JSON.stringify(value)?.slice(0, 120))
  })

  it('takes the questions about symbols and calls, a search across the folder with no file shown included', () => {
    assert.deepEqual(readEditorAsk({ kind: 'symbols', path: 'src\\a.ts', line: 4 }, relative), { kind: 'symbols', path: 'src/a.ts' })
    assert.deepEqual(readEditorAsk({ kind: 'workspaceSymbols', path: '', query: 'Shape' }, relative), { kind: 'workspaceSymbols', path: '', query: 'Shape' })
    assert.deepEqual(readEditorAsk({ kind: 'workspaceSymbols', path: 'a.ts', query: '' }, relative), { kind: 'workspaceSymbols', path: 'a.ts', query: '' })
    assert.deepEqual(readEditorAsk({ kind: 'callHierarchy', path: 'a.ts', line: 2, character: 5, list: 9 }, relative), { kind: 'callHierarchy', path: 'a.ts', line: 2, character: 5 })
    assert.deepEqual(readEditorAsk({ kind: 'calls', path: 'a.ts', list: 3, id: 12, direction: 'outgoing', item: {} }, relative), { kind: 'calls', path: 'a.ts', list: 3, id: 12, direction: 'outgoing' })
    const refused: unknown[] = [
      { kind: 'workspaceSymbols', path: '', query: 'x'.repeat(201) },
      { kind: 'workspaceSymbols', path: '', query: 'two\nlines' },
      { kind: 'workspaceSymbols', path: '../outside.ts', query: 'x' },
      { kind: 'workspaceSymbols', path: '' },
      { kind: 'symbols', path: '' },
      { kind: 'symbols', path: '../outside.ts' },
      { kind: 'callHierarchy', path: 'a.ts', line: -1, character: 0 },
      { kind: 'calls', path: 'a.ts', list: 3, id: 1, direction: 'sideways' },
      { kind: 'calls', path: 'a.ts', list: 3, id: 10_001, direction: 'incoming' },
      { kind: 'calls', path: 'a.ts', list: 1.5, id: 1, direction: 'incoming' },
    ]
    for (const value of refused) assert.equal(readEditorAsk(value, relative), null, JSON.stringify(value)?.slice(0, 120))
  })

  it('takes the question of how a file folds, by its path alone', () => {
    assert.deepEqual(readEditorAsk({ kind: 'folding', path: 'src\\a.ts', ranges: [{}] }, relative), { kind: 'folding', path: 'src/a.ts' })
    for (const value of [{ kind: 'folding', path: '' }, { kind: 'folding', path: '../outside.ts' }, { kind: 'folding' }, { kind: 'folding', path: 5 }]) assert.equal(readEditorAsk(value, relative), null, JSON.stringify(value))
  })

  it('takes the questions for a file\'s semantic tokens by its path alone, and for its hints by a few screens of lines', () => {
    assert.deepEqual(readEditorAsk({ kind: 'semanticTokens', path: 'src\\a.ts', data: [1] }, relative), { kind: 'semanticTokens', path: 'src/a.ts' })
    assert.deepEqual(readEditorAsk({ kind: 'inlayHints', path: 'src\\a.ts', startLine: 10, endLine: 80, label: 'x' }, relative), { kind: 'inlayHints', path: 'src/a.ts', startLine: 10, endLine: 80 })
    assert.deepEqual(readEditorAsk({ kind: 'inlayHints', path: 'a.ts', startLine: 4, endLine: 4 }, relative), { kind: 'inlayHints', path: 'a.ts', startLine: 4, endLine: 4 })
    const refused = [
      { kind: 'semanticTokens', path: '../outside.ts' },
      { kind: 'inlayHints', path: '../outside.ts', startLine: 0, endLine: 5 },
      { kind: 'inlayHints', path: 'a.ts', startLine: 5, endLine: 4 },
      { kind: 'inlayHints', path: 'a.ts', startLine: 0, endLine: 2_001 },
      { kind: 'inlayHints', path: 'a.ts', startLine: -1, endLine: 5 },
      { kind: 'inlayHints', path: 'a.ts', startLine: 0.5, endLine: 5 },
      { kind: 'inlayHints', path: 'a.ts', startLine: 0 },
    ]
    for (const value of refused) assert.equal(readEditorAsk(value, relative), null, JSON.stringify(value))
  })

  it('takes a change with its file and the open files made the folder\'s own, and refuses anything else', () => {
    assert.deepEqual(readEditorChange({ kind: 'rename', path: 'src\\a.ts', line: 1, character: 2, newName: 'next', preview: false, open: ['src/a.ts', '../outside.ts', 7, 'b.ts'], extra: 1 }, relative), {
      kind: 'rename',
      path: 'src/a.ts',
      line: 1,
      character: 2,
      newName: 'next',
      preview: false,
      open: ['src/a.ts', 'b.ts'],
    })
    assert.deepEqual(readEditorChange({ kind: 'action', path: 'a.ts', list: 3, id: 0, preview: true, open: [] }, relative), { kind: 'action', path: 'a.ts', list: 3, id: 0, preview: true, open: [] })
    assert.deepEqual(readEditorChange({ kind: 'apply', id: 4, open: ['a.ts'] }, relative), { kind: 'apply', id: 4, open: ['a.ts'] })
    assert.deepEqual(readEditorChange({ kind: 'undo', id: 4, open: [] }, relative), { kind: 'undo', id: 4, open: [] })
    assert.deepEqual(readEditorChange({ kind: 'discard', id: 4 }, relative), { kind: 'discard', id: 4 })
    const refused: unknown[] = [
      null,
      { kind: 'write', path: 'a.ts', open: [] },
      { kind: 'rename', path: '../a.ts', line: 0, character: 0, newName: 'x', preview: false, open: [] },
      { kind: 'rename', path: 'a.ts', line: 0, character: 0, newName: 'two\nlines', preview: false, open: [] },
      { kind: 'rename', path: 'a.ts', line: 0, character: 0, newName: '   ', preview: false, open: [] },
      { kind: 'rename', path: 'a.ts', line: 0, character: 0, newName: 'x'.repeat(501), preview: false, open: [] },
      { kind: 'rename', path: 'a.ts', line: 0, character: 0, newName: 'x', open: [] },
      { kind: 'rename', path: 'a.ts', line: 0, character: 0, newName: 'x', preview: false },
      { kind: 'action', path: 'a.ts', list: 1, id: 5_000, preview: false, open: [] },
      { kind: 'apply', id: -1, open: [] },
      { kind: 'apply', id: 1, open: Array.from({ length: 2_001 }, () => 'a.ts') },
    ]
    for (const value of refused) assert.equal(readEditorChange(value, relative), null, JSON.stringify(value)?.slice(0, 120))
  })

  it('gets an empty answer of its kind when nothing answers', () => {
    assert.deepEqual(noAnswer('highlights'), [])
    assert.equal(noAnswer('complete'), null)
    assert.equal(noAnswer(undefined), null)
  })
})
