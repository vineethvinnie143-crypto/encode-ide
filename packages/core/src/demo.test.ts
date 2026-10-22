import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { createDemoClient, DEMO_NOTE } from './demo'
import { closeHarnesses, sessionHarness } from './testing'

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

describe('the offline demo', () => {
  it('lists the workspace, writes a note through the approval flow and reads it back', async () => {
    const h = await sessionHarness({ env: { client: createDemoClient({ delayMs: 0 }) } })
    const running = h.session.start({ text: 'show me what you can do', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.match(request.title, /demo-note\.md/)
    h.session.resolveApproval(request.id, true)
    const end = await running
    assert.equal(end.kind, 'done')
    assert.match(await fs.readFile(path.join(h.root, DEMO_NOTE), 'utf8'), /eNCode demo/)
    const tools = h.session.history().entries.filter((entry) => entry.kind === 'tool').map((entry) => [entry.tool?.name, entry.tool?.state])
    assert.deepEqual(tools, [['Glob', 'done'], ['Write', 'done'], ['Read', 'done']])
  })

  it('ends politely when the note is refused', async () => {
    const h = await sessionHarness({ env: { client: createDemoClient({ delayMs: 0 }) } })
    const running = h.session.start({ text: 'demo', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, false)
    assert.equal((await running).kind, 'done')
    await assert.rejects(fs.stat(path.join(h.root, DEMO_NOTE)))
    assert.match(h.session.history().entries.at(-1)?.text ?? '', /note was not written/)
  })

  it('answers the small model roles without calling tools', async () => {
    const client = createDemoClient({ delayMs: 0 })
    const outcome = await client.complete({
      role: 'utility',
      payload: { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'title this' }] }], tools: [], maxOutputTokens: 100 },
      requirements: { promptTokens: 10, maxOutputTokens: 100, tools: false, images: false },
      signal: new AbortController().signal,
    })
    assert.equal(outcome.kind, 'done')
  })

  it('gives a session no name of its own, so the first words of the request stay its title', async () => {
    const h = await sessionHarness({ env: { client: createDemoClient({ delayMs: 0 }), nameSessions: true } })
    const running = h.session.start({ text: 'show me what you can do with this workspace', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, true)
    assert.equal((await running).kind, 'done')
    await h.session.named()
    assert.equal(h.session.summary().title, 'show me what you can do with this workspace')
  })
})
