import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import { createDesktopBroker } from '@encode/tools'
import { FakeDesktop, type FakeWindow } from '@encode/tools/testing'
import type { Script, ScriptedCall } from './scripted'
import { closeHarnesses, hostHarness, sessionHarness, type SessionHarness, type SessionHarnessOptions } from './testing'

after(closeHarnesses)

const notepad = (): FakeWindow => ({
  app: 'notepad.exe',
  label: 'Notepad',
  title: 'Untitled - Notepad',
  elements: [{ role: 'edit', name: 'Text editor', value: '', can: ['set_value'] }],
})

/** What the fake desktop sends as the picture of window w1 in its first state. */
const PICTURE = Buffer.from('w1:1').toString('base64')

const computer = (input: Record<string, unknown>): ScriptedCall => ({ name: 'Computer', input })

/** A script that makes these calls one after another in every turn, and then answers. */
const eachTurn = (...calls: ScriptedCall[]): Script => (request: CompletionRequest) => {
  let answered = 0
  for (let i = request.payload.messages.length - 1; i >= 0; i--) {
    const message = request.payload.messages[i]
    if (message.role === 'assistant') continue
    if (!message.content.some((block) => block.type === 'tool-result')) break
    answered++
  }
  return answered < calls.length ? { calls: [calls[answered]] } : { text: 'ok' }
}

const look = computer({ action: 'screenshot', window: 'w1' })

function setup(options: SessionHarnessOptions = {}) {
  const backend = new FakeDesktop([notepad()])
  const broker = createDesktopBroker(backend, { options: { pace: 'instant' } })
  return {
    backend,
    broker,
    options: {
      settings: { computer: true, policy: 'full-access' as const },
      client: { images: true },
      ...options,
      env: { desktop: (id: string) => broker.open(id), ...options.env },
    } satisfies SessionHarnessOptions,
  }
}

const toolNames = (h: SessionHarness, request: number): string[] => h.client.requests[request].payload.tools.map((tool) => tool.name)

const imagesIn = (messages: readonly Message[]): number =>
  messages.reduce(
    (sum, message) =>
      sum + (message.role === 'user' ? message.content.reduce((inner, block) => inner + (block.type === 'tool-result' ? block.content.filter((part) => part.type === 'image').length : block.type === 'image' ? 1 : 0), 0) : 0),
    0,
  )

async function everythingStored(dir: string): Promise<string> {
  let all = ''
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) all += await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')
  }
  return all
}

describe('the Computer tool in a session', () => {
  it('is offered while the setting is on and a desktop exists, and a change applies from the next turn', async () => {
    const { options } = setup({ settings: { computer: false } })
    const h = await sessionHarness({ ...options, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    assert.ok(!toolNames(h, 0).includes('Computer'))

    h.settings.computer = true
    await h.session.start({ text: 'two', mode: 'code' })
    assert.ok(toolNames(h, 1).includes('Computer'))

    h.settings.computer = false
    await h.session.start({ text: 'three', mode: 'code' })
    assert.ok(!toolNames(h, 2).includes('Computer'))
  })

  it('is never offered where the host has no desktop, whatever the setting says', async () => {
    const h = await sessionHarness({ settings: { computer: true }, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    assert.ok(!toolNames(h, 0).includes('Computer'))
  })

  it('keeps screenshots out of the stored log, shows the newest to the model, and loses none of the text', async () => {
    const { options } = setup()
    const h = await sessionHarness({ ...options, script: eachTurn(look, look) })
    assert.equal((await h.session.start({ text: 'look at notepad twice', mode: 'code' })).kind, 'done')
    assert.deepEqual(h.client.requests.map((request) => imagesIn(request.payload.messages)), [0, 1, 1])
    await h.session.flush()
    const stored = await everythingStored(h.dir)
    assert.ok(!stored.includes(PICTURE), 'no screenshot reached the log')
    assert.match(stored, /Screenshot s\d+ is 800x600 pixels/, 'the text of the result did')
    assert.match(stored, /screenshot removed to save context/)

    const before = h.client.requests.length
    await h.reopen()
    await h.session.start({ text: 'and again', mode: 'code' })
    assert.equal(imagesIn(h.client.requests[before].payload.messages), 0, 'a session opened from its log has no screenshot to send')
  })

  it('asks again for an application after the conversation starts over', async () => {
    const { options } = setup({ settings: { computer: true, policy: 'workspace-write' } })
    const h = await sessionHarness({ ...options, script: eachTurn(look) })
    const first = h.session.start({ text: 'look', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.match(request.title, /Use Notepad/)
    h.session.resolveApproval(request.id, true)
    assert.equal((await first).kind, 'done')

    // Allowed for the rest of the session: no second question.
    await h.session.start({ text: 'once more', mode: 'code' })
    assert.equal(h.of('approval-request').length, 1)

    await h.session.reset()
    const second = h.session.start({ text: 'look again', mode: 'code' })
    const again = await until(() => h.of('approval-request')[1])
    h.session.resolveApproval(again.request.id, true)
    await second
    assert.equal(h.of('approval-request').length, 2)
  })

  it('lets go of the desktop when the user stops it, and when the session closes', async () => {
    const { broker, options } = setup()
    const h = await sessionHarness({ ...options, script: eachTurn(look) })
    await h.session.start({ text: 'look', mode: 'code' })
    assert.equal(broker.holder(), undefined, 'looking takes no hold')

    const g = await sessionHarness({ ...options, script: eachTurn(look, computer({ action: 'set_value', window: 'w1', element: 'e1', text: 'hello' })) })
    await g.session.start({ text: 'type', mode: 'code' })
    assert.equal(broker.holder(), g.session.id)
    g.session.cancel()
    assert.equal(broker.holder(), undefined)

    await g.session.start({ text: 'type again', mode: 'code' })
    assert.equal(broker.holder(), g.session.id)
    await g.session.dispose()
    assert.equal(broker.holder(), undefined)
  })
})

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the Computer tool in the host', () => {
  it('shares one desktop between sessions, refuses a second chat while the first is typing, and stops it when the host closes', async () => {
    const backend = new FakeDesktop([notepad()])
    const h = await hostHarness({
      host: { desktop: backend, desktopOptions: { pace: 'instant' } },
      settings: { computer: true, policy: 'full-access' },
      client: { images: true },
      script: eachTurn(look, computer({ action: 'set_value', window: 'w1', element: 'e1', text: 'hello' })),
    })
    const first = await h.host.create()
    const second = await h.host.create()
    await h.host.start(first.id, { text: 'write hello', mode: 'code' })
    assert.equal(backend.calls.filter((call) => call.op === 'act').length, 1)

    // The first chat typed a moment ago and still holds the desktop, so the second may look but not type.
    await h.host.start(second.id, { text: 'write hello too', mode: 'code' })
    assert.equal(backend.calls.filter((call) => call.op === 'act').length, 1, 'the second chat sent no input')
    const refused = h.of('entry', second.id).filter((event) => event.entry.kind === 'tool' && event.entry.tool?.state === 'error').at(-1)
    assert.match(refused?.entry.tool?.output ?? '', /Another chat is using the desktop right now/)

    await h.host.dispose()
    assert.equal(backend.disposed, true)
  })
})
