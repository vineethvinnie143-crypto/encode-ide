import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { TrustStore } from '@encode/config'
import type { ExternalTool } from './adapter'
import { parseMcpFile, type McpServerEntry, type ServerSetup } from './config'
import { fakeServer, type FakeServer, type FakeServerOptions } from './fake-server'
import { decideServer, McpManager, McpUnavailableError, type McpPolicy, type ServerStatus } from './manager'

const ROOT = '/work/project'
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const entries = (scope: 'user' | 'project', servers: Record<string, unknown>): McpServerEntry[] => {
  const parsed = parseMcpFile(JSON.stringify({ mcpServers: servers }), scope, scope === 'user' ? '/home/u/.encode/mcp.json' : `${ROOT}/.mcp.json`)
  assert.deepEqual(parsed.problems, [])
  return parsed.servers
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `does ${name}`, inputSchema: { type: 'object', properties: {} }, ...extra })

interface Rig {
  manager: McpManager
  registered: Map<string, ExternalTool>
  fakes: Map<string, FakeServer[]>
  statuses: ServerStatus[]
  trust: TrustStore
  clock: { now: number }
  starts: Array<{ name: string; setup: ServerSetup }>
  create(name: string): FakeServer
}

async function rig(options: {
  entries: McpServerEntry[]
  servers?: Record<string, FakeServerOptions | (() => FakeServerOptions | string) | string>
  policy?: Partial<McpPolicy>
  trusted?: boolean
  env?: Record<string, string | undefined>
  concurrency?: number
}): Promise<Rig> {
  let text: string | null = null
  const trust = new TrustStore('/trust.json', { read: async () => text, writeAtomic: async (_file, next) => void (text = next) }, false)
  const registered = new Map<string, ExternalTool>()
  const fakes = new Map<string, FakeServer[]>()
  const statuses: ServerStatus[] = []
  const starts: Rig['starts'] = []
  const clock = { now: 1_000_000 }
  const definitions = options.servers ?? {}
  const create = (name: string, definition: FakeServerOptions = { handle: () => ({ tools: [] }) }): FakeServer => {
    const server = fakeServer(definition)
    fakes.set(name, [...(fakes.get(name) ?? []), server])
    return server
  }
  const manager = new McpManager({
    root: ROOT,
    home: '/home/u',
    entries: options.entries,
    policy: { enableAll: false, enabled: [], disabled: [], ...options.policy },
    trust,
    tools: {
      register(registeredTool) {
        const { name } = registeredTool.definition
        if (registered.has(name)) throw new Error(`A tool called ${name} is already registered.`)
        registered.set(name, registeredTool)
        return () => {
          if (registered.get(name) === registeredTool) registered.delete(name)
        }
      },
    },
    env: options.env ?? {},
    platform: 'linux',
    createTransport(entry, setup) {
      starts.push({ name: entry.name, setup })
      const definition = definitions[entry.name]
      const resolved = typeof definition === 'function' ? definition() : definition
      if (typeof resolved === 'string') return resolved
      return create(entry.name, resolved).transport
    },
    onStatus: (status) => statuses.push(status),
    now: () => clock.now,
    retryBaseMs: 1000,
    connectTimeoutMs: 2000,
    concurrency: options.concurrency,
  })
  if (options.trusted) await trust.trust(ROOT, null)
  return { manager, registered, fakes, statuses, trust, clock, starts, create }
}

const listing = (...names: string[]) => ({ handle: (method: string) => (method === 'tools/list' ? { tools: names.map((n) => tool(n)) } : { content: [{ type: 'text', text: 'ok' }] }) })
const stateOf = (r: Rig, name: string) => r.manager.status().find((s) => s.name === name)!

