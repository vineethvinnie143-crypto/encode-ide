import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { SessionScope } from '@encode/core'
import { fakeServer, type FakeServer, type FakeServerOptions } from '@encode/mcp/testing'
import { tempWorkspace } from '@encode/tools/testing'
import { mcpActionProblem, type McpAction } from './mcp-actions'
import type { McpHub, McpReport, McpServerView } from './mcp'
import { Workspaces } from './scope'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const json = (value: unknown) => JSON.stringify(value)
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `does ${name}`, inputSchema: { type: 'object', properties: {} }, ...extra })
const listing = (...names: string[]): FakeServerOptions => ({
  handle: (method) => (method === 'tools/list' ? { tools: names.map((name) => tool(name)) } : { content: [{ type: 'text', text: 'ok' }] }),
  instructions: 'Use me wisely.',
})
const never: FakeServerOptions = { initialize: () => new Promise(() => {}) }

/** What the workspaces give a session, with the parts these tests rely on present. */
type Opened = SessionScope & { external: McpHub; refresh(): Promise<void>; release(): Promise<void> }

/** Two real folders (the project and the home), the workspaces over them, and servers that live in memory. */
async function rig(
  options: {
    project?: Record<string, unknown>
    user?: Record<string, unknown>
    files?: Record<string, string>
    homeFiles?: Record<string, string>
    servers?: Record<string, FakeServerOptions | (() => FakeServerOptions | string)>
    mcp?: { startWaitMs?: number; idleMs?: number }
  } = {},
) {
  const files = { ...options.files }
  if (options.project) files['.mcp.json'] = json({ mcpServers: options.project })
  const homeFiles = { ...options.homeFiles }
  if (options.user) homeFiles['.encode/mcp.json'] = json({ mcpServers: options.user })
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace(homeFiles))
  const starts: string[] = []
  const fakes: FakeServer[] = []
  const changes: string[] = []
  const warnings: string[] = []
  const workspaces = new Workspaces({
    home,
    env: {},
    warn: (message) => warnings.push(message),
    onMcpChange: (changed) => changes.push(changed),
    mcp: {
      startWaitMs: options.mcp?.startWaitMs ?? 3000,
      ...(options.mcp?.idleMs ? { idleMs: options.mcp.idleMs } : {}),
      manager: {
        retryBaseMs: 1000,
        connectTimeoutMs: 3000,
        createTransport(entry) {
          starts.push(entry.name)
          const definition = options.servers?.[entry.name]
          const resolved = typeof definition === 'function' ? definition() : definition
          if (typeof resolved === 'string') return resolved
          const server = fakeServer(resolved ?? listing('echo'))
          fakes.push(server)
          return server.transport
        },
      },
    },
  })
  const notes: string[] = []
  const open = async (): Promise<Opened> => {
    const scope = await workspaces.scope({ sessionId: `s${notes.length}`, root, notice: (text) => notes.push(text) })
    return scope as Opened
  }
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
  return { root, home, workspaces, starts, fakes, changes, warnings, notes, open, write }
}

const names = (scope: Opened) => scope.external.list().map((candidate) => candidate.definition.name)
const view = (report: McpReport, name: string): McpServerView => {
  const found = report.servers.find((server) => server.name === name)
  assert.ok(found, `no server ${name} in ${report.servers.map((server) => server.name).join(', ')}`)
  return found
}
const act = async (r: Awaited<ReturnType<typeof rig>>, action: McpAction) => r.workspaces.mcpAct(r.root, action)
const signal = () => new AbortController().signal

