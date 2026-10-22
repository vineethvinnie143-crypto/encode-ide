import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { repairJson, repairJsonText } from './json-repair'

describe('repairJsonText', () => {
  it('passes valid JSON through untouched', () => {
    assert.deepEqual(repairJsonText('{"path":"a.ts","limit":20}'), { value: { path: 'a.ts', limit: 20 }, repairs: [], truncated: false })
  })

  const fixed: Array<[name: string, raw: string, value: unknown, repair: string]> = [
    ['a code fence', '```json\n{"path": "a.ts"}\n```', { path: 'a.ts' }, 'removed a code fence'],
    ['prose around the JSON', 'Here you go: {"path": "a.ts"} hope that helps', { path: 'a.ts' }, 'removed text around the JSON'],
    ['a trailing comma', '{"a": 1, "b": [1, 2,],}', { a: 1, b: [1, 2] }, 'removed a trailing comma'],
    ['single quotes', "{'path': 'it\\'s.ts'}", { path: "it's.ts" }, 'replaced single quotes'],
    ['a double quote inside single quotes', `{'say': 'a "b" c'}`, { say: 'a "b" c' }, 'replaced single quotes'],
    ['Python literals', "{'recursive': True, 'limit': None, 'dry': False}", { recursive: true, limit: null, dry: false }, 'replaced Python literals'],
    ['unquoted keys', '{path: "a.ts", start_line: 3}', { path: 'a.ts', start_line: 3 }, 'quoted keys'],
    ['raw newlines and tabs in a string', '{"content": "line one\nline\ttwo"}', { content: 'line one\nline\ttwo' }, 'escaped control characters in strings'],
    ['a Windows path with bad escapes', '{"path": "C:\\Users\\hi\\x.ts"}', { path: 'C:\\Users\\hi\\x.ts' }, 'fixed invalid escapes'],
    ["an escaped single quote in double quotes", '{"text": "it\\\'s"}', { text: "it's" }, 'fixed invalid escapes'],
    ['comments', '{\n  // the file\n  "path": "a.ts" /* yes */\n}', { path: 'a.ts' }, 'removed comments'],
    ['a missing comma', '{"a": 1 "b": 2}', { a: 1, b: 2 }, 'added a missing comma'],
    ['a leading-dot number', '{"ratio": .5, "n": +3}', { ratio: 0.5, n: 3 }, 'normalized numbers'],
    ['an extra comma', '{"a": 1,, "b": 2}', { a: 1, b: 2 }, 'removed an extra comma'],
    ['= instead of :', '{"a" = 1}', { a: 1 }, 'replaced = with :'],
    ['a bare value', '{"mode": fast}', { mode: 'fast' }, 'quoted bare values'],
    ['NaN', '{"n": NaN}', { n: null }, 'replaced a non-number with null'],
  ]
  for (const [name, raw, value, repair] of fixed) {
    it(`fixes ${name}`, () => {
      const result = repairJsonText(raw)
      assert.ok(result, `no repair for ${raw}`)
      assert.deepEqual(result.value, value)
      assert.ok(result.repairs.includes(repair), `expected "${repair}" in ${JSON.stringify(result.repairs)}`)
      assert.equal(result.truncated, false)
      assert.deepEqual(repairJson(raw), value)
    })
  }

  it('decodes an object encoded as a string, once', () => {
    const result = repairJsonText(JSON.stringify(JSON.stringify({ path: 'a.ts' })))
    assert.deepEqual(result?.value, { path: 'a.ts' })
    assert.ok(result?.repairs.includes('decoded JSON inside a string'))
    // A plain string stays a string.
    assert.equal(repairJsonText('"just text"')?.value, 'just text')
  })

  const cut: Array<[name: string, raw: string]> = [
    ['inside a string', '{"path": "a.ts", "content": "half of the fi'],
    ['before a value', '{"path": "a.ts", "content":'],
    ['after a key', '{"path": "a.ts", "content"'],
    ['with an open object', '{"path": "a.ts"'],
    ['with an open array', '{"paths": ["a.ts", "b.ts"'],
    ['after an escape', '{"text": "abc\\'],
  ]
  for (const [name, raw] of cut) {
    it(`reports text cut off ${name} as truncated, and the hook refuses it`, () => {
      assert.equal(repairJsonText(raw)?.truncated, true)
      assert.equal(repairJson(raw), undefined)
    })
  }

  const refused: Array<[name: string, raw: string]> = [
    ['two values glued together', '{"path": "a.ts"}{"path": "b.ts"}'],
    ['prose without JSON', 'I will read the file now.'],
    ['an unclosed comment', '{"a": 1 /* never closed'],
    ['a key without a colon', '{"a" 1}'],
    ['a stray symbol', '{"a": @}'],
  ]
  for (const [name, raw] of refused) {
    it(`refuses ${name}`, () => {
      assert.equal(repairJson(raw), undefined)
    })
  }

  it('leaves empty text to the caller', () => {
    assert.equal(repairJsonText('   '), undefined)
  })
})

/** Arbitrary JSON values with awkward strings: quotes, backslashes, control characters, unicode. */
const jsonValue: Gen<unknown> = (random, size) => {
  const leaf = gen.pick<unknown>(
    gen.int(-1_000_000, 1_000_000),
    gen.map(gen.int(0, 1_000_000), (n) => n / 1000),
    gen.oneOf<unknown>(true, false, null),
    gen.string('ab "\'\\\n\t/{}[]:,é😀\u0001', 0, 12),
  )
  if (size <= 1 || random() < 0.4) return leaf(random, size)
  const child: Gen<unknown> = (r, s) => jsonValue(r, Math.floor(s / 2))
  return random() < 0.5
    ? gen.array(child, 0, 4)(random, size)
    : Object.fromEntries(gen.array(gen.tuple(gen.string('abcxyz_ "\\', 1, 6), child), 0, 4)(random, size))
}

describe('repairJsonText properties', () => {
  it('returns every valid arguments object unchanged, with no repairs', async () => {
    // Tool arguments are objects; a bare string holding JSON is decoded on purpose.
    await check(jsonValue, (value) => {
      const args = { value }
      const result = repairJsonText(JSON.stringify(args))
      assert.ok(result)
      assert.deepEqual(result.value, args)
      assert.deepEqual(result.repairs, [])
    })
  })

  it('reads pretty-printed JSON with trailing commas back to the same value', async () => {
    await check(jsonValue, (value) => {
      if (value === null || typeof value !== 'object') return
      const pretty = JSON.stringify(value, null, 2).replace(/(\S)(\n\s*[}\]])/g, (match, last: string, close: string) =>
        last === '{' || last === '[' ? match : `${last},${close}`,
      )
      assert.deepEqual(repairJson(pretty), value)
    })
  })

  it('never accepts a cut-off object as complete', async () => {
    const cutObject = gen.tuple(jsonValue, gen.int(1, 1000))
    await check(cutObject, ([value, at]) => {
      const object = { value, tail: 'end' }
      const text = JSON.stringify(object)
      const cutAt = 1 + (at % (text.length - 1))
      // Any proper prefix lacks the final brace, so it is truncated or unreadable, never a different "complete" value.
      const repaired = repairJson(text.slice(0, cutAt))
      assert.equal(repaired, undefined, `accepted ${JSON.stringify(text.slice(0, cutAt))}`)
    })
  })
})
