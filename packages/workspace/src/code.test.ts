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
})
