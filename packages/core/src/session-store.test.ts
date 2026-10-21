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

  it('writes the index after changes, so a restart lists them without reading every log', async () => {
    const { store, dir } = await fresh()
    const log = await store.create({ root: '/a' })
    await log.append({ type: 'title', title: 'Renamed' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as { sessions: { title: string }[] }
    assert.equal(index.sessions[0].title, 'Renamed')
  })
})