describe('a folder’s MCP servers in a session', () => {
  it('start the user’s servers, offer their tools, and keep the project’s waiting for approval', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, project: { theirs: { command: 'y', args: ['--go'] } }, servers: { mine: listing('echo'), theirs: listing('push') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__mine__echo'])
    assert.deepEqual(r.starts, ['mine'], 'the project’s server was started')
    assert.deepEqual(scope.external.instructions(), [{ server: 'mine', text: 'Use me wisely.' }])

    const report = await r.workspaces.mcpReport(r.root)
    assert.equal(report.trusted, false)
    assert.equal(report.broken, null)
    assert.equal(view(report, 'mine').state, 'connected')
    assert.deepEqual(view(report, 'mine').tools.map((entry) => entry.name), ['mcp__mine__echo'])
    assert.equal(view(report, 'theirs').state, 'needs-approval')
    assert.match(view(report, 'theirs').detail ?? '', /not trusted/)
    assert.match(view(report, 'theirs').summary, /y --go/)
    assert.equal(view(report, 'theirs').scope, 'project')
    assert.deepEqual(report.files, { user: path.join(r.home, '.encode', 'mcp.json'), project: path.join(r.root, '.mcp.json'), encode: path.join(r.root, '.encode', 'mcp.json') })
  })

  it('run a project server only once the folder is trusted and the person approved exactly that setup', async () => {
    const r = await rig({ project: { theirs: { command: 'y', args: ['--go'] } }, servers: { theirs: listing('push') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), [])

    const trusted = await r.workspaces.act(r.root, { type: 'trust' })
    assert.equal(trusted.ok, true)
    await scope.refresh()
    assert.deepEqual(r.starts, [], 'trusting the folder is not approving the server')
    const waiting = view(await r.workspaces.mcpReport(r.root), 'theirs')
    assert.equal(waiting.state, 'needs-approval')
    assert.match(waiting.detail ?? '', /asks to run an MCP server/)

    const stale = await act(r, { type: 'approve', name: 'theirs', digest: 'a'.repeat(64) })
    assert.equal(stale.ok, false)
    assert.match(stale.ok ? '' : stale.reason, /changed after the approval card was shown/)
    assert.deepEqual(r.starts, [])

    const before = scope.external.key()
    const approved = await act(r, { type: 'approve', name: 'theirs', digest: waiting.digest })
    assert.equal(approved.ok, true, approved.ok ? '' : approved.reason)
    assert.equal(view(approved.report, 'theirs').state, 'connected')
    assert.deepEqual(names(scope), ['mcp__theirs__push'])
    assert.notEqual(scope.external.key(), before)

    const forgotten = await act(r, { type: 'forget', name: 'theirs' })
    assert.equal(forgotten.ok, true)
    assert.equal(view(forgotten.report, 'theirs').state, 'needs-approval')
    assert.deepEqual(names(scope), [])
  })

  it('stop a server whose setup changed after it was approved, and ask again', async () => {
    const r = await rig({ project: { theirs: { command: 'y', args: ['--safe'] } }, servers: { theirs: listing('push') } })
    const scope = await r.open()
    await r.workspaces.act(r.root, { type: 'trust' })
    const first = view(await r.workspaces.mcpReport(r.root), 'theirs')
    assert.equal((await act(r, { type: 'approve', name: 'theirs', digest: first.digest })).ok, true)
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__theirs__push'])

    // The agent, or a pull, rewrites the entry: the very next call sees it.
    await r.write(path.join(r.root, '.mcp.json'), json({ mcpServers: { theirs: { command: 'y', args: ['--steal'] } } }))
    await scope.refresh()
    await scope.external.ready(signal())
    const report = await r.workspaces.mcpReport(r.root)
    assert.equal(view(report, 'theirs').state, 'needs-approval')
    assert.match(view(report, 'theirs').detail ?? '', /setup changed/)
    assert.match(view(report, 'theirs').summary, /--steal/)
    assert.deepEqual(names(scope), [])
    assert.equal(r.starts.length, 1, 'the changed setup was started')
  })

  it('follow the files: a server added or removed while the session is open comes and goes', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo'), later: listing('more') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__mine__echo'])

    await r.write(path.join(r.home, '.encode', 'mcp.json'), json({ mcpServers: { mine: { command: 'x' }, later: { command: 'z' } } }))
    await scope.refresh()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__later__more', 'mcp__mine__echo'])
    assert.deepEqual(r.starts, ['mine', 'later'], 'the server that did not change was started again')

    await r.write(path.join(r.home, '.encode', 'mcp.json'), json({ mcpServers: { later: { command: 'z' } } }))
    await scope.refresh()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__later__more'])
  })

  it('keep the tool list the same while a server only reconnects, and change it when the tools change', async () => {
    let round = 0
    const r = await rig({
      user: { mine: { command: 'x' } },
      servers: { mine: () => listing(...(round++ < 2 ? ['echo'] : ['echo', 'extra'])) },
    })
    const scope = await r.open()
    await scope.external.ready(signal())
    const key = scope.external.key()
    assert.match(key, /^[0-9a-f]{16}$/)

    assert.equal((await act(r, { type: 'restart', name: 'mine' })).ok, true)
    assert.equal(scope.external.key(), key, 'same tools, same key')
    assert.equal((await act(r, { type: 'restart', name: 'mine' })).ok, true)
    assert.deepEqual(names(scope), ['mcp__mine__echo', 'mcp__mine__extra'])
    assert.notEqual(scope.external.key(), key)
  })

  it('turn a server off and on again in the person’s own settings', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, project: { theirs: { command: 'y' } }, servers: { mine: listing('echo'), theirs: listing('push') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__mine__echo'])

    const off = await act(r, { type: 'turn-off', name: 'mine' })
    assert.equal(off.ok, true)
    assert.equal(view(off.report, 'mine').state, 'disabled')
    assert.deepEqual(names(scope), [])
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.home, '.encode', 'settings.json'), 'utf8')), { disabledMcpjsonServers: ['mine'] })

    const on = await act(r, { type: 'turn-on', name: 'mine' })
    assert.equal(on.ok, true)
    assert.equal(view(on.report, 'mine').state, 'connected')
    assert.deepEqual(names(scope), ['mcp__mine__echo'])

    // A project's server is turned off in the local settings, not in the file the project shares.
    const project = await act(r, { type: 'turn-off', name: 'theirs' })
    assert.equal(project.ok, true)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.root, '.encode', 'settings.local.json'), 'utf8')), { disabledMcpjsonServers: ['theirs'] })
    await assert.rejects(fs.readFile(path.join(r.root, '.encode', 'settings.json'), 'utf8'))
  })

  it('say when a server stays off because the project’s own settings list it', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, files: { '.encode/settings.json': json({ disabledMcpjsonServers: ['mine'] }) }, servers: { mine: listing('echo') } })
    const on = await act(r, { type: 'turn-on', name: 'mine' })
    assert.equal(on.ok, true)
    assert.match(on.ok ? (on.note ?? '') : '', /still turned off in .*settings\.json/)
    assert.equal(view(on.report, 'mine').state, 'disabled')
  })

  it('start nothing while the settings cannot be trusted, and refuse to approve or restart', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, files: { '.encode/settings.json': '{ "permissions": { "deny": [ }' }, servers: { mine: listing('echo') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(r.starts, [])
    assert.deepEqual(names(scope), [])
    const report = await r.workspaces.mcpReport(r.root)
    assert.match(report.broken ?? '', /not valid JSON/)
    assert.equal(view(report, 'mine').state, 'stopped')
    assert.match(view(report, 'mine').detail ?? '', /not valid JSON/)
    const restart = await act(r, { type: 'restart', name: 'mine' })
    assert.equal(restart.ok, false)
    assert.match(restart.ok ? '' : restart.reason, /not valid JSON/)

    // Fixing the file is enough: the next call finds the servers allowed again.
    await r.write(path.join(r.root, '.encode', 'settings.json'), '{}')
    await scope.refresh()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__mine__echo'])
  })

  it('report a server that does not start, with the reason, and leave the others alone', async () => {
    const r = await rig({ user: { bad: { command: 'x' }, good: { command: 'y' } }, servers: { bad: () => 'The program was not found.', good: listing('echo') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__good__echo'])
    const report = await r.workspaces.mcpReport(r.root)
    assert.equal(view(report, 'bad').state, 'failed')
    assert.match(view(report, 'bad').detail ?? '', /not found/)
    assert.equal(view(report, 'good').state, 'connected')
  })

  it('give a slow server a few seconds once, and let its tools join when it is up', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = await rig({
      user: { slow: { command: 'x' } },
      servers: { slow: () => ({ ...listing('late'), initialize: async () => (await gate, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } }) }) },
      mcp: { startWaitMs: 80 },
    })
    const scope = await r.open()
    const started = Date.now()
    await scope.external.ready(signal())
    assert.ok(Date.now() - started >= 60, 'ready did not wait for the server that is starting')
    assert.deepEqual(names(scope), [])
    const again = Date.now()
    await scope.external.ready(signal())
    assert.ok(Date.now() - again < 60, 'a second turn waited for the same slow server')

    release?.()
    for (let i = 0; i < 50 && names(scope).length === 0; i++) await wait(20)
    assert.deepEqual(names(scope), ['mcp__slow__late'])
  })

  it('stop waiting for a server when the turn is stopped', async () => {
    const r = await rig({ user: { stuck: { command: 'x' } }, servers: { stuck: never }, mcp: { startWaitMs: 5000 } })
    const scope = await r.open()
    const controller = new AbortController()
    const waiting = scope.external.ready(controller.signal)
    setTimeout(() => controller.abort(), 30)
    const started = Date.now()
    await waiting
    assert.ok(Date.now() - started < 1500)
  })

  it('tell the screen when a server changes, in one go and not once for each step', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo') } })
    await r.workspaces.mcpReport(r.root)
    await wait(150)
    assert.ok(r.changes.length >= 1)
    assert.ok(r.changes.length <= 3, `${r.changes.length} notifications`)
    assert.ok(r.changes.every((changed) => changed === r.root))
  })
})

