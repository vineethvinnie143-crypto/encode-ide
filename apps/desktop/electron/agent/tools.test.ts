import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseToolArguments } from './tools'

describe('parseToolArguments', () => {
  it('reads a JSON object, and treats no arguments as an empty one', () => {
    assert.deepEqual(parseToolArguments('{"path":"a.ts","depth":2}'), { input: { path: 'a.ts', depth: 2 } })
    assert.deepEqual(parseToolArguments(''), { input: {} })
    assert.deepEqual(parseToolArguments('  '), { input: {} })
  })

  it('says why arguments cannot be used instead of running the tool without them', () => {
    // What a reply cut off by the output limit leaves behind.
    const truncated = parseToolArguments('{"path":"src/app.ts","content":"export const')
    assert.deepEqual(truncated.input, {})
    assert.match(truncated.error ?? '', /not valid JSON/)
    for (const raw of ['[1,2]', '"text"', '42', 'null']) {
      assert.equal(parseToolArguments(raw).error, 'the arguments are not a JSON object', raw)
    }
  })
})
