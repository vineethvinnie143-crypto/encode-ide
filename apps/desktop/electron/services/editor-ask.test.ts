import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noAnswer, readEditorAsk } from './editor-ask'

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

  it('gets an empty answer of its kind when nothing answers', () => {
    assert.deepEqual(noAnswer('highlights'), [])
    assert.equal(noAnswer('complete'), null)
    assert.equal(noAnswer(undefined), null)
  })
})
