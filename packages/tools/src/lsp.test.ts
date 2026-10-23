import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { LanguageServers, type ServerSpec } from '@encode/lsp'
import { fakeServer, type FakeServer } from '@encode/lsp/testing'
import { stateOf } from './file-state'
import { applyPlan, lspEditTool, lspTool } from './lsp'
import { tempWorkspace, testContext, textOf } from './testing'
import type { ToolContext, ToolOutcome } from './types'

/** The tools against eNCode's real language server client, talking to the fake server over pipes. */

let fake: FakeServer
before(async () => {
  fake = await fakeServer()
})
after(async () => {
  await fake.dispose()
})

const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: [] }], install: 'npm install -g fake-ls' }

async function setup(files: Record<string, string>, options: { mode?: string; extra?: string } = {}) {
  const root = await tempWorkspace(files)
  const extra = options.extra ? path.resolve(root, options.extra) : undefined
  const code = new LanguageServers({
    root,
    catalog: [spec],
    allowed: () => ({ ok: true }),
    discover: () => ({ file: process.execPath, args: [], found: 'the test', command: 'fake-ls' }),
    spawn: async (_plan, cwd) => fake.start(options.mode ?? '', { cwd, ...(extra ? { extra } : {}) }),
  })
  const writes: { file: string; previous: string | null; toolUseId: string }[] = []
  let call = 0
  const ctx = (overrides: Partial<ToolContext> = {}) =>
    testContext(root, {
      code,
      toolUseId: `call-${++call}`,
      beforeWrite: async (file, previous, info) => {
        writes.push({ file, previous: previous ? previous.toString('utf8') : null, toolUseId: info.toolUseId })
      },
      ...overrides,
    })
  return { root, code, ctx, writes, file: (name: string) => path.join(root, name) }
}

const said = async (outcome: Promise<ToolOutcome> | ToolOutcome): Promise<string> => textOf((await outcome).content)

/** One call as the loop makes it: check, access, describe, then run, with one context. */
async function call<I extends Record<string, unknown>>(tool: { check?(input: I): string | undefined; access(input: I, ctx: ToolContext): unknown; describe(input: I, ctx: ToolContext): unknown; run(input: I, ctx: ToolContext): Promise<ToolOutcome> }, input: I, ctx: ToolContext) {
  const problem = tool.check?.(input)
  if (problem) return { problem, access: undefined, summary: undefined, outcome: undefined }
  const access = await tool.access(input, ctx)
  const summary = await tool.describe(input, ctx)
  const outcome = await tool.run(input, ctx)
  return { problem: undefined, access, summary, outcome }
}