describe('which servers run', () => {
  it('runs the user’s own servers and registers their tools under mcp__server__tool', async () => {
    const r = await rig({ entries: entries('user', { files: { command: 'x' } }), servers: { files: listing('read', 'list.dir') } })
    await r.manager.start()
    assert.deepEqual([...r.registered.keys()].sort(), ['mcp__files__list_dir', 'mcp__files__read'])
    const status = stateOf(r, 'files')
    assert.equal(status.state, 'connected')
    assert.deepEqual(status.tools.sort(), ['mcp__files__list_dir', 'mcp__files__read'])
    const outcome = await r.registered.get('mcp__files__read')!.run({}, { signal: new AbortController().signal })
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.content[1], { type: 'text', text: 'ok' })
    await r.manager.close()
    assert.equal(r.registered.size, 0)
  })

  it('does not start a project server before the folder is trusted and the server approved', async () => {
    const r = await rig({ entries: entries('project', { risky: { command: 'x', args: ['--do-things'] } }), servers: { risky: listing('go') } })
    await r.manager.start()
    assert.equal(r.starts.length, 0, 'the server was started')
    assert.equal(stateOf(r, 'risky').state, 'needs-approval')
    assert.match(stateOf(r, 'risky').detail!, /not trusted/)
    assert.equal(r.registered.size, 0)

    await r.trust.trust(ROOT, null)
    await r.manager.start()
    assert.equal(r.starts.length, 0, 'trusting the folder is not approving the server')
    assert.match(stateOf(r, 'risky').detail!, /asks to run an MCP server/)
  })

  it('starts a project server once the user approves exactly what the card showed', async () => {
    const r = await rig({ entries: entries('project', { risky: { command: 'x' } }), servers: { risky: listing('go') }, trusted: true })
    await r.manager.start()
    const { digest, summary } = stateOf(r, 'risky')
    assert.equal(summary, 'x')
    await assert.rejects(r.manager.approve('risky', 'a-digest-of-something-else'), /changed after the approval card/)
    assert.equal(r.starts.length, 0)
    await r.manager.approve('risky', digest)
    assert.equal(stateOf(r, 'risky').state, 'connected')
    assert.deepEqual([...r.registered.keys()], ['mcp__risky__go'])
    assert.equal(await r.trust.serverApproved(ROOT, 'risky', digest), true)
  })

  it('refuses to approve in a folder that is not trusted, and for a server that is the user’s', async () => {
    const r = await rig({ entries: [...entries('project', { p: { command: 'x' } }), ...entries('user', { u: { command: 'y' } })], servers: { p: listing(), u: listing() } })
    await r.manager.start()
    await assert.rejects(r.manager.approve('p', stateOf(r, 'p').digest), /Trust this folder first/)
    await assert.rejects(r.manager.approve('u', stateOf(r, 'u').digest), /needs no approval/)
    await assert.rejects(r.manager.approve('nope', 'x'), /no MCP server called nope/)
  })

  it('turns off a server whose setup changed, until the new setup is approved', async () => {
    const original = entries('project', { risky: { command: 'x' } })
    const r = await rig({ entries: original, servers: { risky: listing('go') }, trusted: true })
    await r.manager.start()
    await r.manager.approve('risky', original[0].digest)
    assert.equal(r.registered.size, 1)

    const changed = entries('project', { risky: { command: 'x', args: ['--steal-everything'] } })
    await r.manager.update(changed, { enableAll: false, enabled: [], disabled: [] })
    assert.equal(stateOf(r, 'risky').state, 'needs-approval')
    assert.match(stateOf(r, 'risky').detail!, /changed since you approved/)
    assert.equal(r.registered.size, 0, 'its tools are gone')
    assert.equal(r.fakes.get('risky')![0].transport.closed, true, 'the running server was stopped')
    await assert.rejects(r.registered.get('mcp__risky__go')?.run({}, { signal: new AbortController().signal }) ?? Promise.reject(new Error('no tool')), /no tool/)

    await r.manager.approve('risky', changed[0].digest)
    assert.equal(stateOf(r, 'risky').state, 'connected')
    assert.equal(r.fakes.get('risky')!.length, 2)
  })

  it('lets settings enable project servers, and always lets them disable any server', async () => {
    const project = entries('project', { a: { command: 'x' }, b: { command: 'y' } })
    const user = entries('user', { mine: { command: 'z' } })
    const r = await rig({ entries: [...project, ...user], servers: { a: listing('t'), b: listing('t'), mine: listing('t') }, trusted: true, policy: { enabled: ['a'], disabled: ['mine'] } })
    await r.manager.start()
    assert.deepEqual(r.manager.status().map((s) => [s.name, s.state]), [['a', 'connected'], ['b', 'needs-approval'], ['mine', 'disabled']])

    const all = await rig({ entries: project, servers: { a: listing('t'), b: listing('t') }, trusted: true, policy: { enableAll: true } })
    await all.manager.start()
    assert.deepEqual(all.manager.status().map((s) => s.state), ['connected', 'connected'])

    const untrusted = await rig({ entries: project, servers: { a: listing('t'), b: listing('t') }, policy: { enableAll: true } })
    await untrusted.manager.start()
    assert.deepEqual(untrusted.manager.status().map((s) => s.state), ['needs-approval', 'needs-approval'])
    assert.equal(untrusted.starts.length, 0)
  })

  it('does not let a stale entry through: an update that removes a server stops it', async () => {
    const r = await rig({ entries: entries('user', { a: { command: 'x' }, b: { command: 'y' } }), servers: { a: listing('ta'), b: listing('tb') } })
    await r.manager.start()
    assert.equal(r.registered.size, 2)
    await r.manager.update(entries('user', { a: { command: 'x' } }), { enableAll: false, enabled: [], disabled: [] })
    assert.deepEqual([...r.registered.keys()], ['mcp__a__ta'])
    assert.deepEqual(r.manager.status().map((s) => s.name), ['a'])
    assert.equal(r.fakes.get('b')![0].transport.closed, true)
  })
})