describe('looking at the servers', () => {
  it('starts nothing when asked only to look, and says where each server would stand', async () => {
    const r = await rig({ user: { mine: { command: 'x' }, quiet: { command: 'q' } }, project: { theirs: { command: 'y' } }, files: { '.encode/settings.json': json({ disabledMcpjsonServers: ['quiet'] }) }, servers: { mine: listing('echo'), theirs: listing('push') } })
    const cold = await r.workspaces.mcpReport(r.root, { start: false })
    assert.deepEqual(r.starts, [], 'a look started a server')
    assert.equal(view(cold, 'mine').state, 'stopped')
    assert.match(view(cold, 'mine').detail ?? '', /next chat/)
    assert.equal(view(cold, 'quiet').state, 'disabled')
    assert.equal(view(cold, 'theirs').state, 'needs-approval')
    assert.match(view(cold, 'theirs').detail ?? '', /not trusted/)

    // Looking at the screen is what starts them.
    const warm = await r.workspaces.mcpReport(r.root)
    assert.equal(view(warm, 'mine').state, 'connected')
    assert.deepEqual(r.starts, ['mine'])
    // And once they run, a look that starts nothing still sees them as they are.
    assert.equal(view(await r.workspaces.mcpReport(r.root, { start: false }), 'mine').state, 'connected')
  })

  it('starts nothing while a session has the servers running either, and shows what the files say now', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo'), later: listing('more') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(r.starts, ['mine'])

    await r.write(path.join(r.home, '.encode', 'mcp.json'), json({ mcpServers: { mine: { command: 'x', args: ['--changed'] }, later: { command: 'z' } } }))
    const looked = await r.workspaces.mcpReport(r.root, { start: false })
    assert.deepEqual(r.starts, ['mine'], 'a look started or restarted a server')
    assert.equal(view(looked, 'mine').state, 'stopped', 'a server whose entry changed is not shown as it was')
    assert.match(view(looked, 'mine').summary, /--changed/)
    assert.equal(view(looked, 'later').state, 'stopped')
    assert.deepEqual(names(scope), ['mcp__mine__echo'])

    // The session's own next call brings the servers in line with the files.
    await scope.refresh()
    await scope.external.ready(signal())
    assert.deepEqual(r.starts, ['mine', 'mine', 'later'])
  })
})

