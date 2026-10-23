import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { textBlock, userText } from '@encode/providers'
import { createSessionStore, DEFAULT_TITLE, parseLog, type FileSessionStore } from './session-store'
import type { SessionLog } from './session-records'

const stores: FileSessionStore[] = []
const dirs: string[] = []

async function fresh(): Promise<{ store: FileSessionStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-sessions-'))
  dirs.push(dir)
  const store = createSessionStore({ dir, indexDelayMs: 5 })
  stores.push(store)
  return { store, dir }
}

/** The index file once `holds` is true of it (or as it is after five seconds): it is written on a timer, later on a busy machine. */
async function indexWhen<T>(dir: string, holds: (index: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    let index: T | null = null
    try {
      index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as T
    } catch {
      // Not written yet.
    }
    if ((index && holds(index)) || Date.now() > deadline) return index as T
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

/** A user prompt the way the agent writes it: the entry, then the message, under one id. */
async function prompt(log: SessionLog, id: string, text: string): Promise<void> {
  await log.append({ type: 'entry', entry: { id, kind: 'user', text, createdAt: 1 } })
  await log.append({ type: 'message', id, message: userText(text), turnId: id })
}

async function reply(log: SessionLog, turnId: string, text: string): Promise<void> {
  await log.append({ type: 'message', message: { role: 'assistant', content: [textBlock(text)] }, turnId })
}

describe('a session log', () => {
  it('rebuilds the conversation, the transcript and the session state from its records', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work', title: 'Auth' })
    await prompt(log, 'p1', 'add login')
    await reply(log, 'p1', 'done')
    await log.append({ type: 'goal', goal: { text: 'ship', status: 'active', rounds: 1, createdAt: 1, updatedAt: 1 } })
    await log.append({ type: 'todos', todos: [{ id: 't', text: 'x', status: 'pending' }] })
    await log.append({ type: 'plan', plan: { id: 'pl', plan: '1. go' } })
    await log.append({ type: 'title', title: 'Login page' })
    await log.append({ type: 'entry', entry: { id: 'p1', kind: 'user', text: 'add login (edited)', createdAt: 1 } })

    const snapshot = log.snapshot()
    assert.equal(snapshot.title, 'Login page')
    assert.equal(snapshot.messages.length, 2)
    assert.deepEqual(snapshot.entries.map((entry) => entry.text), ['add login (edited)'])
    assert.equal(snapshot.goal?.text, 'ship')
    assert.equal(snapshot.todos.length, 1)
    assert.equal(snapshot.plan?.plan, '1. go')
    await log.close()

    const reopened = (await createSessionStore({ dir }).open(log.id))!
    const again = reopened.snapshot()
    assert.deepEqual(again.messages, snapshot.messages)
    assert.deepEqual(again.entries, snapshot.entries)
    assert.equal(again.title, 'Login page')
    assert.equal(again.lastRecordId, snapshot.lastRecordId)
    await reopened.close()
  })

  it('starts the conversation over at a compaction, and keeps what came after it', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'first')
    await reply(log, 'p1', 'one')
    const kept = log.snapshot().messages.slice(1)
    await log.append({
      type: 'compaction',
      trigger: 'auto',
      summary: 'S',
      removed: 1,
      messages: [{ type: 'message', id: 'c1', at: 1, turnId: 'p1', message: userText('<conversation_summary>S</conversation_summary>') }, ...kept],
    })
    await prompt(log, 'p2', 'second')
    assert.deepEqual(log.snapshot().messages.map((record) => record.id).slice(0, 1), ['c1'])
    assert.equal(log.snapshot().messages.length, 3)
    assert.equal(log.snapshot().entries.length, 2, 'the transcript is not compacted')
  })

  it('skips a torn last line and carries on from a fresh one', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'hello')
    await log.close()
    const file = path.join(dir, `${log.id}.jsonl`)
    await fs.appendFile(file, '{"type":"message","id":"x","at":1,"turn')

    const reopened = (await store.open(log.id))!
    assert.equal(reopened.snapshot().messages.length, 1)
    await reply(reopened, 'p1', 'after the crash')
    await reopened.close()
    const records = parseLog(await fs.readFile(file, 'utf8'))
    assert.equal(records.filter((record) => record.type === 'message').length, 2)
  })

  it('rewinds to a prompt: truncateAfter keeps it, truncateBefore drops it with its entry', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'one')
    await reply(log, 'p1', 'r1')
    await prompt(log, 'p2', 'two')
    await reply(log, 'p2', 'r2')

    await log.truncateBefore('p2')
    assert.deepEqual(log.snapshot().entries.map((entry) => entry.id), ['p1'])
    assert.equal(log.snapshot().messages.length, 2)

    await prompt(log, 'p3', 'three')
    await reply(log, 'p3', 'r3')
    await log.truncateAfter('p3')
    assert.deepEqual(log.snapshot().entries.map((entry) => entry.id), ['p1', 'p3'])
    assert.equal(log.snapshot().messages.length, 3)
    await assert.rejects(log.truncateAfter('nope'), /no record/)
    await log.close()

    const again = (await createSessionStore({ dir }).open(log.id))!
    assert.deepEqual(again.snapshot().entries.map((entry) => entry.id), ['p1', 'p3'])
    assert.equal(again.snapshot().messages.length, 3)
    await again.close()
  })

  it('forks a copy up to a record, with its own id and a link back', async () => {
    const { store } = await fresh()
    const source = await store.create({ root: '/work', title: 'Source' })
    await prompt(source, 'p1', 'one')
    await reply(source, 'p1', 'r1')
    await prompt(source, 'p2', 'two')

    const fork = await store.create({ root: '/work', title: 'Source (fork)', fork: { sessionId: source.id, recordId: 'p1' } })
    assert.notEqual(fork.id, source.id)
    assert.equal(fork.snapshot().header.forkedFrom?.sessionId, source.id)
    assert.deepEqual(fork.snapshot().entries.map((entry) => entry.id), ['p1'])
    assert.equal(fork.snapshot().messages.length, 1)
    await reply(fork, 'p1', 'different')
    assert.equal(source.snapshot().messages.length, 3, 'the source is untouched')

    const whole = await store.create({ root: '/work', fork: { sessionId: source.id } })
    assert.equal(whole.snapshot().messages.length, 3)
  })
})

