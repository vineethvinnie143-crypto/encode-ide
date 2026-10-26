import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dataUrlText, encodeMappings, encodeVlq, resolveSource, SourceMap, SourceMapError } from './sourcemap'

describe('a source map', () => {
  it('reads the VLQ numbers it is written in', () => {
    // From the specification's examples: 0 is A, 1 is C, -1 is D, 16 is gB.
    assert.equal(encodeVlq(0), 'A')
    assert.equal(encodeVlq(1), 'C')
    assert.equal(encodeVlq(-1), 'D')
    assert.equal(encodeVlq(16), 'gB')
    const segments: [number, number, number, number, number][] = [
      [0, 0, 0, 0, 0],
      [0, 6, 0, 0, 6],
      [2, 2, 0, 3, 4],
      [2, 9, 1, 120, 0],
      [5, 0, 0, 7, 1_000_000],
    ]
    const map = SourceMap.parse({ version: 3, sources: ['a.ts', 'b.ts'], mappings: encodeMappings(segments) }, 'file:///work/dist/a.js.map')
    for (const [line, column, source, oLine, oColumn] of segments) assert.deepEqual(map.originalFor(line, column), { source, line: oLine, column: oColumn })
  })

  it('maps a generated place to the last segment at or before it on its line, and nothing before the first', () => {
    const map = SourceMap.parse({ version: 3, sources: ['src/a.ts'], mappings: encodeMappings([[1, 4, 0, 2, 0], [1, 10, 0, 3, 2]]) }, 'file:///work/dist/a.js.map')
    assert.deepEqual(map.originalFor(1, 4), { source: 0, line: 2, column: 0 })
    assert.deepEqual(map.originalFor(1, 9), { source: 0, line: 2, column: 0 })
    assert.deepEqual(map.originalFor(1, 50), { source: 0, line: 3, column: 2 })
    assert.equal(map.originalFor(1, 3), null)
    assert.equal(map.originalFor(0, 0), null)
    assert.equal(map.originalFor(7, 0), null)
    assert.deepEqual(map.sources, ['file:///work/dist/src/a.ts'])
  })

  it('finds the generated places of an original line, the first on each generated line', () => {
    const map = SourceMap.parse(
      { version: 3, sources: ['a.ts'], mappings: encodeMappings([[0, 0, 0, 0, 0], [3, 2, 0, 5, 2], [3, 8, 0, 5, 9], [4, 0, 0, 6, 0], [9, 4, 0, 5, 0]]) },
      'file:///w/a.js.map',
    )
    assert.deepEqual(map.generatedFor(0, 5), [
      { line: 3, column: 2, originalColumn: 2 },
      { line: 9, column: 4, originalColumn: 0 },
    ])
    assert.deepEqual(map.generatedFor(0, 4), [])
    assert.equal(map.nextMappedLine(0, 1), 5)
    assert.equal(map.nextMappedLine(0, 7), null)
    assert.equal(map.nextMappedLine(0, 1, 2), null)
  })

  it('reads an index map, its sections at their places and a source two sections share as one', () => {
    const map = SourceMap.parse(
      {
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: encodeMappings([[0, 0, 0, 0, 0]]) } },
          { offset: { line: 10, column: 20 }, map: { version: 3, sources: ['b.ts', 'a.ts'], mappings: encodeMappings([[0, 0, 0, 1, 0], [0, 5, 1, 7, 0], [1, 3, 0, 2, 0]]) } },
        ],
      },
      'file:///w/out.js.map',
    )
    assert.deepEqual(map.sources, ['file:///w/a.ts', 'file:///w/b.ts'])
    assert.deepEqual(map.originalFor(10, 20), { source: 1, line: 1, column: 0 })
    assert.deepEqual(map.originalFor(10, 25), { source: 0, line: 7, column: 0 })
    // Only the section's first line moves right.
    assert.deepEqual(map.originalFor(11, 3), { source: 1, line: 2, column: 0 })
    assert.deepEqual(map.generatedFor(0, 7), [{ line: 10, column: 25, originalColumn: 0 }])
  })

  it('resolves sources against the source root and the map, and keeps absolute paths of either system', () => {
    assert.equal(resolveSource('a.ts', '../src', 'file:///w/dist/a.js.map'), 'file:///w/src/a.ts')
    assert.equal(resolveSource('a.ts', '../src/', 'file:///w/dist/a.js.map'), 'file:///w/src/a.ts')
    assert.equal(resolveSource('/abs/a.ts', undefined, 'file:///w/dist/a.js.map'), 'file:///abs/a.ts')
    assert.equal(resolveSource('C:\\Work\\src\\my file.ts', undefined, 'file:///C:/Work/dist/a.js.map'), 'file:///C:/Work/src/my%20file.ts')
    assert.equal(resolveSource('a.ts', 'c:\\work\\src', 'file:///C:/Work/dist/a.js.map'), 'file:///C:/work/src/a.ts')
    assert.equal(resolveSource('webpack://app/./src/a.ts', undefined, 'file:///w/a.js.map'), 'webpack://app/src/a.ts')
    assert.equal(resolveSource('..\\src\\a.ts', undefined, 'file:///C:/w/dist/a.js.map'), 'file:///C:/w/src/a.ts')
  })

  it('keeps the text a map carries for its sources', () => {
    const map = SourceMap.parse({ version: 3, sources: ['a.ts', 'b.ts'], sourcesContent: ['const a = 1\n', null], mappings: '' }, 'file:///w/a.js.map')
    assert.deepEqual(map.contents, ['const a = 1\n', null])
  })

  it('drops segments that name what is not there, and refuses a map it cannot read', () => {
    // A source past the end, and a negative original line: dropped, the rest kept (the numbers are relative, so the
    // last segment's line is -9 + 10).
    const map = SourceMap.parse({ version: 3, sources: ['a.ts'], mappings: `${encodeMappings([[0, 0, 0, 0, 0]])},${encodeVlq(2)}${encodeVlq(5)}AA,${encodeVlq(2)}${encodeVlq(-5)}${encodeVlq(-9)}A,${encodeVlq(2)}A${encodeVlq(10)}A` }, 'file:///w/a.js.map')
    assert.deepEqual(map.originalFor(0, 0), { source: 0, line: 0, column: 0 })
    assert.deepEqual(map.originalFor(0, 6), { source: 0, line: 1, column: 0 })
    assert.deepEqual(map.originalFor(0, 3), { source: 0, line: 0, column: 0 })
    for (const bad of [
      'not json',
      JSON.stringify({ version: 2, sources: [], mappings: '' }),
      JSON.stringify({ version: 3, mappings: '' }),
      JSON.stringify({ version: 3, sources: [], mappings: 'A!' }),
      JSON.stringify({ version: 3, sources: ['a'], mappings: 'AAAAAA' }),
      JSON.stringify({ version: 3, sources: ['a'], mappings: 'AA' }),
      JSON.stringify({ version: 3, sources: ['a'], mappings: 'g' }),
      JSON.stringify({ version: 3, sources: ['a'], mappings: '////////////////A' }),
      JSON.stringify({ version: 3, sections: [{ offset: { line: -1, column: 0 }, map: { version: 3, sources: [], mappings: '' } }] }),
      JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sections: [] } }] }),
    ]) {
      assert.throws(() => SourceMap.parse(bad, 'file:///w/a.js.map'), SourceMapError, bad)
    }
  })

  it('reads a map that starts with the line that keeps it from running', () => {
    const map = SourceMap.parse(`)]}'\n${JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'AAAA' })}`, 'file:///w/a.js.map')
    assert.deepEqual(map.originalFor(0, 0), { source: 0, line: 0, column: 0 })
  })

  it('sorts the segments of a line written out of order', () => {
    const mappings = `${encodeVlq(10)}AAA,${encodeVlq(-8)}ACA`
    const map = SourceMap.parse({ version: 3, sources: ['a.ts'], mappings }, 'file:///w/a.js.map')
    assert.deepEqual(map.originalFor(0, 2), { source: 0, line: 1, column: 0 })
    assert.deepEqual(map.originalFor(0, 11), { source: 0, line: 0, column: 0 })
  })

  it('reads the text of a data: URL', () => {
    const json = JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'AAAA' })
    assert.equal(dataUrlText(`data:application/json;charset=utf-8;base64,${Buffer.from(json).toString('base64')}`), json)
    assert.equal(dataUrlText(`data:application/json,${encodeURIComponent(json)}`), json)
    assert.equal(dataUrlText('file:///a.js.map'), null)
  })
})
