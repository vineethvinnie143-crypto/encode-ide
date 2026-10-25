import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { globBase, globToRegExp } from './glob'
import { ignoredBy, parseIgnoreFile } from './ignore'
import { globTool, GREP_FILE_LINES, grepRegex, grepTool } from './search'
import { tempWorkspace, testContext, textOf } from './testing'

describe('globToRegExp', () => {
  const matches = (pattern: string, file: string, options = {}) => globToRegExp(pattern, options).test(file)

  it('handles stars, double stars, classes and nested alternatives', () => {
    assert.ok(matches('**/*.ts', 'a.ts'))
    assert.ok(matches('**/*.ts', 'src/deep/a.ts'))
    assert.ok(!matches('*.ts', 'src/a.ts'))
    assert.ok(matches('src/**/*.{ts,tsx}', 'src/a/b/c.tsx'))
    assert.ok(matches('src/**', 'src/a/b'))
    assert.ok(matches('a/**/b', 'a/b'))
    assert.ok(matches('a/**/b', 'a/x/y/b'))
    assert.ok(matches('file?.[jt]s', 'file1.js'))
    assert.ok(!matches('file?.[!j]s', 'file1.js'))
    assert.ok(matches('{a,b{c,d}}.txt', 'bd.txt'))
    assert.ok(matches('{lonely}.txt', '{lonely}.txt'))
    assert.ok(matches('a+b(1).txt', 'a+b(1).txt'))
  })

  it('matches the last segment anywhere with matchBase, and ignores case on request', () => {
    assert.ok(matches('*.md', 'docs/guide/README.md', { matchBase: true }))
    assert.ok(!matches('docs/*.md', 'x/docs/a.md', { matchBase: true }))
    assert.ok(matches('*.MD', 'a.md', { caseInsensitive: true }))
    assert.ok(matches('src\\**\\*.ts', 'src/a/b.ts'))
  })

  it('finds the fixed directory a pattern can start from', () => {
    assert.deepEqual(globBase('src/app/**/*.ts'), { base: 'src/app', rest: '**/*.ts' })
    assert.deepEqual(globBase('./*.json'), { base: '', rest: '*.json' })
    assert.deepEqual(globBase('docs/readme.md'), { base: 'docs', rest: 'readme.md' })
  })
})

describe('.gitignore rules', () => {
  it('applies negation, directory-only and anchored rules, last match winning', () => {
    const root = parseIgnoreFile('# build output\n*.log\n!keep.log\nbuild/\n/top.txt\n\\#hash\n', '')
    assert.equal(ignoredBy([root], 'a/b.log', false), true)
    assert.equal(ignoredBy([root], 'keep.log', false), false)
    assert.equal(ignoredBy([root], 'build', true), true)
    assert.equal(ignoredBy([root], 'build', false), undefined)
    assert.equal(ignoredBy([root], 'top.txt', false), true)
    assert.equal(ignoredBy([root], 'sub/top.txt', false), undefined)
    assert.equal(ignoredBy([root], '#hash', false), true)
    const nested = parseIgnoreFile('!debug.log\n', 'pkg')
    assert.equal(ignoredBy([root, nested], 'pkg/debug.log', false), false)
    assert.equal(ignoredBy([root, nested], 'other/debug.log', false), true)
  })
})

async function touch(file: string, secondsAgo: number) {
  const time = new Date(Date.now() - secondsAgo * 1000)
  await fs.utimes(file, time, time)
}

describe('Glob', () => {
  it('lists matches newest first and honours .gitignore', async () => {
    const root = await tempWorkspace({
      '.gitignore': 'dist/\n*.gen.ts\n',
      'src/a.ts': '',
      'src/b.tsx': '',
      'src/c.gen.ts': '',
      'dist/out.ts': '',
      'node_modules/x/index.ts': '',
      'notes.md': '',
    })
    await touch(path.join(root, 'src/a.ts'), 100)
    await touch(path.join(root, 'src/b.tsx'), 10)
    const outcome = await globTool.run({ pattern: '**/*.{ts,tsx}' }, testContext(root))
    assert.equal(outcome.content, 'src/b.tsx\nsrc/a.ts')
    const scoped = await globTool.run({ pattern: '*.ts', path: path.join(root, 'src') }, testContext(root))
    assert.equal(scoped.content, 'src/a.ts')
    assert.equal((await globTool.run({ pattern: '**/*.py' }, testContext(root))).content, 'No files found.')
    const absolute = await globTool.run({ pattern: `${root}/src/*.tsx` }, testContext(root))
    assert.equal(absolute.content, 'src/b.tsx')
  })

  it('reports a path that is not a directory', async () => {
    const root = await tempWorkspace({ 'a.txt': '' })
    const outcome = await globTool.run({ pattern: '*', path: 'a.txt' }, testContext(root))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /is a file, not a directory/)
  })
})

