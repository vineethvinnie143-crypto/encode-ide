/**
 * The language servers through the agent host, as the desktop uses them: the editor's files go to a folder's servers
 * once the folder is trusted and servers are on, and what the servers find comes back as marks, which go away when
 * servers are turned off.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { stubManagedShell } from '@encode/core/testing'
import type { ServerSpec } from '@encode/lsp'
import { fakeServer, type FakeServer } from '@encode/lsp/testing'
import { createPortPair } from '@encode/protocol'
import { realPathOf } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import type { CodeDiagnostic } from '../../shared/types'
import type { HostConfig } from './api'
import { runHostRuntime } from './runtime'
import { AgentHostService, type HostProcess } from './service'

let fake: FakeServer
before(async () => {
  fake = await fakeServer()
})
const services: AgentHostService[] = []
after(async () => {
  for (const service of services.splice(0)) await service.dispose()
  await fake.dispose()
})

const spec: ServerSpec = { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: [] }], install: 'npm install -g fake-ls' }

const config = (languageServers: boolean): HostConfig => ({
  policy: 'workspace-write',
  maxSteps: 30,
  maxGoalRounds: 8,
  computer: false,
  languageServers,
  errorGate: 'auto',
  guide: 'auto',
  checkGate: 'auto',
  reviewWork: 'auto',
  model: 'none',
  router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } },
  providers: {},
  searchProvider: 'duckduckgo',
})

async function until(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture() {
  const dir = await tempWorkspace()
  const home = await tempWorkspace()
  const workspace = await tempWorkspace({ 'a.fk': 'fine' })
  const marks: [string, string, CodeDiagnostic[]][] = []
  let changes = 0
  const service = new AgentHostService({
    spawn(): HostProcess {
      const [mainSide, hostSide] = createPortPair()
      let onExit: () => void = () => undefined
      const exit = () => {
        mainSide.close?.()
        hostSide.close?.()
        onExit()
      }
      runHostRuntime(hostSide, {
        hostOptions: { createShell: stubManagedShell, goalDelayMs: 0, nameSessions: false },
        log: () => undefined,
        onShutdown: exit,
        languageServers: { catalog: [spec], discover: () => ({ file: process.execPath, args: [fake.script, ''], found: 'the test', command: 'fake-ls' }) },
      })
      return { port: mainSide, kill: exit, onExit: (handler) => (onExit = handler) }
    },
    init: () => ({ dir, home, workspace }),
    apiKey: () => '',
    searchKey: () => '',
    onEvent: () => undefined,
    onJobs: () => undefined,
    onCode: () => changes++,
    onDiagnostics: (root, file, diagnostics) => marks.push([root, file, diagnostics]),
    log: () => undefined,
  })
  services.push(service)
  const real = await realPathOf(workspace)
  return { service, workspace, real, marks, changes: () => changes, last: () => marks.at(-1) }
}

describe('language servers through the agent host', () => {
  it('mark the editor\'s files once the folder is trusted, and take the marks back when they are turned off', async () => {
    const f = await fixture()
    f.service.configure(config(true))
    await f.service.start()
    const untrusted = await f.service.codeReport(f.workspace)
    assert.equal(untrusted.state, 'untrusted')
    assert.deepEqual(untrusted.servers.map((server) => [server.label, server.state, server.install]), [['Fake', 'off', 'npm install -g fake-ls']])

    f.service.document({ kind: 'open', root: f.workspace, path: 'a.fk', text: 'ERROR\nWARN', dirty: true })
    await f.service.permissionsAct(f.workspace, { type: 'trust' })
    await until('the marks', () => f.last()?.[2].length === 2)
    const [root, file, diagnostics] = f.last()!
    assert.equal(root, f.real)
    assert.equal(file, path.join(f.real, 'a.fk'))
    assert.deepEqual(diagnostics.map((item) => [item.line, item.severity]), [[0, 'error'], [1, 'warning']])
    assert.ok(f.changes() > 0, 'the server starting was told')
    const on = await f.service.codeReport(f.workspace)
    assert.equal(on.state, 'on')
    assert.equal(on.servers[0].state, 'running')

    f.service.document({ kind: 'change', root: f.workspace, path: 'a.fk', text: 'ERROR', dirty: true })
    await until('the marks of the change', () => f.last()?.[2].length === 1)

    f.service.configure(config(false))
    await until('the marks to be taken back', () => f.last()?.[2].length === 0)
    assert.equal((await f.service.codeReport(f.workspace)).state, 'off')

    f.service.configure(config(true))
    await until('the marks to come back', () => f.last()?.[2].length === 1)
  })
})
