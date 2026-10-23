import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { ChangeSet, Text } from '@encode/text'
import {
  EditorState,
  Highlighter,
  TOKEN_NAMES,
  acceptHunk,
  languageById,
  languageForContent,
  languageForPath,
  languages,
  rejectHunks,
  reviewHunks,
  reviewStats,
  wordChanges,
  type Tokenizer,
} from './index'

/** The token kind at the first occurrence of `needle` (or at `offset` into it) in a multi-line source. */
function kindAt(language: string, source: string, needle: string, offset = 0): string {
  const tokenizer = languageById(language)!.tokenizer
  const at = source.indexOf(needle)
  assert.ok(at >= 0, `"${needle}" is not in the source`)
  const target = at + offset
  let state = tokenizer.start
  let lineStart = 0
  for (const line of source.split('\n')) {
    const result = tokenizer.line(line, state)
    if (target <= lineStart + line.length) {
      const column = target - lineStart
      let kind = 'plain'
      for (let index = 0; index < result.tokens.length && result.tokens[index] <= column; index += 2) {
        kind = TOKEN_NAMES[result.tokens[index + 1]]
      }
      return kind
    }
    state = result.state
    lineStart += line.length + 1
  }
  throw new Error('unreachable')
}

function assertWellFormed(tokens: readonly number[], line: string): void {
  assert.equal(tokens.length % 2, 0)
  if (line.length) assert.equal(tokens[0], 0, 'the first token starts the line')
  for (let index = 0; index < tokens.length; index += 2) {
    assert.ok(tokens[index] >= 0 && tokens[index] < Math.max(1, line.length), `token start ${tokens[index]} inside "${line}"`)
    if (index) assert.ok(tokens[index] > tokens[index - 2], 'token starts increase')
    assert.ok(Number.isInteger(tokens[index + 1]) && tokens[index + 1] >= 0 && tokens[index + 1] < TOKEN_NAMES.length)
  }
}

const FRAGMENTS = [
  ' ', 'a', 'x1', '_', '$v', '0x1F', '1.5e3', '"', "'", '`', '\\', '/', '*', '/*', '*/', '//', '#', '--', '--[[', ']]', '[[',
  '[==[', ']==]', '${', '{', '}', '(', ')', '[', ']', '<', '>', '</', '<div ', '</div>', '<script>', '</script>', '<style>',
  '</style>', '<!--', '-->', '```', '```js', '~~~', '"""', "'''", 'f"', 'r"', '@"', 'r#"', '"#', '<<EOF', 'EOF', '@\'', "'@",
  '<#', '#>', 'key: ', '- ', '| ', '=', ':', ';', ',', '.', '?.', 'function', 'end', 'if', 'then', 'return', 'class', 'def',
  'local', 'const', 'let', 'import', 'from', '#include', '\t', 'é', '😀', 'end\n', '\n',
]
const fragment = gen.oneOf(...FRAGMENTS)
const lineGen: Gen<string> = (random, size) => gen.array(fragment, 0, Math.max(1, size >> 1))(random, size).join('')
const sourceGen: Gen<string> = (random, size) => gen.array(lineGen, 1, Math.max(1, size))(random, size).join('\n')

