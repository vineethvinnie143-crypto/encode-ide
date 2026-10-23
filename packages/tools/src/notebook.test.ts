import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createToolRegistry } from './builtin'
import { readTool } from './files'
import { notebookEditTool } from './notebook'
import { tempWorkspace, testContext, textOf } from './testing'
import type { ToolContext } from './types'

/** A notebook as Jupyter saves one: sorted keys, one space of indentation, a line break at the end. */
function saved(cells: object[], minor = 5, indent = ' '): string {
  const notebook = { cells, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }, nbformat: 4, nbformat_minor: minor }
  return `${JSON.stringify(notebook, null, indent)}\n`
}

const code = (id: string | undefined, source: string[], outputs: object[] = [], count: number | null = 1) => ({
  cell_type: 'code',
  execution_count: count,
  ...(id ? { id } : {}),
  metadata: {},
  outputs,
  source,
})
const markdown = (id: string | undefined, source: string[]) => ({ cell_type: 'markdown', ...(id ? { id } : {}), metadata: {}, source })

async function opened(text: string): Promise<{ root: string; file: string; ctx: ToolContext }> {
  const root = await tempWorkspace({ 'nb.ipynb': text })
  const ctx = testContext(root)
  const file = path.join(root, 'nb.ipynb')
  assert.equal((await readTool.run({ file_path: file }, ctx)).ok, true)
  return { root, file, ctx }
}

const edit = (ctx: ToolContext, input: Record<string, unknown>) => notebookEditTool.run({ notebook_path: path.join(ctx.root, 'nb.ipynb'), ...input } as never, ctx)