describe('starting', () => {
  it('fills in variables when it starts, not when it reads the file', async () => {
    const r = await rig({
      entries: entries('user', { s: { command: '${BIN:-tool}', args: ['--token=${TOKEN}'] } }),
      servers: { s: listing() },
      env: { TOKEN: 'abc' },
    })
    await r.manager.start()
    assert.deepEqual(r.starts[0].setup, { type: 'stdio', command: 'tool', args: ['--token=abc'], env: {} })
    assert.equal(stateOf(r, 's').summary, '${BIN:-tool} --token=${TOKEN}')
    assert.ok(!JSON.stringify(r.manager.status()).includes('abc'), 'the value of a variable was shown')
  })

  it('says why a server could not start: a variable that is not set, a program that is not there, a handshake that failed', async () => {
    const r = await rig({
      entries: entries('user', { novar: { command: 'x', env: { K: '${MISSING}' } }, noprog: { command: 'nothing' }, badshake: { command: 'y' } }),
      servers: { noprog: 'Cannot start noprog: the program "nothing" was not found.', badshake: { protocolVersion: '2019-01-01' } },
    })
    await r.manager.start()
    const by = Object.fromEntries(r.manager.status().map((s) => [s.name, s]))
    assert.equal(by.novar.state, 'failed')
    assert.match(by.novar.detail!, /MISSING is not set/)
    assert.match(by.noprog.detail!, /was not found/)
    assert.equal(by.badshake.state, 'failed')
    assert.match(by.badshake.detail!, /Could not start badshake: .*2019-01-01/)
    assert.equal(r.registered.size, 0)
  })

  it('starts several servers at once, but not more than asked', async () => {
    let running = 0
    let peak = 0
    const slow = (): FakeServerOptions => ({
      initialize: async () => {
        peak = Math.max(peak, ++running)
        await wait(20)
        running--
        return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } }
      },
      handle: () => ({ tools: [] }),
    })
    const many = entries('user', Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, { command: 'x' }])))
    const servers = Object.fromEntries(many.map((e) => [e.name, slow]))
    const r = await rig({ entries: many, servers, concurrency: 2 })
    await r.manager.start()
    assert.equal(peak, 2)
    assert.ok(r.manager.status().every((s) => s.state === 'connected'))
  })

  it('keeps tools of different servers apart, and tools whose names collapse to one', async () => {
    const r = await rig({
      entries: entries('user', { a: { command: 'x' }, b: { command: 'y' } }),
      servers: { a: listing('same', 'x.y', 'x_y'), b: listing('same') },
    })
    await r.manager.start()
    const names = [...r.registered.keys()]
    for (const expected of ['mcp__a__same', 'mcp__a__x_y', 'mcp__b__same']) assert.ok(names.includes(expected), `${expected} is missing from ${names.join(', ')}`)
    assert.ok(names.some((name) => /^mcp__a__x_y_[0-9a-f]{6}$/.test(name)), 'the third tool of a keeps a name of its own')
    assert.equal(r.registered.size, 4)
    assert.equal(new Set(r.registered.keys()).size, 4)
    for (const name of r.registered.keys()) assert.match(name, /^mcp__[a-z]+__[A-Za-z0-9_-]+$/)
  })
})

