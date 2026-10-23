import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { EditPlan, LanguageServers, PlannedChange, ServerSpec, TextEdit } from '@encode/lsp'
import { fakeServer, type FakeServer } from '@encode/lsp/testing'
import { realPathOf } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { applyEditorPlan, ChangeRefused, previewPlan, undoEditorChange } from './editor-changes'
import { Workspaces } from './scope'

let fake: FakeServer
before(async () => {
  fake = await fakeServer()
})
after(async () => {
  await fake.dispose()
})

const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: [] }], install: 'npm install -g fake-ls' }
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const E_ACUTE = String.fromCharCode(0xe9)
const SNOWMAN = String.fromCharCode(0x2603)

/** The editor's documents as a stub of the servers knows them, and what it was told. */
function stubServers(docs: Record<string, { text: string; dirty: boolean }> = {}) {
  const told: { editor: [string, string, boolean][]; changed: string[] } = { editor: [], changed: [] }
  const servers = {
    editorText: (file: string) => docs[file] ?? null,
    editorChange: (file: string, text: string, dirty: boolean) => {
      told.editor.push([file, text, dirty])
      docs[file] = { text, dirty }
    },
    changed: async (changes: { file: string; kind: string }[]) => {
      told.changed.push(...changes.map((change) => `${change.kind} ${path.basename(change.file)}`))
    },
  } as unknown as LanguageServers
  return { servers, told, docs }
}

const at = (line: number, start: number, end: number, newText: string): TextEdit => ({ range: { start: { line, character: start }, end: { line, character: end } }, newText })
const edit = (file: string, before: string, after: string, textEdits: TextEdit[]): PlannedChange => ({ kind: 'edit', file, before, after, edits: textEdits.length, textEdits })
const planOf = (...changes: PlannedChange[]): EditPlan => ({
  server: 'Fake',
  changes,
  files: [...new Set(changes.flatMap((change) => (change.kind === 'rename' ? [change.from, change.to] : [change.file])))],
})

