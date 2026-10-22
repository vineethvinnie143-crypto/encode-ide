import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { languageForPath } from '@encode/editor'
import type { ReviewFile, ReviewHunk, ReviewLine, ReviewSnapshot } from '@shared/types'
import { commentsMessage, scopePhrase } from './comments'
import { HunkTokens, segmentsOf, tokenizeHunk } from './highlight'
import { columnsOf, expandTabs, wrappedLines } from './measure'
import { forAgent, inFolder, inRepository } from './paths'
import { buildRows, fileNote, firstChangedLine, hunkRange, lineAt, foldedPaths, layoutRows, pairLines, pinnedFile, rowAt, startsFolded, toggledForAll, ROW_HEIGHT, type ReviewComment, type Row } from './rows'

const ctx = (text: string, old: number, now: number): ReviewLine => ({ kind: 'ctx', text, old, new: now })
const del = (text: string, old: number): ReviewLine => ({ kind: 'del', text, old })
const add = (text: string, now: number, words?: Array<[number, number]>): ReviewLine => ({ kind: 'add', text, new: now, ...(words ? { words } : {}) })

function hunk(id: string, lines: ReviewLine[]): ReviewHunk {
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.filter((line) => line.kind === 'del').length
  return { id, oldStart: lines[0].old ?? 1, oldLines: lines.length - added, newStart: lines[0].new ?? 1, newLines: lines.length - removed, lines, added, removed }
}

function file(path: string, hunks: ReviewHunk[], extra: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    change: 'modified',
    kind: 'text',
    added: hunks.reduce((sum, item) => sum + item.added, 0),
    removed: hunks.reduce((sum, item) => sum + item.removed, 0),
    hunks,
    hunkActions: true,
    fingerprint: 'f'.repeat(40),
    ...extra,
  }
}

function snapshot(files: ReviewFile[]): ReviewSnapshot {
  return {
    scope: { kind: 'unstaged' },
    repo: { root: '/repo', folder: '', branch: 'main', head: 'a'.repeat(40) },
    files,
    added: 0,
    removed: 0,
    counts: { unstaged: files.length, staged: 0 },
    skipped: 0,
    readOnly: false,
    options: { context: 3, ignoreWhitespace: false },
  }
}

const app = file('src/app.ts', [hunk('h1', [ctx('a', 1, 1), del('b', 2), del('c', 3), add('B', 2), ctx('d', 4, 3)])])
const image = file('logo.png', [], { kind: 'binary', note: 'Binary file.', size: { old: 2048, new: 4096 }, hunkActions: false })
const kinds = (rows: Row[]) => rows.map((row) => row.kind)