describe('the session store', () => {
  it('lists newest first, filters by workspace, and survives a missing index', async () => {
    const { store, dir } = await fresh()
    const a = await store.create({ root: '/a', title: 'A' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await store.create({ root: '/b' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await prompt(a, 'p', 'touch a')

    assert.deepEqual((await store.list()).map((entry) => entry.id), [a.id, b.id])
    assert.deepEqual((await store.list({ root: '/b' })).map((entry) => entry.title), [DEFAULT_TITLE])
    await store.dispose()

    await fs.rm(path.join(dir, 'index.json'), { force: true })
    const rebuilt = createSessionStore({ dir })
    stores.push(rebuilt)
    assert.deepEqual((await rebuilt.list()).map((entry) => entry.id).sort(), [a.id, b.id].sort())
  })

  it('removes a session and its file, and refuses ids that are not ids', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/a' })
    await store.remove(log.id)
    assert.equal(await store.open(log.id), undefined)
    assert.deepEqual(await store.list(), [])
    await assert.rejects(fs.stat(path.join(dir, `${log.id}.jsonl`)))
    await assert.rejects(store.open('../escape'), /not a session id/)
  })

  it('returns the same log while one is open', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/a' })
    assert.equal(await store.open(log.id), log)
  })

  it('opens a session again only once its log has finished closing, with everything the old log wrote', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/a' })
    await prompt(log, 'p', 'first')
    // The last write is still queued when the close begins; the reader must see it.
    const late = log.append({ type: 'title', title: 'Late' })
    const closing = log.close()
    const reopened = await store.open(log.id)
    await Promise.all([late, closing])
    assert.ok(reopened && reopened !== log)
    assert.equal(reopened.snapshot().title, 'Late')
    await reopened.append({ type: 'title', title: 'After' })
    assert.equal(reopened.snapshot().title, 'After')
    await assert.rejects(log.append({ type: 'title', title: 'Too late' }), /session log is closed/)
  })

  it('closes a log once, however many ask, and every asker waits for the close', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/a' })
    const first = log.close()
    const second = log.close()
    assert.equal(first, second)
    await Promise.all([first, second])
    const reopened = await store.open(log.id)
    assert.ok(reopened && reopened !== log)
  })

  it('gives everyone who opens a session at the same moment the same log', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/a' })
    await log.close()
    const opened = await Promise.all([store.open(log.id), store.open(log.id), store.open(log.id)])
    assert.ok(opened[0])
    assert.ok(opened.every((each) => each === opened[0]))
  })

  it('writes the index after changes, so a restart lists them without reading every log', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/a' })
    await log.append({ type: 'title', title: 'Renamed' })
    const index = await indexWhen<{ sessions: { title: string }[] }>(dir, (written) => written.sessions[0]?.title === 'Renamed')
    assert.equal(index.sessions[0].title, 'Renamed')
  })
})

