import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { applyHunk, diffContents, hunkHeader, reverseHunk } from './hunks'
import { parseRaw } from './raw'
import { compareBytes } from './review'
import { parseStatus } from './status'
import { decode, encode, splitLines, type TextContent } from './text'

const text = (value: string): TextContent => {
  const content = decode(Buffer.from(value, 'utf8'))
  assert.equal(content.kind, 'text')
  return content as TextContent
}
const asString = (content: TextContent) => encode(content).toString('utf8')
/** Built from its code point: written out, the mark would be an invisible character in the source. */
const BOM = String.fromCodePoint(0xfeff)

describe('reading what git status says', () => {
  it('reads the branch, ordinary, renamed, unmerged and untracked entries, paths with spaces included', () => {
    const zero = '0'.repeat(40)
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const output = [
      '# branch.oid ' + a,
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      `1 .M N... 100644 100644 100644 ${a} ${a} src/with space.ts`,
      `1 A. N... 000000 100644 100644 ${zero} ${b} new.ts`,
      `2 R. N... 100644 100644 100644 ${a} ${a} R100 renamed.ts`,
      'old name.ts',
      `u UU N... 100644 100644 100644 100644 ${a} ${b} ${a} conflict.ts`,
      '? notes/ünïcode.md',
      '',
    ].join('\0')
    const status = parseStatus(output)
    assert.deepEqual(status.branch, { oid: a, head: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 })
    assert.deepEqual(
      status.entries.map((entry) => [entry.type, entry.x, entry.y, entry.path, entry.origPath ?? '']),
      [
        ['ordinary', '.', 'M', 'src/with space.ts', ''],
        ['ordinary', 'A', '.', 'new.ts', ''],
        ['renamed', 'R', '.', 'renamed.ts', 'old name.ts'],
        ['unmerged', 'U', 'U', 'conflict.ts', ''],
        ['untracked', '?', '?', 'notes/ünïcode.md', ''],
      ],
    )
    assert.equal(status.entries[3].oids?.index, b, 'an unmerged path compares with our side')
  })

  it('knows a repository without commits and a detached HEAD', () => {
    assert.deepEqual(parseStatus('# branch.oid (initial)\0# branch.head main\0').branch, { oid: null, head: 'main' })
    assert.equal(parseStatus(`# branch.oid ${'c'.repeat(40)}\0# branch.head (detached)\0`).branch.head, null)
  })
})

describe('reading git diff --raw', () => {
  it('reads modifications, additions, deletions and renames with their scores', () => {
    const zero = '0'.repeat(40)
    const a = 'a'.repeat(40)
    const output = [`:100644 100644 ${a} ${zero} M`, 'src/a.ts', `:000000 100644 ${zero} ${a} A`, 'b c.ts', `:100644 000000 ${a} ${zero} D`, 'gone.ts', `:100644 100644 ${a} ${a} R087`, 'from.ts', 'to.ts', ''].join('\0')
    assert.deepEqual(
      parseRaw(output).map((entry) => [entry.status, entry.path, entry.oldPath ?? '', entry.score ?? '']),
      [
        ['M', 'src/a.ts', '', ''],
        ['A', 'b c.ts', '', ''],
        ['D', 'gone.ts', '', ''],
        ['R', 'to.ts', 'from.ts', 87],
      ],
    )
  })
})