describe('the editor\'s changes', () => {
  it('change unsaved documents in the editor, and saved ones and closed files on disk, keeping their encoding and line breaks', async () => {
    const root = await realPathOf(await tempWorkspace({ 'a.fk': 'old a\n', 'c.fk': 'call old\n' }))
    const a = path.join(root, 'a.fk')
    const b = path.join(root, 'b.fk')
    const c = path.join(root, 'c.fk')
    // b: UTF-8 with a byte order mark, CRLF lines and one line ending in LF, which stays as it is.
    await writeFile(b, Buffer.concat([BOM, Buffer.from('use old\r\nkeep\nold again\r\n')]))
    const { servers, told } = stubServers({ [a]: { text: 'old a\nold unsaved\n', dirty: true }, [c]: { text: 'call old\n', dirty: false } })
    const plan = planOf(
      edit(a, 'old a\nold unsaved\n', 'new a\nnew unsaved\n', [at(0, 0, 3, 'new'), at(1, 0, 3, 'new')]),
      edit(b, 'use old\r\nkeep\r\nold again\r\n', 'use new\r\nkeep\r\nnew again\r\n', [at(0, 4, 7, 'new'), at(2, 0, 3, 'new')]),
      edit(c, 'call old\n', 'call new\n', [at(0, 5, 8, 'new')]),
    )
    const applied = await applyEditorPlan(plan, { root, servers, open: [a, c], platform: 'linux' })
    assert.deepEqual(
      applied.editor.map((item) => [path.basename(item.file), item.edits.length, item.written]),
      [
        ['a.fk', 2, false],
        ['c.fk', 1, true],
      ],
    )
    assert.deepEqual(applied.written, [b])
    assert.equal(applied.places, 5)
    assert.equal(await readFile(a, 'utf8'), 'old a\n', 'the unsaved document is changed in the editor only')
    assert.deepEqual(await readFile(b), Buffer.concat([BOM, Buffer.from('use new\r\nkeep\nnew again\r\n')]))
    assert.equal(await readFile(c, 'utf8'), 'call new\n')
    // The servers see the editor's documents as they are now, and the closed file as changed on disk.
    assert.deepEqual(told.editor, [
      [a, 'new a\nnew unsaved\n', true],
      [c, 'call new\n', false],
    ])
    assert.deepEqual(told.changed, ['changed b.fk'])

    // Taken back whole: the disk as it was, byte for byte, and the editor's documents as they were.
    const undone = await undoEditorChange(applied.record, { root, servers, open: [a, c], platform: 'linux' })
    assert.deepEqual(
      undone.editor.map((item) => [path.basename(item.file), item.written]),
      [
        ['a.fk', false],
        ['c.fk', true],
      ],
    )
    assert.deepEqual(undone.written, [b])
    assert.deepEqual(await readFile(b), Buffer.concat([BOM, Buffer.from('use old\r\nkeep\nold again\r\n')]))
    assert.equal(await readFile(c, 'utf8'), 'call old\n')
    assert.deepEqual(told.editor.slice(2), [
      [a, 'old a\nold unsaved\n', true],
      [c, 'call old\n', false],
    ])
  })

  it('are not taken back once something they touched has changed', async () => {
    const root = await realPathOf(await tempWorkspace({ 'b.fk': 'old\n' }))
    const b = path.join(root, 'b.fk')
    const { servers } = stubServers()
    const applied = await applyEditorPlan(planOf(edit(b, 'old\n', 'new\n', [at(0, 0, 3, 'new')])), { root, servers, open: [], platform: 'linux' })
    await writeFile(b, 'new, and more\n')
    await assert.rejects(undoEditorChange(applied.record, { root, servers, open: [], platform: 'linux' }), (error: unknown) => error instanceof ChangeRefused && /b\.fk changed since/.test(error.message))
    assert.equal(await readFile(b, 'utf8'), 'new, and more\n')
  })

  it('refuse the whole plan, writing nothing, when any part of it does not hold', async () => {
    const root = await realPathOf(await tempWorkspace({ 'a.fk': 'old\n', 'b.fk': 'old\n', 'ansi.fk': `caf${E_ACUTE} old\n`, 'big.fk': 'old\n' }))
    const [a, b, big] = ['a.fk', 'b.fk', 'big.fk'].map((name) => path.join(root, name))
    const ansi = path.join(root, 'ansi.fk')
    // An older Windows (ANSI) file: one byte for the e with its accent.
    await writeFile(ansi, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6c, 0x64, 0x0a]))
    const refused = async (plan: EditPlan, pattern: RegExp, options: { open?: string[]; docs?: Record<string, { text: string; dirty: boolean }> } = {}) => {
      const { servers } = stubServers(options.docs)
      await assert.rejects(applyEditorPlan(plan, { root, servers, open: options.open ?? [], platform: 'linux' }), (error: unknown) => error instanceof ChangeRefused && pattern.test(error.message))
      assert.equal(await readFile(a, 'utf8'), 'old\n')
      assert.equal(await readFile(b, 'utf8'), 'old\n')
    }
    const change = (file: string) => edit(file, 'old\n', 'new\n', [at(0, 0, 3, 'new')])
    // A file outside the folder.
    await refused(planOf(change(a), change(path.join(path.dirname(root), 'elsewhere.fk'))), /outside the folder/)
    // A file that changed on disk since the server read it, after one that did not.
    await refused(planOf(change(a), edit(b, 'older\n', 'new\n', [at(0, 0, 5, 'new')])), /b\.fk changed since/)
    // A file the editor has open that the servers were not given.
    await refused(planOf(change(a), change(big)), /big\.fk is open in the editor, but it is too large/, { open: [big] })
    // An unsaved document the server did not see, and one the plan would move.
    await refused(planOf(change(a), change(b)), /b\.fk has changes in the editor that its language server has not seen/, { docs: { [b]: { text: 'old, typed\n', dirty: true } } })
    await refused(planOf(change(a), { kind: 'rename', from: b, to: path.join(root, 'c.fk'), overwrite: false, ignoreIfExists: false }), /moves b\.fk, which has unsaved changes/, { docs: { [b]: { text: 'old\n', dirty: true } } })
    // A character an ANSI file cannot hold.
    await refused(planOf(change(a), edit(ansi, `caf${E_ACUTE} old\n`, `caf${E_ACUTE} ${SNOWMAN}\n`, [at(0, 5, 8, SNOWMAN)])), /ansi\.fk is an older ANSI text file/)
    // A write that fails takes back the ones before it: the folder for the new file is a file.
    await writeFile(path.join(root, 'x'), 'a file')
    await refused(planOf(change(a), { kind: 'create', file: path.join(root, 'x', 'y.fk'), overwrite: false, ignoreIfExists: false }), /could not be written/)
  })

  it('make, move and delete files, and put them all back', async () => {
    const root = await realPathOf(await tempWorkspace({ 'old.fk': 'module\n', 'gone.fk': 'bye\n' }))
    const [old, moved, made, gone] = ['old.fk', 'sub/new.fk', 'index.fk', 'gone.fk'].map((name) => path.join(root, name))
    const { servers, told } = stubServers()
    const plan = planOf(
      { kind: 'rename', from: old, to: moved, overwrite: false, ignoreIfExists: false },
      edit(moved, 'module\n', 'module new\n', [at(0, 6, 6, ' new')]),
      { kind: 'create', file: made, overwrite: false, ignoreIfExists: false },
      edit(made, '', 'use new\n', [at(0, 0, 0, 'use new\n')]),
      { kind: 'delete', file: gone, recursive: false, ignoreIfNotExists: false },
    )
    const applied = await applyEditorPlan(plan, { root, servers, open: [], platform: 'linux' })
    assert.deepEqual(applied.moved, [{ from: old, to: moved }])
    assert.deepEqual(applied.created, [made])
    assert.deepEqual(applied.deleted, [gone])
    assert.equal(await readFile(moved, 'utf8'), 'module new\n')
    assert.equal(await readFile(made, 'utf8'), 'use new\n')
    await assert.rejects(readFile(old))
    await assert.rejects(readFile(gone))
    assert.ok(told.changed.includes('deleted old.fk') && told.changed.includes('created index.fk') && told.changed.includes('deleted gone.fk'), told.changed.join(', '))
    const undone = await undoEditorChange(applied.record, { root, servers, open: [], platform: 'linux' })
    assert.equal(await readFile(old, 'utf8'), 'module\n')
    assert.equal(await readFile(gone, 'utf8'), 'bye\n')
    await assert.rejects(readFile(moved))
    await assert.rejects(readFile(made))
    assert.deepEqual(undone.deleted.sort(), [made, moved].sort())
    assert.deepEqual(undone.created.sort(), [gone, old].sort())
  })

  it('show what a plan changes, line by line, before and after', async () => {
    const root = await realPathOf(await tempWorkspace())
    const a = path.join(root, 'src', 'a.fk')
    await mkdir(path.dirname(a))
    const { servers } = stubServers({ [a]: { text: 'one old old\ntwo\nthree old\n', dirty: true } })
    const files = previewPlan(
      planOf(
        edit(a, 'one old old\ntwo\nthree old\n', 'one new new\ntwo\nadded\nthree new\n', [at(0, 4, 7, 'new'), at(0, 8, 11, 'new'), at(1, 3, 3, '\nadded'), at(2, 6, 9, 'new')]),
        { kind: 'create', file: path.join(root, 'b.fk'), overwrite: false, ignoreIfExists: false },
      ),
      { root, servers },
    )
    assert.deepEqual(files, [
      { path: 'b.fk', kind: 'create', places: 0 },
      {
        path: 'src/a.fk',
        kind: 'edit',
        places: 4,
        lines: [
          { line: 0, before: 'one old old', after: 'one new new' },
          { line: 1, before: 'two', after: 'two' },
          { line: 2, before: 'three old', after: 'three new' },
        ],
        inEditor: true,
      },
    ])
  })
})

