import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { applyHunks, diffHunks, diffLines, diffWords, toHunks, unapplyHunks, type DiffBlock } from './index'

function lcs(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1])
      diagonal = above
    }
  }
  return row[b.length]
}

/** Rebuilds `b` from `a` and the blocks, checking that unchanged runs really match. */
function rebuild(a: readonly string[], b: readonly string[], blocks: readonly DiffBlock[]): string[] {
  const out: string[] = []
  let x = 0
  let y = 0
  for (const block of blocks) {
    assert.ok(block.fromA >= x && block.fromB >= y, 'blocks are out of order')
    assert.equal(block.fromA - x, block.fromB - y, 'unchanged runs differ in length')
    for (; x < block.fromA; x++, y++) {
      assert.equal(a[x], b[y], `line ${x} is reported unchanged but differs`)
      out.push(a[x])
    }
    assert.ok(block.toA > block.fromA || block.toB > block.fromB, 'empty block')
    out.push(...b.slice(block.fromB, block.toB))
    x = block.toA
    y = block.toB
  }
  assert.equal(a.length - x, b.length - y)
  for (; x < a.length; x++) out.push(a[x])
  return out
}

const lines = gen.array(gen.oneOf('alpha', 'beta', 'gamma', 'delta', '', '}', '{'))

describe('diffLines', () => {
  it('finds a minimal edit that rebuilds the new lines', async () => {
    await check(gen.tuple(lines, lines), ([a, b]) => {
      const { blocks, approximate } = diffLines(a, b)
      assert.equal(approximate, false)
      assert.deepEqual(rebuild(a, b, blocks), b)
      for (let index = 1; index < blocks.length; index++) {
        const previous = blocks[index - 1]
        assert.ok(blocks[index].fromA > previous.toA || blocks[index].fromB > previous.toB, 'touching blocks were not merged')
      }
      const changed = blocks.reduce((sum, block) => sum + (block.toA - block.fromA) + (block.toB - block.fromB), 0)
      assert.equal(changed, a.length + b.length - 2 * lcs(a, b))
    }, { runs: 300, maxSize: 40 })
  })

  it('handles the edges', () => {
    assert.deepEqual(diffLines([], []).blocks, [])
    assert.deepEqual(diffLines(['a'], ['a']).blocks, [])
    assert.deepEqual(diffLines([], ['a', 'b']).blocks, [{ fromA: 0, toA: 0, fromB: 0, toB: 2 }])
    assert.deepEqual(diffLines(['a', 'b'], []).blocks, [{ fromA: 0, toA: 2, fromB: 0, toB: 0 }])
    assert.deepEqual(diffLines(['a', 'x', 'c'], ['a', 'y', 'c']).blocks, [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }])
  })

  it('places an inserted function where it reads best', () => {
    const before = ['function a() {', '}', '', 'function c() {', '}']
    const after = ['function a() {', '}', '', 'function b() {', '}', '', 'function c() {', '}']
    const [block] = diffLines(before, after).blocks
    assert.deepEqual(after.slice(block.fromB, block.toB), ['', 'function b() {', '}'])
  })

  it('stays correct when the time limit cuts the search short', () => {
    const random = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const next = random(7)
    const a = Array.from({ length: 4000 }, () => String(Math.floor(next() * 50)))
    const b = Array.from({ length: 4000 }, () => String(Math.floor(next() * 50)))
    const result = diffLines(a, b, { timeoutMs: 0 })
    assert.equal(result.approximate, true)
    assert.deepEqual(rebuild(a, b, result.blocks), b)
  })

  it('diffs a large file with scattered edits quickly', () => {
    const a = Array.from({ length: 200_000 }, (_, index) => `line ${index}`)
    const b = a.slice()
    for (let index = 0; index < b.length; index += 997) b[index] = `changed ${index}`
    b.splice(5000, 0, 'inserted')
    const started = Date.now()
    const { blocks, approximate } = diffLines(a, b)
    assert.equal(approximate, false)
    assert.ok(Date.now() - started < 1500)
    assert.deepEqual(rebuild(a, b, blocks), b)
  })
})

describe('hunks', () => {
  const texts = gen.tuple(gen.map(lines, (list) => list.join('\n')), gen.map(lines, (list) => list.join('\n')))

  it('replay forwards and backwards', async () => {
    await check(texts, ([before, after]) => {
      for (const context of [0, 1, 3]) {
        const hunks = diffHunks(before, after, context)
        assert.deepEqual(applyHunks(before.split('\n'), hunks), after.split('\n'))
        assert.deepEqual(unapplyHunks(after.split('\n'), hunks), before.split('\n'))
        for (const hunk of hunks) {
          assert.equal(hunk.oldLines, hunk.lines.filter((line) => line.type !== 'add').length)
          assert.equal(hunk.newLines, hunk.lines.filter((line) => line.type !== 'del').length)
        }
      }
    }, { runs: 300 })
  })

  it('refuses to replay onto text that does not match', () => {
    const hunks = diffHunks('a\nb\nc', 'a\nB\nc')
    assert.equal(applyHunks(['a', 'x', 'c'], hunks), null)
    assert.equal(unapplyHunks(['a', 'b', 'c'], hunks), null)
    assert.equal(applyHunks(['a'], hunks), null)
  })

  it('numbers lines like a unified diff', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9']
    const [hunk] = toHunks(a, b, diffLines(a, b).blocks, 2)
    assert.equal(hunk.oldStart, 3)
    assert.equal(hunk.oldLines, 5)
    assert.equal(hunk.newStart, 3)
    assert.equal(hunk.newLines, 5)
    assert.deepEqual(
      hunk.lines.map((line) => `${line.type}:${line.text}:${line.oldNo ?? ''}:${line.newNo ?? ''}`),
      ['ctx:3:3:3', 'ctx:4:4:4', 'del:5:5:', 'add:five::5', 'ctx:6:6:6', 'ctx:7:7:7'],
    )
  })
})

describe('diffWords', () => {
  it('rebuilds the new string and keeps surrogate pairs whole', async () => {
    const strings = gen.string('ab c😀é_\n', 0, 30)
    await check(gen.tuple(strings, strings), ([a, b]) => {
      const blocks = diffWords(a, b)
      let out = ''
      let x = 0
      for (const block of blocks) {
        assert.equal(a.slice(x, block.fromA), b.slice(out.length, block.fromB))
        out += a.slice(x, block.fromA) + b.slice(block.fromB, block.toB)
        x = block.toA
        for (const offset of [block.fromA, block.toA]) {
          const code = a.charCodeAt(offset)
          assert.ok(!(code >= 0xdc00 && code <= 0xdfff), 'split a surrogate pair')
        }
      }
      out += a.slice(x)
      assert.equal(out, b)
    }, { runs: 300 })
  })

  it('marks whole changed words', () => {
    const blocks = diffWords('const value = 1', 'const total = 1')
    assert.deepEqual(blocks, [{ fromA: 6, toA: 11, fromB: 6, toB: 11 }])
  })
})
