import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { applyEdit, applyEdits } from './edit'
import { editTool, multiEditTool, readTool, writeTool } from './files'
import { tempWorkspace, testContext, textOf } from './testing'

describe('Read', () => {
  it('numbers lines like cat -n and pages with offset and limit', async () => {
    const root = await tempWorkspace({ 'a.txt': 'one\ntwo\nthree\nfour\n' })
    const ctx = testContext(root)
    const whole = await readTool.run({ file_path: path.join(root, 'a.txt') }, ctx)
    assert.equal(whole.content, '     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour')
    const page = await readTool.run({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx)
    assert.equal(page.content, '     2\ttwo\n     3\tthree\n\n(Lines 2-3 of 4. Pass offset and limit to read other lines.)')
    assert.equal(ctx.files.get(path.join(root, 'a.txt'))?.partial, true)
    const past = await readTool.run({ file_path: 'a.txt', offset: 9 }, ctx)
    assert.equal(past.ok, false)
    assert.match(textOf(past.content), /has 4 lines, so offset 9 is past its end/)
  })

  it('explains directories, missing files, empty and binary files', async () => {
    const root = await tempWorkspace({ 'src/App.tsx': 'x', 'empty.txt': '', 'blob.bin': Buffer.from([0, 1, 2, 0]) })
    const ctx = testContext(root)
    assert.match(textOf((await readTool.run({ file_path: 'src' }, ctx)).content), /is a directory/)
    assert.match(textOf((await readTool.run({ file_path: 'src/App.ts' }, ctx)).content), /does not exist\. Did you mean src\/App\.tsx\?/)
    assert.equal((await readTool.run({ file_path: 'empty.txt' }, ctx)).content, 'empty.txt exists but is empty.')
    const binary = await readTool.run({ file_path: 'blob.bin' }, ctx)
    assert.equal(binary.ok, false)
    assert.match(textOf(binary.content), /binary file/)
  })

  it('returns images as image blocks', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const root = await tempWorkspace({ 'logo.png': png })
    const outcome = await readTool.run({ file_path: 'logo.png' }, testContext(root))
    assert.ok(Array.isArray(outcome.content))
    const image = (outcome.content as { type: string; mediaType?: string; data?: string }[])[1]
    assert.equal(image.type, 'image')
    assert.equal(image.mediaType, 'image/png')
    assert.equal(image.data, png.toString('base64'))
  })

  it('renders notebooks cell by cell', async () => {
    const notebook = { cells: [{ cell_type: 'code', id: 'c1', source: ['print(1)\n'], outputs: [{ output_type: 'stream', text: ['1\n'] }] }] }
    const root = await tempWorkspace({ 'n.ipynb': JSON.stringify(notebook) })
    const outcome = await readTool.run({ file_path: 'n.ipynb' }, testContext(root))
    assert.equal(outcome.content, '<cell index="0" id="c1" type="code">\nprint(1)\n\n</cell>\n<outputs index="0">\n1\n\n</outputs>')
  })
})

describe('older ANSI files', () => {
  const e = String.fromCodePoint(0xe9)
  const original = Buffer.concat([Buffer.from('-- caf'), Buffer.from([0xe9]), Buffer.from('\r\nlocal price = 5 -- '), Buffer.from([0x80]), Buffer.from('\r\n')])

  it('shows a Windows-1252 file as text, says so, and keeps every other byte when it is edited', async () => {
    const root = await tempWorkspace({ 'old.lua': original })
    const ctx = testContext(root)
    const read = textOf((await readTool.run({ file_path: 'old.lua' }, ctx)).content)
    assert.match(read, new RegExp(`caf${e}`))
    assert.match(read, /older ANSI file, not UTF-8: it is shown as Windows-1252/)

    const edited = await editTool.run({ file_path: 'old.lua', old_string: 'price = 5', new_string: `price = 6 -- ${e}t${e}` }, ctx)
    assert.equal(edited.ok, true)
    const expected = original.toString('latin1').replace('price = 5', `price = 6 -- ${e}t${e}`)
    assert.deepEqual(await fs.readFile(path.join(root, 'old.lua')), Buffer.from(expected, 'latin1'))
    // The file stays CRLF, and a whole-file write keeps its encoding too.
    const written = await writeTool.run({ file_path: 'old.lua', content: `caf${e}\nnext\n` }, ctx)
    assert.equal(written.ok, true)
    assert.deepEqual(await fs.readFile(path.join(root, 'old.lua')), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x6e, 0x65, 0x78, 0x74, 0x0d, 0x0a]))
  })

  it('refuses a character the file cannot hold, and leaves the file as it was', async () => {
    const root = await tempWorkspace({ 'old.lua': original })
    const ctx = testContext(root)
    await readTool.run({ file_path: 'old.lua' }, ctx)
    const cjk = String.fromCodePoint(0x65e5)
    const edit = await editTool.run({ file_path: 'old.lua', old_string: 'price = 5', new_string: `price = ${cjk}` }, ctx)
    assert.equal(edit.ok, false)
    assert.match(textOf(edit.content), /older ANSI text file \(Windows-1252, not UTF-8\) and cannot hold "/)
    const write = await writeTool.run({ file_path: 'old.lua', content: cjk }, ctx)
    assert.equal(write.ok, false)
    assert.deepEqual(await fs.readFile(path.join(root, 'old.lua')), original)
  })
})

