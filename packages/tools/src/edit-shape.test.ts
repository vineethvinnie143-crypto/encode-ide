import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reshapeEdit, searchReplaceEdits } from './edit-shape'
import { editTool, multiEditTool } from './files'
import { ToolRegistry } from './registry'

const registry = new ToolRegistry()
registry.register(editTool)
registry.register(multiEditTool)

describe('Edit and MultiEdit calls sent in another shape', () => {
  it('reads one edit in a list sent to Edit as old_string and new_string', () => {
    const repaired = registry.repair('Edit', { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] })
    assert.deepEqual(repaired.value, { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    assert.equal(repaired.name, undefined)
    assert.deepEqual(repaired.fixes, ['"edits" with one change read as old_string and new_string'])
  })

  it('runs several edits sent to Edit as MultiEdit, unless the agent may not use it', () => {
    const input = { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }
    const repaired = registry.repair('Edit', input)
    assert.equal(repaired.name, 'MultiEdit')
    assert.deepEqual(repaired.value, input)
    assert.equal(registry.check('MultiEdit', repaired.value), undefined)
    const refused = registry.repair('Edit', input, (name) => name !== 'MultiEdit')
    assert.equal(refused.name, undefined)
    assert.match(registry.check('Edit', refused.value) ?? '', /old_string is required/)
  })

  it('reads one replacement sent to MultiEdit as a list of one', () => {
    const repaired = registry.repair('MultiEdit', { file_path: '/a.ts', old_str: 'a', new_str: 'b', replace_all: true })
    assert.deepEqual(repaired.value, { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] })
    assert.equal(registry.check('MultiEdit', repaired.value), undefined)
  })

  it('reads the str_replace command of a text editor tool as an Edit', () => {
    const repaired = registry.repair('Edit', { command: 'str_replace', path: '/a.ts', old_str: 'a', new_str: 'b' })
    assert.deepEqual(repaired.value, { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  })

  it('reads SEARCH/REPLACE blocks in either marker style', () => {
    const diff = [
      'src/a.ts',
      '```',
      '<<<<<<< SEARCH',
      'const a = 1',
      '=======',
      'const a = 2',
      '>>>>>>> REPLACE',
      '```',
      '------- SEARCH',
      'old()',
      '',
      '=======',
      '+++++++ REPLACE',
    ].join('\r\n')
    assert.deepEqual(searchReplaceEdits(diff), [
      { old_string: 'const a = 1', new_string: 'const a = 2' },
      { old_string: 'old()\n', new_string: '' },
    ])
    const repaired = registry.repair('Edit', { path: '/a.ts', diff })
    assert.equal(repaired.name, 'MultiEdit')
    assert.deepEqual(repaired.fixes[0], '2 changes in "diff" as SEARCH/REPLACE blocks made with MultiEdit, all or none')
  })

  it('reads a list written as JSON text', () => {
    const repaired = registry.repair('Edit', { file_path: '/a.ts', edits: '[{"old_string":"a","new_string":"b"}]' })
    assert.deepEqual(repaired.value, { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  })

  it('leaves alone what has no single reading', () => {
    // Both a replacement and a list: which one was meant?
    assert.equal(registry.repair('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b', edits: [{ old_string: 'c', new_string: 'd' }] }).fixes.length, 0)
    // Line numbers say where, not what: nothing to match.
    assert.equal(registry.repair('Edit', { file_path: '/a.ts', edits: [{ line: 3, text: 'x' }] }).fixes.length, 0)
    assert.equal(reshapeEdit({ file_path: '/a.ts', diff: 'no blocks here' }, 'Edit'), undefined)
    // A call that passes is never changed.
    assert.deepEqual(registry.repair('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }).fixes, [])
  })
})