describe('marks and summaries', () => {
  it('keeps marks apart from the work: they last, and do not make a session look recently used', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work' })
    assert.deepEqual(log.snapshot().marks, { projectRoot: '/work', pinned: false, archived: false, unread: false })
    const touched = log.snapshot().updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))

    await log.append({ type: 'meta', pinned: true, unread: true })
    assert.deepEqual(log.snapshot().marks, { projectRoot: '/work', pinned: true, archived: false, unread: true })
    assert.equal(log.snapshot().updatedAt, touched)
    await log.append({ type: 'meta', projectRoot: null, archived: true, pinned: false })
    assert.deepEqual(log.snapshot().marks, { projectRoot: null, pinned: false, archived: true, unread: true })
    assert.deepEqual((await store.list({ root: '/work' })).map((entry) => entry.id), [])
    assert.deepEqual((await store.list({ root: null })).map((entry) => entry.id), [log.id])
    await log.close()

    const again = (await createSessionStore({ dir }).open(log.id))!
    assert.deepEqual(again.snapshot().marks, { projectRoot: null, pinned: false, archived: true, unread: true })
    assert.equal(again.snapshot().updatedAt, touched)
    await again.close()
  })

  it('summarizes a session for the sidebar: the start of the last reply and how much was said', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'fix the bug')
    await log.append({ type: 'entry', entry: { id: 'a1', kind: 'assistant', text: 'Done. **The bug** was in `parse.ts`.\n\n```ts\nconst x = 1\n```', createdAt: 2 } })
    const [summary] = await store.list()
    assert.equal(summary.preview, 'Done. The bug was in parse.ts.')
    assert.equal(summary.entryCount, 2)
    assert.equal(summary.projectRoot, '/work')
    assert.equal(summary.pinned, false)
  })

  it('rebuilds an index entry written before summaries existed', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work', title: 'Old' })
    await prompt(log, 'p1', 'hello')
    await store.dispose()
    // The index of an earlier build: no marks, no preview, and newer than the log.
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ sessions: [{ id: log.id, title: 'Old', createdAt: 1, updatedAt: 1, root: '/work' }] }))
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(dir, 'index.json'), later, later)
    const rebuilt = createSessionStore({ dir })
    stores.push(rebuilt)
    const [summary] = await rebuilt.list()
    assert.equal(summary.entryCount, 1)
    assert.equal(summary.projectRoot, '/work')
    assert.equal(summary.pinned, false)
  })
})

