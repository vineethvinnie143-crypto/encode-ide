import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createScriptedClient, type AgentEvent } from '@encode/core'
import { stubManagedShell } from '@encode/core/testing'
import { createPortPair } from '@encode/protocol'
import { tempWorkspace } from '@encode/tools/testing'
import type { HostConfig } from './api'
import { runHostRuntime, type HostRuntime } from './runtime'
import { AgentHostService, HOST_STOPPED_MESSAGE, type HostProcess } from './service'

const config: HostConfig = {
  policy: 'workspace-write',
  maxSteps: 30,
  maxGoalRounds: 8,
  contextCap: 200_000,
  computer: false,
  languageServers: false,
  errorGate: 'auto',
  guide: 'auto',
  checkGate: 'auto',
  reviewWork: 'auto',
  askAgain: 'on',
  learnConventions: 'on',
  lightSteps: 'off',
  helpSmaller: 'auto',
  offerStronger: 'ask',
  model: 'none',
  router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } },
  providers: {},
  searchProvider: 'duckduckgo',
}

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Fixture {
  service: AgentHostService
  events: AgentEvent[]
  /** Every process started, newest last. */
  processes: { runtime: HostRuntime; kill(): void; killed: boolean; exit(): void }[]
  keysAsked: string[]
  searchKeysAsked: string[]
  dir: string
  workspace: string
}

const services: AgentHostService[] = []
after(async () => {
  for (const service of services.splice(0)) await service.dispose()
})

async function fixture(options: { script?: Parameters<typeof createScriptedClient>[0]; spawnFails?: () => boolean; maxFailures?: number } = {}): Promise<Fixture> {
  const dir = await tempWorkspace()
  const home = await tempWorkspace()
  const workspace = await tempWorkspace()
  const events: AgentEvent[] = []
  const processes: Fixture['processes'] = []
  const keysAsked: string[] = []
  const searchKeysAsked: string[] = []
  const client = createScriptedClient(options.script ?? [{ text: 'ok' }], { delayMs: 15 })
  const service = new AgentHostService({
    spawn(): HostProcess {
      const [mainSide, hostSide] = createPortPair()
      let onExit: () => void = () => undefined
      const record = {
        runtime: undefined as unknown as HostRuntime,
        killed: false,
        kill() {
          if (record.killed) return
          record.killed = true
          mainSide.close?.()
          hostSide.close?.()
          onExit()
        },
        exit() {
          record.kill()
        },
      }
      // A process that dies as soon as it starts, or one that runs the host.
      if (options.spawnFails?.()) setImmediate(() => record.kill())
      else record.runtime = runHostRuntime(hostSide, { hostOptions: { client, createShell: stubManagedShell, goalDelayMs: 0 }, log: () => undefined, onShutdown: () => record.exit() })
      processes.push(record)
      return { port: mainSide, kill: record.kill, onExit: (handler) => (onExit = handler) }
    },
    init: () => ({ dir, home, workspace, legacySessionsFile: undefined }),
    apiKey: (profileId, baseUrl) => {
      keysAsked.push(`${profileId} ${baseUrl}`)
      return baseUrl.startsWith('http://127.0.0.1') ? `key-for-${profileId}` : ''
    },
    searchKey: (provider) => {
      searchKeysAsked.push(provider)
      return provider === 'brave' ? 'brave-key' : ''
    },
    onEvent: (event) => events.push(event),
    onJobs: () => undefined,
    log: () => undefined,
    restartDelayMs: 5,
    maxRestartDelayMs: 20,
    ...(options.maxFailures ? { maxFailures: options.maxFailures } : {}),
  })
  services.push(service)
  return { service, events, processes, keysAsked, searchKeysAsked, dir, workspace }
}