describe('when a server goes away', () => {
  it('keeps its tools listed, tells the model why a call failed, and starts it again after a pause', async () => {
    const r = await rig({ entries: entries('user', { s: { command: 'x' } }), servers: { s: listing('go') } })
    await r.manager.start()
    const go = r.registered.get('mcp__s__go')!
    const run = () => go.run({}, { signal: new AbortController().signal })
    assert.equal((await run()).ok, true)

    await r.fakes.get('s')![0].transport.peer.close()
    await wait(10)
    assert.equal(stateOf(r, 's').state, 'failed')
    assert.ok(r.registered.has('mcp__s__go'), 'the tool list does not change under the model')

    const early = await run()
    assert.equal(early.ok, false)
    assert.match((early.content[0] as { text: string }).text, /go failed: s is not running: .* It will be tried again in 1 s\./)
    assert.equal(r.starts.length, 1, 'no new start before the pause is over')

    r.clock.now += 1500
    const later = await run()
    assert.equal(later.ok, true)
    assert.equal(r.starts.length, 2)
    assert.equal(stateOf(r, 's').state, 'connected')
  })

  it('pauses longer after each failure, and a good start resets it', async () => {
    let attempts = 0
    const r = await rig({
      entries: entries('user', { s: { command: 'x' } }),
      servers: { s: () => (++attempts <= 3 ? 'Cannot start s: no.' : listing('go')) },
    })
    await r.manager.start()
    const call = () => r.manager.callTool('s', 'go', {}, { signal: new AbortController().signal }).then(() => 'ok', (error: Error) => error.message)
    assert.match(await call(), /tried again in 1 s/)
    r.clock.now += 1001
    assert.match(await call(), /^Cannot start s/)
    assert.match(await call(), /tried again in 2 s/)
    r.clock.now += 1500
    assert.match(await call(), /tried again in 1 s/)
    r.clock.now += 600
    assert.match(await call(), /^Cannot start s/)
    assert.match(await call(), /tried again in 4 s/)
    assert.equal(r.starts.length, 3)
    r.clock.now += 4001
    assert.equal(await call(), 'ok')
    assert.equal(stateOf(r, 's').state, 'connected')

    // The server dies again: the pause starts from the beginning, not from where it had grown to.
    await r.fakes.get('s')![0].transport.peer.close()
    await wait(10)
    assert.match(await call(), /tried again in 1 s/)
  })

  it('does not start a server again that is no longer allowed to run', async () => {
    const original = entries('project', { p: { command: 'x' } })
    const r = await rig({ entries: original, servers: { p: listing('go') }, trusted: true })
    await r.manager.start()
    await r.manager.approve('p', original[0].digest)
    await r.fakes.get('p')![0].transport.peer.close()
    await wait(10)
    await r.trust.revoke(ROOT)
    r.clock.now += 5000
    await assert.rejects(r.manager.callTool('p', 'go', {}, { signal: new AbortController().signal }), (error: Error) => error instanceof McpUnavailableError && /not running/.test(error.message))
    assert.equal(r.starts.length, 1)
    assert.equal(stateOf(r, 'p').state, 'needs-approval')
  })
})