describe('tokenizers', () => {
  it('produce well-formed tokens for any input in every language', async () => {
    await check(sourceGen, (source) => {
      for (const language of languages) {
        let state = language.tokenizer.start
        for (const line of source.split('\n')) {
          const result = language.tokenizer.line(line, state)
          assertWellFormed(result.tokens, line)
          assert.equal(typeof result.state, 'string')
          // Deterministic: the same line and state give the same answer.
          assert.deepEqual(language.tokenizer.line(line, state), result)
          state = result.state
        }
      }
    })
  })

  it('highlight JavaScript, TypeScript and JSX', () => {
    const source = [
      'import { a } from "./a"',
      'const re = /a+b/g, n = 0x1F, s = `x ${a + 1} y`',
      'function render(props) {',
      '  return <Card title="hi" onClick={() => go(1)}>Hello {props.name}</Card>',
      '}',
      '/** @param x the input */',
      'let type = obj.value?.call(MAX_SIZE)',
    ].join('\n')
    assert.equal(kindAt('typescriptreact', source, 'import'), 'keyword')
    assert.equal(kindAt('typescriptreact', source, '"./a"'), 'string')
    assert.equal(kindAt('typescriptreact', source, '/a+b/'), 'regexp')
    assert.equal(kindAt('typescriptreact', source, '0x1F'), 'number')
    assert.equal(kindAt('typescriptreact', source, '${'), 'punct')
    assert.equal(kindAt('typescriptreact', source, 'a + 1'), 'variable')
    assert.equal(kindAt('typescriptreact', source, ' y`'), 'string')
    assert.equal(kindAt('typescriptreact', source, 'render'), 'function')
    assert.equal(kindAt('typescriptreact', source, 'Card'), 'tag')
    assert.equal(kindAt('typescriptreact', source, 'title'), 'attr')
    assert.equal(kindAt('typescriptreact', source, 'go(1)'), 'function')
    assert.equal(kindAt('typescriptreact', source, 'Hello'), 'plain')
    assert.equal(kindAt('typescriptreact', source, 'name}'), 'property')
    assert.equal(kindAt('typescriptreact', source, '@param'), 'keyword')
    assert.equal(kindAt('typescriptreact', source, 'the input'), 'comment')
    assert.equal(kindAt('typescriptreact', source, 'type ='), 'variable')
    assert.equal(kindAt('typescriptreact', source, 'call'), 'function')
    assert.equal(kindAt('typescriptreact', source, 'MAX_SIZE'), 'constant')
    // Without JSX, `<` compares.
    assert.equal(kindAt('typescript', 'if (a < b) {}', '<'), 'operator')
  })

  it('highlight Lua as FiveM writes it', () => {
    const source = [
      '--[[ resource',
      '  manifest ]]',
      'local Players <const> = {}',
      "RegisterNetEvent('bank:deposit', function(amount)",
      '  local src = source',
      '  if not Players[src] then return end',
      '  Citizen.CreateThread(function() Wait(0) end)',
      '  local hash = `adder`',
      '  local s = [==[long',
      ']==] .. "x"',
      'end)',
    ].join('\n')
    assert.equal(kindAt('lua', source, 'manifest'), 'comment')
    assert.equal(kindAt('lua', source, 'local'), 'keyword')
    assert.equal(kindAt('lua', source, '<const>'), 'keyword')
    assert.equal(kindAt('lua', source, 'RegisterNetEvent'), 'function')
    assert.equal(kindAt('lua', source, "'bank:deposit'"), 'string')
    assert.equal(kindAt('lua', source, 'CreateThread'), 'function')
    assert.equal(kindAt('lua', source, 'Citizen'), 'variable')
    assert.equal(kindAt('lua', source, '`adder`'), 'string')
    assert.equal(kindAt('lua', source, 'long'), 'string')
    assert.equal(kindAt('lua', source, ']==]'), 'string')
    assert.equal(kindAt('lua', source, '..'), 'operator')
  })

  it("highlight CfxLua's C comments and safe navigation", () => {
    const source = ['/* a note', '   over lines */ local job = player?.job?.name', 'local grade = jobs?[job]', 'local ok = obj?:isReady()', 'x = 1 /* inline */ + 2'].join('\n')
    assert.equal(kindAt('lua', source, 'note'), 'comment')
    assert.equal(kindAt('lua', source, 'over'), 'comment')
    assert.equal(kindAt('lua', source, '*/'), 'comment')
    assert.equal(kindAt('lua', source, 'local job'), 'keyword')
    assert.equal(kindAt('lua', source, '?.job'), 'punct')
    assert.equal(kindAt('lua', source, 'job?.name', 5), 'property')
    assert.equal(kindAt('lua', source, '?[job]'), 'punct')
    assert.equal(kindAt('lua', source, 'isReady'), 'function')
    assert.equal(kindAt('lua', source, 'inline'), 'comment')
    assert.equal(kindAt('lua', source, '+ 2'), 'operator')
  })

  it('highlight Python strings, f-strings and decorators', () => {
    const source = ['@app.route("/")', 'def handler(self):', '    """Doc', '    string"""', '    return f"{self.x!r} \\n"', 'match = re.match(x)'].join('\n')
    assert.equal(kindAt('python', source, '@app'), 'meta')
    assert.equal(kindAt('python', source, 'handler'), 'function')
    assert.equal(kindAt('python', source, 'self)'), 'constant')
    assert.equal(kindAt('python', source, 'string"""'), 'string')
    assert.equal(kindAt('python', source, 'self.x'), 'variable')
    assert.equal(kindAt('python', source, '\\n'), 'escape')
    assert.equal(kindAt('python', source, 'match ='), 'variable')
  })

  it('highlight markup with embedded languages', () => {
    const html = ['<div class="a">', '<script>', 'const x = 1', '</script>', '<style>.a { color: red }</style>', '&amp; {{ name }}'].join('\n')
    assert.equal(kindAt('html', html, 'div'), 'tag')
    assert.equal(kindAt('html', html, 'class'), 'attr')
    assert.equal(kindAt('html', html, '"a"'), 'string')
    assert.equal(kindAt('html', html, 'const'), 'keyword')
    assert.equal(kindAt('html', html, 'color'), 'property')
    assert.equal(kindAt('html', html, '&amp;'), 'escape')
    assert.equal(kindAt('html', html, 'name'), 'variable')

    const markdown = ['---', 'title: Hi', '---', '# Heading', 'Some **bold** and `code`, see [docs](https://x.dev).', '```lua', 'local x = 1', '```', '- [ ] task'].join('\n')
    assert.equal(kindAt('markdown', markdown, 'title'), 'key')
    assert.equal(kindAt('markdown', markdown, 'Heading'), 'heading')
    assert.equal(kindAt('markdown', markdown, 'bold'), 'strong')
    assert.equal(kindAt('markdown', markdown, 'code`'), 'code')
    assert.equal(kindAt('markdown', markdown, 'docs'), 'link')
    assert.equal(kindAt('markdown', markdown, 'lua'), 'type')
    assert.equal(kindAt('markdown', markdown, 'local'), 'keyword')
    assert.equal(kindAt('markdown', markdown, '[ ]'), 'keyword')
  })

  it('highlight styles and data files', () => {
    const scss = ['$accent: #c9a96e;', '.card:hover > a {', '  color: darken($accent, 10%) !important;', '  &.active { margin: 0 auto; }', '}'].join('\n')
    assert.equal(kindAt('scss', scss, '$accent'), 'variable')
    assert.equal(kindAt('scss', scss, '#c9a96e'), 'constant')
    assert.equal(kindAt('scss', scss, '.card'), 'type')
    assert.equal(kindAt('scss', scss, ':hover'), 'keyword')
    assert.equal(kindAt('scss', scss, 'color'), 'property')
    assert.equal(kindAt('scss', scss, 'darken'), 'function')
    assert.equal(kindAt('scss', scss, '10%'), 'number')
    assert.equal(kindAt('scss', scss, '!important'), 'keyword')
    assert.equal(kindAt('scss', scss, 'auto'), 'value')

    const json = '{ "name": "encode", "n": -1.5e3, "ok": true, "x": null } // note'
    assert.equal(kindAt('jsonc', json, '"name"'), 'key')
    assert.equal(kindAt('jsonc', json, '"encode"'), 'string')
    assert.equal(kindAt('jsonc', json, '-1.5e3'), 'number')
    assert.equal(kindAt('jsonc', json, 'true'), 'bool')
    assert.equal(kindAt('jsonc', json, 'note'), 'comment')

    const yaml = ['on:', '  push: { branches: [main] }', 'jobs:', '  test:', '    run: |', '      pnpm test # not a comment', '    timeout: 30', 'a: &anchor yes'].join('\n')
    assert.equal(kindAt('yaml', yaml, 'push'), 'key')
    assert.equal(kindAt('yaml', yaml, 'branches'), 'key')
    assert.equal(kindAt('yaml', yaml, 'pnpm'), 'string')
    assert.equal(kindAt('yaml', yaml, '30'), 'number')
    assert.equal(kindAt('yaml', yaml, '&anchor'), 'variable')
    assert.equal(kindAt('yaml', yaml, 'yes'), 'bool')

    const toml = ['[package]', 'name = "encode"', 'version = 1', 'created = 2026-10-21', 'deps = { a = "1" }'].join('\n')
    assert.equal(kindAt('toml', toml, '[package]'), 'heading')
    assert.equal(kindAt('toml', toml, 'name'), 'key')
    assert.equal(kindAt('toml', toml, '2026'), 'number')
    assert.equal(kindAt('toml', toml, 'a ='), 'key')

    const sql = "SELECT id, COUNT(*) FROM users WHERE name = 'x''y' -- n"
    assert.equal(kindAt('sql', sql, 'SELECT'), 'keyword')
    assert.equal(kindAt('sql', sql, 'COUNT'), 'function')
    assert.equal(kindAt('sql', sql, "'x"), 'string')
    assert.equal(kindAt('sql', sql, "''"), 'escape')
    assert.equal(kindAt('sql', sql, '-- n'), 'comment')
  })

  it('highlight shells', () => {
    const bash = ['#!/bin/bash', 'NAME="w $USER" && echo "$(date) ok" | grep -v x', 'cat <<EOF', 'body $HOME', 'EOF', 'ls'].join('\n')
    assert.equal(kindAt('shellscript', bash, 'NAME'), 'variable')
    assert.equal(kindAt('shellscript', bash, '$USER'), 'variable')
    assert.equal(kindAt('shellscript', bash, 'echo'), 'function')
    assert.equal(kindAt('shellscript', bash, 'date'), 'function')
    assert.equal(kindAt('shellscript', bash, ' ok'), 'string')
    assert.equal(kindAt('shellscript', bash, 'grep'), 'function')
    assert.equal(kindAt('shellscript', bash, 'body'), 'string')
    assert.equal(kindAt('shellscript', bash, '$HOME'), 'variable')
    assert.equal(kindAt('shellscript', bash, 'EOF\nls'), 'keyword')
    assert.equal(kindAt('shellscript', bash, 'ls'), 'function')

    const ps = ['<# help', '#>', 'function Get-Thing { param([string]$Name) }', '$x = @"', 'text $Name', '"@', 'if ($x -eq $true) { Write-Host "hi" -ForegroundColor Green }'].join('\n')
    assert.equal(kindAt('powershell', ps, 'help'), 'comment')
    assert.equal(kindAt('powershell', ps, 'Get-Thing'), 'function')
    assert.equal(kindAt('powershell', ps, 'string'), 'type')
    assert.equal(kindAt('powershell', ps, 'text'), 'string')
    assert.equal(kindAt('powershell', ps, '$Name\n'), 'variable')
    assert.equal(kindAt('powershell', ps, '-eq'), 'operator')
    assert.equal(kindAt('powershell', ps, '$true'), 'bool')
    assert.equal(kindAt('powershell', ps, 'Write-Host'), 'function')
    assert.equal(kindAt('powershell', ps, '-ForegroundColor'), 'attr')
  })

  it('pick languages from paths and shebangs', () => {
    const id = (path: string) => languageForPath(path).id
    assert.equal(id('src/App.tsx'), 'typescriptreact')
    assert.equal(id('C:\\server\\resources\\bank\\fxmanifest.lua'), 'lua')
    assert.equal(id('client/main.LUA'), 'lua')
    assert.equal(id('deploy/Dockerfile'), 'dockerfile')
    assert.equal(id('api.Dockerfile'), 'dockerfile')
    assert.equal(id('.env.local'), 'ini')
    assert.equal(id('.gitignore'), 'ignore')
    assert.equal(id('tsconfig.json'), 'jsonc')
    assert.equal(id('package.json'), 'json')
    assert.equal(id('Makefile'), 'makefile')
    assert.equal(id('notes.unknown'), 'plaintext')
    assert.equal(id('script.ps1'), 'powershell')
    assert.equal(languageForContent('#!/usr/bin/env node')?.id, 'javascript')
    assert.equal(languageForContent('#!/bin/bash -e')?.id, 'shellscript')
    assert.equal(languageForContent('#!/usr/bin/env python3')?.id, 'python')
    assert.equal(languageForContent('no shebang'), undefined)
  })
})