describe('NotebookEdit', () => {
  const cells = () => [
    code('a1', ['import os\n', 'print(os.sep)'], [{ name: 'stdout', output_type: 'stream', text: ['/\n'] }]),
    markdown('b2', ['# Notes']),
    code('c3', ['x = 1'], [], null),
  ]

  it('replaces a cell, clears its old outputs and leaves every other byte of the file as it was', async () => {
    const before = saved(cells())
    const { file, ctx } = await opened(before)
    const outcome = await edit(ctx, { cell_id: 'a1', new_source: 'import sys\nprint(sys.version)\n' })
    assert.equal(outcome.ok, true, textOf(outcome.content))
    assert.equal(textOf(outcome.content), 'Replaced cell 0 (id a1) of nb.ipynb. Its outputs were cleared, since they came from the old code.')
    const after = await fs.readFile(file, 'utf8')
    const expected = cells()
    expected[0] = code('a1', ['import sys\n', 'print(sys.version)\n'], [], null)
    assert.equal(after, saved(expected))
    assert.deepEqual(outcome.changed, [file])
    assert.ok(outcome.display?.diff?.length)
  })

  it('finds a cell by id, by index, or by the cell-N name Claude Code uses, and lists the cells when none matches', async () => {
    const { file, ctx } = await opened(saved(cells()))
    assert.equal((await edit(ctx, { cell_id: '1', new_source: '# Notes, again' })).ok, true)
    assert.equal((await edit(ctx, { cell_id: 'cell-2', new_source: 'x = 2' })).ok, true)
    const notebook = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(notebook.cells[1].source, ['# Notes, again'])
    assert.deepEqual(notebook.cells[2].source, ['x = 2'])
    const missing = await edit(ctx, { cell_id: 'zz', new_source: 'y' })
    assert.equal(missing.ok, false)
    assert.equal(textOf(missing.content), 'nb.ipynb has no cell "zz". Its cells, by index: 0 (id a1), 1 (id b2), 2 (id c3).')
  })

  it('inserts a cell after another, or first, with a fresh id and the keys in Jupyter\'s order', async () => {
    const { file, ctx } = await opened(saved(cells()))
    const after = await edit(ctx, { edit_mode: 'insert', cell_id: 'b2', cell_type: 'code', new_source: 'y = 2\nprint(y)' })
    assert.match(textOf(after.content), /^Inserted a code cell \(id [0-9a-f]{8}\) at index 2 of nb\.ipynb\.$/)
    const first = await edit(ctx, { edit_mode: 'insert', cell_type: 'markdown', new_source: '# Title' })
    assert.match(textOf(first.content), /at index 0 of/)
    const notebook = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(notebook.cells.map((cell: { cell_type: string }) => cell.cell_type), ['markdown', 'code', 'markdown', 'code', 'code'])
    assert.deepEqual(Object.keys(notebook.cells[3]), ['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source'])
    assert.deepEqual(notebook.cells[3].source, ['y = 2\n', 'print(y)'])
    assert.deepEqual(Object.keys(notebook.cells[0]), ['cell_type', 'id', 'metadata', 'source'])
    const ids = notebook.cells.map((cell: { id: string }) => cell.id)
    assert.equal(new Set(ids).size, ids.length)
    // The file still reads as Jupyter writes it.
    assert.equal(await fs.readFile(file, 'utf8'), saved(notebook.cells))
    const untyped = await edit(ctx, { edit_mode: 'insert', new_source: 'z' })
    assert.equal(textOf(untyped.content), 'cell_type is required to insert a cell: code or markdown.')
  })

  it('deletes the first, a middle, the last and the only cell', async () => {
    const { file, ctx } = await opened(saved(cells()))
    assert.equal(textOf((await edit(ctx, { edit_mode: 'delete', cell_id: 'b2' })).content), 'Deleted cell 1 (id b2) from nb.ipynb; 2 cells left.')
    assert.equal(await fs.readFile(file, 'utf8'), saved([cells()[0], cells()[2]]))
    await edit(ctx, { edit_mode: 'delete', cell_id: 'c3' })
    assert.equal(await fs.readFile(file, 'utf8'), saved([cells()[0]]))
    await edit(ctx, { edit_mode: 'delete', cell_id: 'a1' })
    assert.equal(await fs.readFile(file, 'utf8'), saved([]))
    // And into the empty list again.
    await edit(ctx, { edit_mode: 'insert', cell_type: 'markdown', new_source: 'back' })
    const notebook = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(await fs.readFile(file, 'utf8'), saved(notebook.cells))
  })

  it('keeps an older notebook\'s own ways: CRLF, two spaces, sources as one string, escaped characters, no ids', async () => {
    const old = {
      cells: [
        { cell_type: 'markdown', metadata: {}, source: 'Café' },
        { cell_type: 'code', execution_count: 3, metadata: {}, outputs: [], source: 'print(1)' },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 2,
    }
    const escaped = (text: string) => text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    const text = escaped(JSON.stringify(old, null, 2)).replace(/\n/g, '\r\n')
    const { file, ctx } = await opened(text)
    assert.equal((await edit(ctx, { cell_id: '1', new_source: 'print("été")' })).ok, true)
    assert.equal((await edit(ctx, { edit_mode: 'insert', cell_id: '0', cell_type: 'markdown', new_source: 'Two\nlines' })).ok, true)
    const expected = structuredClone(old)
    expected.cells[1] = { cell_type: 'code', execution_count: null as unknown as number, metadata: {}, outputs: [], source: 'print("été")' }
    expected.cells.splice(1, 0, { cell_type: 'markdown', metadata: {}, source: 'Two\nlines' } as never)
    assert.equal(await fs.readFile(file, 'utf8'), escaped(JSON.stringify(expected, null, 2)).replace(/\n/g, '\r\n'))
  })

  it('changes a cell\'s type, adding or dropping what a code cell has', async () => {
    const { file, ctx } = await opened(saved(cells()))
    assert.equal(textOf((await edit(ctx, { cell_id: 'b2', cell_type: 'code', new_source: 'print(2)' })).content), 'Replaced cell 1 (id b2) of nb.ipynb. It is a code cell now.')
    assert.equal((await edit(ctx, { cell_id: 'a1', cell_type: 'markdown', new_source: 'Just text' })).ok, true)
    const notebook = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(notebook.cells[1], code('b2', ['print(2)'], [], null))
    assert.deepEqual(notebook.cells[0], markdown('a1', ['Just text']))
  })

  it('refuses what it should not do, and says why', async () => {
    const { ctx } = await opened(saved(cells()))
    assert.match(textOf((await edit(ctx, { cell_id: 'a1', new_source: 'import os\nprint(os.sep)' })).content), /already has that source and type; nothing changed/)
    assert.equal(textOf((await edit(ctx, { new_source: 'x' })).content), 'cell_id is required to replace a cell. Read the notebook to see the cells\' ids.')
    assert.equal(textOf((await edit(ctx, { cell_id: 'a1' })).content), 'new_source is required to replace a cell.')

    const root = await tempWorkspace({ 'nb.ipynb': saved(cells()), 'v3.ipynb': JSON.stringify({ nbformat: 3, worksheets: [], cells: [] }) })
    const fresh = testContext(root)
    assert.match(textOf((await edit(fresh, { cell_id: 'a1', new_source: 'x' })).content), /has not been read in this session/)
    await readTool.run({ file_path: path.join(root, 'v3.ipynb') }, fresh)
    const v3 = await notebookEditTool.run({ notebook_path: path.join(root, 'v3.ipynb'), cell_id: '0', new_source: 'x' }, fresh)
    assert.match(textOf(v3.content), /notebook format 3; NotebookEdit edits format 4/)

    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux' })
    assert.equal(registry.check('NotebookEdit', { notebook_path: '/a/b.py', new_source: 'x' }), 'Invalid input for NotebookEdit: NotebookEdit changes Jupyter notebooks (.ipynb); use Edit for other files.')
    assert.equal(registry.check('Edit', { file_path: '/a/b.ipynb', old_string: 'a', new_string: 'b' }), 'Invalid input for Edit: this is a Jupyter notebook; change its cells with NotebookEdit (load it with ToolSearch).')
    assert.equal(registry.check('NotebookEdit', { notebook_path: '/a/b.ipynb', edit_mode: 'append' })?.startsWith('Invalid input for NotebookEdit'), true)
  })

  it('shows the change on the approval card as cells, before anything is written', async () => {
    const { file, ctx } = await opened(saved(cells()))
    const summary = await notebookEditTool.describe({ notebook_path: file, cell_id: 'b2', new_source: '# Better notes' }, ctx)
    assert.equal(summary.title, 'Edit nb.ipynb')
    const lines = summary.preview!.flatMap((hunk) => hunk.lines)
    assert.ok(lines.some((line) => line.type === 'add' && line.text === '# Better notes'))
    assert.ok(lines.some((line) => line.type === 'del' && line.text === '# Notes'))
    assert.equal((await notebookEditTool.describe({ notebook_path: file, cell_id: 'nope', new_source: 'x' }, ctx)).detail, 'nb.ipynb has no cell "nope". Its cells, by index: 0 (id a1), 1 (id b2), 2 (id c3).')
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).cells[1].source[0], '# Notes')
  })
})