describe('what a server offers', () => {
  it('follows the server when its tool list changes', async () => {
    let tools = ['one', 'two']
    const r = await rig({
      entries: entries('user', { s: { command: 'x' } }),
      servers: { s: () => ({ capabilities: { tools: { listChanged: true } }, handle: () => ({ tools: tools.map((n) => tool(n)) }) }) },
    })
    await r.manager.start()
    assert.deepEqual([...r.registered.keys()].sort(), ['mcp__s__one', 'mcp__s__two'])
    tools = ['two', 'three']
    await r.fakes.get('s')![0].connection.notify('notifications/tools/list_changed')
    await wait(350)
    assert.deepEqual([...r.registered.keys()].sort(), ['mcp__s__three', 'mcp__s__two'])
    assert.deepEqual(stateOf(r, 's').tools.sort(), ['mcp__s__three', 'mcp__s__two'])
  })

  it('registers the resource tools while some server offers resources, and drops them with the last one', async () => {
    const r = await rig({
      entries: entries('user', { docs: { command: 'x' }, plain: { command: 'y' } }),
      servers: {
        docs: { capabilities: { tools: {}, resources: {} }, handle: (method) => (method === 'tools/list' ? { tools: [] } : method === 'resources/list' ? { resources: [{ uri: 'docs://a', name: 'A' }] } : { resourceTemplates: [] }) },
        plain: listing('t'),
      },
    })
    await r.manager.start()
    assert.ok(r.registered.has('ListMcpResources') && r.registered.has('ReadMcpResource'))
    assert.equal(stateOf(r, 'docs').resources, 1)
    const listed = await r.registered.get('ListMcpResources')!.run({}, { signal: new AbortController().signal })
    assert.match((listed.content[1] as { text: string }).text, /docs: docs:\/\/a {2}A/)
    await r.manager.update(entries('user', { plain: { command: 'y' } }), { enableAll: false, enabled: [], disabled: [] })
    assert.ok(!r.registered.has('ListMcpResources'))
  })

  it('shows a server’s instructions only while it is connected', async () => {
    const r = await rig({ entries: entries('user', { s: { command: 'x' } }), servers: { s: { instructions: 'Prefer the search tool.', handle: () => ({ tools: [] }) } } })
    await r.manager.start()
    assert.deepEqual(r.manager.instructions(), [{ server: 's', text: 'Prefer the search tool.' }])
    assert.equal(stateOf(r, 's').hasInstructions, true)
    await r.manager.close()
    assert.deepEqual(r.manager.instructions(), [])
  })

  it('shows what approving would run, and the names of what it would pass on, never the values', async () => {
    const r = await rig({
      entries: entries('project', {
        a: { command: 'npx', args: ['-y', '@acme/server', 'has space'], env: { API_KEY: 'literal-secret' } },
        b: { type: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: 'Bearer literal-secret' } },
      }),
    })
    const [a, b] = r.manager.status()
    assert.equal(a.summary, 'npx -y @acme/server "has space"')
    assert.deepEqual(a.envNames, ['API_KEY'])
    assert.equal(b.summary, 'https://x.example.com/mcp')
    assert.deepEqual(b.headerNames, ['Authorization'])
    assert.ok(!JSON.stringify([a, b]).includes('literal-secret'))
  })
})

describe('closing', () => {
  it('stops every server, removes every tool, and can be asked twice', async () => {
    const r = await rig({ entries: entries('user', { a: { command: 'x' }, b: { command: 'y' } }), servers: { a: listing('t'), b: listing('t') } })
    await r.manager.start()
    await r.manager.close()
    await r.manager.close()
    assert.equal(r.registered.size, 0)
    assert.ok([...r.fakes.values()].flat().every((f) => f.transport.closed))
  })
})

