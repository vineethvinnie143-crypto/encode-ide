import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ServerSpec } from './catalog'
import { applyTextEdits } from './edits'
import { fakeServer, type FakeServer } from './fake-server'
import { LanguageServers, type CodeDiagnostic, type EditPlan, type HubOptions } from './hub'

let fake: FakeServer
let root: string

before(async () => {
  fake = await fakeServer()
  root = path.join(fake.dir, 'project')
  await mkdir(root)
})

after(async () => {
  await fake.dispose()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await wait(10)
  }
}

const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: [] }], install: 'npm install -g fake-ls', settings: { fake: { option: 'on' } } }

let count = 0
async function project(files: Record<string, string>): Promise<string> {
  const dir = path.join(root, `p${++count}`)
  await mkdir(dir)
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  return dir
}

function hub(dir: string, options: { mode?: string; extra?: string; idleMs?: number; missing?: boolean } & Partial<HubOptions> = {}) {
  const spawned: string[] = []
  const published: [string, CodeDiagnostic[]][] = []
  let allowed: { ok: true } | { ok: false; reason: string } = { ok: true }
  const servers = new LanguageServers({
    root: dir,
    catalog: [spec],
    allowed: () => allowed,
    discover: () => (options.missing ? { missing: 'No language server for Fake is installed (fake-ls). To get one: npm install -g fake-ls.' } : { file: process.execPath, args: [], found: 'the test', command: 'fake-ls' }),
    spawn: async (_plan, cwd) => {
      spawned.push(cwd)
      return fake.start(options.mode ?? '', { cwd, ...(options.extra ? { extra: options.extra } : {}) })
    },
    onDiagnostics: (file, items) => published.push([file, items]),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    ...options,
  })
  return {
    servers,
    spawned,
    published,
    forbid(reason: string) {
      allowed = { ok: false, reason }
    },
    allow() {
      allowed = { ok: true }
    },
    /** What the editor was last told of a file. */
    marks(file: string): CodeDiagnostic[] | undefined {
      return published.filter(([name]) => name === file).at(-1)?.[1]
    },
  }
}

const logs = (servers: LanguageServers) => servers.logs('fake')

