import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActRequest, ActResult, DesktopBackend } from './contract'
import { DesktopError } from './contract'
import { createDesktopBroker } from './broker'
import { FakeDesktop } from './fake'

const NOTEPAD = ['notepad.exe']

function scene() {
  const backend = new FakeDesktop([{ app: 'notepad.exe', label: 'Notepad', title: 'Untitled - Notepad', elements: [{ role: 'edit', name: 'Text editor', value: '', can: ['set_value'] }] }])
  const signal = new AbortController().signal
  const press = (): ActRequest => ({
    window: 'w1',
    allowed: NOTEPAD,
    steps: [{ kind: 'key', combos: [{ modifiers: ['ctrl'], key: 'a' }] }],
    look: { image: false, outline: 'none', maxElements: 10, maxImageEdge: 1568, maxImagePixels: 1_150_000 },
    settleMs: 0,
    pace: 'instant',
  })
  return { backend, signal, press }
}

async function refused(work: Promise<unknown>): Promise<DesktopError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof DesktopError, String(error))
    return error
  }
  assert.fail('The call should have been refused.')
}

describe('desktop broker', () => {
  it('lets one chat at a time send input, and tells the other to wait', async () => {
    const { backend, signal, press } = scene()
    const broker = createDesktopBroker(backend)
    const a = broker.open('chat-a').backend
    const b = broker.open('chat-b').backend

    await a.act(press(), signal)
    assert.equal(broker.holder(), 'chat-a')
    const error = await refused(b.act(press(), signal))
    assert.equal(error.code, 'busy')
    assert.match(error.message, /Another chat is using the desktop/)
    assert.equal(backend.calls.filter((call) => call.op === 'act').length, 1, 'the refused call never reached the desktop')

    await a.act(press(), signal)
    assert.equal(broker.holder(), 'chat-a', 'the holder keeps it between its own calls')
  })

  it('lets any chat look, because looking changes nothing', async () => {
    const { backend, signal, press } = scene()
    const broker = createDesktopBroker(backend)
    const a = broker.open('chat-a').backend
    const b = broker.open('chat-b').backend
    await a.act(press(), signal)
    assert.equal((await b.windows(signal)).length, 1)
    assert.deepEqual(await b.cursor(signal), [0, 0])
    const look = await b.look({ window: 'w1', allowed: NOTEPAD, image: false, outline: 'none', maxElements: 5, maxImageEdge: 1568, maxImagePixels: 1_150_000 }, signal)
    assert.equal(look.window.id, 'w1')
  })

  it('hands the desktop over after the holder has been idle, and not before', async () => {
    const { backend, signal, press } = scene()
    let now = 1_000
    const broker = createDesktopBroker(backend, { idleMs: 30_000, now: () => now })
    const a = broker.open('chat-a').backend
    const b = broker.open('chat-b').backend
    await a.act(press(), signal)

    now += 29_999
    assert.equal((await refused(b.act(press(), signal))).code, 'busy')
    now += 2
    await b.act(press(), signal)
    assert.equal(broker.holder(), 'chat-b')
    assert.equal((await refused(a.act(press(), signal))).code, 'busy', 'and now the first chat waits')
  })

  it('never takes the desktop from a call that is still running, however long it takes', async () => {
    const { backend, signal, press } = scene()
    let now = 0
    let finish: (result: ActResult) => void = () => undefined
    const slow: DesktopBackend = {
      ready: () => backend.ready(),
      windows: () => backend.windows(),
      focus: (request) => backend.focus(request),
      look: (request) => backend.look(request),
      act: () => new Promise<ActResult>((resolve) => (finish = resolve)),
      cursor: () => backend.cursor(),
      dispose: () => backend.dispose(),
    }
    const broker = createDesktopBroker(slow, { idleMs: 1_000, now: () => now })
    const a = broker.open('chat-a').backend
    const b = broker.open('chat-b').backend
    const running = a.act(press(), signal)
    now += 60_000
    assert.equal((await refused(b.act(press(), signal))).code, 'busy')
    finish({ performed: [], look: null, opened: [], closed: [], cursor: [0, 0] })
    await running
    now += 500
    assert.equal((await refused(b.act(press(), signal))).code, 'busy', 'the idle time runs from the end of the call')
    assert.equal(broker.holder(), 'chat-a')
  })

  it('lets go at once when a chat closes its view, or when its running call ends after that', async () => {
    const { backend, signal, press } = scene()
    const broker = createDesktopBroker(backend)
    const a = broker.open('chat-a').backend
    const b = broker.open('chat-b').backend
    await a.act(press(), signal)
    await a.dispose()
    assert.equal(broker.holder(), undefined)
    assert.equal(backend.disposed, false, 'a chat closing its view does not stop the desktop for the others')
    await b.act(press(), signal)
    assert.equal(broker.holder(), 'chat-b')

    let finish: (result: ActResult) => void = () => undefined
    const hold: DesktopBackend = {
      ready: () => backend.ready(),
      windows: () => backend.windows(),
      focus: (request) => backend.focus(request),
      look: (request) => backend.look(request),
      act: () => new Promise<ActResult>((resolve) => (finish = resolve)),
      cursor: () => backend.cursor(),
      dispose: () => backend.dispose(),
    }
    const second = createDesktopBroker(hold)
    const c = second.open('chat-c').backend
    const running = c.act(press(), signal)
    await c.dispose()
    assert.equal(second.holder(), 'chat-c', 'the running call is not cut off')
    finish({ performed: [], look: null, opened: [], closed: [], cursor: [0, 0] })
    await running
    assert.equal(second.holder(), undefined)
  })

  it('gives each chat a state of its own and the options it was configured with', () => {
    const { backend } = scene()
    const broker = createDesktopBroker(backend, { options: { maxActionsPerTurn: 7, pace: 'instant' } })
    const a = broker.open('chat-a')
    const b = broker.open('chat-b')
    assert.notEqual(a.state, b.state)
    assert.equal(a.options.maxActionsPerTurn, 7)
    assert.equal(a.options.pace, 'instant')
    assert.equal(a.options.settleMs, 1_200)
    a.options.maxActionsPerTurn = 1
    assert.equal(b.options.maxActionsPerTurn, 7, 'the options are copies')
  })

  it('stops the desktop once and refuses every call after that', async () => {
    const { backend, signal, press } = scene()
    const broker = createDesktopBroker(backend)
    const a = broker.open('chat-a').backend
    await broker.dispose()
    assert.equal(backend.disposed, true)
    assert.equal((await refused(a.act(press(), signal))).code, 'unavailable')
    assert.equal((await refused(a.windows(signal))).code, 'unavailable')
  })
})