describe('Read of a notebook', () => {
  it('shows cells from an index, says what it left out, and keeps long outputs short', async () => {
    const long = Array.from({ length: 400 }, (_, index) => `row ${index}`).join('\n')
    const failure = { ename: 'ValueError', evalue: 'bad', output_type: 'error', traceback: ['\u001b[0;31mValueError\u001b[0m: bad'] }
    const text = saved([
      code('a', ['print(rows)'], [{ name: 'stdout', output_type: 'stream', text: [long] }]),
      code('b', ['fail()'], [failure]),
      code('c', ['plot()'], [{ data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': ['<Figure>'] }, metadata: {}, output_type: 'display_data' }]),
      code('d', ['table()'], [{ data: { 'text/html': ['<table></table>'] }, metadata: {}, output_type: 'display_data' }]),
    ])
    const root = await tempWorkspace({ 'nb.ipynb': text })
    const ctx = testContext(root)
    const all = textOf((await readTool.run({ file_path: 'nb.ipynb' }, ctx)).content)
    assert.match(all, /row 0[\s\S]*… \(\d+ characters left out\) …[\s\S]*row 399/)
    assert.match(all, /<outputs index="1">\nValueError: bad\n<\/outputs>/)
    assert.match(all, /<outputs index="2">\n<Figure>\n<\/outputs>/)
    assert.match(all, /<outputs index="3">\n\[HTML output\]\n<\/outputs>/)
    const some = textOf((await readTool.run({ file_path: 'nb.ipynb', offset: 1, limit: 2 }, ctx)).content)
    assert.match(some, /^<cell index="1" id="b" type="code">/)
    assert.doesNotMatch(some, /index="3"/)
    assert.match(some, /\(Cells 1-2 of 4\. Pass offset, the index of a cell, and limit to read others\.\)$/)
    assert.match(textOf((await readTool.run({ file_path: 'nb.ipynb', offset: 9 }, ctx)).content), /has 4 cells, so offset 9 is past its last cell/)
  })
})