describe('the review as rows', () => {
  it('gives each file a header, a note when its lines cannot be shown, and each hunk its lines', () => {
    const rows = buildRows(snapshot([app, image]), { layout: 'unified', collapsed: new Set(), comments: [], editing: null })
    assert.deepEqual(kinds(rows), ['file', 'hunk', 'line', 'line', 'line', 'line', 'line', 'gap', 'file', 'note', 'gap'])
    assert.equal((rows[9] as Extract<Row, { kind: 'note' }>).text, 'Binary file. 2.0 KB to 4.0 KB.')
    assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, 'keys are unique')
  })

  it('pairs removed and added lines side by side, kept lines on both sides', () => {
    assert.deepEqual(pairLines(app.hunks[0].lines), [
      [0, 0],
      [1, 3],
      [2, null],
      [4, 4],
    ])
    assert.deepEqual(pairLines([add('x', 1), add('y', 2)]), [
      [null, 0],
      [null, 1],
    ])
    const rows = buildRows(snapshot([app]), { layout: 'split', collapsed: new Set(), comments: [], editing: null })
    assert.deepEqual(kinds(rows), ['file', 'hunk', 'pair', 'pair', 'pair', 'pair', 'gap'])
  })

  it('folds a file to its header', () => {
    const rows = buildRows(snapshot([app, image]), { layout: 'unified', collapsed: new Set(['src/app.ts']), comments: [], editing: null })
    assert.deepEqual(kinds(rows), ['file', 'gap', 'file', 'note', 'gap'])
  })

  it('puts a comment under the line it is about, in either layout, and keeps one whose line is gone', () => {
    const onAdded: ReviewComment = { id: 'c1', path: 'src/app.ts', side: 'new', line: 2, text: 'Why?', excerpt: 'B' }
    const onRemoved: ReviewComment = { id: 'c2', path: 'src/app.ts', side: 'old', line: 3, text: 'Keep c', excerpt: 'c' }
    const gone: ReviewComment = { id: 'c3', path: 'src/app.ts', side: 'new', line: 90, text: 'Old note', excerpt: 'x' }
    const unified = buildRows(snapshot([app]), { layout: 'unified', collapsed: new Set(), comments: [onAdded, onRemoved, gone], editing: null })
    assert.deepEqual(kinds(unified), ['file', 'hunk', 'line', 'line', 'line', 'comment', 'line', 'comment', 'line', 'comment', 'gap'])
    assert.equal((unified[5] as Extract<Row, { kind: 'comment' }>).comment.id, 'c2')
    assert.equal((unified[7] as Extract<Row, { kind: 'comment' }>).comment.id, 'c1')
    assert.equal((unified[9] as Extract<Row, { kind: 'comment' }>).detached, true)

    const split = buildRows(snapshot([app]), { layout: 'split', collapsed: new Set(), comments: [onAdded, onRemoved], editing: null })
    assert.deepEqual(kinds(split), ['file', 'hunk', 'pair', 'pair', 'comment', 'pair', 'comment', 'pair', 'gap'])
  })

  it('opens the editor under the line, or in place of the comment being edited', () => {
    const anchor = { path: 'src/app.ts', side: 'new' as const, line: 3 }
    const fresh = buildRows(snapshot([app]), { layout: 'unified', collapsed: new Set(), comments: [], editing: { anchor, comment: null } })
    assert.deepEqual(kinds(fresh).slice(-3), ['line', 'editor', 'gap'])
    const existing: ReviewComment = { id: 'c1', ...anchor, text: 'x', excerpt: 'd' }
    const editing = buildRows(snapshot([app]), { layout: 'unified', collapsed: new Set(), comments: [existing], editing: { anchor, comment: existing } })
    assert.equal(editing.filter((row) => row.kind === 'comment').length, 0)
    assert.equal(editing.filter((row) => row.kind === 'editor').length, 1)
  })

  it('places rows by their heights, measured ones included, and finds the row at a position', () => {
    const comment: ReviewComment = { id: 'c1', path: 'src/app.ts', side: 'new', line: 1, text: 'x', excerpt: 'a' }
    const rows = buildRows(snapshot([app]), { layout: 'unified', collapsed: new Set(), comments: [comment], editing: null })
    const plain = layoutRows(rows, { measured: new Map() })
    const measured = layoutRows(rows, { measured: new Map([['c:c1', 120]]) })
    const wrapped = layoutRows(rows, { measured: new Map(), lines: (row) => (row.kind === 'line' && row.line === 1 ? 3 : 1) })
    assert.equal(wrapped.total - plain.total, 2 * ROW_HEIGHT.line, 'a line that wraps to three is three lines tall')
    assert.equal(measured.total - plain.total, 120 - ROW_HEIGHT.comment)
    assert.equal(plain.tops[0], 0)
    assert.equal(plain.tops[1], ROW_HEIGHT.file)
    assert.equal(rowAt(plain, 0), 0)
    assert.equal(rowAt(plain, ROW_HEIGHT.file - 1), 0)
    assert.equal(rowAt(plain, ROW_HEIGHT.file), 1)
    assert.equal(rowAt(plain, plain.total + 500), rows.length - 1)
  })

  it('pins the header of the file the top of the list is in', () => {
    const rows = buildRows(snapshot([app, app]), { layout: 'unified', collapsed: new Set(), comments: [], editing: null })
    const layout = layoutRows(rows, { measured: new Map() })
    assert.equal(pinnedFile(rows, layout, 0), null, 'its own header is in place')
    assert.equal(pinnedFile(rows, layout, ROW_HEIGHT.file + 30), 0)
    const secondHeader = rows.findIndex((row, index) => index > 0 && row.kind === 'file')
    assert.equal(pinnedFile(rows, layout, layout.tops[secondHeader] + 50), 1)
  })

  it('starts lockfiles, minified files and huge rewrites folded, and remembers what the person toggled', () => {
    const lock = file('pnpm-lock.yaml', [])
    const big = file('data.ts', [], { added: 3000 })
    assert.equal(startsFolded(lock), true)
    assert.equal(startsFolded(file('dist/app.min.js', [])), true)
    assert.equal(startsFolded(big), true)
    assert.equal(startsFolded(app), false)
    assert.deepEqual([...foldedPaths([app, lock], new Set())], ['pnpm-lock.yaml'])
    assert.deepEqual([...foldedPaths([app, lock], new Set(['pnpm-lock.yaml', 'src/app.ts']))], ['src/app.ts'])
    assert.deepEqual([...foldedPaths([app, lock], toggledForAll([app, lock], true))].sort(), ['pnpm-lock.yaml', 'src/app.ts'])
    assert.deepEqual([...foldedPaths([app, lock], toggledForAll([app, lock], false))], [])
  })

  it('writes hunk ranges as git does, and finds lines by anchor', () => {
    assert.equal(hunkRange({ oldStart: 3, oldLines: 7, newStart: 3, newLines: 8 }), '@@ -3,7 +3,8 @@')
    assert.equal(hunkRange({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }), '@@ -0,0 +1 @@')
    assert.equal(lineAt(app, { path: app.path, side: 'old', line: 3 })?.text, 'c')
    assert.equal(lineAt(app, { path: app.path, side: 'new', line: 2 })?.text, 'B')
    assert.equal(lineAt(app, { path: app.path, side: 'new', line: 3 })?.text, 'd', 'a kept line has both numbers')
    assert.equal(lineAt(app, { path: app.path, side: 'new', line: 99 }), null)
    assert.equal(firstChangedLine(app), 2)
  })

  it('says what stands in for lines', () => {
    assert.equal(fileNote(app), null)
    assert.equal(fileNote(file('empty.txt', [])), 'Nothing to show.')
    assert.equal(fileNote(file('big.bin', [], { kind: 'large', note: 'Too large to show here.', size: { new: 5 * 1024 * 1024 } })), 'Too large to show here. 5.0 MB.')
  })
})