describe('big files', () => {
  it('does not load a file over 20 MB, and says how to look at part of it', async () => {
    const root = await tempWorkspace({ 'big.log': 'x\n' })
    await fs.truncate(path.join(root, 'big.log'), 21 * 1024 * 1024)
    const ctx = testContext(root)
    const read = await readTool.run({ file_path: 'big.log' }, ctx)
    assert.equal(read.ok, false)
    assert.match(textOf(read.content), /big\.log is 21 MB, more than the 20 MB that Read loads whole\. Search it with Grep, or look at part of it through Bash \(head -n 200/)
    const edit = await editTool.run({ file_path: 'big.log', old_string: 'x', new_string: 'y' }, ctx)
    assert.equal(edit.ok, false)
    assert.match(textOf(edit.content), /that Edit and Write load whole\. Change it through Bash/)
    assert.equal((await writeTool.run({ file_path: 'big.log', content: 'y' }, ctx)).ok, false)
    assert.equal((await fs.stat(path.join(root, 'big.log'))).size, 21 * 1024 * 1024)
  })

  it('suggests PowerShell commands when that is the shell', async () => {
    const root = await tempWorkspace({ 'big.log': 'x\n' })
    await fs.truncate(path.join(root, 'big.log'), 21 * 1024 * 1024)
    const ctx = testContext(root, { shell: { dialect: 'pwsh', program: 'pwsh', state: () => ({ cwd: root, env: {}, dialect: 'pwsh' }), run: async () => Promise.reject(new Error('not used')) } })
    assert.match(textOf((await readTool.run({ file_path: 'big.log' }, ctx)).content), /Get-Content -TotalCount 200 or Get-Content -Tail 200/)
  })

  it('cuts one Read to about 100,000 characters and says where it stopped', async () => {
    const root = await tempWorkspace({ 'wide.txt': `${`${'x'.repeat(99)}\n`.repeat(3000)}` })
    const outcome = await readTool.run({ file_path: 'wide.txt' }, testContext(root))
    const text = textOf(outcome.content)
    assert.ok(text.length < 105_000, `${text.length} characters`)
    assert.match(text, /\(Lines 1-\d+ of 3000, shortened to fit\. Pass offset and limit to read other lines\.\)/)
  })
})

describe('Write', () => {
  it('creates new files, but refuses to overwrite a file it has not read', async () => {
    const root = await tempWorkspace({ 'old.txt': 'before\n' })
    const ctx = testContext(root)
    const created = await writeTool.run({ file_path: 'new/deep/file.txt', content: 'hello\n' }, ctx)
    assert.equal(created.ok, true)
    assert.equal(await fs.readFile(path.join(root, 'new/deep/file.txt'), 'utf8'), 'hello\n')
    assert.deepEqual(created.changed, [path.join(root, 'new/deep/file.txt')])

    const refused = await writeTool.run({ file_path: 'old.txt', content: 'after\n' }, ctx)
    assert.equal(refused.ok, false)
    assert.match(textOf(refused.content), /has not been read in this session/)
    await readTool.run({ file_path: 'old.txt' }, ctx)
    assert.equal((await writeTool.run({ file_path: 'old.txt', content: 'after\n' }, ctx)).ok, true)
    assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'after\n')
  })

  it('refuses when the file changed after it was read', async () => {
    const root = await tempWorkspace({ 'a.txt': 'one\n' })
    const ctx = testContext(root)
    await readTool.run({ file_path: 'a.txt' }, ctx)
    await fs.writeFile(path.join(root, 'a.txt'), 'changed by the user\n')
    const outcome = await writeTool.run({ file_path: 'a.txt', content: 'two\n' }, ctx)
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /changed since it was last read/)
  })

  it('keeps CRLF endings and the byte order mark, and passes the old bytes to beforeWrite', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')])
    const root = await tempWorkspace({ 'w.txt': original })
    const seen: { file: string; previous: Buffer | null; turnId: string }[] = []
    const ctx = testContext(root, { beforeWrite: async (file, previous, info) => void seen.push({ file, previous, turnId: info.turnId }) })
    await readTool.run({ file_path: 'w.txt' }, ctx)
    await writeTool.run({ file_path: 'w.txt', content: 'x\ny\n' }, ctx)
    const written = await fs.readFile(path.join(root, 'w.txt'))
    assert.deepEqual(written, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\ny\r\n')]))
    assert.deepEqual(seen, [{ file: path.join(root, 'w.txt'), previous: original, turnId: 'turn' }])
  })

  it('does not write when beforeWrite fails', async () => {
    const root = await tempWorkspace()
    const ctx = testContext(root, { beforeWrite: async () => Promise.reject(new Error('checkpoint store is full')) })
    await assert.rejects(writeTool.run({ file_path: 'a.txt', content: 'x' }, ctx), /checkpoint store is full/)
    await assert.rejects(fs.stat(path.join(root, 'a.txt')))
  })
})