describe('the editor\'s changes through a folder\'s servers', () => {
  async function setup(files: Record<string, string>) {
    const root = await realPathOf(await tempWorkspace(files))
    const home = await tempWorkspace()
    const workspaces = new Workspaces({
      home,
      env: {},
      languageServers: {
        enabled: () => true,
        // The server also knows b.fk, as one that reads the project would, though nobody has it open.
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, FAKE_LSP_EXTRA: path.join(root, 'b.fk') },
        catalog: [spec],
        discover: () => ({ file: process.execPath, args: [fake.script], found: 'the test', command: 'fake-ls' }),
      },
    })
    await workspaces.act(root, { type: 'trust' })
    return { root, workspaces }
  }

  it('rename across the editor and the disk, shown first, applied, and taken back', async () => {
    const { root, workspaces } = await setup({ 'a.fk': 'function greet\n', 'b.fk': 'call greet\r\n' })
    try {
      await workspaces.editorDocument(root, { kind: 'open', path: 'a.fk', text: 'function greet\ngreet()\n', dirty: true })
      const prepared = await workspaces.editorAsk(root, { kind: 'prepareRename', path: 'a.fk', line: 1, character: 2 })
      assert.deepEqual(prepared, { ok: true, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } })
      const preview = await workspaces.editorChange(root, { kind: 'rename', path: 'a.fk', line: 1, character: 2, newName: 'welcome', preview: true, open: ['a.fk'] })
      assert.ok(preview.ok && preview.done === 'preview', JSON.stringify(preview))
      assert.equal(preview.title, 'Rename to welcome')
      assert.deepEqual(
        preview.files.map((file) => [file.path, file.places, file.inEditor ?? false]),
        [
          ['a.fk', 2, true],
          ['b.fk', 1, false],
        ],
      )
      const applied = await workspaces.editorChange(root, { kind: 'apply', id: preview.id, open: ['a.fk'] })
      assert.ok(applied.ok && applied.done === 'applied', JSON.stringify(applied))
      assert.deepEqual(applied.editor.map((item) => [item.path, item.edits.length, item.written]), [['a.fk', 2, false]])
      assert.deepEqual([applied.written, applied.places, applied.files, applied.undo], [['b.fk'], 3, 2, true])
      assert.equal(await readFile(path.join(root, 'b.fk'), 'utf8'), 'call welcome\r\n')
      assert.equal(await readFile(path.join(root, 'a.fk'), 'utf8'), 'function greet\n')
      // A preview is applied once.
      assert.deepEqual(await workspaces.editorChange(root, { kind: 'apply', id: preview.id, open: ['a.fk'] }), { ok: false, reason: 'That preview is out of date. Make the change again.' })
      // The editor puts the edits in and sends its text, as it does after any change.
      await workspaces.editorDocument(root, { kind: 'change', path: 'a.fk', text: 'function welcome\nwelcome()\n', dirty: true })
      const undone = await workspaces.editorChange(root, { kind: 'undo', id: applied.id, open: ['a.fk'] })
      assert.deepEqual(undone, { ok: true, done: 'undone', id: applied.id, editor: [{ path: 'a.fk', written: false }], written: ['b.fk'], created: [], deleted: [] })
      assert.equal(await readFile(path.join(root, 'b.fk'), 'utf8'), 'call greet\r\n')
      // A name the server refuses says why, and a file outside the folder is not asked about.
      assert.deepEqual(await workspaces.editorChange(root, { kind: 'rename', path: 'a.fk', line: 1, character: 2, newName: 'bad', preview: false, open: ['a.fk'] }), { ok: false, reason: 'That name cannot be used.' })
      assert.deepEqual(await workspaces.editorChange(root, { kind: 'rename', path: '../a.fk', line: 0, character: 0, newName: 'x', preview: false, open: [] }), { ok: false, reason: 'That file is not in the open folder.' })
    } finally {
      await workspaces.close()
    }
  })

  it('take a quick fix, and an action whose command sends its edits while it runs', async () => {
    const { root, workspaces } = await setup({ 'a.fk': 'ERROR one\nERROR two\n' })
    try {
      await workspaces.editorDocument(root, { kind: 'open', path: 'a.fk', text: 'ERROR one\nERROR two\n', dirty: false })
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
      const fixes = await workspaces.editorAsk(root, { kind: 'codeActions', path: 'a.fk', range, only: ['quickfix'], automatic: true })
      assert.deepEqual(fixes?.actions.map((item) => item.title), ['Replace ERROR with OK'])
      const fixed = await workspaces.editorChange(root, { kind: 'action', path: 'a.fk', list: fixes!.list, id: 0, preview: false, open: ['a.fk'] })
      assert.ok(fixed.ok && fixed.done === 'applied', JSON.stringify(fixed))
      // A saved document is changed on disk and in the editor.
      assert.deepEqual(fixed.editor.map((item) => [item.path, item.written]), [['a.fk', true]])
      assert.equal(await readFile(path.join(root, 'a.fk'), 'utf8'), 'OK one\nERROR two\n')
      const all = await workspaces.editorAsk(root, { kind: 'codeActions', path: 'a.fk', range, automatic: false })
      const command = all!.actions.find((item) => item.title === 'Fix everything in the file')!
      const ran = await workspaces.editorChange(root, { kind: 'action', path: 'a.fk', list: all!.list, id: command.id, preview: true, open: ['a.fk'] })
      // A command has no preview: what it changes is known only once it runs.
      assert.ok(ran.ok && ran.done === 'applied', JSON.stringify(ran))
      assert.deepEqual(ran.editor.map((item) => [item.path, item.edits.length, item.written]), [['a.fk', 1, true]])
      assert.equal(await readFile(path.join(root, 'a.fk'), 'utf8'), 'OK one\nOK two\n')
      const disabled = all!.actions.find((item) => item.disabled)!
      assert.deepEqual(await workspaces.editorChange(root, { kind: 'action', path: 'a.fk', list: all!.list, id: disabled.id, preview: false, open: ['a.fk'] }), { ok: false, reason: 'Not now: It is Tuesday' })
    } finally {
      await workspaces.close()
    }
  })

  it('format the editor\'s text, and as it is typed', async () => {
    const { root, workspaces } = await setup({ 'a.fk': '' })
    try {
      await workspaces.editorDocument(root, { kind: 'open', path: 'a.fk', text: '\tx  \n', dirty: true })
      assert.deepEqual(await workspaces.editorAsk(root, { kind: 'format', path: 'a.fk', tabSize: 4, insertSpaces: true }), [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: '    ' },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: '' },
      ])
      await workspaces.editorDocument(root, { kind: 'change', path: 'a.fk', text: 'x  ;', dirty: true })
      assert.deepEqual(await workspaces.editorAsk(root, { kind: 'formatOnType', path: 'a.fk', line: 0, character: 4, ch: ';', tabSize: 4, insertSpaces: true }), [
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: '' },
      ])
      assert.deepEqual((await workspaces.editorAsk(root, { kind: 'triggers', path: 'a.fk' }))?.format, [';', '}'])
    } finally {
      await workspaces.close()
    }
  })
})
