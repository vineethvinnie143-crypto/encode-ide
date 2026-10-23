import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { LANGUAGE_SERVERS, serverFor, type ServerSpec } from './catalog'
import { discover, shimScript } from './discover'
import { applyTextEdits, EditConflict } from './edits'
import type { TextEdit } from './protocol'
import { readCodeActions, readDiagnostics, readDocumentSymbols, readHover, readLocations, readRange, readWorkspaceEdit } from './results'
import { documentKey, pathToUri, uriToPath } from './uri'

describe('file URIs', () => {
  it('writes and reads back POSIX paths, encoding what a URI cannot carry', () => {
    const file = '/home/me/my project/a#b?c%d.ts'
    const uri = pathToUri(file, 'linux')
    assert.equal(uri, 'file:///home/me/my%20project/a%23b%3Fc%25d.ts')
    assert.equal(uriToPath(uri, 'linux'), file)
    const accents = '/srv/caf\u00e9/\u65e5\u672c.lua'
    assert.equal(uriToPath(pathToUri(accents, 'linux'), 'linux'), accents)
  })

  it('writes Windows drives with an upper-case letter and reads the spellings servers use', () => {
    assert.equal(pathToUri('c:\\Users\\Me\\src\\main.ts', 'win32'), 'file:///C:/Users/Me/src/main.ts')
    assert.equal(uriToPath('file:///c%3A/Users/Me/src/main.ts', 'win32'), 'C:\\Users\\Me\\src\\main.ts')
    assert.equal(uriToPath('file:///C:/Users/Me/src/main.ts', 'win32'), 'C:\\Users\\Me\\src\\main.ts')
    assert.equal(uriToPath('file://localhost/D:/x.ts', 'win32'), 'D:\\x.ts')
    assert.equal(uriToPath('file:///D:', 'win32'), 'D:\\')
  })

  it('keeps network shares on Windows', () => {
    const uri = pathToUri('\\\\Server\\share\\dir\\a b.ts', 'win32')
    assert.equal(uri, 'file://server/share/dir/a%20b.ts')
    assert.equal(uriToPath(uri, 'win32'), '\\\\server\\share\\dir\\a b.ts')
  })

  it('refuses what is not a local file', () => {
    assert.equal(uriToPath('untitled:Untitled-1', 'linux'), null)
    assert.equal(uriToPath('https://example.com/a.ts', 'linux'), null)
    assert.equal(uriToPath('file://elsewhere/etc/passwd', 'linux'), null)
    assert.equal(uriToPath('file:///a%00b', 'linux'), null)
    assert.equal(uriToPath('file:///bad%E0%A4%A', 'linux'), null)
    assert.equal(uriToPath('file:///no-drive/x.ts', 'win32'), null)
    assert.throws(() => pathToUri('relative/a.ts', 'linux'))
    assert.throws(() => pathToUri('relative\\a.ts', 'win32'))
  })

  it('keys documents without case where the file system has none', () => {
    assert.equal(documentKey('C:\\Src\\A.ts', 'win32'), documentKey('c:\\src\\a.TS', 'win32'))
    assert.equal(documentKey('/Users/Me/A.ts', 'darwin'), documentKey('/users/me/a.ts', 'darwin'))
    assert.notEqual(documentKey('/src/A.ts', 'linux'), documentKey('/src/a.ts', 'linux'))
  })

  it('round-trips any path made of awkward names', async () => {
    const segment = gen.string('aZ09 -_.~#?%&=+@!$\u00e9\u4e2d', 1, 8)
    await check(gen.array(segment, 1, 5), (parts) => {
      const clean = parts.map((part) => (part === '.' || part === '..' ? `${part}x` : part))
      const posix = `/${clean.join('/')}`
      assert.equal(uriToPath(pathToUri(posix, 'linux'), 'linux'), posix)
      const windows = `C:\\${clean.join('\\')}`
      assert.equal(uriToPath(pathToUri(windows, 'win32'), 'win32'), windows)
    })
  })
})