describe('the language servers of a folder', () => {
  it('starts nothing until a file needs its server, then shares one', async () => {
    const dir = await project({ 'a.fk': 'ok\nERROR\n', 'b.fk': 'WARN' })
    const { servers, spawned } = hub(dir)
    assert.deepEqual(servers.covers(path.join(dir, 'a.fk')), { ok: true, server: 'Fake', languageId: 'fake' })
    assert.equal(spawned.length, 0)
    const [a, b] = await servers.diagnostics([path.join(dir, 'a.fk'), path.join(dir, 'b.fk')], { waitMs: 3_000 })
    assert.equal(spawned.length, 1)
    assert.deepEqual(spawned, [dir])
    assert.ok(a.ok && a.diagnostics.length === 1 && a.diagnostics[0].severity === 'error' && a.diagnostics[0].line === 1 && a.diagnostics[0].code === 'E1')
    assert.ok(b.ok && b.diagnostics[0].severity === 'warning')
    assert.equal(servers.status()[0].state, 'running')
    assert.equal(servers.status()[0].documents, 2)
    await servers.dispose()
  })

  it('says why a file gets no server', async () => {
    const dir = await project({ 'a.fk': 'x', 'a.txt': 'x' })
    const none = hub(dir)
    const [text] = await none.servers.diagnostics([path.join(dir, 'a.txt')], { waitMs: 500 })
    assert.deepEqual(text, { file: path.join(dir, 'a.txt'), ok: false, reason: 'No language server covers .txt files.' })
    none.forbid('Language servers run only in folders you trust.')
    const [off] = await none.servers.diagnostics([path.join(dir, 'a.fk')], { waitMs: 500 })
    assert.ok(!off.ok && off.reason === 'Language servers run only in folders you trust.')
    assert.equal(none.servers.status()[0].state, 'off')
    const missing = hub(dir, { missing: true })
    const [gone] = await missing.servers.diagnostics([path.join(dir, 'a.fk')], { waitMs: 500 })
    assert.ok(!gone.ok && gone.reason.includes('npm install -g fake-ls'))
    assert.equal(missing.servers.status()[0].state, 'missing')
    assert.equal(none.spawned.length + missing.spawned.length, 0)
    await none.servers.dispose()
    await missing.servers.dispose()
  })

  it('follows what eNCode wrote to the disk, and tells the server the files changed', async () => {
    const dir = await project({ 'a.fk': 'fine' })
    const { servers } = hub(dir)
    const a = path.join(dir, 'a.fk')
    const [first] = await servers.diagnostics([a], { waitMs: 3_000 })
    assert.ok(first.ok && first.diagnostics.length === 0)
    await writeFile(a, 'now ERROR')
    await servers.changed([{ file: a, kind: 'changed' }])
    const [second] = await servers.diagnostics([a], { waitMs: 3_000 })
    assert.ok(second.ok && second.diagnostics.length === 1 && !second.stale)
    await until('the watched-files notice', () => logs(servers).includes('watched 2:a.fk'))
    await servers.changed([{ file: a, kind: 'deleted' }])
    await until('the close', () => logs(servers).includes('close a.fk'))
    await servers.dispose()
  })

  it('lets the editor\'s unsaved text win over the disk, and says the answer is for it', async () => {
    const dir = await project({ 'a.fk': 'clean on disk' })
    const { servers, published } = hub(dir)
    const a = path.join(dir, 'a.fk')
    servers.editorOpen(a, 'ERROR typed but not saved', true)
    await until('the editor document to reach the server', () => published.some(([file, items]) => file === a && items.length === 1))
    await servers.changed([{ file: a, kind: 'changed' }])
    const [result] = await servers.diagnostics([a], { waitMs: 3_000 })
    assert.ok(result.ok && result.unsaved === true && result.diagnostics.length === 1)
    servers.editorChange(a, 'clean on disk', false)
    await until('the save', () => logs(servers).includes('save a.fk'))
    const [saved] = await servers.diagnostics([a], { waitMs: 3_000 })
    assert.ok(saved.ok && !saved.unsaved && saved.diagnostics.length === 0)
    servers.editorClose(a)
    await until('the close', () => logs(servers).includes('close a.fk'))
    await servers.dispose()
  })

  it('looks things up: definitions in other files, references, hovers, outlines, symbols and calls', async () => {
    const dir = await project({ 'lib.fk': 'function greet\n  body\n', 'main.fk': 'call greet\ncall greet again\n' })
    const { servers } = hub(dir)
    const main = path.join(dir, 'main.fk')
    const lib = path.join(dir, 'lib.fk')
    await servers.diagnostics([lib], { waitMs: 3_000 })
    const definitions = await servers.definition(main, 0, 6)
    assert.deepEqual(definitions, [{ file: lib, line: 0, character: 9, endLine: 0, endCharacter: 14 }])
    const references = await servers.references(main, 0, 6, true)
    assert.equal(references.length, 3)
    assert.equal(await servers.hover(main, 1, 7), '**greet**')
    assert.equal(await servers.hover(main, 5, 0), null)
    const outline = await servers.documentSymbols(lib)
    assert.deepEqual(outline.map((item) => [item.name, item.kind, item.depth]), [['greet', 'function', 0], ['inner', 'variable', 1]])
    const symbols = await servers.workspaceSymbols('gre', undefined)
    assert.deepEqual(symbols.map((item) => [item.name, item.file, item.container]), [['greet', lib, 'module']])
    const calls = await servers.calls(lib, 0, 10, 'incoming')
    assert.equal(calls?.item.name, 'greet')
    assert.deepEqual(calls?.calls.map((item) => item.name), ['caller'])
    await servers.dispose()
  })

  it('says plainly what a server does not offer', async () => {
    const dir = await project({ 'a.fk': 'function x' })
    const { servers } = hub(dir, { mode: 'bare' })
    await assert.rejects(servers.definition(path.join(dir, 'a.fk'), 0, 9), /Fake's language server \(fake-ls\) does not offer go to definition\./)
    await assert.rejects(servers.rename(path.join(dir, 'a.fk'), 0, 9, 'y'), /does not offer renaming/)
    assert.deepEqual(await servers.workspaceSymbols('x', path.join(dir, 'a.fk')), [])
    await servers.dispose()
  })

  it('plans a rename across open documents and files on disk, each with its text before and after', async () => {
    const dir = await project({ 'a.fk': 'function greet\ncall greet\n', 'b.fk': 'call greet\n' })
    const b = path.join(dir, 'b.fk')
    const { servers } = hub(dir, { extra: b })
    const a = path.join(dir, 'a.fk')
    const plan = await servers.rename(a, 1, 6, 'welcome')
    assert.equal(plan.server, 'Fake')
    assert.deepEqual(plan.files.sort(), [a, b].sort())
    const byFile = new Map(plan.changes.map((change) => [change.kind === 'edit' ? change.file : '', change]))
    assert.deepEqual(byFile.get(a), { kind: 'edit', file: a, before: 'function greet\ncall greet\n', after: 'function welcome\ncall welcome\n', edits: 2, textEdits: [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } }, newText: 'welcome' }, { range: { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } }, newText: 'welcome' }] })
    assert.deepEqual(byFile.get(b), { kind: 'edit', file: b, before: 'call greet\n', after: 'call welcome\n', edits: 1, textEdits: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText: 'welcome' }] })
    await assert.rejects(servers.rename(a, 1, 6, 'bad'), /fake-ls could not rename: that name cannot be used/)
    await assert.rejects(servers.rename(a, 9, 0, 'x'), /Nothing at that position can be renamed/)
    await servers.dispose()
  })

  it('refuses a rename made for an older version of a document', async () => {
    const dir = await project({ 'a.fk': 'function greet\n' })
    const { servers } = hub(dir, { mode: 'stale' })
    await assert.rejects(servers.rename(path.join(dir, 'a.fk'), 0, 10, 'x'), /older version of a\.fk/)
    await servers.dispose()
  })

  it('lists code actions and gives the edit of the one chosen, resolving it or running its command', async () => {
    const dir = await project({ 'a.fk': 'line one\nan ERROR here\n' })
    const { servers } = hub(dir)
    const a = path.join(dir, 'a.fk')
    await servers.diagnostics([a], { waitMs: 3_000 })
    const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }
    const actions = await servers.codeActions(a, range)
    assert.deepEqual(actions, [
      { id: 1, title: 'Replace ERROR with OK', kind: 'quickfix', preferred: true },
      { id: 2, title: 'Fix everything in the file', kind: 'source.fixAll', command: true },
      { id: 3, title: 'Add a note at the top', kind: 'refactor' },
      { id: 4, title: 'Not now', kind: 'refactor', disabled: 'It is Tuesday' },
      { id: 5, title: 'Run a bare command', command: true },
    ])
    const fix = await servers.actionEdit(a, 1)
    assert.ok('plan' in fix)
    assert.deepEqual(fix.plan.changes, [{ kind: 'edit', file: a, before: 'line one\nan ERROR here\n', after: 'line one\nan OK here\n', edits: 1, textEdits: [{ range: { start: { line: 1, character: 3 }, end: { line: 1, character: 8 } }, newText: 'OK' }] }])
    const resolved = await servers.actionEdit(a, 3)
    assert.ok('plan' in resolved && resolved.plan.changes[0].kind === 'edit' && resolved.plan.changes[0].after === '// note\nline one\nan ERROR here\n')
    await assert.rejects(servers.actionEdit(a, 4), /not available: It is Tuesday/)
    await assert.rejects(servers.actionEdit(a, 9), /There is no action 9; the list has 5\./)
    assert.deepEqual(await servers.actionEdit(a, 2), { command: 'Fix all' })
    const plans: EditPlan[] = []
    const ran = await servers.runActionCommand(a, 2, async (plan) => {
      plans.push(plan)
      return { applied: true }
    })
    assert.deepEqual(ran, { applied: 1, refused: [] })
    assert.ok(plans[0].changes[0].kind === 'edit' && plans[0].changes[0].after === 'line one\nan OK here\n')
    const refused = await servers.runActionCommand(a, 5, async () => ({ applied: false, failureReason: 'Only a.fk may change.' }))
    assert.deepEqual(refused, { applied: 0, refused: ['Only a.fk may change.'] })
    await assert.rejects(servers.actionEdit(path.join(dir, 'other.fk'), 1), /List the actions for this file again/)
    await servers.dispose()
  })

  it('starts a crashed server again, and leaves it off after three crashes', async () => {
    const dir = await project({ 'a.fk': 'x' })
    const { servers, spawned } = hub(dir, { mode: 'crash' })
    const a = path.join(dir, 'a.fk')
    for (let round = 0; round < 3; round++) {
      const [result] = await servers.diagnostics([a], { waitMs: 3_000 })
      assert.ok(!result.ok && result.reason.includes('stopped before it answered'), JSON.stringify(result))
      await until('the crash to be counted', () => servers.status()[0].state !== 'running', 3_000)
    }
    assert.equal(spawned.length, 3)
    assert.equal(servers.status()[0].state, 'failed')
    const [after] = await servers.diagnostics([a], { waitMs: 500 })
    assert.ok(!after.ok && /stopped 3 times/.test(after.reason) && /boom/.test(after.reason), JSON.stringify(after))
    assert.equal(spawned.length, 3)
    await servers.dispose()
  })

  it('stops a server nobody uses, unless the editor shows its files', async () => {
    const dir = await project({ 'a.fk': 'x', 'b.fk': 'y' })
    const { servers, spawned } = hub(dir, { idleMs: 100 })
    await servers.diagnostics([path.join(dir, 'a.fk')], { waitMs: 3_000 })
    await until('the idle stop', () => servers.status()[0].state === 'stopped', 3_000)
    servers.editorOpen(path.join(dir, 'b.fk'), 'y')
    await until('the editor to start it', () => servers.status()[0].state === 'running')
    await wait(400)
    assert.equal(servers.status()[0].state, 'running')
    assert.equal(spawned.length, 2)
    await servers.dispose()
    assert.equal(servers.status()[0].state, 'stopped')
  })

  it('stops its servers when they may no longer run', async () => {
    const dir = await project({ 'a.fk': 'x' })
    const h = hub(dir)
    await h.servers.diagnostics([path.join(dir, 'a.fk')], { waitMs: 3_000 })
    h.forbid('Language servers are turned off in Settings.')
    await h.servers.sync()
    const view = h.servers.status()[0]
    assert.equal(view.state, 'off')
    assert.equal(view.detail, 'Language servers are turned off in Settings.')
    await h.servers.dispose()
  })

  it('marks the files the editor shows, and takes the marks back when a file closes or its server stops', async () => {
    const dir = await project({ 'a.fk': 'ERROR' })
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'ERROR\nWARN')
    await until('the marks', () => h.marks(a)?.length === 2)
    h.servers.editorClose(a)
    assert.deepEqual(h.marks(a), [])
    h.servers.editorOpen(a, 'ERROR')
    await until('the marks again', () => h.marks(a)?.length === 1)
    h.forbid('Language servers are turned off in Settings.')
    await h.servers.sync()
    assert.deepEqual(h.marks(a), [])
    await h.servers.dispose()
  })

  it('asks a server that waits to be asked for its diagnostics about the editor\'s files, after each change', async () => {
    const dir = await project({ 'a.fk': 'ok', 'b.fk': 'ERROR' })
    const h = hub(dir, { mode: 'pull' })
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'ERROR\nWARN')
    await until('the marks', () => h.marks(a)?.length === 2)
    h.servers.editorChange(a, 'ERROR', true)
    await until('the marks after the change', () => h.marks(a)?.length === 1)
    h.servers.editorChange(a, 'fine now', true)
    await until('no marks', () => h.marks(a)?.length === 0)
    // A file the agent opened first is watched once the editor shows it.
    const b = path.join(dir, 'b.fk')
    await h.servers.diagnostics([b], { waitMs: 2_000 })
    const before = h.published.length
    h.servers.editorOpen(b, 'ERROR')
    await until('the marks of the agent\'s file', () => h.published.length > before && h.marks(b)?.length === 1)
    await h.servers.dispose()
  })

  it('gives the files the editor shows their servers once servers may run again', async () => {
    const dir = await project({ 'a.fk': 'ok' })
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.forbid('Language servers run only in folders you trust.')
    h.servers.editorOpen(a, 'ERROR')
    h.servers.editorChange(a, 'ERROR\nERROR', true)
    await wait(100)
    assert.equal(h.spawned.length, 0)
    assert.equal(h.servers.status()[0].state, 'off')
    h.allow()
    await h.servers.sync()
    await until('the server and its marks', () => h.marks(a)?.length === 2)
    assert.equal(h.servers.status()[0].state, 'running')
    assert.equal(h.spawned.length, 1)
    await h.servers.dispose()
  })

  it('looks for the servers again once the folder is trusted, since the project\'s own count only then', async () => {
    const dir = await project({ 'a.fk': 'ERROR' })
    let projectBins = false
    const h = hub(dir, { discover: () => (projectBins ? { file: process.execPath, args: [], found: 'the project', command: 'fake-ls' } : { missing: 'No language server for Fake is installed.' }) })
    const a = path.join(dir, 'a.fk')
    h.forbid('Language servers run only in folders you trust.')
    // Read while the folder is not trusted: what was found then is kept for a while.
    assert.equal(h.servers.status()[0].state, 'off')
    h.servers.editorOpen(a, 'ERROR')
    projectBins = true
    h.allow()
    await h.servers.sync()
    await until('the server of the project and its marks', () => h.marks(a)?.length === 1)
    assert.match(h.servers.status()[0].command ?? '', /the project/)
    await h.servers.dispose()
  })

  it('completes for the editor\'s text: snippets, the word to replace, a resolve that brings an import, and members after a dot', async () => {
    const dir = await project({ 'lib.fk': 'function greet\nfunction grow\n' })
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'gr', true)
    await until('the server', () => h.servers.editorTriggers(a) !== null)
    assert.deepEqual(h.servers.editorTriggers(a), { completion: ['.'], commit: [';'], signature: ['('], signatureRetrigger: [','], format: [';', '}'] })
    // The library is not open: what the server knows of it comes from the disk (the extra file).
    const result = (await h.servers.completion(a, 0, 2, { triggerKind: 1 }))!
    assert.equal(result.incomplete, false)
    const labels = result.items.map((item) => item.label)
    assert.ok(labels.includes('function') && labels.includes('helper'))
    const helper = result.items.find((item) => item.label === 'helper')!
    assert.deepEqual({ kind: helper.kind, description: helper.description, resolved: helper.resolved, additional: helper.additionalEdits }, { kind: 'function', description: './helpers', resolved: false, additional: undefined })
    assert.deepEqual(helper.replace, { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } })
    assert.deepEqual(helper.commitCharacters, ['('])
    assert.equal(result.items.find((item) => item.label === 'oldThing')?.deprecated, true)
    const resolved = (await h.servers.resolveCompletion(a, result.list, helper.id))!
    assert.equal(resolved.resolved, true)
    assert.deepEqual(resolved.documentation, { kind: 'markdown', value: '**helper** does a thing.' })
    assert.deepEqual(resolved.additionalEdits, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import helper\n' }])
    // A newer list makes the older one's items unknown.
    const newer = (await h.servers.completion(a, 0, 2, { triggerKind: 1 }))!
    assert.equal(await h.servers.resolveCompletion(a, result.list, helper.id), null)
    assert.ok(newer.list > result.list)
    h.servers.editorChange(a, 'items.', true)
    const members = (await h.servers.completion(a, 0, 6, { triggerKind: 2, triggerCharacter: '.' }))!
    const push = members.items.find((item) => item.label === 'push')!
    assert.deepEqual({ text: push.insertText, snippet: push.snippet, kind: push.kind }, { text: 'push($1)', snippet: true, kind: 'method' })
    await h.servers.dispose()
  })

  it('helps with a call\'s signature, highlights a symbol, and hovers, for the editor', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'function add\nadd(1, 2)\nadd', true)
    const help = (await h.servers.signatureHelp(a, 1, 6, { triggerKind: 2, triggerCharacter: ',', isRetrigger: false }))!
    assert.equal(help.signatures[0].label, 'add(a: number, b: string)')
    assert.equal(help.activeParameter, 1)
    assert.deepEqual(help.signatures[0].parameters?.[0], { label: [4, 13], documentation: { kind: 'plaintext', value: 'the first' } })
    assert.equal(await h.servers.signatureHelp(a, 2, 1, { triggerKind: 1, isRetrigger: false }), null)
    const marks = await h.servers.highlights(a, 1, 1)
    assert.deepEqual(marks.map((item) => [item.range.start.line, item.kind]), [[0, 'write'], [1, 'read'], [2, 'read']])
    const hover = await h.servers.editorHover(a, 1, 1)
    assert.equal(hover?.markdown, '**add**')
    // Where nothing is, nothing is said; and a server that does not offer a feature answers nothing, not an error.
    assert.equal(await h.servers.editorHover(a, 1, 5), null)
    assert.deepEqual(await h.servers.editorLocations('definition', a, 1, 1), [{ file: a, line: 0, character: 9, endLine: 0, endCharacter: 12 }])
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'add(', true)
    assert.equal(await bare.servers.completion(a, 0, 4, { triggerKind: 1 }), null)
    assert.deepEqual(await bare.servers.highlights(a, 0, 1), [])
    await bare.servers.dispose()
  })

  it('prepares a rename for the editor, and says why one cannot be made', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'function add\nadd(1)', true)
    assert.deepEqual(await h.servers.editorPrepareRename(a, 1, 1), { ok: true, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } })
    assert.deepEqual(await h.servers.editorPrepareRename(a, 1, 4), { ok: false, reason: 'This element cannot be renamed.' })
    // A name with line breaks in a file of CRLF lines takes the file's own.
    h.servers.editorChange(a, 'function add\r\nadd(1)', true)
    const plan = await h.servers.rename(a, 1, 1, 'a\nb')
    const edit = plan.changes[0]
    assert.ok(edit.kind === 'edit')
    assert.deepEqual(edit.textEdits.map((item) => item.newText), ['a\r\nb', 'a\r\nb'])
    assert.equal(edit.after, 'function a\r\nb\r\na\r\nb(1)')
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'add', true)
    assert.equal(await bare.servers.editorPrepareRename(a, 0, 1), null)
    await bare.servers.dispose()
  })

  it('keeps the editor\'s actions apart from the agent\'s, narrows them by kind, and plans or runs the one chosen', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'ok\nERROR here\n', true)
    await until('the marks', () => h.marks(a)?.length === 1)
    const whole = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }
    const listed = (await h.servers.editorCodeActions(a, whole, { automatic: false }))!
    assert.deepEqual(
      listed.actions.map((item) => [item.id, item.title, item.preferred ?? false, item.command ?? false, item.disabled ?? '']),
      [
        [0, 'Replace ERROR with OK', true, false, ''],
        [1, 'Fix everything in the file', false, true, ''],
        [2, 'Add a note at the top', false, false, ''],
        [3, 'Not now', false, false, 'It is Tuesday'],
        [4, 'Run a bare command', false, true, ''],
      ],
    )
    // The agent's list does not replace the editor's.
    await h.servers.codeActions(a, whole)
    const fix = await h.servers.editorAction(a, listed.list, 0)
    assert.ok('plan' in fix && fix.plan)
    assert.equal(fix.command, false)
    const change = fix.plan.changes[0]
    assert.ok(change.kind === 'edit')
    assert.deepEqual(change.textEdits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: 'OK' }])
    assert.equal(change.after, 'ok\nOK here\n')
    // One that comes without its edit is resolved; one that is disabled says why; a command is run, not planned.
    const note = await h.servers.editorAction(a, listed.list, 2)
    assert.ok('plan' in note && note.plan?.changes[0].kind === 'edit' && note.plan.changes[0].after.startsWith('// note\n'))
    assert.deepEqual(await h.servers.editorAction(a, listed.list, 3), { reason: 'Not now: It is Tuesday' })
    assert.deepEqual(await h.servers.editorAction(a, listed.list, 1), { title: 'Fix everything in the file', command: true })
    const plans: EditPlan[] = []
    const ran = await h.servers.editorRunCommand(a, listed.list, 1, async (plan) => {
      plans.push(plan)
      return { applied: true }
    })
    assert.deepEqual(ran, { applied: 1, refused: [] })
    assert.equal(plans[0].changes[0].kind === 'edit' && plans[0].changes[0].after, 'ok\nOK here\n')
    // Only quick fixes, as the lightbulb asks: kinds that only start the same do not count, nor actions without one.
    const fixes = (await h.servers.editorCodeActions(a, whole, { only: ['quickfix'], automatic: true }))!
    assert.deepEqual(fixes.actions.map((item) => item.title), ['Replace ERROR with OK'])
    // The list before it is gone.
    assert.deepEqual(await h.servers.editorAction(a, listed.list, 0), { reason: 'That list of actions is out of date. Open it again.' })
    await h.servers.dispose()
  })

  it('gives the editor a document\'s outline as a tree, nests a flat one, and searches symbols across the folder', async () => {
    const dir = await project({ 'lib.fk': 'function greet\n  body\n' })
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'function add\nfunction sub\n', true)
    const tree = (await h.servers.editorSymbols(a))!
    assert.deepEqual(
      tree.map((item) => [item.name, item.kind, item.selection.start.character, item.children?.map((child) => child.name)]),
      [
        ['add', 'function', 9, ['inner']],
        ['sub', 'function', 9, ['inner']],
      ],
    )
    // A flat list: nested by range, in the order of the text, and nothing from another file.
    h.servers.editorChange(a, 'function add\nfunction sub\n// flat-symbols\n', true)
    const nested = (await h.servers.editorSymbols(a))!
    assert.deepEqual(
      nested.map((item) => [item.name, item.range.start.line, item.children?.map((child) => [child.name, child.kind])]),
      [
        ['add', 0, [['inner', 'variable']]],
        ['sub', 1, [['inner', 'variable']]],
      ],
    )
    // Across the folder: from the server of the file named, which starts for it.
    const hits = (await h.servers.editorWorkspaceSymbols('gre', path.join(dir, 'lib.fk')))!
    assert.deepEqual(hits.map((item) => [item.name, item.kind, item.container, item.file, item.range.start]), [['greet', 'function', 'module', path.join(dir, 'lib.fk'), { line: 0, character: 9 }]])
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'function add', true)
    assert.equal(await bare.servers.editorSymbols(a), null)
    assert.equal(await bare.servers.editorWorkspaceSymbols('add', a), null)
    await bare.servers.dispose()
  })

  it('gives the editor the blocks a document folds by, and nothing from a server that does not fold', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'function add {\n  /* a\n  b */\n  if (x) {\n    y\n  }\n}\n', true)
    assert.deepEqual(await h.servers.editorFoldingRanges(a), [
      { startLine: 1, endLine: 2, kind: 'comment' },
      { startLine: 3, endLine: 5, endCharacter: 3 },
      { startLine: 0, endLine: 6, endCharacter: 1 },
    ])
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'function add {\n}\n', true)
    assert.equal(await bare.servers.editorFoldingRanges(a), null)
    await bare.servers.dispose()
  })

  it('gives the editor the hints of the lines it asks for and the semantic tokens of a document, by the server\'s legend', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'let a = 1\nlet bb = 2\nfunction run\nfunction oldRun\nrun(oldRun)\nlet c = 3\n', true)
    assert.deepEqual(await h.servers.editorInlayHints(a, 1, 4), [{ line: 1, character: 6, label: ': number', kind: 'type' }])
    const kinds = (await import('./semantic')).SEMANTIC_KINDS
    const fn = kinds.indexOf('function')
    assert.deepEqual((await h.servers.editorSemanticTokens(a))!.data, [2, 9, 3, fn, 0, 3, 9, 6, fn, 1, 4, 0, 3, fn, 0, 4, 4, 6, fn, 1])
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'let a = 1\n', true)
    assert.equal(await bare.servers.editorInlayHints(a, 0, 10), null)
    assert.equal(await bare.servers.editorSemanticTokens(a), null)
    await bare.servers.dispose()
  })

  it('opens a call hierarchy for the editor a level at a time, and refuses one that is out of date', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    h.servers.editorOpen(a, 'function add\nadd(1)\n', true)
    const first = (await h.servers.editorPrepareCalls(a, 0, 10))!
    assert.deepEqual(first.items, [{ id: 0, name: 'add', kind: 'function', file: a, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }])
    const incoming = await h.servers.editorCalls(first.list, 0, 'incoming')
    assert.ok('calls' in incoming)
    assert.deepEqual(
      incoming.calls.map((call) => [call.item.id, call.item.name, call.item.detail, call.file, call.sites]),
      [[1, 'caller', 'add', a, [{ start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }]]],
    )
    // The caller found is numbered in the same hierarchy: its own callers can be asked for.
    const deeper = await h.servers.editorCalls(first.list, 1, 'incoming')
    assert.ok('calls' in deeper && deeper.calls[0].item.id === 2)
    const outgoing = await h.servers.editorCalls(first.list, 0, 'outgoing')
    assert.ok('calls' in outgoing && outgoing.calls[0].item.name === 'callee' && outgoing.calls[0].file === a)
    // A new hierarchy replaces it; a number it never gave is refused too.
    const second = (await h.servers.editorPrepareCalls(a, 1, 1))!
    assert.deepEqual(await h.servers.editorCalls(first.list, 0, 'incoming'), { reason: 'That call hierarchy is out of date. Open it again.' })
    assert.deepEqual(await h.servers.editorCalls(second.list, 9, 'incoming'), { reason: 'That call hierarchy is out of date. Open it again.' })
    // Nothing there: an empty hierarchy, not an error.
    assert.deepEqual((await h.servers.editorPrepareCalls(a, 1, 5))?.items, [])
    await h.servers.dispose()
  })

  it('formats the editor\'s text, a range of it, and as it is typed, keeping its line breaks', async () => {
    const dir = await project({})
    const h = hub(dir)
    const a = path.join(dir, 'a.fk')
    const text = '\tx = 1   \r\n\ty\r\n'
    h.servers.editorOpen(a, text, true)
    const options = { tabSize: 2, insertSpaces: true }
    const whole = (await h.servers.format(a, options))!
    assert.equal(applyTextEdits(text, whole), '  x = 1\r\n  y\r\n')
    const range = (await h.servers.format(a, options, { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }))!
    assert.equal(applyTextEdits(text, range), '\tx = 1   \r\n  y\r\n')
    h.servers.editorChange(a, 'a = 1  ;', true)
    const typed = (await h.servers.formatOnType(a, 0, 8, ';', options))!
    assert.equal(applyTextEdits('a = 1  ;', typed), 'a = 1;')
    // A formatter that fails answers nothing, and so does a server without one.
    h.servers.editorChange(a, 'FORMAT_FAILS', true)
    assert.equal(await h.servers.format(a, options), null)
    await h.servers.dispose()
    const bare = hub(dir, { mode: 'bare' })
    bare.servers.editorOpen(a, 'x', true)
    assert.equal(await bare.servers.format(a, options), null)
    assert.equal(await bare.servers.formatOnType(a, 0, 1, ';', options), null)
    await bare.servers.dispose()
  })

  it('keeps no more than 64 documents open for the agent', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 70; index++) files[`f${index}.fk`] = `x${index}`
    const dir = await project(files)
    const { servers } = hub(dir)
    const results = await servers.diagnostics(Object.keys(files).map((name) => path.join(dir, name)), { waitMs: 5_000 })
    assert.equal(results.filter((item) => item.ok).length, 70)
    assert.ok(servers.status()[0].documents <= 64, String(servers.status()[0].documents))
    await servers.dispose()
  })
})