/** A fresh highlighter's tokens for every line. */
function allTokens(tokenizer: Tokenizer, doc: Text): number[][] {
  const fresh = new Highlighter(tokenizer, doc)
  return Array.from({ length: doc.lineCount }, (_, index) => [...fresh.line(index + 1).tokens])
}

describe('Highlighter', () => {
  for (const id of ['typescriptreact', 'python', 'lua', 'markdown', 'html', 'shellscript', 'yaml', 'scss']) {
    it(`re-highlights ${id} incrementally exactly as from scratch`, async () => {
      const tokenizer = languageById(id)!.tokenizer
      const edit = gen.tuple(gen.int(0, 10_000), gen.int(0, 12), gen.array(fragment, 0, 4))
      await check(gen.tuple(sourceGen, gen.array(edit, 1, 8), gen.int(0, 3)), ([source, edits, mode]) => {
        let doc = Text.of(source)
        const highlighter = new Highlighter(tokenizer, doc)
        for (let line = 1; line <= doc.lineCount; line++) highlighter.line(line)
        for (const [at, length, insert] of edits) {
          const from = at % (doc.length + 1)
          const changes = ChangeSet.of({ from, to: Math.min(doc.length, from + length), insert: insert.join('') }, doc.length)
          doc = changes.apply(doc)
          highlighter.update(changes, doc)
          // Read some lines between edits, as a view would, so stale states are compared and reused.
          if (mode > 0) for (let line = 1; line <= doc.lineCount; line += mode) highlighter.line(line)
        }
        const expected = allTokens(tokenizer, doc)
        for (let line = 1; line <= doc.lineCount; line++) assert.deepEqual([...highlighter.line(line).tokens], expected[line - 1], `line ${line}`)
      })
    })
  }

  it('guesses far lines, then catches up in the background', () => {
    const tokenizer = languageById('typescript')!.tokenizer
    const lines = Array.from({ length: 20_000 }, (_, index) => (index === 5 ? '/* open' : index === 9000 ? 'end */ const x = 1' : `line(${index})`))
    const doc = Text.of(lines)
    const highlighter = new Highlighter(tokenizer, doc)
    const guessed = highlighter.line(15_000)
    assert.equal(guessed.exact, false)
    while (highlighter.work(Infinity));
    assert.ok(highlighter.done)
    const exact = highlighter.line(15_000)
    assert.equal(exact.exact, true)
    assert.deepEqual(exact.tokens, allTokens(tokenizer, doc)[14_999])
    assert.equal(TOKEN_NAMES[highlighter.line(8000).tokens[1]], 'comment')
  })

  it('reads far lines drawn in order once each, going on over the lines not asked for', () => {
    const tokenizer = languageById('typescript')!.tokenizer
    let calls = 0
    const counting: Tokenizer = { start: tokenizer.start, line: (text, state) => (calls++, tokenizer.line(text, state)) }
    // Comments that open and close, so a line read from a wrong state is coloured otherwise; blank lines between.
    const lines = Array.from({ length: 20_000 }, (_, index) =>
      index % 7 === 3 ? '' : index % 5 === 0 ? '/* open' : index % 5 === 2 ? 'close */ const y = 2' : `line(${index})`,
    )
    const doc = Text.of(lines)
    const every = new Highlighter(tokenizer, doc)
    const some = new Highlighter(counting, doc)
    // A view draws every line; a minimap skips the blank ones, and here some others too (one that opens a comment).
    const drawn = new Map<number, readonly number[]>()
    for (let line = 15_000; line <= 15_200; line++) drawn.set(line, every.line(line).tokens)
    const asked = [...drawn.keys()].filter((line) => lines[line - 1] !== '' && line % 4 !== 1)
    for (const line of asked) {
      const guessed = some.line(line)
      assert.equal(guessed.exact, false)
      assert.deepEqual(guessed.tokens, drawn.get(line), `line ${line}`)
    }
    assert.ok(calls <= 80 + 201, `tokenized ${calls} lines for ${asked.length}`)
  })

  it('re-tokenizes only a few lines after an edit in a large file', () => {
    const tokenizer = languageById('typescript')!.tokenizer
    let calls = 0
    const counting: Tokenizer = { start: tokenizer.start, line: (text, state) => (calls++, tokenizer.line(text, state)) }
    let doc = Text.of(Array.from({ length: 50_000 }, (_, index) => `const v${index} = ${index}`))
    const highlighter = new Highlighter(counting, doc)
    while (highlighter.work(Infinity));
    calls = 0
    const at = doc.line(25_000).from
    const changes = ChangeSet.of({ from: at, insert: 'x\ny\n' }, doc.length)
    doc = changes.apply(doc)
    highlighter.update(changes, doc)
    highlighter.line(49_000)
    assert.ok(calls < 10, `tokenized ${calls} lines`)
  })
})

