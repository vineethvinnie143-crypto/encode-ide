import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import {
  commandName,
  hasUnterminatedQuote,
  parseLine,
  resolveShellPath,
  splitPipeline,
  splitStatements,
  tokenizeSegment,
} from './shell-grammar'

describe('shell grammar', () => {
  it('splits statements on ; && and ||, outside quotes', () => {
    assert.deepEqual(splitStatements('a; b && c || d'), [
      { text: 'a', cond: 'always' },
      { text: ' b ', cond: 'always' },
      { text: ' c ', cond: 'and' },
      { text: ' d', cond: 'or' },
    ])
    assert.deepEqual(
      splitStatements(`echo "a; b && c" ; echo 'x || y'`).map((statement) => statement.text.trim()),
      [`echo "a; b && c"`, `echo 'x || y'`],
    )
  })

  it('treats a lone & and newlines as ordinary characters', () => {
    assert.equal(splitStatements('a & b').length, 1)
    assert.deepEqual(parseLine('echo a\nrm x')[0].segments[0].tokens, ['echo', 'a\nrm', 'x'])
  })

  it('splits pipelines on |, outside quotes', () => {
    assert.deepEqual(splitPipeline(`cat a | grep "x|y" | wc -l`), ['cat a ', ` grep "x|y" `, ' wc -l'])
  })

  it('removes quotes and joins adjacent quoted parts', () => {
    assert.deepEqual(tokenizeSegment(`l"s" -a 'my file' ""`).tokens, ['ls', '-a', 'my file'])
  })

  it('takes the rest of the segment as the redirect target', () => {
    assert.deepEqual(tokenizeSegment('echo hi > out.txt extra'), {
      tokens: ['echo', 'hi'],
      redirect: { file: 'out.txt extra', append: false },
    })
    assert.deepEqual(tokenizeSegment(`echo hi>>'a b'`).redirect, { file: 'a b', append: true })
    assert.deepEqual(tokenizeSegment('echo "a > b"').tokens, ['echo', 'a > b'])
  })

  it('drops empty segments and statements', () => {
    assert.deepEqual(parseLine(' ; "" | ls'), [{ cond: 'always', segments: [{ tokens: ['ls'], redirect: undefined }] }])
  })

  it('resolves aliases without consulting the object prototype', () => {
    assert.equal(commandName('dir'), 'ls')
    assert.equal(commandName('type'), 'cat')
    assert.equal(commandName('constructor'), 'constructor')
    assert.equal(commandName('__proto__'), '__proto__')
  })

  it('detects unterminated quotes', () => {
    assert.equal(hasUnterminatedQuote(`echo "a'b"`), false)
    assert.equal(hasUnterminatedQuote(`echo "abc`), true)
    assert.equal(hasUnterminatedQuote(`echo 'it''s`), true)
  })

  it('expands ~ the way the interpreter does', () => {
    const posix = { home: '/home/u', path: path.posix }
    assert.equal(resolveShellPath('/ws', '~', posix), '/home/u')
    assert.equal(resolveShellPath('/ws', '~/x', posix), '/home/u/x')
    assert.equal(resolveShellPath('/ws', '~x', posix), '/ws/~x')
    assert.equal(resolveShellPath('/ws', 'a/../b', posix), '/ws/b')
    assert.equal(resolveShellPath('/ws', '/etc/passwd', posix), '/etc/passwd')
    const windows = { home: 'C:\\Users\\u', path: path.win32 }
    assert.equal(resolveShellPath('C:\\ws', '~\\x', windows), 'C:\\Users\\u\\x')
    assert.equal(resolveShellPath('C:\\ws', 'sub/a.txt', windows), 'C:\\ws\\sub\\a.txt')
  })

  it('matches a naive reading on lines without quotes', async () => {
    const piece = gen.oneOf('ls', 'cat', 'a.txt', '-n', '2', ' ', '  ', ';', '&&', '||', '|', 'x', '\t')
    const lines = gen.map(gen.array(piece), (parts) => parts.join(' '))
    await check(lines, (line) => {
      const expected = line
        .split(/;|&&|\|\|/)
        .filter((text) => text.trim())
        .map((text) =>
          text
            .split('|')
            .map((segment) => segment.split(/[ \t]+/).filter(Boolean))
            .filter((tokens) => tokens.length),
        )
      assert.deepEqual(
        parseLine(line).map((statement) => statement.segments.map((segment) => segment.tokens)),
        expected,
      )
    })
  })
})