describe('with a real program', () => {
  const SERVER = String.raw`
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'real', version: '1' } } })
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'env', description: 'Shows its environment', inputSchema: { type: 'object' } }] } })
  else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, env: process.env }) }] } })
})
`

  it('finds the program, starts it with the variables it was given and no others, and stops it on close', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'encode-mcp-manager-'))
    try {
      const script = path.join(dir, 'server.cjs')
      await writeFile(script, SERVER)
      const registered = new Map<string, ExternalTool>()
      const trust = new TrustStore(path.join(dir, 'trust.json'), { read: async () => null, writeAtomic: async () => {} }, false)
      const manager = new McpManager({
        root: dir,
        home: dir,
        entries: entries('user', { real: { command: process.execPath, args: [script], env: { GREETING: '${GREETING}' } } }),
        policy: { enableAll: false, enabled: [], disabled: [] },
        trust,
        tools: { register: (tool) => (registered.set(tool.definition.name, tool), () => registered.delete(tool.definition.name)) },
        env: { ...process.env, GREETING: 'hello', ENCODE_TEST_SECRET: 'do-not-leak' },
      })
      await manager.start()
      assert.equal(manager.status()[0].state, 'connected', manager.status()[0].detail ?? '')
      const outcome = await registered.get('mcp__real__env')!.run({}, { signal: new AbortController().signal })
      const text = (outcome.content[1] as { text: string }).text
      const seen = JSON.parse(text) as { pid: number; env: Record<string, string> }
      assert.equal(seen.env.GREETING, 'hello')
      assert.equal(seen.env.ENCODE_TEST_SECRET, undefined)
      await manager.close()
      await wait(100)
      assert.throws(() => process.kill(seen.pid, 0), 'the program is still running after close')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('says so when the program is not there', async () => {
    const registered = new Map<string, ExternalTool>()
    const manager = new McpManager({
      root: os.tmpdir(),
      home: os.tmpdir(),
      entries: entries('user', { ghost: { command: 'definitely-not-installed-anywhere' } }),
      policy: { enableAll: false, enabled: [], disabled: [] },
      trust: new TrustStore('/t.json', { read: async () => null, writeAtomic: async () => {} }, false),
      tools: { register: (tool) => (registered.set(tool.definition.name, tool), () => {}) },
      env: process.env,
    })
    await manager.start()
    const status = manager.status()[0]
    assert.equal(status.state, 'failed')
    assert.match(status.detail!, /"definitely-not-installed-anywhere" was not found/)
    assert.equal(registered.size, 0)
  })
})

describe('decideServer', () => {
  const none: McpPolicy = { enableAll: false, enabled: [], disabled: [] }
  const [project] = entries('project', { risky: { command: 'x' } })
  const [mine] = entries('user', { mine: { command: 'y' } })

  it('lets the person’s own servers run unless the settings turn them off', () => {
    assert.deepEqual(decideServer(mine, none, { trusted: false }), { run: true })
    const off = decideServer(mine, { ...none, disabled: ['mine'] }, { trusted: true })
    assert.equal(off.run, false)
    assert.equal(off.run ? '' : off.state, 'disabled')
  })

  it('waits for trust, then for the approval of exactly this setup, unless the settings enable it', () => {
    const untrusted = decideServer(project, none, { trusted: false })
    assert.equal(untrusted.run ? '' : untrusted.state, 'needs-approval')
    assert.match(untrusted.run ? '' : untrusted.detail, /not trusted/)
    const trusted = decideServer(project, none, { trusted: true })
    assert.match(trusted.run ? '' : trusted.detail, /asks to run an MCP server/)
    assert.deepEqual(decideServer(project, none, { trusted: true, mcpServers: { risky: project.digest } }), { run: true })
    const stale = decideServer(project, none, { trusted: true, mcpServers: { risky: 'an-older-digest' } })
    assert.match(stale.run ? '' : stale.detail, /changed since you approved/)
    assert.deepEqual(decideServer(project, { ...none, enableAll: true }, { trusted: true }), { run: true })
    assert.deepEqual(decideServer(project, { ...none, enabled: ['risky'] }, { trusted: true }), { run: true })
    assert.equal(decideServer(project, { ...none, enableAll: true }, { trusted: false }).run, false, 'trust comes first')
    assert.equal(decideServer(project, { ...none, enableAll: true, disabled: ['risky'] }, { trusted: true }).run, false, 'off wins over enabled')
  })

  it('does not read an approval off the prototype', () => {
    const [odd] = entries('project', { constructor_: { command: 'x' } })
    const decision = decideServer({ ...odd, name: 'constructor' }, none, { trusted: true, mcpServers: {} })
    assert.equal(decision.run, false)
  })
})
