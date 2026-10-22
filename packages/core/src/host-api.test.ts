import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { createPortPair, Peer, type NoApi } from '@encode/protocol'
import { createHostClient, serveHost, type HostApi, type HostClient } from './host-api'
import { closeHarnesses, hostHarness, type HostHarness } from './testing'
import type { AgentEvent, BackgroundJob } from './ui'

after(closeHarnesses)

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Connected {
  h: HostHarness
  client: HostClient
  caller: Peer<NoApi, HostApi>
  server: Peer<HostApi, NoApi>
  events: AgentEvent[]
  jobs: BackgroundJob[][]
}

/** A host behind a pair of in-memory ports, as the desktop app's main process sees it. */
async function connect(options: Parameters<typeof hostHarness>[0] = {}): Promise<Connected> {
  const [near, far] = createPortPair()
  const server = new Peer<HostApi, NoApi>(far)
  const caller = new Peer<NoApi, HostApi>(near)
  const h = await hostHarness({
    ...options,
    host: { ...options.host, emit: (event) => server.notify('event', event), onJobs: (jobs) => server.notify('jobs', jobs) },
  })
  serveHost(server, h.host)
  const events: AgentEvent[] = []
  const jobs: BackgroundJob[][] = []
  caller.on('event', (event) => events.push(event))
  caller.on('jobs', (list) => jobs.push(list))
  return { h, client: createHostClient(caller), caller, server, events, jobs }
}