describe('review', () => {
  const lines: Gen<string[]> = (random, size) => gen.array(gen.oneOf('a', 'b', 'c', '', 'd e'), 1, size + 1)(random, size)

  it('rejects every hunk back to the baseline and accepts every hunk into it', async () => {
    await check(gen.tuple(lines, lines), ([baseline, current]) => {
      const doc = Text.of(current)
      const { hunks } = reviewHunks(baseline, doc)
      const rejected = rejectHunks(EditorState.create({ doc }), hunks)
      assert.deepEqual((rejected?.state.doc ?? doc).lineTexts(), baseline)
      let accepted = baseline
      for (const hunk of [...hunks].reverse()) accepted = acceptHunk(accepted, hunk, doc)
      assert.deepEqual(accepted, current)
    })
  })

  it('rejects one hunk and leaves the others', async () => {
    await check(gen.tuple(lines, lines, gen.int(0, 50)), ([baseline, current, pick]) => {
      const doc = Text.of(current)
      const { hunks } = reviewHunks(baseline, doc)
      if (!hunks.length) return
      const hunk = hunks[pick % hunks.length]
      const state = rejectHunks(EditorState.create({ doc }), [hunk])!.state
      const after = state.doc.lineTexts()
      // The rejected region now matches the baseline, and the remaining changes still reject cleanly.
      assert.deepEqual(after.slice(hunk.fromB, hunk.fromB + hunk.removed.length), [...hunk.removed])
      const rest = reviewHunks(baseline, state.doc).hunks
      assert.deepEqual((rejectHunks(state, rest)?.state.doc ?? state.doc).lineTexts(), baseline)
    })
  })

  it('finds the words that changed in a modified line', () => {
    const doc = Text.of(['const total = price * qty', 'other'])
    const { hunks } = reviewHunks(['const total = price + qty', 'other'], doc)
    assert.deepEqual(reviewStats(hunks), { added: 1, removed: 1 })
    const words = wordChanges(hunks[0], doc)!
    assert.deepEqual(
      words.map((change) => doc.sliceString(change.fromB, change.toB)),
      ['*'],
    )
  })
})