describe('Grep', () => {
  const files = {
    'src/app.ts': 'import x from "y"\nfunction start() {\n  log("Error: boom")\n}\n',
    'src/util.py': 'def start():\n    pass\n',
    'README.md': 'Start here\n',
    'build.log': 'Error everywhere\n',
    '.gitignore': '*.log\n',
  }

  it('lists files, shows content with context, and counts', async () => {
    const root = await tempWorkspace(files)
    const ctx = testContext(root)
    const listed = await grepTool.run({ pattern: 'start', '-i': true }, ctx)
    assert.deepEqual(textOf(listed.content).split('\n').sort(), ['README.md', 'src/app.ts', 'src/util.py'])
    const content = await grepTool.run({ pattern: 'Error', output_mode: 'content', '-B': 1 }, ctx)
    // A file with several lines heads them with its name (ADR 0133).
    assert.equal(content.content, 'src/app.ts\n2-function start() {\n3:  log("Error: boom")')
    const counted = await grepTool.run({ pattern: 'start', output_mode: 'count', type: 'py' }, ctx)
    assert.equal(counted.content, 'src/util.py:1')
    const globbed = await grepTool.run({ pattern: 'start', glob: '*.ts' }, ctx)
    assert.equal(globbed.content, 'src/app.ts')
  })

  it('matches across lines in multiline mode and pages results', async () => {
    const root = await tempWorkspace(files)
    const ctx = testContext(root)
    const spanning = await grepTool.run({ pattern: 'start\\(\\) \\{.*boom', multiline: true, output_mode: 'content' }, ctx)
    assert.equal(spanning.content, 'src/app.ts\n2:function start() {\n3:  log("Error: boom")')
    const paged = await grepTool.run({ pattern: '.', output_mode: 'content', path: 'src/app.ts', head_limit: 1, offset: 2 }, ctx)
    assert.equal(paged.content, 'src/app.ts (continued)\n2:function start() {\n(2 more lines; raise offset or head_limit, or narrow the search.)')
  })

  it('shows each file\'s first lines when one of several is full of matches, and counts the rest', async () => {
    const root = await tempWorkspace({ 'a.txt': 'hit\n'.repeat(GREP_FILE_LINES + 12), 'b.txt': 'miss\nhit\n' })
    const ctx = testContext(root)
    const text = textOf((await grepTool.run({ pattern: 'hit', output_mode: 'content' }, ctx)).content)
    const lines = text.split('\n')
    assert.equal(lines[0], 'a.txt')
    assert.equal(lines[GREP_FILE_LINES], `${GREP_FILE_LINES}:hit`)
    assert.equal(lines[GREP_FILE_LINES + 1], '… (12 more matching lines here; Grep this file alone for them)')
    assert.deepEqual(lines.slice(GREP_FILE_LINES + 2), ['', 'b.txt', '2:hit'])
    // A search of the one file shows them all.
    const alone = textOf((await grepTool.run({ pattern: 'hit', output_mode: 'content', path: 'a.txt' }, ctx)).content).split('\n')
    assert.equal(alone.length, GREP_FILE_LINES + 13)
    // A page that starts on the blank line between two files starts with the next file's name.
    const next = textOf((await grepTool.run({ pattern: 'hit', output_mode: 'content', offset: GREP_FILE_LINES + 2 }, ctx)).content)
    assert.equal(next, 'b.txt\n2:hit')
  })

  it('searches an older ANSI file, and gives up on a binary file after its first 8 KB', async () => {
    const e = String.fromCodePoint(0xe9)
    const root = await tempWorkspace({
      'legacy.lua': Buffer.concat([Buffer.from('-- caf'), Buffer.from([0xe9]), Buffer.from('\nprint("needle")\n')]),
      'image.dat': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(20_000, 0x61), Buffer.from(' needle ')]),
      'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('needle in utf16\n', 'utf16le')]),
    })
    const ctx = testContext(root)
    assert.deepEqual(textOf((await grepTool.run({ pattern: 'needle' }, ctx)).content).split('\n').sort(), ['legacy.lua', 'utf16.txt'])
    const content = await grepTool.run({ pattern: `caf${e}`, output_mode: 'content' }, ctx)
    assert.equal(content.content, `legacy.lua:1:-- caf${e}`)
  })

  it('reads many files at once and answers in the same order every time', async () => {
    const tree: Record<string, string> = {}
    for (let index = 0; index < 120; index++) tree[`pkg${index % 7}/file${String(index).padStart(3, '0')}.ts`] = `// ${index}\n${index % 3 === 0 ? 'target()\n' : 'other()\n'}`
    const root = await tempWorkspace(tree)
    const ctx = testContext(root)
    const first = await grepTool.run({ pattern: 'target', output_mode: 'content', '-n': false }, ctx)
    const lines = textOf(first.content).split('\n')
    assert.equal(lines.length, 40)
    assert.deepEqual(lines, [...lines].sort())
    assert.deepEqual(lines, textOf((await grepTool.run({ pattern: 'target', output_mode: 'content', '-n': false }, ctx)).content).split('\n'))
    assert.equal(first.display?.output, '40 matches')
    assert.equal(textOf((await grepTool.run({ pattern: 'target', output_mode: 'count', glob: 'pkg3/*.ts' }, ctx)).content).split('\n').length, 6)
  })

  it('stops a content search that finds far too much, at a whole number of files in path order, and says so', async () => {
    const tree: Record<string, string> = {}
    for (let index = 0; index < 48; index++) tree[`part${String(index).padStart(2, '0')}.txt`] = 'hit\n'.repeat(40_000)
    const root = await tempWorkspace(tree)
    const outcome = await grepTool.run({ pattern: 'hit', output_mode: 'content', head_limit: 2 }, testContext(root))
    const text = textOf(outcome.content)
    assert.ok(text.startsWith('part00.txt\n1:hit\n('), text.slice(0, 80))
    const stopped = /\(The search stopped after ([\d,]+) lines? of matches; narrow the pattern, path or glob\.\)/.exec(text)
    assert.ok(stopped, text.slice(-200))
    const kept = Number(stopped[1].replace(/,/g, ''))
    assert.ok(kept >= 100_000 && kept < 48 * 40_000, `${kept} lines kept`)
    assert.match(text, /\(at least \d+ more lines; raise offset or head_limit, or narrow the search\.\)/)
  })

  it('refuses unknown types and broken patterns before running', () => {
    assert.match(grepTool.check!({ pattern: 'x', type: 'cobol' }) ?? '', /type must be one of/)
    assert.match(grepTool.check!({ pattern: '(' }) ?? '', /not a valid regular expression/)
    assert.equal(grepRegex('(?i)abc', { ignoreCase: false, multiline: false }).flags.includes('i'), true)
  })
})