describe('the host over a port', () => {
  it('creates a session, runs a turn and streams its events to the caller', async () => {
    const { client, events } = await connect({ script: [{ text: 'Hello over the wire' }] })
    const [first] = await client.sessions()
    assert.equal(first.title, 'New session')
    await client.start(first.id, { text: 'say hello', mode: 'code' })
    const history = await client.history(first.id)
    assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.text]), [['user', 'say hello'], ['assistant', 'Hello over the wire']])
    assert.equal(history.status, 'done')
    await until(() => events.some((event) => event.type === 'done'))
    assert.ok(events.every((event) => event.sessionId === first.id))
    assert.ok(events.some((event) => event.type === 'delta'))
    assert.deepEqual(await client.statuses(), {})
  })

  it('carries an approval round trip with a note and a grant', async () => {
    const { client, events, h } = await connect({
      scriptFor: (root) => [
        { calls: [{ name: 'Write', input: { file_path: path.join(root, '.encode', 'note.md'), content: 'x' } }] },
        { text: 'done' },
      ],
    })
    const session = await client.create()
    const running = client.start(session.id, { text: 'write', mode: 'code' })
    const asked = await until(() => events.find((event) => event.type === 'approval-request'))
    assert.equal(asked.type === 'approval-request' && asked.request.grantable, false)
    assert.equal((await client.history(session.id)).approvals?.length, 1)
    assert.equal(await client.approve(asked.type === 'approval-request' ? asked.request.id : '', { approved: false, note: 'not there' }), true)
    await running
    assert.equal(await client.approve('nobody', true), false)
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /not there/)
  })

  it('stops a turn on request', async () => {
    const { client, events } = await connect({ client: { delayMs: 20 }, script: [{ text: 'one two three four five six seven eight nine ten eleven twelve' }] })
    const session = await client.create()
    const running = client.start(session.id, { text: 'talk', mode: 'code' })
    await until(() => events.some((event) => event.type === 'delta'))
    assert.deepEqual(await client.statuses(), { [session.id]: 'thinking' })
    await client.cancel(session.id)
    await running
    assert.equal((await client.history(session.id)).entries.at(-1)?.text, 'Stopped.')
  })

  it('steers a running turn, and says so when nothing runs to take the message', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ')
    const { client, events } = await connect({ client: { delayMs: 20 }, script: [{ text: long }, { text: 'Steered.' }] })
    const session = await client.create()
    assert.equal(await client.steer(session.id, 'nobody is working'), null)
    const running = client.start(session.id, { text: 'talk', mode: 'code' })
    await until(() => events.some((event) => event.type === 'delta'))
    const chosen = crypto.randomUUID()
    assert.deepEqual(await client.steer(session.id, 'shorter, please', chosen), { id: chosen })
    await running
    const entries = (await client.history(session.id)).entries
    assert.deepEqual(entries.map((entry) => entry.kind), ['user', 'assistant', 'steer', 'assistant'])
    assert.equal(entries[2].id, chosen)
    assert.equal(entries.at(-1)?.text, 'Steered.')
    assert.equal(await client.steer('missing', 'hello'), null)
  })

  it('keeps goals, todos, plans, titles and exports', async () => {
    const { client } = await connect({ script: [{ text: 'ok' }] })
    const session = await client.create({ title: 'Wire' })
    await client.setGoal(session.id, { text: 'Ship', status: 'active', rounds: 0, createdAt: 1, updatedAt: 1 })
    assert.equal((await client.goal(session.id))?.text, 'Ship')
    await client.setTodos(session.id, [{ id: 't', text: 'Do it', status: 'pending' }])
    assert.equal((await client.todos(session.id))[0].text, 'Do it')
    await client.setPlan(session.id, { id: 'p', plan: '1. go' })
    assert.equal((await client.plan(session.id))?.plan, '1. go')
    await client.rename(session.id, 'Renamed')
    assert.equal((await client.sessions()).find((entry) => entry.id === session.id)?.title, 'Renamed')
    await client.start(session.id, { text: 'hi', mode: 'code' })
    assert.match((await client.exportData(session.id)).transcript, /hi/)
    const forked = await client.fork(session.id)
    assert.match(forked.title, /fork/)
    await client.remove(forked.id)
    assert.equal((await client.update(session.id, { pinned: true }))?.pinned, true)
    assert.equal(await client.update('missing', { pinned: true }), null)
  })

  it('refuses requests that do not match their schema', async () => {
    const { caller, h } = await connect({ script: [{ text: 'never' }] })
    const refused = (method: string, params: unknown) =>
      assert.rejects((caller as unknown as { request(method: string, params?: unknown): Promise<unknown> }).request(method, params), { code: 'invalid-params' })
    await refused('start', { sessionId: 's', input: { text: 5, mode: 'code' } })
    await refused('start', { sessionId: 's', input: { text: 'x', mode: 'root' } })
    await refused('start', { input: { text: 'x', mode: 'code' } })
    await refused('update', { sessionId: 's', patch: { pinned: 'yes' } })
    await refused('approve', { requestId: 'r', answer: true })
    await refused('approve', { requestId: 'r', answer: { approved: true, remember: 'forever' } })
    await refused('setGoal', { sessionId: 's', goal: { text: 'x', status: 'done', rounds: 0, createdAt: 1, updatedAt: 1 } })
    await refused('setTodos', { sessionId: 's', todos: [{ id: 't', text: 'x', status: 'later' }] })
    await refused('steer', { sessionId: 's', text: '' })
    await refused('steer', { sessionId: 's' })
    await refused('steer', { sessionId: 's', text: 'x', id: 'turn-1' })
    await refused('setWorkspace', { root: '' })
    await refused('killJob', {})
    await refused('turnChanges', { sessionId: 's', limits: { maxFileBytes: -1 } })
    await refused('turnWrite', { sessionId: 's', write: { file: '/ws/a.ts', expected: 'not-a-hash', next: null } })
    await refused('turnWrite', { sessionId: 's', write: { file: '/ws/a.ts', expected: null, next: { kept: '../../etc' } } })
    await refused('turnWrite', { sessionId: 's', write: { file: '', expected: null, next: null } })
    await assert.rejects((caller as unknown as { request(method: string): Promise<unknown> }).request('dropTables'), { code: 'unknown-method' })
    assert.equal(h.client.requests.length, 0)
  })

  it('carries one request\'s changes and a file write across, bytes and all', async () => {
    const written: Buffer[] = []
    const { client, caller } = await connect({
      script: [{ text: 'ok' }],
      host: {
        scope: () => ({
          checkpoints: {
            info: async () => ({ available: true, turns: [], canUndo: false }),
            plan: async (turn) => ({ kind: 'rewind', turn, known: true, files: [], fingerprint: 'fp' }),
            planRedo: async () => null,
            apply: async () => ({ ok: true, restored: 0, deleted: 0, skipped: [], failed: [] }),
            changes: async () => ({ known: true, files: [{ path: 'a.ts', file: '/ws/a.ts', before: { state: 'missing' }, after: { state: 'bytes', hash: 'h', bytes: Buffer.from('new') }, afterFrom: 'now', changedSince: false }] }),
            write: async (write) => {
              if (write.next && 'bytes' in write.next) written.push(Buffer.from(write.next.bytes))
              return { ok: true, previous: null, written: null }
            },
          },
        }),
      },
    })
    const [session] = await client.sessions()
    await client.start(session.id, { text: 'go', mode: 'code' })
    const user = (await client.history(session.id)).entries.find((entry) => entry.kind === 'user')!
    const changes = await client.turnChanges(session.id, user.id)
    const after = changes.files[0].after
    assert.equal(after.state === 'bytes' && Buffer.from(after.bytes).toString('utf8'), 'new')
    const bytes = new TextEncoder().encode('old').buffer as ArrayBuffer
    assert.deepEqual(await client.turnWrite(session.id, { file: '/ws/a.ts', expected: null, next: { bytes } }), { ok: true, previous: null, written: null })
    assert.deepEqual(written.map((item) => item.toString('utf8')), ['old'])
    // Bytes in any other shape are refused before the record sees them.
    const request = caller as unknown as { request(method: string, params?: unknown): Promise<unknown> }
    await assert.rejects(request.request('turnWrite', { sessionId: session.id, write: { file: '/ws/a.ts', expected: null, next: { bytes: { 0: 1 } } } }), /ArrayBuffer/)
    assert.equal(written.length, 1)
  })

  it('moves the workspace and reports jobs', async () => {
    const { client, jobs, h } = await connect()
    await client.setWorkspace(null)
    await assert.rejects(client.start((await client.sessions())[0].id, { text: 'go', mode: 'code' }), /Open a folder/)
    await client.setWorkspace(h.root)
    assert.deepEqual(await client.jobs(), [])
    assert.equal(await client.jobOutput('nope:bash_1'), '')
    await client.killJob('nope:bash_1')
    assert.equal(jobs.length, 0)
  })

  it('stops answering when asked, and when the port closes', async () => {
    const { h, server, caller } = await connect()
    const [near, far] = createPortPair()
    const second = new Peer<HostApi, NoApi>(far)
    const stop = serveHost(second, h.host)
    const other = createHostClient(new Peer<NoApi, HostApi>(near))
    assert.equal((await other.sessions()).length, 1)
    stop()
    await assert.rejects(other.sessions(), { code: 'unknown-method' })
    server.close()
    await until(() => caller.closed)
    await assert.rejects(createHostClient(caller).sessions(), { code: 'closed' })
  })
})
