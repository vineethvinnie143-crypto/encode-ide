import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { globBase, globToRegExp } from './glob'
import { ignoredBy, parseIgnoreFile } from './ignore'
import { globTool, grepRegex, grepTool } from './search'
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
    assert.equal(content.content, 'src/app.ts-2-function start() {\nsrc/app.ts:3:  log("Error: boom")')
    const counted = await grepTool.run({ pattern: 'start', output_mode: 'count', type: 'py' }, ctx)
    assert.equal(counted.content, 'src/util.py:1')
    const globbed = await grepTool.run({ pattern: 'start', glob: '*.ts' }, ctx)
    assert.equal(globbed.content, 'src/app.ts')
  })

  it('matches across lines in multiline mode and pages results', async () => {
    const root = await tempWorkspace(files)
    const ctx = testContext(root)
    const spanning = await grepTool.run({ pattern: 'start\\(\\) \\{.*boom', multiline: true, output_mode: 'content' }, ctx)
    assert.equal(spanning.content, 'src/app.ts:2:function start() {\nsrc/app.ts:3:  log("Error: boom")')
    const paged = await grepTool.run({ pattern: '.', output_mode: 'content', path: 'src/app.ts', head_limit: 1, offset: 1 }, ctx)
    assert.equal(paged.content, 'app.ts:2:function start() {\n(2 more lines; raise offset or head_limit, or narrow the search.)'.replace('app.ts', 'src/app.ts'))
  })

  it('refuses unknown types and broken patterns before running', () => {
    assert.match(grepTool.check!({ pattern: 'x', type: 'cobol' }) ?? '', /type must be one of/)
    assert.match(grepTool.check!({ pattern: '(' }) ?? '', /not a valid regular expression/)
    assert.equal(grepRegex('(?i)abc', { ignoreCase: false, multiline: false }).flags.includes('i'), true)
  })
})
