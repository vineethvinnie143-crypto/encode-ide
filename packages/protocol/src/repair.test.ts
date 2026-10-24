import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { repairInput } from './repair'
import { validate, type JsonSchema } from './schema'

const read: JsonSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, pages: { type: 'string' } },
  required: ['file_path'],
  additionalProperties: false,
}

const edits: JsonSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    edits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
        required: ['old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  required: ['file_path', 'edits'],
  additionalProperties: false,
}

const grep: JsonSchema = {
  type: 'object',
  properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, '-i': { type: 'boolean' } },
  required: ['pattern'],
}

describe('a tool call mended where it means one thing', () => {
  it('leaves a call that passes alone, even with names it could read otherwise', () => {
    const input = { file_path: 'a.ts', limit: 5 }
    assert.deepEqual(repairInput(input, read), { value: input, fixes: [] })
    const extra = { pattern: 'x', regex: 'y' }
    assert.equal(repairInput(extra, grep).value, extra)
  })

  it('reads numbers, booleans, lists and objects sent as text', () => {
    const fixed = repairInput({ file_path: 'a.ts', offset: '10', limit: ' 50 ' }, read)
    assert.deepEqual(fixed.value, { file_path: 'a.ts', offset: 10, limit: 50 })
    assert.deepEqual(fixed.fixes, ['"offset": "10" as 10', '"limit": " 50 " as 50'])

    assert.deepEqual(repairInput({ pattern: 'x', '-i': 'TRUE', paths: 'src' }, grep).value, { pattern: 'x', '-i': true, paths: ['src'] })
    assert.deepEqual(repairInput({ pattern: 'x', paths: '["a", "b"]' }, grep).value, { pattern: 'x', paths: ['a', 'b'] })
    const nested = repairInput({ file_path: 'a.ts', edits: '[{"old_string": "a", "new_string": "b"}]' }, edits)
    assert.deepEqual(nested.value, { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }] })
  })

  it('takes the names models give a parameter: its own in another case, or a known other name', () => {
    const fixed = repairInput({ path: 'a.ts', Limit: 5 }, read)
    assert.deepEqual(fixed.value, { file_path: 'a.ts', limit: 5 })
    assert.deepEqual(fixed.fixes, ['"path" as "file_path"', '"Limit" as "limit"'])
    const multi = repairInput({ filePath: 'a.ts', edits: [{ oldString: 'a', new: 'b', replaceAll: 'true' }] }, edits)
    assert.deepEqual(multi.value, { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] })
    // `path` is Grep's own parameter, so it is never read as another; `regex` is read as the pattern Grep needs.
    assert.deepEqual(repairInput({ regex: 'todo', path: 'src' }, grep).value, { pattern: 'todo', path: 'src' })
    // Two other names for one parameter leave a choice, even where the schema would take the one left over.
    const open: JsonSchema = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    const both = { path: 'a.ts', file: 'b.ts' }
    assert.equal(repairInput(both, open).value, both)
  })

  it('leaves out a null the model sent for a parameter it may leave out', () => {
    const fixed = repairInput({ file_path: 'a.ts', offset: null, limit: '20' }, read)
    assert.deepEqual(fixed.value, { file_path: 'a.ts', limit: 20 })
    assert.deepEqual(fixed.fixes, ['"offset": null left out', '"limit": "20" as 20'])
  })

  it('unwraps a list of one where one value is asked for, and writes a number as text where text is', () => {
    assert.deepEqual(repairInput({ file_path: ['a.ts'] }, read).value, { file_path: 'a.ts' })
    assert.deepEqual(repairInput({ pattern: 404 }, grep).value, { pattern: '404' })
  })

  it('changes nothing when a reading is not the only one, or the call still fails', () => {
    const cases: [Record<string, unknown>, JsonSchema][] = [
      [{ file_path: 'a.ts', limit: '5.5' }, read],
      [{ file_path: 'a.ts', limit: 'all' }, read],
      [{ file_path: 'a.ts', offset: '0' }, read],
      [{ path: 'a.ts', file: 'b.ts' }, read],
      [{ file_path: ['a.ts', 'b.ts'] }, read],
      [{ file_path: null }, read],
      [{ pattern: 'x', paths: '["a", {"b": 1}]' }, grep],
      [{ file_path: 'a.ts', limit: 5, extra: 1 }, read],
    ]
    for (const [input, schema] of cases) {
      const result = repairInput(input, schema)
      assert.equal(result.value, input, JSON.stringify(input))
      assert.deepEqual(result.fixes, [])
      assert.ok(validate(input, schema).length > 0)
    }
  })

  it('never reads into a choice between shapes', () => {
    const either: JsonSchema = { type: 'object', properties: { at: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }] } }, required: ['at'] }
    const input = { at: '3' }
    assert.equal(repairInput(input, either).value, input)
  })
})
