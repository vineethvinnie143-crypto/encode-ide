import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ServerSpec } from './catalog'
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
    assert.deepEqual(byFile.get(a), { kind: 'edit', file: a, before: 'function greet\ncall greet\n', after: 'function welcome\ncall welcome\n', edits: 2 })
    assert.deepEqual(byFile.get(b), { kind: 'edit', file: b, before: 'call greet\n', after: 'call welcome\n', edits: 1 })
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
    const none = async () => ({ applied: false })
    const fix = await servers.actionEdit(a, 1, none)
    assert.ok('plan' in fix)
    assert.deepEqual(fix.plan.changes, [{ kind: 'edit', file: a, before: 'line one\nan ERROR here\n', after: 'line one\nan OK here\n', edits: 1 }])
    const resolved = await servers.actionEdit(a, 3, none)
    assert.ok('plan' in resolved && resolved.plan.changes[0].kind === 'edit' && resolved.plan.changes[0].after === '// note\nline one\nan ERROR here\n')
    await assert.rejects(servers.actionEdit(a, 4, none), /not available: It is Tuesday/)
    await assert.rejects(servers.actionEdit(a, 9, none), /There is no action 9; the list has 5\./)
    const plans: EditPlan[] = []
    const ran = await servers.actionEdit(a, 2, async (plan) => {
      plans.push(plan)
      return { applied: true }
    })
    assert.deepEqual(ran, { ran: true, applied: 1 })
    assert.ok(plans[0].changes[0].kind === 'edit' && plans[0].changes[0].after === 'line one\nan OK here\n')
    await assert.rejects(servers.actionEdit(path.join(dir, 'other.fk'), 1, none), /List the actions for this file again/)
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