describe('the servers of a folder are shared and let go of', () => {
  it('start a server once for every session in the folder', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo') } })
    const [a, b] = [await r.open(), await r.open()]
    await a.external.ready(signal())
    await b.external.ready(signal())
    assert.deepEqual(r.starts, ['mine'])
    assert.equal(a.external, b.external)
  })

  it('stop the servers when nobody has worked in the folder for a while, and start them again with the next session', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo') }, mcp: { idleMs: 60 } })
    const a = await r.open()
    const b = await r.open()
    await a.external.ready(signal())
    await a.release()
    await wait(120)
    assert.equal(r.fakes[0].transport.closed, false, 'the folder was let go of while a session was still in it')
    await b.release()
    await b.release()
    for (let i = 0; i < 50 && !r.fakes[0].transport.closed; i++) await wait(20)
    assert.equal(r.fakes[0].transport.closed, true)

    const c = await r.open()
    await c.external.ready(signal())
    assert.deepEqual(r.starts, ['mine', 'mine'])
    assert.deepEqual(names(c), ['mcp__mine__echo'])
  })

  it('stop every server when the program closes', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, project: {}, servers: { mine: listing('echo') } })
    const scope = await r.open()
    await scope.external.ready(signal())
    await r.workspaces.close()
    assert.equal(r.fakes[0].transport.closed, true)
    assert.deepEqual(names(scope), [])
  })
})