describe('a companion beside the main server (ADR 0086)', () => {
  const side: ServerSpec = {
    id: 'side',
    label: 'Side',
    extensions: {},
    candidates: [{ command: 'side-ls', args: [] }],
    install: 'npm install -g side-ls',
    companion: { languages: ['fake'], uses: (dir, exists) => exists(path.join(dir, 'side.config')) },
  }

  function pair(dir: string, options: { sideMissing?: boolean } = {}) {
    const spawned: string[] = []
    const published: [string, CodeDiagnostic[]][] = []
    const servers = new LanguageServers({
      root: dir,
      catalog: [spec, side],
      allowed: () => ({ ok: true }),
      exists: (file) => existsSync(file),
      discover: (which) =>
        which.id === 'side' && options.sideMissing ? { missing: 'No language server for Side is installed (side-ls).' } : { file: process.execPath, args: [], found: 'the test', command: which.candidates[0]!.command },
      spawn: async (plan, cwd) => {
        spawned.push(plan.command)
        return fake.start(plan.command === 'side-ls' ? 'companion' : '', { cwd })
      },
      onDiagnostics: (file, items) => published.push([file, items]),
    })
    const marks = (file: string) => published.filter(([name]) => name === file).at(-1)?.[1] ?? []
    return { servers, spawned, marks }
  }

  it('runs beside the main server in a folder that uses it: marks, suggestions and hovers together', async () => {
    const dir = await project({ 'side.config': '', 'a.fk': 'function go\nERROR CLASS\n' })
    const a = path.join(dir, 'a.fk')
    const { servers, spawned, marks } = pair(dir)
    servers.editorOpen(a, 'function go\nERROR CLASS\n')
    await until('both servers marked the file', () => marks(a).length === 2)
    assert.deepEqual(spawned.sort(), ['fake-ls', 'side-ls'])
    assert.deepEqual(marks(a).map((item) => [item.source, item.severity]).sort(), [['companion', 'warning'], ['fake', 'error']])
    const side = servers.status().find((view) => view.id === 'side')
    assert.equal(side?.state, 'running')
    assert.equal(side?.documents, 1)

    // Its suggestions follow the main server's, numbered after them; its hover follows the main server's.
    const list = (await servers.completion(a, 0, 11, { triggerKind: 1 }))!
    assert.equal(list.items.at(-1)?.label, 'bg-red-500')
    assert.equal(list.items.at(-1)?.id, list.items.length - 1)
    assert.ok(list.items.some((item) => item.label === 'go'))
    assert.equal(await servers.resolveCompletion(a, list.list, list.items.length - 1), null)
    assert.equal((await servers.editorHover(a, 0, 10))?.markdown, '**go**\n\n---\n\n_go_ as a class')
    assert.equal(await servers.hover(a, 0, 10), '**go**\n\n---\n\n_go_ as a class')

    // A change goes to both, and what each says of it replaces what it said before.
    servers.editorChange(a, 'function go\nERROR\n', true)
    await until('the companion took its mark back', () => marks(a).length === 1)
    assert.equal(marks(a)[0]?.source, 'fake')
    servers.editorChange(a, 'function go\nCLASS\n', true)
    await until('only the companion marks the file', () => marks(a).length === 1 && marks(a)[0]?.source === 'companion')

    // Closed in the editor, it is closed in both, and nothing stays marked.
    servers.editorClose(a)
    await until('no marks once closed', () => marks(a).length === 0)
    assert.equal(servers.status().find((view) => view.id === 'side')?.documents, 0)
    await servers.dispose()
  })

  it('takes only the files of a project of its kind inside the folder', async () => {
    const dir = await project({ 'b.fk': 'CLASS\n' })
    await mkdir(path.join(dir, 'web', 'src'), { recursive: true })
    await writeFile(path.join(dir, 'web', 'side.config'), '')
    const inside = path.join(dir, 'web', 'src', 'a.fk')
    const outside = path.join(dir, 'b.fk')
    await writeFile(inside, 'CLASS\n')
    const { servers, spawned, marks } = pair(dir)
    servers.editorOpen(outside, 'CLASS\n')
    await wait(300)
    assert.deepEqual(spawned, ['fake-ls'])
    assert.deepEqual(marks(outside), [])
    servers.editorOpen(inside, 'CLASS\n')
    await until('the companion marked the file in its project', () => marks(inside).length === 1)
    assert.equal(marks(inside)[0]?.source, 'companion')
    assert.deepEqual(spawned, ['fake-ls', 'side-ls'])
    // The file outside its project stays the main server's alone, though the companion now runs.
    servers.editorChange(outside, 'CLASS here\n', true)
    await wait(300)
    assert.deepEqual(marks(outside), [])
    assert.equal(servers.status().find((view) => view.id === 'side')?.documents, 1)
    await servers.dispose()
  })

  it('does not start in a folder that does not use it, nor when it is not installed', async () => {
    const plain = await project({ 'a.fk': 'ERROR CLASS\n' })
    const a = path.join(plain, 'a.fk')
    const first = pair(plain)
    first.servers.editorOpen(a, 'ERROR CLASS\n')
    await until('the main server marked the file', () => first.marks(a).length === 1)
    await wait(200)
    assert.deepEqual(first.spawned, ['fake-ls'])
    assert.equal((await first.servers.editorHover(a, 0, 1))?.markdown, '**ERROR**')
    await first.servers.dispose()

    const used = await project({ 'side.config': '', 'a.fk': 'ERROR CLASS\n' })
    const b = path.join(used, 'a.fk')
    const second = pair(used, { sideMissing: true })
    second.servers.editorOpen(b, 'ERROR CLASS\n')
    await until('the main server marked the file', () => second.marks(b).length === 1)
    await wait(200)
    assert.deepEqual(second.spawned, ['fake-ls'])
    assert.equal(second.servers.status().find((view) => view.id === 'side')?.state, 'missing')
    await second.servers.dispose()
  })
})