describe('Edit and MultiEdit', () => {
  it('replaces exactly one occurrence and shows the changed lines', async () => {
    const root = await tempWorkspace({ 'a.ts': 'const a = 1\nconst b = 2\n' })
    const ctx = testContext(root)
    await readTool.run({ file_path: 'a.ts' }, ctx)
    const outcome = await editTool.run({ file_path: 'a.ts', old_string: 'b = 2', new_string: 'b = 3' }, ctx)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.content, 'Edited a.ts. The changed part now reads:\n     1\tconst a = 1\n     2\tconst b = 3')
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'const a = 1\nconst b = 3\n')
    // Its own write counts as read: a second edit needs no Read.
    assert.equal((await editTool.run({ file_path: 'a.ts', old_string: 'a = 1', new_string: 'a = 0' }, ctx)).ok, true)
  })

  it('needs a read first, and explains ambiguous or missing text', async () => {
    const root = await tempWorkspace({ 'a.txt': 'x x\n' })
    const ctx = testContext(root)
    assert.match(textOf((await editTool.run({ file_path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx)).content), /has not been read/)
    await readTool.run({ file_path: 'a.txt' }, ctx)
    assert.match(textOf((await editTool.run({ file_path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx)).content), /occurs 2 times/)
    assert.match(textOf((await editTool.run({ file_path: 'a.txt', old_string: 'z', new_string: 'y' }, ctx)).content), /was not found/)
    const all = await editTool.run({ file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx)
    assert.match(textOf(all.content), /\(2 replacements\)/)
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'y y\n')
  })

  it('creates a file from an empty old_string', async () => {
    const root = await tempWorkspace()
    const ctx = testContext(root)
    const outcome = await editTool.run({ file_path: 'new.md', old_string: '', new_string: '# Title\n' }, ctx)
    assert.equal(outcome.ok, true)
    assert.equal(await fs.readFile(path.join(root, 'new.md'), 'utf8'), '# Title\n')
  })

  it('applies all edits or none', async () => {
    const root = await tempWorkspace({ 'a.txt': 'alpha\nbeta\n' })
    const ctx = testContext(root)
    await readTool.run({ file_path: 'a.txt' }, ctx)
    const failed = await multiEditTool.run(
      { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'one' }, { old_string: 'gamma', new_string: 'three' }] },
      ctx,
    )
    assert.match(textOf(failed.content), /Edit 2 of 2: old_string was not found.*No edit was applied\./)
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'alpha\nbeta\n')
    const done = await multiEditTool.run(
      { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'one' }, { old_string: 'one\nbeta', new_string: 'one\ntwo' }] },
      ctx,
    )
    assert.equal(done.ok, true)
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n')
  })

  it('previews the diff an approval card shows', async () => {
    const root = await tempWorkspace({ 'a.txt': 'one\ntwo\n' })
    const summary = await editTool.describe({ file_path: 'a.txt', old_string: 'two', new_string: 'TWO' }, testContext(root))
    assert.equal(summary.title, 'Edit a.txt')
    assert.deepEqual(
      summary.preview?.[0].lines.map((line) => `${line.type}:${line.text}`),
      ['ctx:one', 'del:two', 'add:TWO', 'ctx:'],
    )
  })
})