describe('colours and changed words', () => {
  it('reads removed lines on the old side and added ones on the new side', () => {
    const tokenizer = languageForPath('a.ts').tokenizer
    const lines = [ctx('/* open', 1, 1), del('still comment */ const a = 1', 2), add('const b = 2', 2), ctx('let c = 3', 3, 3)]
    const tokens = tokenizeHunk(tokenizer, hunk('h', lines))
    const first = (index: number) => segmentsOf(lines[index].text, tokens[index], undefined)[0]
    assert.equal(first(1).className, 'tok-comment', 'the old side is still in the comment')
    assert.equal(first(2).className, 'tok-comment', 'so is the new side, which kept the opening line')
  })

  it('splits a line into runs of one colour, marks the changed words, and cuts a very long line', () => {
    const tokenizer = languageForPath('a.ts').tokenizer
    const line = add('const total = price * amount', 1, [[22, 28]])
    const [tokens] = tokenizeHunk(tokenizer, hunk('h', [line]))
    const segments = segmentsOf(line.text, tokens, line.words)
    assert.equal(segments.map((segment) => segment.text).join(''), line.text)
    assert.deepEqual(segments.filter((segment) => segment.changed).map((segment) => segment.text), ['amount'])
    assert.equal(segments[0].className, 'tok-keyword')
    const long = segmentsOf('x'.repeat(5000), undefined, undefined)
    assert.equal(long.length, 2)
    assert.equal(long[0].text.length, 2000)
    assert.equal(long[1].text, '…')
    assert.deepEqual(segmentsOf('', undefined, undefined), [])
  })

  it('works a hunk out once', () => {
    const cache = new HunkTokens()
    const item = hunk('h', [add('let x = 1', 1)])
    assert.equal(cache.get('a.ts', item), cache.get('a.ts', item))
  })
})

describe('the width of a line', () => {
  it('counts tabs to the next stop and wide characters as two columns', () => {
    assert.equal(columnsOf('abc'), 3)
    assert.equal(columnsOf('\tx'), 5)
    assert.equal(columnsOf('ab\tx'), 5)
    assert.equal(columnsOf(String.fromCodePoint(0x4e2d, 0x6587)), 4, 'two CJK characters')
    assert.equal(columnsOf(String.fromCodePoint(0x1f600)), 2, 'an emoji')
    assert.deepEqual(expandTabs('a\tb', 0), { text: 'a   b', column: 5 })
    assert.deepEqual(expandTabs('\tb', 2), { text: '  b', column: 5 }, 'a tab after two columns goes to the next stop')
    assert.equal(wrappedLines(10, 80), 1)
    assert.equal(wrappedLines(161, 80), 3)
    assert.equal(wrappedLines(0, 80), 1)
  })
})

