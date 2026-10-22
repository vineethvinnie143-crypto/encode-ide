import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { messageText } from '@encode/providers'
import { tempWorkspace } from '@encode/tools/testing'
import { summarizeEntries } from './migrate'
import { closeHarnesses, hostHarness } from './testing'
import type { ConversationEntry } from './ui'

after(closeHarnesses)

const entries: ConversationEntry[] = [
  { id: 'u1', kind: 'user', text: 'add a login page', createdAt: 1 },
  { id: 'a1', kind: 'assistant', text: 'I will start with the form.', createdAt: 2 },
  { id: 't1', kind: 'tool', createdAt: 3, tool: { name: 'write_file', input: { path: 'src/login.tsx' }, state: 'done', ok: true } },
  { id: 't2', kind: 'tool', createdAt: 4, tool: { name: 'run_command', input: { command: 'pnpm test' }, state: 'done', ok: false } },
]

async function legacyFile(sessions: unknown[]): Promise<string> {
  const dir = await tempWorkspace()
  const file = path.join(dir, 'sessions.json')
  await fs.writeFile(file, JSON.stringify({ sessions }))
  return file
}

describe('importing sessions from an earlier build', () => {
  it('summarizes what was said, one line per request, reply and tool call', () => {
    assert.equal(
      summarizeEntries(entries),
      ['User: add a login page', 'You: I will start with the form.', 'Tool write_file src/login.tsx', 'Tool run_command pnpm test (failed)'].join('\n'),
    )
    assert.equal(summarizeEntries([]), '')
    assert.ok(summarizeEntries(Array.from({ length: 400 }, (_, i) => ({ id: `u${i}`, kind: 'user' as const, text: `request number ${i} `.repeat(10), createdAt: i }))).startsWith('…'))
  })

  it('brings the sessions in with their transcript, marks, goal and a summary for the model', async () => {
    const legacy = [
      { id: 'old-1', title: 'Login page', createdAt: 1000, updatedAt: 5000, entries, pinned: true, goal: { text: 'Ship', status: 'active', rounds: 1, createdAt: 1, updatedAt: 1 }, todos: [{ id: 't', text: 'x', status: 'pending' }] },
      { id: 'old-2', title: '', entries: [], projectRoot: null },
      { id: '../escape', entries: [] },
      { id: 'dup', entries: [] },
      null,
    ]
    const file = await legacyFile(legacy)
    const h = await hostHarness()
    // One of them already exists in the store and must not be imported twice.
    await h.host.importLegacySessions(await legacyFile([{ id: 'dup', title: 'First time', entries: [] }]))
    assert.equal(await h.host.importLegacySessions(file), 2)

    const sessions = await h.host.sessions()
    assert.deepEqual(sessions.map((session) => session.id).sort(), ['dup', 'old-1', 'old-2'])
    const imported = sessions.find((session) => session.id === 'old-1')!
    assert.equal(imported.title, 'Login page')
    assert.equal(imported.pinned, true)
    assert.equal(imported.projectRoot, null)
    assert.equal(imported.entryCount, 4)
    assert.equal(imported.updatedAt, 5000)

    const history = await h.host.history('old-1')
    assert.deepEqual(history.entries.map((entry) => entry.kind), ['user', 'assistant', 'tool', 'tool'])
    assert.equal((await h.host.goal('old-1'))?.text, 'Ship')
    assert.equal((await h.host.todos('old-1')).length, 1)

    // The model hears the earlier conversation as a summary when the user carries on.
    const scripted = await hostHarness({ script: [{ text: 'continuing' }] })
    await scripted.host.importLegacySessions(await legacyFile(legacy))
    await scripted.host.start('old-1', { text: 'now add logout', mode: 'code' })
    const sent = scripted.client.requests[0].payload.messages.map(messageText).join('\n')
    assert.match(sent, /conversation_summary/)
    assert.match(sent, /User: add a login page/)
    assert.match(sent, /now add logout/)
  })

  it('renames the file once it is imported, and copes with files that are missing or broken', async () => {
    const h = await hostHarness()
    const file = await legacyFile([{ id: 'x1', entries: [] }])
    assert.equal(await h.host.importLegacySessions(file), 1)
    await assert.rejects(fs.stat(file))
    assert.equal((await fs.stat(`${file}.migrated`)).isFile(), true)
    assert.equal(await h.host.importLegacySessions(file), 0)

    const broken = path.join(await tempWorkspace(), 'sessions.json')
    await fs.writeFile(broken, '{ not json')
    assert.equal(await h.host.importLegacySessions(broken), 0)
    assert.equal((await fs.stat(broken)).isFile(), true, 'a file that cannot be read is left alone')
    assert.equal(await h.host.importLegacySessions(path.join(await tempWorkspace(), 'nothing.json')), 0)
  })
})
