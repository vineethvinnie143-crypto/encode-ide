import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ServerSpec } from '@encode/lsp'
import { fakeServer, type FakeServer } from '@encode/lsp/testing'
import { realPathOf } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { FOLDER_NOT_TRUSTED, SERVERS_OFF } from './code'
import { Workspaces } from './scope'

/** A folder's language servers as sessions get them: one hub, only in a trusted folder, only while turned on. */

let fake: FakeServer
before(async () => {
  fake = await fakeServer()
})
after(async () => {
  await fake.dispose()
})

const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: [] }], install: 'npm install -g fake-ls' }

async function setup() {
  const root = await tempWorkspace({ 'a.fk': 'an ERROR\n' })
  const home = await tempWorkspace()
  let enabled = true
  const published: [string, string, number][] = []
  const workspaces = new Workspaces({
    home,
    env: {},
    languageServers: {
      enabled: () => enabled,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GOPATH: '/go', OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp-secret' },
      catalog: [spec],
      discover: () => ({ file: process.execPath, args: [fake.script, 'env'], found: 'the test', command: 'fake-ls' }),
      onDiagnostics: (folder, file, items) => published.push([folder, file, items.length]),
    },
  })
  const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
  return { root, workspaces, scope, published, turn: (on: boolean) => (enabled = on) }
}