describe('text edits', () => {
  const at = (line: number, character: number) => ({ line, character })
  const edit = (sl: number, sc: number, el: number, ec: number, newText: string): TextEdit => ({ range: { start: at(sl, sc), end: at(el, ec) }, newText })

  it('applies edits in any order the server gives them', () => {
    const text = 'let a = 1\nlet b = a\nprint(a)\n'
    const edits = [edit(2, 6, 2, 7, 'x'), edit(0, 4, 0, 5, 'x'), edit(1, 8, 1, 9, 'x')]
    assert.equal(applyTextEdits(text, edits), 'let x = 1\nlet b = x\nprint(x)\n')
  })

  it('counts lines across CRLF and lone CR, and characters in UTF-16 units', () => {
    assert.equal(applyTextEdits('one\r\ntwo\rthree', [edit(1, 0, 1, 3, 'TWO'), edit(2, 0, 2, 5, '3')]), 'one\r\nTWO\r3')
    // The emoji is two code units: the edit after it starts at 3.
    assert.equal(applyTextEdits('a\u{1F600}b', [edit(0, 3, 0, 4, 'c')]), 'a\u{1F600}c')
  })

  it('reads a character past a line as its end, and a line past the text as the text end', () => {
    assert.equal(applyTextEdits('ab\r\ncd', [edit(0, 99, 0, 99, '!')]), 'ab!\r\ncd')
    assert.equal(applyTextEdits('ab\ncd', [edit(9, 0, 9, 0, '\nef')]), 'ab\ncd\nef')
    assert.equal(applyTextEdits('ab\ncd', [edit(1, 1, 7, 0, '')]), 'ab\nc')
  })

  it('keeps inserts at one place in the order given', () => {
    assert.equal(applyTextEdits('x', [edit(0, 0, 0, 0, 'a'), edit(0, 0, 0, 0, 'b'), edit(0, 1, 0, 1, 'c')]), 'abxc')
  })

  it('refuses edits that overlap', () => {
    assert.throws(() => applyTextEdits('abcdef', [edit(0, 0, 0, 3, 'x'), edit(0, 2, 0, 4, 'y')]), EditConflict)
  })

  it('matches a plain reference on random documents and random edits that do not overlap', async () => {
    const line = gen.string('ab \u00e9\u{1F600}', 0, 6)
    const documents = gen.map(gen.tuple(gen.array(line, 1, 6), gen.oneOf('\n', '\r\n')), ([lines, eol]) => lines.join(eol))
    const cases = gen.tuple(documents, gen.array(gen.tuple(gen.int(0, 40), gen.int(0, 4), gen.string('xyz\n', 0, 3)), 0, 5))
    await check(cases, ([text, picks]) => {
      // Offsets turned into positions; spans sorted and kept apart.
      const spans: { start: number; end: number; newText: string }[] = []
      let floor = 0
      for (const [start, length, newText] of [...picks].sort((a, b) => a[0] - b[0])) {
        let from = Math.max(floor, Math.min(start, text.length))
        // Never split a surrogate pair or a CRLF.
        const inside = (offset: number) => offset > 0 && offset < text.length && ((/[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) || (text[offset] === '\n' && text[offset - 1] === '\r'))
        while (inside(from)) from++
        let to = Math.min(from + length, text.length)
        while (inside(to)) to++
        if (from > text.length) break
        spans.push({ start: from, end: to, newText })
        floor = to + 1
      }
      const position = (offset: number) => {
        const before = text.slice(0, offset)
        const breaks = before.match(/\r\n|\r|\n/g) ?? []
        const last = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
        return { line: breaks.length, character: offset - (last + 1) }
      }
      const edits = spans.map((span) => ({ range: { start: position(span.start), end: position(span.end) }, newText: span.newText }))
      let expected = text
      for (const span of [...spans].reverse()) expected = expected.slice(0, span.start) + span.newText + expected.slice(span.end)
      assert.equal(applyTextEdits(text, edits.reverse()), expected)
    })
  })
})

describe('reading what a server answers', () => {
  it('reads locations and location links, and drops what does not read', () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
    assert.deepEqual(readLocations({ uri: 'file:///a.ts', range }), [{ uri: 'file:///a.ts', range }])
    assert.deepEqual(readLocations([{ targetUri: 'file:///b.ts', targetRange: range, targetSelectionRange: range }, { uri: 7 }, null, { uri: 'file:///c.ts', range: { start: { line: -1, character: 0 }, end: range.end } }]), [{ uri: 'file:///b.ts', range }])
    assert.deepEqual(readLocations(null), [])
  })

  it('reads a range given backwards the right way round', () => {
    assert.deepEqual(readRange({ start: { line: 3, character: 0 }, end: { line: 1, character: 4 } }), { start: { line: 1, character: 4 }, end: { line: 3, character: 0 } })
  })

  it('reads diagnostics and keeps their fields to a sane size', () => {
    const read = readDiagnostics([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x'.repeat(5000), severity: 9, code: 42, source: 'tsc' }, { message: 'no range' }])
    assert.equal(read.length, 1)
    assert.equal(read[0].message.length, 2000)
    assert.equal(read[0].severity, undefined)
    assert.equal(read[0].code, 42)
  })

  it('refuses a whole workspace edit when one part of it does not read', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    assert.ok(readWorkspaceEdit({ changes: { 'file:///a.ts': [{ range, newText: 'x' }] } }))
    assert.equal(readWorkspaceEdit({ changes: { 'file:///a.ts': [{ range, newText: 'x' }], 'file:///b.ts': [{ range }] } }), null)
    assert.equal(readWorkspaceEdit({ documentChanges: [{ textDocument: { uri: 'file:///a.ts', version: 1 }, edits: [{ range, newText: 'x' }] }, { kind: 'format-disk', uri: 'file:///' }] }), null)
    const ops = readWorkspaceEdit({ documentChanges: [{ kind: 'create', uri: 'file:///n.ts' }, { kind: 'rename', oldUri: 'file:///n.ts', newUri: 'file:///m.ts', options: { overwrite: 'yes' } }, { kind: 'delete', uri: 'file:///m.ts', options: { recursive: true } }] })
    assert.deepEqual(ops?.documentChanges?.map((item) => ('kind' in item ? item.kind : 'edit')), ['create', 'rename', 'delete'])
    assert.equal((ops?.documentChanges?.[1] as { options: { overwrite: boolean } }).options.overwrite, false)
  })

  it('reads an outline as a tree or a flat list', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }
    const tree = readDocumentSymbols([{ name: 'main', kind: 12, range, selectionRange: range, children: [{ name: 'x', kind: 13, range, selectionRange: range }, { name: 7 }] }])
    assert.ok('tree' in tree && tree.tree[0].children?.length === 1)
    const flat = readDocumentSymbols([{ name: 'main', kind: 12, location: { uri: 'file:///a.ts', range } }])
    assert.ok('flat' in flat && flat.flat[0].name === 'main')
  })

  it('reads hovers of every shape', () => {
    assert.equal(readHover({ contents: 'plain' }), 'plain')
    assert.equal(readHover({ contents: { kind: 'markdown', value: '**x**' } }), '**x**')
    assert.equal(readHover({ contents: [{ language: 'ts', value: 'let x: number' }, 'doc'] }), '```ts\nlet x: number\n```\n\ndoc')
    assert.equal(readHover({ contents: '' }), null)
  })

  it('reads code actions, a bare command as an action that runs it', () => {
    const read = readCodeActions([{ title: 'Run', command: 'x.run', arguments: [1] }, { title: 'Fix', kind: 'quickfix', edit: { changes: {} } }, { title: 'Broken', edit: { changes: { a: 'no' } } }, { kind: 'quickfix' }])
    assert.deepEqual(read.map((item) => item.title), ['Run', 'Fix'])
    assert.deepEqual(read[0].command, { title: 'Run', command: 'x.run', arguments: [1] })
  })
})