describe('the agent host service', () => {
  it('starts the host on first use, and runs a turn through it', async () => {
    const f = await fixture({ script: [{ text: 'Hello from the host' }] })
    assert.equal(f.processes.length, 0)
    const [session] = await f.service.client.sessions()
    assert.equal(f.processes.length, 1)
    await f.service.client.start(session.id, { text: 'hi', mode: 'code' })
    const history = await f.service.client.history(session.id)
    assert.deepEqual(history.entries.map((entry) => entry.text), ['hi', 'Hello from the host'])
    assert.ok(f.events.some((event) => event.type === 'done'))
    assert.equal(f.processes.length, 1)
  })

  it('gives the host its configuration at start, and a change while it runs', async () => {
    const f = await fixture()
    f.service.configure({ ...config, maxGoalRounds: 3 })
    await f.service.start()
    f.service.configure({ ...config, maxGoalRounds: 2, policy: 'read-only' })
    await until(() => (f.processes[0].runtime.host() as unknown as { o: { settings(): { maxGoalRounds: number; policy: string } } }).o.settings().maxGoalRounds === 2)
    assert.equal((f.processes[0].runtime.host() as unknown as { o: { settings(): { policy: string } } }).o.settings().policy, 'read-only')
  })

  it('tells the user which sessions a dying host was working in, and starts it again', async () => {
    const f = await fixture({ script: [{ text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen' }] })
    const [session] = await f.service.client.sessions()
    const running = f.service.client.start(session.id, { text: 'talk', mode: 'code' })
    running.catch(() => undefined)
    // The model is answering, so the user's message is on disk: the restart can bring it back.
    await until(() => f.events.some((event) => event.type === 'delta'))
    f.processes[0].kill()
    await assert.rejects(running, { code: 'closed' })

    const errors = f.events.filter((event) => event.type === 'error')
    assert.deepEqual(errors.map((event) => event.type === 'error' && event.message), [HOST_STOPPED_MESSAGE])
    assert.equal(f.events.at(-1)?.type === 'status' && f.events.at(-1)?.type === 'status' && (f.events.at(-1) as { status: string }).status, 'error')

    // The restart brings the sessions back from their logs.
    await until(() => f.processes.length === 2 && f.processes[1].runtime?.host())
    const again = await f.service.client.history(session.id)
    assert.equal(again.entries[0].text, 'talk')
  })

  it('gives up after repeated failures, and tries once more when asked again', async () => {
    let failing = true
    const f = await fixture({ spawnFails: () => failing, maxFailures: 3 })
    await assert.rejects(f.service.client.sessions())
    await until(() => f.processes.length >= 1)
    // Each process that never answers is killed by the failed start, and the restarts back off.
    await until(() => f.processes.length >= 3, 2_000)
    const count = f.processes.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(f.processes.length, count, 'it stopped trying')

    failing = false
    const sessions = await f.service.client.sessions()
    assert.equal(sessions.length, 1)
  })

  it('answers the host\'s requests for keys, and for nothing else', async () => {
    const f = await fixture()
    await f.service.start()
    const peer = f.processes[0].runtime.peer
    assert.equal(await peer.request('key', { profileId: 'p1', baseUrl: 'http://127.0.0.1:9/v1' }), 'key-for-p1')
    // A key goes only to the server it was entered for: the main process decides, and says nothing otherwise.
    assert.equal(await peer.request('key', { profileId: 'p1', baseUrl: 'https://elsewhere.example/v1' }), '')
    assert.deepEqual(f.keysAsked, ['p1 http://127.0.0.1:9/v1', 'p1 https://elsewhere.example/v1'])
    // The host is another process: a request that is not shaped as agreed never reaches the key vault.
    await assert.rejects((peer as unknown as { request(method: string, params: unknown): Promise<unknown> }).request('key', { profileId: 'p1' }), { code: 'invalid-params' })
    await assert.rejects((peer as unknown as { request(method: string, params: unknown): Promise<unknown> }).request('key', { profileId: 'p1', baseUrl: 'x', extra: 1 }), { code: 'invalid-params' })
    assert.equal(f.keysAsked.length, 2)
    await assert.rejects((peer as unknown as { request(method: string): Promise<unknown> }).request('cancelEverything'), { code: 'unknown-method' })
  })

  it('answers the host\'s request for a search key only for a provider that has one, and only as agreed', async () => {
    const f = await fixture()
    await f.service.start()
    const peer = f.processes[0].runtime.peer
    assert.equal(await peer.request('searchKey', { provider: 'brave' }), 'brave-key')
    assert.equal(await peer.request('searchKey', { provider: 'exa' }), '')
    const raw = peer as unknown as { request(method: string, params: unknown): Promise<unknown> }
    // DuckDuckGo has no key, a profile id is not a provider, and nothing else rides along: none of these reaches the vault.
    await assert.rejects(raw.request('searchKey', { provider: 'duckduckgo' }), { code: 'invalid-params' })
    await assert.rejects(raw.request('searchKey', { provider: 'search:brave' }), { code: 'invalid-params' })
    await assert.rejects(raw.request('searchKey', { provider: 'brave', baseUrl: 'https://elsewhere.example' }), { code: 'invalid-params' })
    await assert.rejects(raw.request('searchKey', {}), { code: 'invalid-params' })
    assert.deepEqual(f.searchKeysAsked, ['brave', 'exa'])
  })

  it('shows the host the files the editor has open, again after a restart, and only those of the open folder', async () => {
    const f = await fixture()
    const seen: string[] = []
    const watch = async () => {
      const started = f.service.start()
      f.processes.at(-1)!.runtime.peer.on('document', (event) => seen.push(`${event.kind} ${event.root === f.workspace ? 'here' : event.root} ${event.path}${'text' in event ? ` ${event.text}${event.dirty ? '*' : ''}` : ''}`))
      await started
    }
    f.service.document({ kind: 'open', root: f.workspace, path: 'a.ts', text: 'one', dirty: false })
    await watch()
    f.service.document({ kind: 'change', root: f.workspace, path: 'b.ts', text: 'never opened', dirty: true })
    f.service.document({ kind: 'change', root: f.workspace, path: 'a.ts', text: 'two', dirty: true })
    await until(() => seen.length === 2)
    assert.deepEqual(seen.splice(0), ['open here a.ts one', 'change here a.ts two*'])

    f.processes.at(-1)!.exit()
    await until(() => f.processes.at(-1)!.killed)
    await watch()
    await until(() => seen.length === 1)
    assert.deepEqual(seen.splice(0), ['open here a.ts two*'], 'a host that starts again is shown what the editor holds')

    f.service.document({ kind: 'open', root: '/elsewhere', path: 'c.ts', text: 'three', dirty: false })
    f.service.closeDocuments()
    await until(() => seen.length === 3)
    assert.deepEqual(seen, ['close here a.ts', 'open /elsewhere c.ts three', 'close /elsewhere c.ts'])
  })

  it('starts another host when asked, after closing the one that runs, and counts no failure', async () => {
    const f = await fixture({ script: [{ text: 'done' }] })
    await f.service.start()
    await f.service.restart()
    assert.equal(f.processes.length, 2)
    assert.equal(f.processes[0].killed, true)
    assert.equal(f.processes[0].runtime.host(), undefined, 'the first host was shut down, not only ended')
    assert.equal(f.processes[1].killed, false)
    assert.ok(Array.isArray(await f.service.client.sessions()))
    assert.deepEqual(f.service.health(), { running: true, failures: 0, working: 0 })
    assert.ok(!f.events.some((event) => event.type === 'error'), 'nothing was reported as stopped')
  })

  it('shuts the host down in order', async () => {
    const f = await fixture({ script: [{ text: 'done' }] })
    const [session] = await f.service.client.sessions()
    await f.service.client.start(session.id, { text: 'go', mode: 'code' })
    await f.service.dispose()
    assert.equal(f.processes[0].killed, true)
    assert.equal(f.processes[0].runtime.host(), undefined)
    await assert.rejects(f.service.client.sessions(), /closing/)
    assert.equal(f.processes.length, 1, 'no restart after dispose')
  })
})