describe('a folder\'s language servers', () => {
  it('are offered to a session only once the folder is trusted', async () => {
    const s = await setup()
    assert.ok(s.scope.code, 'the scope has a way to ask for them')
    assert.equal(s.scope.code(), undefined)
    const servers = s.workspaces.languageServers(s.root)!
    assert.deepEqual(servers.available(), { ok: false, reason: FOLDER_NOT_TRUSTED })
    await s.workspaces.act(s.root, { type: 'trust' })
    assert.equal(s.scope.code(), servers, 'the same hub for the session and the editor')
    await s.workspaces.close()
  })

  it('start in the folder with the agent\'s environment, and nothing that looks like a secret', async () => {
    const s = await setup()
    await s.workspaces.act(s.root, { type: 'trust' })
    const code = s.scope.code!()!
    const [result] = await code.diagnostics([path.join(s.root, 'a.fk')], { waitMs: 5_000 })
    assert.ok(result.ok && result.diagnostics.length === 1, JSON.stringify(result))
    const line = s.workspaces.languageServers(s.root)!.logs('fake').find((item) => item.startsWith('env '))!
    const [names, cwd] = line.slice(4).split(' cwd ')
    const env = names.split(',')
    assert.ok(env.includes('GOPATH'))
    assert.ok(env.includes('ENCODE_AGENT'))
    assert.ok(!env.includes('OPENAI_API_KEY') && !env.includes('GITHUB_TOKEN'), names)
    assert.equal(cwd, s.root)
    await s.workspaces.close()
  })

  it('stop when they are turned off or the folder loses its trust', async () => {
    const s = await setup()
    await s.workspaces.act(s.root, { type: 'trust' })
    const servers = s.workspaces.languageServers(s.root)!
    await servers.diagnostics([path.join(s.root, 'a.fk')], { waitMs: 5_000 })
    assert.equal(servers.status()[0].state, 'running')
    s.turn(false)
    await s.workspaces.syncLanguageServers()
    assert.equal(servers.status()[0].state, 'off')
    assert.equal(servers.status()[0].detail, SERVERS_OFF)
    assert.equal(s.scope.code!(), undefined)
    s.turn(true)
    await servers.diagnostics([path.join(s.root, 'a.fk')], { waitMs: 5_000 })
    assert.equal(servers.status()[0].state, 'running')
    await s.workspaces.act(s.root, { type: 'revoke' })
    assert.equal(servers.status()[0].state, 'off')
    await writeFile(path.join(s.root, 'a.fk'), 'fine')
    const [refused] = await servers.diagnostics([path.join(s.root, 'a.fk')], { waitMs: 1_000 })
    assert.ok(!refused.ok && refused.reason === FOLDER_NOT_TRUSTED)
    await s.workspaces.close()
  })

  it('take the editor\'s files by their paths in the folder, and say how they stand', async () => {
    const s = await setup()
    assert.deepEqual(await s.workspaces.languageServersReport(s.root), {
      state: 'untrusted',
      reason: FOLDER_NOT_TRUSTED,
      servers: [{ id: 'fake', label: 'Fake', state: 'off', detail: FOLDER_NOT_TRUSTED, documents: 0, install: 'npm install -g fake-ls', files: ['.fk'] }],
    })
    await s.workspaces.editorDocument(s.root, { kind: 'open', path: 'a.fk', text: 'ERROR\nERROR', dirty: true })
    await s.workspaces.editorDocument(s.root, { kind: 'open', path: '../outside.fk', text: 'ERROR', dirty: false })
    await s.workspaces.act(s.root, { type: 'trust' })
    const real = await realPathOf(s.root)
    const until = Date.now() + 5_000
    while (!s.published.some(([, , count]) => count === 2) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(s.published.at(-1), [real, path.join(real, 'a.fk'), 2])
    const report = await s.workspaces.languageServersReport(s.root)
    assert.equal(report.state, 'on')
    assert.equal(report.servers[0].state, 'running')
    assert.equal(report.servers[0].documents, 1, 'the file outside the folder was not opened')
    await s.workspaces.editorDocument(s.root, { kind: 'close', path: 'a.fk' })
    assert.deepEqual(s.published.at(-1), [real, path.join(real, 'a.fk'), 0])
    await s.workspaces.close()
  })

  it('answer the editor for its text as it is now, and never for a file outside the folder', async () => {
    const s = await setup()
    try {
      await s.workspaces.act(s.root, { type: 'trust' })
      const real = await realPathOf(s.root)
      await s.workspaces.editorDocument(s.root, { kind: 'open', path: 'a.fk', text: 'function add\n', dirty: false })
      // Not awaited: the question after it still sees the new text.
      void s.workspaces.editorDocument(s.root, { kind: 'change', path: 'a.fk', text: 'function add\nfunction sub\nsub', dirty: true })
      const completion = await s.workspaces.editorAsk(s.root, { kind: 'complete', path: 'a.fk', line: 2, character: 3, triggerKind: 1 })
      assert.deepEqual(
        completion?.items.slice(0, 2).map((item) => item.label),
        ['add', 'sub'],
      )
      // A place comes with the text of its line as the file on disk has it (the editor puts in its own for open files).
      await writeFile(path.join(real, 'a.fk'), 'function add\r\n  function sub  \r\nsub')
      assert.deepEqual(await s.workspaces.editorAsk(s.root, { kind: 'definition', path: 'a.fk', line: 2, character: 1 }), [
        { path: 'a.fk', file: path.join(real, 'a.fk'), line: 1, character: 9, endLine: 1, endCharacter: 12, preview: '  function sub' },
      ])
      assert.equal((await s.workspaces.editorAsk(s.root, { kind: 'triggers', path: 'a.fk' }))?.completion.includes('.'), true)

      // A newer question of the same kind cancels the older one; other kinds are left alone.
      const [older, newer, hover] = await Promise.all([
        s.workspaces.editorAsk(s.root, { kind: 'complete', path: 'a.fk', line: 2, character: 3, triggerKind: 1 }),
        s.workspaces.editorAsk(s.root, { kind: 'complete', path: 'a.fk', line: 2, character: 3, triggerKind: 1 }),
        s.workspaces.editorAsk(s.root, { kind: 'hover', path: 'a.fk', line: 2, character: 1 }),
      ])
      assert.equal(older, null)
      assert.ok(newer && newer.items.length > 0)
      assert.equal(hover?.markdown, '**sub**')

      assert.equal(await s.workspaces.editorAsk(s.root, { kind: 'hover', path: '../outside.fk', line: 0, character: 0 }), null)
      assert.deepEqual(await s.workspaces.editorAsk(s.root, { kind: 'highlights', path: '../outside.fk', line: 0, character: 0 }), [])
    } finally {
      await s.workspaces.close()
    }
  })

  it('give the editor a file\'s outline, the folder\'s symbols and call hierarchies, places in the folder only', async () => {
    const s = await setup()
    try {
      await s.workspaces.act(s.root, { type: 'trust' })
      const real = await realPathOf(s.root)
      await writeFile(path.join(real, 'b.fk'), 'function helper\n')
      await s.workspaces.editorDocument(s.root, { kind: 'open', path: 'a.fk', text: 'function add\nadd(1)\n', dirty: true })
      const outline = await s.workspaces.editorAsk(s.root, { kind: 'symbols', path: 'a.fk' })
      assert.deepEqual(outline?.map((item) => [item.name, item.kind, item.children?.length]), [['add', 'function', 1]])

      // Across the folder, with the file shown or with none; nothing outside the folder is asked about.
      const found = await s.workspaces.editorAsk(s.root, { kind: 'workspaceSymbols', path: 'a.fk', query: 'help' })
      // The fake server searches the files it was given: b.fk is not one yet.
      assert.deepEqual(found, [])
      await s.workspaces.editorDocument(s.root, { kind: 'open', path: 'b.fk', text: 'function helper\n', dirty: false })
      assert.deepEqual(await s.workspaces.editorAsk(s.root, { kind: 'workspaceSymbols', path: '', query: 'help' }), [
        { name: 'helper', kind: 'function', container: 'module', path: 'b.fk', range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } },
      ])
      assert.equal(await s.workspaces.editorAsk(s.root, { kind: 'workspaceSymbols', path: '../outside.fk', query: 'help' }), null)
      assert.equal(await s.workspaces.editorAsk(s.root, { kind: 'symbols', path: '../outside.fk' }), null)

      // How a file folds, as its server sees it.
      await s.workspaces.editorDocument(s.root, { kind: 'change', path: 'b.fk', text: 'function helper {\n  body\n}\n', dirty: true })
      assert.deepEqual(await s.workspaces.editorAsk(s.root, { kind: 'folding', path: 'b.fk' }), [{ startLine: 0, endLine: 2, endCharacter: 1 }])
      assert.equal(await s.workspaces.editorAsk(s.root, { kind: 'folding', path: '../outside.fk' }), null)

      // A call hierarchy: the function with its line, then who calls it, each with the lines of the calls.
      const prepared = await s.workspaces.editorAsk(s.root, { kind: 'callHierarchy', path: 'a.fk', line: 0, character: 10 })
      assert.deepEqual(prepared?.items, [{ id: 0, name: 'add', kind: 'function', at: { path: 'a.fk', file: path.join(real, 'a.fk'), line: 0, character: 9, endLine: 0, endCharacter: 12, preview: 'an ERROR' } }])
      const callers = await s.workspaces.editorAsk(s.root, { kind: 'calls', path: 'a.fk', list: prepared!.list, id: 0, direction: 'incoming' })
      assert.ok(callers && 'calls' in callers)
      assert.deepEqual(
        callers.calls.map((call) => [call.item.id, call.item.name, call.item.detail, call.sites.map((site) => [site.path, site.line, site.character])]),
        [[1, 'caller', 'add', [['a.fk', 0, 9]]]],
      )
      assert.deepEqual(await s.workspaces.editorAsk(s.root, { kind: 'calls', path: 'a.fk', list: prepared!.list + 1, id: 0, direction: 'incoming' }), { reason: 'That call hierarchy is out of date. Open it again.' })
    } finally {
      await s.workspaces.close()
    }
  })
})