describe("eNCode's own folder", () => {
  it('is never entered by Glob or Grep, nor read through a link, while the folders kept for the session are searched', async (t) => {
    const root = await fs.realpath(await tempWorkspace({ 'src/a.ts': 'secret hit\n', 'profile/Cookies.ts': 'secret hit\n', 'profile/outputs/s1/Bash-1.ts': 'secret hit\n' }))
    const profile = path.join(root, 'profile')
    const ctx = testContext(root, { offLimits: { folders: [profile], except: [path.join(profile, 'outputs', 's1')] } })
    let linked = true
    try {
      await fs.symlink(path.join(profile, 'Cookies.ts'), path.join(root, 'src', 'linked.ts'))
    } catch {
      linked = false
    }
    assert.equal(textOf((await globTool.run({ pattern: '**/*.ts' }, ctx)).content), 'src/a.ts')
    assert.equal(textOf((await grepTool.run({ pattern: 'secret' }, ctx)).content).trim(), 'src/a.ts')
    // The session's own results are searched where the search starts in them.
    assert.match(textOf((await grepTool.run({ pattern: 'secret', path: path.join(profile, 'outputs', 's1') }, ctx)).content), /Bash-1\.ts/)
    if (!linked) t.diagnostic('this system cannot make links: the link case was not run')
    // Without the folder off limits, the same search sees all of it.
    assert.match(textOf((await grepTool.run({ pattern: 'secret' }, testContext(root))).content), /Cookies\.ts/)
  })
})