describe('the servers eNCode knows', () => {
  it('finds the server for a file by its extension or its name', () => {
    assert.equal(serverFor('/p/src/app.tsx')?.languageId, 'typescriptreact')
    assert.equal(serverFor('/p/fxmanifest.lua')?.spec.id, 'lua')
    assert.equal(serverFor('C:\\p\\go.mod')?.spec.id, 'go')
    assert.equal(serverFor('/p/README.md'), null)
    assert.equal(serverFor('/p/Makefile'), null)
  })

  it('carries no server taken from VS Code', () => {
    const commands = LANGUAGE_SERVERS.flatMap((spec) => spec.candidates.map((candidate) => candidate.command))
    for (const command of commands) assert.doesNotMatch(command, /vscode/i)
  })

  it('points TypeScript at the project\'s own compiler when it has one', () => {
    const spec = LANGUAGE_SERVERS.find((item) => item.id === 'typescript')!
    assert.deepEqual(spec.initializationOptions?.('/p', () => false), { hostInfo: 'eNCode' })
    assert.deepEqual(spec.initializationOptions?.('/p', (file) => file.endsWith('tsserver.js')), { hostInfo: 'eNCode', tsserver: { path: '/p/node_modules/typescript/lib' } })
  })
})

describe('finding a server', () => {
  const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: ['--stdio'] }, { command: 'other-ls', args: [] }], install: 'npm install -g fake-ls' }

  it('reads the script an npm or pnpm shim runs', () => {
    const npm = '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\fake-ls\\lib\\cli.js" %*\r\n'
    assert.equal(shimScript('C:\\Users\\Me\\AppData\\Roaming\\npm\\fake-ls.cmd', npm), 'C:\\Users\\Me\\AppData\\Roaming\\npm\\node_modules\\fake-ls\\lib\\cli.js')
    const pnpm = '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=x"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\fake-ls\\bin\\fake.mjs" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\fake-ls\\bin\\fake.mjs" %*\r\n)\r\n'
    assert.equal(shimScript('C:\\p\\node_modules\\.bin\\fake-ls.cmd', pnpm), 'C:\\p\\node_modules\\fake-ls\\bin\\fake.mjs')
  })

  it('refuses a shim whose script lies outside its package folder', () => {
    assert.equal(shimScript('C:\\p\\node_modules\\.bin\\fake-ls.cmd', '"%~dp0\\..\\..\\..\\evil\\x.js" %*'), null)
    assert.equal(shimScript('C:\\p\\node_modules\\.bin\\fake-ls.cmd', 'calc.exe'), null)
  })

  it('starts a Windows shim\'s script with Node, never through cmd.exe', () => {
    const files = new Set(['C:\\npm\\fake-ls.cmd', 'C:\\npm\\node_modules\\fake-ls\\cli.js', 'C:\\Program Files\\nodejs\\node.exe'])
    const plan = discover(spec, 'C:\\p', {
      platform: 'win32',
      which: (name) => (name === 'fake-ls' ? 'C:\\npm\\fake-ls.cmd' : name === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : null),
      isFile: (file) => files.has(file),
      readText: () => '"%dp0%\\node_modules\\fake-ls\\cli.js" %*',
    })
    assert.deepEqual(plan, { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\fake-ls\\cli.js', '--stdio'], found: 'the PATH', command: 'fake-ls' })
  })

  it('looks in the project only when told to, and says how to install what is missing', () => {
    const files = new Set(['/p/node_modules/.bin/fake-ls'])
    const options = { platform: 'linux' as const, which: () => null, isFile: (file: string) => files.has(file) }
    assert.deepEqual(discover(spec, '/p', options), { missing: 'No language server for Fake is installed (fake-ls or other-ls). To get one: npm install -g fake-ls.' })
    assert.deepEqual(discover(spec, '/p', { ...options, projectBins: true }), { file: '/p/node_modules/.bin/fake-ls', args: ['--stdio'], found: 'the project', command: 'fake-ls' })
  })

  it('takes the next candidate when the first is not there, and skips a Windows file it cannot start', () => {
    const files = new Set(['C:\\bin\\fake-ls.ps1', 'C:\\bin\\other-ls.exe'])
    const plan = discover(spec, 'C:\\p', { platform: 'win32', which: (name) => (name === 'fake-ls' ? 'C:\\bin\\fake-ls.ps1' : name === 'other-ls' ? 'C:\\bin\\other-ls.exe' : null), isFile: (file) => files.has(file) })
    assert.deepEqual(plan, { file: 'C:\\bin\\other-ls.exe', args: [], found: 'the PATH', command: 'other-ls' })
  })
})