describe('what the screen may ask', () => {
  it('refuses what is not an action, or names a server that cannot exist', () => {
    const digest = 'a'.repeat(64)
    for (const action of [null, 'approve', 42, {}, { type: 'delete', name: 'x' }, { type: 'restart' }, { type: 'restart', name: 7 }, { type: 'restart', name: '' }, { type: 'restart', name: 'a__b' }, { type: 'restart', name: '../x' }, { type: 'approve', name: 'x' }, { type: 'approve', name: 'x', digest: 'nope' }, { type: 'approve', name: 'x', digest: digest.toUpperCase() }]) {
      assert.notEqual(mcpActionProblem(action), null, JSON.stringify(action))
    }
    for (const action of [{ type: 'approve', name: 'x', digest }, { type: 'forget', name: 'my-server_2' }, { type: 'restart', name: 'x' }, { type: 'turn-off', name: 'x' }, { type: 'turn-on', name: 'x' }]) {
      assert.equal(mcpActionProblem(action), null, JSON.stringify(action))
    }
  })

  it('says so for a server the files do not have, and for taking back an approval of one’s own server', async () => {
    const r = await rig({ user: { mine: { command: 'x' } }, servers: { mine: listing('echo') } })
    const missing = await act(r, { type: 'restart', name: 'ghost' })
    assert.equal(missing.ok, false)
    assert.match(missing.ok ? '' : missing.reason, /no MCP server called ghost/)
    const own = await act(r, { type: 'forget', name: 'mine' })
    assert.equal(own.ok, false)
    assert.match(own.ok ? '' : own.reason, /your own server/)
    const bad = await r.workspaces.mcpAct(r.root, { type: 'restart', name: 'a__b' })
    assert.equal(bad.ok, false)
    assert.equal(r.starts.length, 1, 'a refused action started something')
  })

  it('does not approve before the folder is trusted', async () => {
    const r = await rig({ project: { theirs: { command: 'y' } }, servers: { theirs: listing('push') } })
    const waiting = view(await r.workspaces.mcpReport(r.root), 'theirs')
    const refused = await act(r, { type: 'approve', name: 'theirs', digest: waiting.digest })
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.reason, /Trust this folder first/)
    assert.deepEqual(r.starts, [])
  })
})