describe('LSP', () => {
  it('is deferred, read-only, and checks what each operation needs', () => {
    assert.equal(lspTool.defer, 'always')
    assert.equal(lspTool.readOnly, true)
    assert.match(lspTool.check!({ operation: 'goToDefinition', filePath: 'a.fk' })!, /line is needed/)
    assert.match(lspTool.check!({ operation: 'hover', filePath: 'a.fk', line: 3 })!, /Give symbol/)
    assert.equal(lspTool.check!({ operation: 'hover', filePath: 'a.fk', line: 3, symbol: 'x' }), undefined)
    assert.match(lspTool.check!({ operation: 'workspaceSymbol', filePath: 'a.fk' })!, /needs query/)
    assert.equal(lspTool.check!({ operation: 'documentSymbol', filePath: 'a.fk' }), undefined)
  })

  it('finds definitions and references by symbol name, with the lines they are on', async () => {
    const s = await setup({ 'lib.fk': 'function greet\n  body\n', 'main.fk': 'call greet\ncall greet again\n' })
    await s.code.diagnostics([s.file('lib.fk')], { waitMs: 3_000 })
    const definition = await said(lspTool.run({ operation: 'goToDefinition', filePath: 'main.fk', line: 1, symbol: 'greet' }, s.ctx()))
    assert.equal(definition, 'The definition of greet:\nlib.fk\n  1:10  function greet')
    const references = await said(lspTool.run({ operation: 'findReferences', filePath: s.file('main.fk'), line: 2, symbol: 'greet' }, s.ctx()))
    assert.equal(references, '3 references to greet in 2 files:\nmain.fk (2)\n  1:6  call greet\n  2:6  call greet again\nlib.fk (1)\n  1:10  function greet')
    await s.code.dispose()
  })

  it('finds the symbol on a nearby line when the line given is a little off', async () => {
    const s = await setup({ 'a.fk': 'one\ntwo\nfunction greet\n' })
    const text = await said(lspTool.run({ operation: 'hover', filePath: 'a.fk', line: 2, symbol: 'greet' }, s.ctx()))
    assert.equal(text, 'greet is on line 3, not 2; used line 3.\n**greet**')
    const missing = await lspTool.run({ operation: 'hover', filePath: 'a.fk', line: 1, symbol: 'nowhere' }, s.ctx())
    assert.equal(missing.ok, false)
    assert.equal(textOf(missing.content), 'nowhere is not on line 1 of a.fk (it reads: one). Give the line where it appears.')
    await s.code.dispose()
  })

  it('gives outlines, symbol searches and calls', async () => {
    const s = await setup({ 'a.fk': 'function greet\nfunction part\n' })
    assert.equal(await said(lspTool.run({ operation: 'documentSymbol', filePath: 'a.fk' }, s.ctx())), 'Outline of a.fk:\nfunction greet (line 1-2)\n  variable inner (line 1)\nfunction part (line 2-3)\n  variable inner (line 2)')
    assert.equal(await said(lspTool.run({ operation: 'workspaceSymbol', filePath: 'a.fk', query: 'gre' }, s.ctx())), '1 symbol matching gre:\nfunction greet in module  a.fk:1:10')
    assert.equal(await said(lspTool.run({ operation: 'incomingCalls', filePath: 'a.fk', line: 1, symbol: 'greet' }, s.ctx())), 'function greet  a.fk:1:10\nCalled from:\nfunction caller  a.fk:1:10')
    await s.code.dispose()
  })

  it('reports diagnostics, errors first', async () => {
    const s = await setup({ 'a.fk': 'WARN first\nthen ERROR\n', 'b.fk': 'fine\n' })
    assert.equal(await said(lspTool.run({ operation: 'diagnostics', filePath: 'a.fk' }, s.ctx())), 'a.fk: 1 error, 1 warning\n  2:6 error: Something is wrong here [fake E1]\n  1:1 warning: This could be better [fake]')
    assert.equal(await said(lspTool.run({ operation: 'diagnostics', filePath: 'b.fk' }, s.ctx())), 'No problems in b.fk.')
    await s.code.dispose()
  })

  it('lists code actions with their numbers for LSPEdit', async () => {
    const s = await setup({ 'a.fk': 'ok\nan ERROR\n' })
    await s.code.diagnostics([s.file('a.fk')], { waitMs: 3_000 })
    const text = await said(lspTool.run({ operation: 'codeActions', filePath: 'a.fk', line: 2 }, s.ctx()))
    assert.equal(text, [
      'Code actions for a.fk:2:',
      '1. Replace ERROR with OK (quickfix, preferred)',
      '2. Fix everything in the file (source.fixAll)',
      '3. Add a note at the top (refactor)',
      '4. Not now (refactor) [not available: It is Tuesday]',
      '5. Run a bare command',
      'Apply one with LSPEdit (operation applyCodeAction, the same filePath, actionId).',
    ].join('\n'))
    await s.code.dispose()
  })

  it('says why there is no answer, and what to use instead', async () => {
    const s = await setup({ 'a.txt': 'x' })
    const none = await lspTool.run({ operation: 'documentSymbol', filePath: 'a.txt' }, s.ctx())
    assert.equal(none.ok, false)
    assert.equal(textOf(none.content), 'No language server covers .txt files. Use Grep and Read instead.')
    const off = await lspTool.run({ operation: 'documentSymbol', filePath: 'a.txt' }, testContext(s.root))
    assert.match(textOf(off.content), /only in a folder you trust/)
    await s.code.dispose()
  })
})