describe('applyEdit', () => {
  it('matches LF snippets in CRLF files and keeps CRLF', () => {
    assert.deepEqual(applyEdit('a\r\nb\r\nc\r\n', { old_string: 'a\nb', new_string: 'a\nB' }), { ok: true, text: 'a\r\nB\r\nc\r\n', replacements: 1 })
  })

  it('matches curly quotes against straight ones and keeps the file straight', () => {
    const outcome = applyEdit('say("hi")\n', { old_string: 'say(“hi”)', new_string: 'say(“hello”)' })
    assert.deepEqual(outcome, { ok: true, text: 'say("hello")\n', replacements: 1 })
  })

  it('strips line-number prefixes copied from Read', () => {
    const outcome = applyEdit('x = 1\ny = 2\n', { old_string: '     1\tx = 1\n     2\ty = 2', new_string: '     1\tx = 10\n     2\ty = 20' })
    assert.deepEqual(outcome, { ok: true, text: 'x = 10\ny = 20\n', replacements: 1 })
  })

  it('points at the same text with other spacing, so the next try can copy it', () => {
    const text = 'function a() {\n\treturn 1   \n}\nfunction b() {\n\treturn 2\n}\n'
    const outcome = applyEdit(text, { old_string: 'function a() {\n  return 1\n}', new_string: 'x' }) as { ok: false; error: string }
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /old_string was not found in the file\./)
    assert.match(outcome.error, /The same text is at lines 1-3 with different spacing/)
    assert.ok(outcome.error.includes('function a() {\n\treturn 1   \n}'))
  })

  it('lists the places when the same text with other spacing is there more than once', () => {
    const outcome = applyEdit('a\nx  =  1\nb\nx   =   1\n', { old_string: 'x = 1', new_string: 'y' }) as { ok: false; error: string }
    assert.match(outcome.error, /The same text with different spacing is at lines 2, 4; copy the one you mean from Read, spacing included\./)
  })

  it('names the line where only the first line of old_string is found, and says nothing when nothing is close', () => {
    const lead = applyEdit('const answer = compute()\nreturn answer\n', { old_string: 'const answer = compute()\nreturn other', new_string: 'x' }) as { ok: false; error: string }
    assert.match(lead.error, /Line 1 of the file has the same text as line 1 of old_string, but the lines around it differ\./)
    const nowhere = applyEdit('abc\n', { old_string: 'zzzzzzzzzz', new_string: 'x' }) as { ok: false; error: string }
    assert.equal(nowhere.error, 'old_string was not found in the file. Read the file again and copy the text exactly, including indentation, without the line-number prefix.')
  })

  it('says where an ambiguous old_string occurs', () => {
    const outcome = applyEdit('x\nfoo\nx\nbar\nx\n', { old_string: 'x', new_string: 'y' }) as { ok: false; error: string }
    assert.match(outcome.error, /occurs 3 times \(lines 1, 3, 5\)\. Add surrounding lines/)
    const many = applyEdit('x\n'.repeat(9), { old_string: 'x', new_string: 'y' }) as { ok: false; error: string }
    assert.match(many.error, /occurs 9 times \(lines 1, 2, 3, 4, 5, …\)\./)
  })

  it('refuses identical strings, and reports which edit failed', () => {
    assert.equal(applyEdit('a', { old_string: 'a', new_string: 'a' }).ok, false)
    const outcome = applyEdits('a b', [{ old_string: 'a', new_string: 'c' }, { old_string: 'a', new_string: 'd' }])
    assert.equal(outcome.ok, false)
    assert.match((outcome as { error: string }).error, /^Edit 2 of 2:/)
  })
})