describe('comments for the agent', () => {
  it('name the file and line, quote the line, and keep the order of the files', () => {
    const comments: ReviewComment[] = [
      { id: '2', path: 'src/b.ts', side: 'old', line: 4, text: 'Why was this removed?', excerpt: '  old()  ' },
      { id: '1', path: 'src/a.ts', side: 'new', line: 12, text: 'Use amount here.', excerpt: 'const total = price * count' },
    ]
    assert.equal(
      commentsMessage(comments, 'the unstaged changes'),
      'Review comments on the unstaged changes. Address each one:\n\n1. src/a.ts:12\n> const total = price * count\nUse amount here.\n\n2. src/b.ts, line 4 before the change\n> old()\nWhy was this removed?',
    )
    assert.match(commentsMessage([comments[1]], 'x'), /^A review comment on x\. Address it:/)
    assert.match(commentsMessage([comments[1]], 'x', (path) => path.replace('src/', '')), /\n1\. a\.ts:12\n/)
  })

  it('say what the review is of', () => {
    const shot = snapshot([])
    assert.equal(scopePhrase({ kind: 'staged' }, shot), 'the staged changes')
    assert.equal(scopePhrase({ kind: 'branch' }, { ...shot, scope: { kind: 'branch' }, base: { ref: 'origin/main', oid: null } }), 'the changes on branch main against origin/main')
    assert.equal(scopePhrase({ kind: 'commit', commit: 'abcdef1234' }, null), 'commit abcdef1')
  })
})

describe('paths between the repository and the open folder', () => {
  const top = { root: '/home/me/repo', folder: '' }
  const inner = { root: '/home/me/repo', folder: 'apps/web/' }
  const windows = { root: 'C:\\dev\\Repo', folder: 'apps/web/' }

  it('name a file of the repository the way the open folder does, or say it is outside', () => {
    assert.equal(inFolder('src/a.ts', ''), 'src/a.ts')
    assert.equal(inFolder('apps/web/src/a.ts', 'apps/web/'), 'src/a.ts')
    assert.equal(inFolder('apps/webby/a.ts', 'apps/web/'), null)
    assert.equal(inFolder('README.md', 'apps/web/'), null)
  })

  it('name a file the agent named, absolute or from the open folder, the way the repository does', () => {
    assert.equal(inRepository('/home/me/repo/src/a.ts', top), 'src/a.ts')
    assert.equal(inRepository('/home/me/repo/apps/web/src/a.ts', inner), 'apps/web/src/a.ts')
    assert.equal(inRepository('src/a.ts', inner), 'apps/web/src/a.ts')
    assert.equal(inRepository('./src/a.ts', inner), 'apps/web/src/a.ts')
    assert.equal(inRepository('src\\a.ts', inner), 'apps/web/src/a.ts')
    assert.equal(inRepository('../a.ts', inner), null, 'nothing is guessed above the open folder')
    assert.equal(inRepository('/home/me/repository/a.ts', top), null, 'a folder whose name starts the same is another folder')
    assert.equal(inRepository('/home/me/repo', top), null)
    assert.equal(inRepository('/elsewhere/a.ts', top), null)
    assert.equal(inRepository('c:/DEV/repo/apps/web/x.ts', windows), 'apps/web/x.ts', 'Windows paths compare without case')
    assert.equal(inRepository('C:\\dev\\Repo\\README.md', windows), 'README.md')
    assert.equal(inRepository('/link/web/src/a.ts', inner, '/link/web'), 'apps/web/src/a.ts', 'a folder opened through a link')
    assert.equal(inRepository('/x/a.ts', { root: '/', folder: '' }), 'x/a.ts')
  })

  it('name a file to the agent from the open folder, or by its whole path when it is outside', () => {
    assert.equal(forAgent('apps/web/src/a.ts', inner), 'src/a.ts')
    assert.equal(forAgent('README.md', inner), '/home/me/repo/README.md')
    assert.equal(forAgent('docs/x.md', windows), 'C:\\dev\\Repo\\docs\\x.md')
    assert.equal(forAgent('src/a.ts', top), 'src/a.ts')
  })
})