describe('adding and removing a server from the screen', () => {
  it('writes your own server into your file and starts it, and a project’s into .mcp.json, approved when the folder is trusted', async () => {
    const r = await rig({ files: { '.mcp.json': json({ other: 1, mcpServers: { kept: { command: 'k' } } }) }, servers: { mine: listing('echo'), web: listing('fetch'), kept: listing('k') } })
    const added = await act(r, { type: 'add', name: 'mine', scope: 'user', setup: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} } })
    assert.equal(added.ok, true, added.ok ? '' : added.reason)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.home, '.encode', 'mcp.json'), 'utf8')), { mcpServers: { mine: { command: 'npx', args: ['-y', 'server'] } } })
    assert.equal(view(added.report, 'mine').scope, 'user')

    const twice = await act(r, { type: 'add', name: 'mine', scope: 'project', setup: { type: 'stdio', command: 'x', args: [], env: {} } })
    assert.equal(twice.ok, false)
    assert.match(twice.ok ? '' : twice.reason, /already/)

    // Not trusted yet: written, and waiting.
    const waiting = await act(r, { type: 'add', name: 'web', scope: 'project', setup: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } })
    assert.equal(waiting.ok, true, waiting.ok ? '' : waiting.reason)
    assert.match(waiting.ok ? (waiting.note ?? '') : '', /trust this folder/)
    assert.equal(view(waiting.report, 'web').state, 'needs-approval')
    const file = JSON.parse(await fs.readFile(path.join(r.root, '.mcp.json'), 'utf8'))
    assert.equal(file.other, 1, 'the rest of the file stays')
    assert.deepEqual(file.mcpServers.web, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } })
    assert.ok(file.mcpServers.kept)

    // Trusted: the person wrote it here, so it starts without a second approval.
    assert.equal((await r.workspaces.act(r.root, { type: 'trust' })).ok, true)
    const scope = await r.open()
    const trusted = await act(r, { type: 'add', name: 'web2', scope: 'project', setup: { type: 'stdio', command: 'w', args: [], env: { MODE: 'fast' } } })
    assert.equal(trusted.ok, true, trusted.ok ? '' : trusted.reason)
    assert.equal(view(trusted.report, 'web2').state, 'connected', JSON.stringify([trusted.ok && trusted.note, view(trusted.report, 'web2').detail, trusted.report.broken]))
    await scope.external.ready(signal())
    assert.ok(names(scope).includes('mcp__web2__echo'), names(scope).join(', '))
  })

  it('takes a server out of the files of its scope, and the approval of a project’s with it', async () => {
    const r = await rig({
      user: { mine: { command: 'x' } },
      project: { theirs: { command: 'y' } },
      files: { '.encode/mcp.json': json({ mcpServers: { theirs: { command: 'z' } } }) },
      servers: { mine: listing('echo'), theirs: listing('push') },
    })
    const scope = await r.open()
    await scope.external.ready(signal())
    assert.deepEqual(names(scope), ['mcp__mine__echo'])
    const gone = await act(r, { type: 'remove', name: 'mine' })
    assert.equal(gone.ok, true)
    assert.deepEqual(names(scope), [])
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.home, '.encode', 'mcp.json'), 'utf8')), { mcpServers: {} })

    const project = await act(r, { type: 'remove', name: 'theirs' })
    assert.equal(project.ok, true)
    assert.equal(project.report.servers.length, 0, 'the copy in .mcp.json does not come back')
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.root, '.mcp.json'), 'utf8')).mcpServers, {})
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.root, '.encode', 'mcp.json'), 'utf8')).mcpServers, {})
  })

  it('refuses a server it cannot use, and a file it cannot read, without writing', async () => {
    for (const setup of [{ type: 'stdio', command: '', args: [], env: {} }, { type: 'http', url: 'ftp://x', headers: {} }, { type: 'stdio', command: 'x', args: [], env: { 'BAD NAME': '1' } }, { type: 'stdio', command: 'x', url: 'https://x' }, 'npx']) {
      assert.notEqual(mcpActionProblem({ type: 'add', name: 'x', scope: 'user', setup }), null, JSON.stringify(setup))
    }
    assert.notEqual(mcpActionProblem({ type: 'add', name: 'x', scope: 'local', setup: { type: 'stdio', command: 'x', args: [], env: {} } }), null)
    const r = await rig({ files: { '.mcp.json': '{ "mcpServers": ' } })
    const refused = await act(r, { type: 'add', name: 'x', scope: 'project', setup: { type: 'stdio', command: 'x', args: [], env: {} } })
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.reason, /not valid JSON/)
    assert.equal(await fs.readFile(path.join(r.root, '.mcp.json'), 'utf8'), '{ "mcpServers": ')
  })
})