describe('background work in the log', () => {
  const info = (status: 'running' | 'done', extra: Record<string, unknown> = {}) => ({ id: 'agent_1', type: 'Explore', description: 'Look around', status, background: true, mode: 'code' as const, startedAt: 1, ...extra })

  it('keeps a subagent\'s messages to itself, and replays them for it after its own compactions', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'look around')
    await log.append({ type: 'agent', agent: info('running') })
    await log.append({ type: 'message', message: userText('BRIEF'), turnId: 'p1', agentId: 'agent_1' })
    await log.append({ type: 'message', message: { role: 'assistant', content: [textBlock('first look')] }, turnId: 'p1', agentId: 'agent_1' })
    await reply(log, 'p1', 'main reply')
    assert.deepEqual(log.snapshot().messages.map((record) => record.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')), ['look around', 'main reply'])
    assert.equal(log.agentMessages('agent_1').length, 2)
    assert.deepEqual(log.agentMessages('agent_2'), [])

    // A compaction of the subagent's starts its conversation over and leaves the main one alone.
    const kept = { type: 'message' as const, id: 'k1', at: 2, message: userText('SUMMARY'), turnId: 'p1', agentId: 'agent_1' }
    await log.append({ type: 'compaction', agentId: 'agent_1', trigger: 'auto', summary: 'SUMMARY', removed: 2, messages: [kept] })
    await log.append({ type: 'message', message: userText('MORE'), turnId: 'p1', agentId: 'agent_1' })
    assert.deepEqual(log.agentMessages('agent_1').map((message) => (message.content[0] as { text: string }).text), ['SUMMARY', 'MORE'])
    assert.equal(log.snapshot().messages.length, 2)
    await log.close()

    const again = (await createSessionStore({ dir }).open(log.id))!
    assert.deepEqual(again.agentMessages('agent_1').map((message) => (message.content[0] as { text: string }).text), ['SUMMARY', 'MORE'])
    await again.close()
  })

  it('keeps the latest record of each subagent and of the wake-up, which do not make a session look used', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/work' })
    const touched = log.snapshot().updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    await log.append({ type: 'agent', agent: info('running') })
    await log.append({ type: 'agent', agent: info('done', { report: 'R', told: false }) })
    await log.append({ type: 'wakeup', wakeup: { at: 5_000, reason: 'check', prompt: 'P' } })
    assert.deepEqual(log.snapshot().agents, [info('done', { report: 'R', told: false })])
    assert.deepEqual(log.snapshot().wakeup, { at: 5_000, reason: 'check', prompt: 'P' })
    assert.equal(log.snapshot().updatedAt, touched)
    assert.equal((await store.list())[0].wakeAt, 5_000)
    const index = await indexWhen<{ sessions: { wakeAt?: number }[] }>(dir, (written) => written.sessions[0]?.wakeAt === 5_000)
    assert.equal(index.sessions[0].wakeAt, 5_000)

    await log.append({ type: 'wakeup', wakeup: null })
    assert.equal(log.snapshot().wakeup, null)
    assert.equal((await store.list())[0].wakeAt, undefined)
  })

  it('drops what a rewind cut: the subagents and the wake-up after the request go with it', async () => {
    const { store } = await fresh()
    const log = await store.create({ root: '/work' })
    await prompt(log, 'p1', 'one')
    await prompt(log, 'p2', 'two')
    await log.append({ type: 'agent', agent: info('running') })
    await log.append({ type: 'message', message: userText('BRIEF'), turnId: 'p2', agentId: 'agent_1' })
    await log.append({ type: 'wakeup', wakeup: { at: 5_000, reason: 'check', prompt: 'P' } })
    await log.truncateBefore('p2')
    assert.deepEqual(log.snapshot().agents, [])
    assert.equal(log.snapshot().wakeup, null)
    assert.deepEqual(log.agentMessages('agent_1'), [])
  })
})