describe('LSPEdit', () => {
  it('renames across files, the plan it showed for approval being the one it applies', async () => {
    const s = await setup({ 'a.fk': 'function greet\r\ncall greet\r\n', 'b.fk': 'call greet\n' }, { extra: 'b.fk' })
    const b = s.file('b.fk')
    const ctx = s.ctx()
    // The agent read a.fk; b.fk it never read.
    const aBytes = await fs.readFile(s.file('a.fk'))
    ctx.files.set(s.file('a.fk'), stateOf(aBytes, await fs.stat(s.file('a.fk')), false))
    const result = await call(lspEditTool, { operation: 'rename', filePath: 'a.fk', line: 2, symbol: 'greet', newName: 'welcome' }, ctx)
    assert.deepEqual(result.access, { type: 'write', paths: [s.file('a.fk'), b] })
    const summary = result.summary as { title: string; detail: string; preview: unknown[] }
    assert.equal(summary.title, 'Rename greet to welcome')
    assert.equal(summary.detail, '3 edits in 2 files (a.fk 2, b.fk 1)')
    assert.ok(summary.preview.length > 0)
    assert.equal(result.outcome!.ok, true, textOf(result.outcome!.content))
    assert.equal(textOf(result.outcome!.content), 'Renamed greet to welcome: 3 edits in 2 files (a.fk 2, b.fk 1). Read a file again before you edit it by hand.')
    assert.deepEqual([...result.outcome!.changed!].sort(), [s.file('a.fk'), b])
    // CRLF kept, every write checkpointed, and b.fk still has to be read before a hand edit.
    assert.equal(await fs.readFile(s.file('a.fk'), 'utf8'), 'function welcome\r\ncall welcome\r\n')
    assert.equal(await fs.readFile(b, 'utf8'), 'call welcome\n')
    assert.deepEqual(s.writes.map((write) => [path.basename(write.file), write.previous]).sort(), [['a.fk', 'function greet\r\ncall greet\r\n'], ['b.fk', 'call greet\n']])
    assert.ok(ctx.files.get(s.file('a.fk')))
    assert.equal(ctx.files.get(b), undefined)
    await s.code.dispose()
  })

  it('writes nothing when a file no longer reads as the server saw it', async () => {
    const s = await setup({ 'a.fk': 'function greet\ncall greet\n' })
    const ctx = s.ctx()
    await lspEditTool.access({ operation: 'rename', filePath: 'a.fk', line: 1, symbol: 'greet', newName: 'hi' }, ctx)
    // The person changes the file while the approval card is open.
    await fs.writeFile(s.file('a.fk'), 'function greet\ncall greet\n// edited\n')
    const outcome = await lspEditTool.run({ operation: 'rename', filePath: 'a.fk', line: 1, symbol: 'greet', newName: 'hi' }, ctx)
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /a\.fk is not what the language server read .* Nothing was changed/)
    assert.equal(await fs.readFile(s.file('a.fk'), 'utf8'), 'function greet\ncall greet\n// edited\n')
    assert.deepEqual(s.writes, [])
    await s.code.dispose()
  })

  it('refuses a rename that reaches outside the project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-lsp-outside-'))
    const other = path.join(await fs.realpath(outside), 'other.fk')
    await fs.writeFile(other, 'call greet\n')
    const s = await setup({ 'a.fk': 'function greet\n' }, { extra: other })
    const outcome = await lspEditTool.run({ operation: 'rename', filePath: 'a.fk', line: 1, symbol: 'greet', newName: 'hi' }, s.ctx())
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /reaches outside the project/)
    assert.equal(await fs.readFile(s.file('a.fk'), 'utf8'), 'function greet\n')
    assert.equal(await fs.readFile(other, 'utf8'), 'call greet\n')
    await s.code.dispose()
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('moves, creates and deletes files when the rename asks, each through the checkpoint seam', async () => {
    const s = await setup({ 'greet.fk': 'function greet\n' }, { mode: 'move' })
    const outcome = await lspEditTool.run({ operation: 'rename', filePath: 'greet.fk', line: 1, symbol: 'greet', newName: 'hello' }, s.ctx())
    assert.equal(outcome.ok, true, textOf(outcome.content))
    assert.equal(await fs.readFile(s.file('hello.fk'), 'utf8'), '-- moved\nfunction hello\n')
    assert.equal(await fs.readFile(s.file('index.fk'), 'utf8'), 'use hello\n')
    await assert.rejects(fs.stat(s.file('greet.fk')))
    assert.deepEqual(s.writes.map((write) => [path.basename(write.file), write.previous]), [
      ['greet.fk', 'function greet\n'],
      ['greet.fk', 'function hello\n'],
      ['hello.fk', null],
      ['hello.fk', 'function hello\n'],
      ['index.fk', null],
      ['index.fk', ''],
    ])
    assert.match(textOf(outcome.content), /moves greet\.fk to hello\.fk; creates index\.fk; deletes old\.fk/)
    await s.code.dispose()
  })

  it('applies a code action\'s edit, and runs a command action only on its own file', async () => {
    const s = await setup({ 'a.fk': 'ok\nan ERROR\nERROR again\n' })
    await s.code.diagnostics([s.file('a.fk')], { waitMs: 3_000 })
    await lspTool.run({ operation: 'codeActions', filePath: 'a.fk', line: 2 }, s.ctx())
    const fix = await call(lspEditTool, { operation: 'applyCodeAction', filePath: 'a.fk', actionId: 1 }, s.ctx())
    assert.equal(fix.outcome!.ok, true, textOf(fix.outcome!.content))
    assert.equal(await fs.readFile(s.file('a.fk'), 'utf8'), 'ok\nan OK\nERROR again\n')
    await s.code.changed([{ file: s.file('a.fk'), kind: 'changed' }])
    await lspTool.run({ operation: 'codeActions', filePath: 'a.fk', line: 3 }, s.ctx())
    const all = await call(lspEditTool, { operation: 'applyCodeAction', filePath: 'a.fk', actionId: 2 }, s.ctx())
    assert.deepEqual(all.access, { type: 'write', paths: [s.file('a.fk')] })
    assert.match((all.summary as { detail: string }).detail, /Runs the language server's command "Fix all", which may change a\.fk only/)
    assert.equal(all.outcome!.ok, true, textOf(all.outcome!.content))
    assert.equal(await fs.readFile(s.file('a.fk'), 'utf8'), 'ok\nan OK\nOK again\n')
    assert.match(textOf(all.outcome!.content), /^Applied code action 2 \("Fix all"\): 1 edit in 1 file/)
    const gone = await lspEditTool.run({ operation: 'applyCodeAction', filePath: 'a.fk', actionId: 4 }, s.ctx())
    assert.equal(gone.ok, false)
    assert.match(textOf(gone.content), /not available: It is Tuesday/)
    await s.code.dispose()
  })

  it('checks the whole plan before it writes anything', async () => {
    const root = await tempWorkspace({ 'a.txt': 'one', 'b.txt': 'two' })
    const writes: string[] = []
    const ctx = testContext(root, { beforeWrite: async (file) => void writes.push(file) })
    const result = await applyPlan(
      {
        server: 'Fake',
        files: [path.join(root, 'a.txt'), path.join(root, 'b.txt')],
        changes: [
          { kind: 'edit', file: path.join(root, 'a.txt'), before: 'one', after: 'ONE', edits: 1 },
          { kind: 'edit', file: path.join(root, 'b.txt'), before: 'not two', after: 'TWO', edits: 1 },
        ],
      },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.deepEqual(writes, [])
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one')
    const folder = await applyPlan({ server: 'Fake', files: [root], changes: [{ kind: 'delete', file: root, recursive: true, ignoreIfNotExists: false }] }, ctx)
    assert.ok(!folder.ok && /not folders/.test(folder.reason))
  })
})
