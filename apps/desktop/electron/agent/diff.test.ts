import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import type { DiffHunk } from '../../shared/types'
import { buildDiff } from './diff'

/** Replays hunks over `before`, asserting every context and deleted line on the way. */
function apply(before: string, hunks: DiffHunk[]): string {
  const source = before.split('\n')
  const out: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1
    assert.ok(start >= cursor, 'hunks overlap or are out of order')
    out.push(...source.slice(cursor, start))
    cursor = start
    assert.equal(hunk.newStart - 1, out.length, 'newStart does not match the output position')
    let oldLines = 0
    let newLines = 0
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        assert.equal(line.newNo, out.length + 1)
        out.push(line.text)
        newLines++
        continue
      }
      assert.equal(source[cursor], line.text, `${line.type} line differs from old line ${cursor + 1}`)
      assert.equal(line.oldNo, cursor + 1)
      if (line.type === 'ctx') {
        assert.equal(line.newNo, out.length + 1)
        out.push(line.text)
        newLines++
      }
      oldLines++
      cursor++
    }
    assert.equal(hunk.oldLines, oldLines)
    assert.equal(hunk.newLines, newLines)
  }
  out.push(...source.slice(cursor))
  return out.join('\n')
}

function lcs(a: string[], b: string[]): number {
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

const lines = gen.array(gen.oneOf('alpha', 'beta', 'gamma', 'delta', '', '}'))
const texts = gen.tuple(gen.map(lines, (list) => list.join('\n')), gen.map(lines, (list) => list.join('\n')))

describe('buildDiff', () => {
  it('returns no hunks for identical text', () => {
    assert.deepEqual(buildDiff('a.txt', 'one\ntwo', 'one\ntwo'), [])
  })

  it('keeps three lines of context around a change', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const after = before.replace('line 10', 'line ten')
    const hunks = buildDiff('a.txt', before, after)
    assert.equal(hunks.length, 1)
    assert.deepEqual(
      { oldStart: hunks[0].oldStart, oldLines: hunks[0].oldLines, newStart: hunks[0].newStart, newLines: hunks[0].newLines },
      { oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 },
    )
    assert.deepEqual(
      hunks[0].lines.map((line) => line.type),
      ['ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx'],
    )
  })

  it('merges nearby changes and splits distant ones', () => {
    const before = Array.from({ length: 40 }, (_, index) => `l${index + 1}`).join('\n')
    const near = before.replace('l10\n', 'x10\n').replace('l16\n', 'x16\n')
    assert.equal(buildDiff('a', before, near).length, 1)
    const far = before.replace('l10\n', 'x10\n').replace('l30\n', 'x30\n')
    assert.equal(buildDiff('a', before, far).length, 2)
  })

  it('shows a removed trailing newline', () => {
    const hunks = buildDiff('a', 'a\nb\n', 'a\nb')
    assert.equal(apply('a\nb\n', hunks), 'a\nb')
    assert.deepEqual(
      hunks[0].lines.filter((line) => line.type !== 'ctx'),
      [{ type: 'del', text: '', oldNo: 3 }],
    )
  })

  it('falls back to a full replacement when the edit distance is huge, and stays correct', () => {
    const before = Array.from({ length: 1500 }, (_, index) => `old ${index}`).join('\n')
    const after = Array.from({ length: 1500 }, (_, index) => `new ${index}`).join('\n')
    assert.equal(apply(before, buildDiff('a', before, after)), after)
  })

  it('produces hunks that turn the old text into the new text', async () => {
    await check(texts, ([before, after]) => {
      assert.equal(apply(before, buildDiff('a', before, after)), after)
    })
  })

  it('produces a minimal edit script', async () => {
    await check(texts, ([before, after]) => {
      const a = before.split('\n')
      const b = after.split('\n')
      const edits = buildDiff('a', before, after)
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.type !== 'ctx').length
      assert.equal(edits, a.length + b.length - 2 * lcs(a, b))
    })
  })
})