describe('text as lines', () => {
  it('keeps each line’s ending, the byte order mark and a missing final newline', () => {
    const content = text(`${BOM}a\r\nb\nc`)
    assert.deepEqual(content.lines, ['a', 'b', 'c'])
    assert.deepEqual(content.endings, ['\r\n', '\n', ''])
    assert.equal(content.bom, true)
    assert.equal(asString(content), `${BOM}a\r\nb\nc`)
    assert.deepEqual(splitLines(''), { lines: [], endings: [] })
    assert.deepEqual(splitLines('x\n'), { lines: ['x'], endings: ['\n'] })
    assert.deepEqual(splitLines('a\rb\n'), { lines: ['a\rb'], endings: ['\n'] }, 'a lone carriage return stays in its line')
  })

  it('takes a NUL as binary, and bytes that are not UTF-8 as text it will not write back', () => {
    assert.equal(decode(Buffer.from([0x61, 0x00, 0x62])).kind, 'binary')
    const latin = decode(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    assert.equal(latin.kind, 'text')
    assert.equal((latin as TextContent).lossy, true)
    assert.equal(decode(Buffer.alloc(10, 0x61), 5).kind, 'large')
  })
})

describe('hunks', () => {
  it('groups changes with three lines around them, and marks the words that changed', () => {
    const before = text(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'const total = price * count', ''].join('\n'))
    const after = text(['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'const total = price * amount', ''].join('\n'))
    const diff = diffContents(before, after)
    assert.equal(diff.hunks.length, 2)
    assert.equal(diff.added, 2)
    assert.equal(diff.removed, 2)
    const [first, second] = diff.hunks
    assert.deepEqual([first.oldStart, first.oldLines, first.newStart, first.newLines], [1, 5, 1, 5])
    const added = second.lines.find((line) => line.kind === 'add')!
    assert.deepEqual(added.words, [[22, 28]])
    assert.equal(added.text.slice(22, 28), 'amount')
    assert.notEqual(first.id, second.id)
    assert.equal(diffContents(before, after).hunks[1].id, second.id, 'the same change has the same id')
  })

  it('shows a final newline added or removed as a change of the last line', () => {
    const diff = diffContents(text('a\nb'), text('a\nb\n'))
    assert.equal(diff.hunks.length, 1)
    const lines = diff.hunks[0].lines.filter((line) => line.kind !== 'ctx')
    assert.deepEqual(lines.map((line) => [line.kind, line.text, Boolean(line.noEol)]), [
      ['del', 'b', true],
      ['add', 'b', false],
    ])
  })

  it('can ignore whitespace, and then lines that differ only in it are unchanged', () => {
    const diff = diffContents(text('if (a) {\n  b()\n}\n'), text('if (a) {\n    b()\n}\n'), { ignoreWhitespace: true })
    assert.equal(diff.hunks.length, 0)
  })

  it('write their header the way git does', () => {
    assert.equal(hunkHeader({ oldStart: 3, oldLines: 7, newStart: 3, newLines: 8 }), '@@ -3,7 +3,8 @@')
    assert.equal(hunkHeader(diffContents(text(''), text('a\n')).hunks[0]), '@@ -0,0 +1 @@')
    assert.equal(hunkHeader(diffContents(text('a\nb\nc\n'), text('a\nc\n'), { context: 0 }).hunks[0]), '@@ -2 +1,0 @@')
    assert.equal(hunkHeader(diffContents(text('a\nc\n'), text('a\nb\nc\n'), { context: 0 }).hunks[0]), '@@ -1,0 +2 @@')
  })

  it('show the whole file with infinite context', () => {
    const diff = diffContents(text('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'), text('1\n2\n3\n4\n5\n6\n7\n8\n9\nten\n'), { context: Infinity })
    assert.equal(diff.hunks.length, 1)
    assert.equal(diff.hunks[0].lines.length, 11)
  })

  const lines = gen.array(gen.oneOf('a', 'b', 'c', '', 'd e', 'x'), 0, 14)
  const file = (items: string[], finalNewline: boolean) => text(items.join('\n') + (items.length && finalNewline ? '\n' : ''))

  it('put in one by one from the last, turn the old version into the new one; taken out, the other way', async () => {
    await check(
      gen.tuple(lines, lines, gen.oneOf(true, false), gen.oneOf(true, false), gen.int(0, 4)),
      ([a, b, endA, endB, context]) => {
        const before = file(a, endA)
        const after = file(b, endB)
        const { hunks } = diffContents(before, after, { context })
        let forward: TextContent | null = before
        for (const hunk of [...hunks].reverse()) forward = forward && applyHunk(forward, hunk)
        assert.ok(forward, 'every hunk fits')
        assert.equal(asString(forward!), asString(after))
        let backward: TextContent | null = after
        for (const hunk of [...hunks].reverse()) backward = backward && reverseHunk(backward, hunk)
        assert.ok(backward)
        assert.equal(asString(backward!), asString(before))
      },
      { runs: 400 },
    )
  })

  it('put in alone, leave the other changes as they were', async () => {
    await check(
      gen.tuple(lines, lines),
      ([a, b]) => {
        const before = file(a, true)
        const after = file(b, true)
        const { hunks } = diffContents(before, after, { context: 1 })
        for (const hunk of hunks) {
          const staged = applyHunk(before, hunk)
          assert.ok(staged)
          // What is left between the staged version and the new one is every other hunk, unchanged.
          const rest = diffContents(staged!, after, { context: 1 }).hunks
          assert.equal(rest.reduce((sum, item) => sum + item.added + item.removed, 0), hunks.reduce((sum, item) => sum + item.added + item.removed, 0) - hunk.added - hunk.removed)
        }
      },
      { runs: 300 },
    )
  })

  it('give lines a file gains its own line ending, and leave the others as they are', () => {
    const index = text('a\nb\nc\n')
    const worktree = text('a\r\nB\r\nc\r\n')
    const [hunk] = diffContents(index, worktree).hunks
    assert.equal(asString(applyHunk(index, hunk)!), 'a\nB\nc\n', 'staged into an LF index, the line is LF')
    assert.equal(asString(reverseHunk(worktree, hunk)!), 'a\r\nb\r\nc\r\n', 'reverted in a CRLF file, the line is CRLF')
  })

  it('refuse a version that is not the one they were made from', () => {
    const [hunk] = diffContents(text('a\nb\n'), text('a\nc\n')).hunks
    assert.equal(applyHunk(text('a\nz\n'), hunk), null)
    assert.equal(reverseHunk(text('a\nb\n'), hunk), null)
  })
})

describe('comparing versions git does not hold', () => {
  const options = { context: 3, ignoreWhitespace: false }
  it('draws the change, and offers its hunks only when it may be written back', () => {
    const shown = compareBytes({ path: 'a.ts', change: 'modified', old: Buffer.from('a\nb\n'), new: Buffer.from('a\nc\n'), editable: true }, options)
    assert.deepEqual([shown.kind, shown.added, shown.removed, shown.hunkActions, shown.hunks.length], ['text', 1, 1, true, 1])
    assert.match(shown.fingerprint, /^[0-9a-f]{40}$/)
    const fixed = compareBytes({ path: 'a.ts', change: 'modified', old: Buffer.from('a\nb\n'), new: Buffer.from('a\nc\n'), editable: false }, options)
    assert.deepEqual([fixed.hunkActions, fixed.hunkActionsOff], [false, undefined])
    assert.equal(fixed.fingerprint, shown.fingerprint, 'the same versions are the same picture')
  })

  it('names new and removed files, binary content, and a change only the endings make', () => {
    const added = compareBytes({ path: 'n.ts', change: 'added', old: null, new: Buffer.from('x\n'), editable: true }, options)
    assert.deepEqual([added.change, added.added, added.removed], ['added', 1, 0])
    const removed = compareBytes({ path: 'n.ts', change: 'deleted', old: Buffer.from('x\ny\n'), new: null, editable: true }, options)
    assert.deepEqual([removed.added, removed.removed], [0, 2])
    const binary = compareBytes({ path: 'logo.png', change: 'modified', old: Buffer.from([0x89, 0, 1]), new: Buffer.from([0x89, 0, 2]), editable: true }, options)
    assert.deepEqual([binary.kind, binary.hunkActions], ['binary', false])
    const endings = compareBytes({ path: 'e.ts', change: 'modified', old: Buffer.from('a\nb\n'), new: Buffer.from('a\r\nb\r\n'), editable: true }, options)
    assert.deepEqual([endings.hunks.length, endings.note], [0, 'Only the line endings changed (LF to CRLF).'])
  })
})
