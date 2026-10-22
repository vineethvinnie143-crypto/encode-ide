import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { DesktopError, type ActRequest, type LookRequest } from '../contract'
import type { BuildOptions, HelperBuild } from './build'
import { createWindowsDesktop, helperEnvironment, type WindowsDesktop, type WindowsDesktopOptions } from './desktop'
import { spawnFakeHelper, writeFakeHelper } from './fake-helper'

let folder: string
let script: string
let counter = 0
const open: WindowsDesktop[] = []

before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-desktop-'))
  script = await writeFakeHelper(folder)
})

after(async () => {
  await Promise.all(open.map((desktop) => desktop.dispose()))
  await fs.rm(folder, { recursive: true, force: true })
})

const never = () => new AbortController().signal
const NOTEPAD = ['notepad.exe']

function scene(env: Record<string, string> = {}, options: WindowsDesktopOptions = {}) {
  const id = ++counter
  const log = path.join(folder, `requests-${id}.jsonl`)
  const state = {
    spawns: 0,
    builds: 0,
    child: undefined as ChildProcessWithoutNullStreams | undefined,
    clock: 1_000_000,
  }
  const desktop = createWindowsDesktop({
    ensure: async (_options: BuildOptions): Promise<HelperBuild> => {
      state.builds++
      return { dir: folder, exe: 'fake-helper.exe', hash: 'fake', built: false }
    },
    spawn: () => {
      state.spawns++
      state.child = spawnFakeHelper(script, { FAKE_LOG: log, ...env })
      return state.child
    },
    now: () => state.clock,
    ...options,
  })
  open.push(desktop)
  const requests = async () => {
    try {
      return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id?: number; op: string; args?: Record<string, unknown> })
    } catch {
      return []
    }
  }
  const sent = async (op: string) => (await requests()).filter((request) => request.op === op)
  return { desktop, state, sent, log }
}

async function failure(work: Promise<unknown>): Promise<DesktopError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof DesktopError, String(error))
    return error
  }
  return assert.fail('The call should have failed.')
}

const LOOK: LookRequest = { window: 'w1', allowed: NOTEPAD, image: true, outline: 'full', maxElements: 300, maxImageEdge: 1568, maxImagePixels: 1_150_000 }
const ACT: ActRequest = {
  window: 'w1',
  allowed: NOTEPAD,
  steps: [
    { kind: 'click', target: { element: 'e1' }, button: 'left', count: 1 },
    { kind: 'type', text: 'hello' },
  ],
  expectCursor: [220, 330],
  look: { image: 'changed', outline: 'full', maxElements: 300, maxImageEdge: 1568, maxImagePixels: 1_150_000 },
  settleMs: 1_200,
  pace: 'smooth',
}

describe('the Windows desktop backend', () => {
  it('starts the helper on the first call, tells it who it must not touch, and keeps it for the next', async () => {
    const { desktop, state, sent } = scene({}, { ownPids: [777], ownPaths: ['C:\\Apps\\eNCode.exe'] })
    assert.equal(state.spawns, 0, 'nothing starts before it is needed')
    const info = await desktop.ready(never())
    assert.deepEqual(info, { platform: 'win32', version: '1', scale: 125, monitors: [[0, 0, 1920, 1080]] })
    await desktop.ready(never())
    await desktop.windows(never())
    assert.equal(state.spawns, 1)
    assert.equal(state.builds, 1)
    const [ready, ...more] = await sent('ready')
    assert.equal(more.length, 0, 'it is asked once')
    const args = ready.args as { ownPids: number[]; ownPaths: string[]; allowElevated: boolean; firstWindow: number }
    for (const pid of [process.pid, process.ppid, 777]) assert.ok(args.ownPids.includes(pid), `pid ${pid}`)
    assert.ok(args.ownPaths.includes(process.execPath))
    assert.ok(args.ownPaths.includes('C:\\Apps\\eNCode.exe'))
    assert.equal(args.allowElevated, false)
    assert.equal(args.firstWindow, 1)
  })

  it('shares one start between calls that arrive together', async () => {
    const { desktop, state } = scene()
    await Promise.all([desktop.ready(never()), desktop.windows(never()), desktop.cursor(never())])
    assert.equal(state.spawns, 1)
    assert.equal(state.builds, 1)
  })

  it('lists windows and the cursor after checking what came back', async () => {
    const { desktop } = scene()
    const list = await desktop.windows(never())
    assert.deepEqual(list.map((window) => [window.id, window.app]), [['w1', 'notepad.exe'], ['w2', 'calc.exe']])
    assert.deepEqual(await desktop.cursor(never()), [10, 20])
    const focused = await desktop.focus({ window: 'w1', allowed: NOTEPAD }, never())
    assert.equal(focused.foreground, true)
  })

  it('asks for the picture and the outline the request names', async () => {
    const { desktop, sent } = scene()
    const look = await desktop.look({ ...LOOK, settleMs: 400, zoom: { capture: 's1', box: [1, 2, 30, 40] } }, never())
    assert.equal(look.capture.data, 'AAAA')
    assert.equal(look.outline?.elements.length, 4)
    const [request] = await sent('look')
    assert.deepEqual(request.args, {
      window: 'w1',
      allowed: NOTEPAD,
      image: true,
      outline: 'full',
      maxElements: 300,
      maxImageEdge: 1568,
      maxImagePixels: 1_150_000,
      zoom: { capture: 's1', box: [1, 2, 30, 40] },
      settleMs: 400,
    })
    await desktop.look({ ...LOOK, image: 'changed', outline: 'none' }, never())
    const second = (await sent('look'))[1].args!
    assert.equal(second.outline, 'none')
    assert.equal(second.image, 'changed')
    assert.equal('zoom' in second, false)
    assert.equal('settleMs' in second, false)
  })

  it('reads the whole window for a search and keeps only what matches, best first', async () => {
    const { desktop, sent } = scene()
    const found = await desktop.look({ ...LOOK, image: false, outline: { query: 'save' } }, never())
    assert.deepEqual(found.outline?.elements.map((element) => element.name), ['Save', 'Save as'])
    assert.equal(found.outline?.total, 2)
    assert.equal((await sent('look'))[0].args!.maxElements, 2_500, 'a name deep in a big window is still found')
    const byRole = await desktop.look({ ...LOOK, image: false, outline: { role: 'edit' } }, never())
    assert.deepEqual(byRole.outline?.elements.map((element) => element.ref), ['e2'])
    const none = await desktop.look({ ...LOOK, image: false, outline: { query: 'nothing like it' } }, never())
    assert.deepEqual(none.outline, { elements: [], total: 0 })
  })

  it('sends the steps as they are, the cursor it expects and how to pace them', async () => {
    const { desktop, sent } = scene()
    const result = await desktop.act(ACT, never())
    assert.deepEqual(result.performed.map((done) => [done.kind, done.via]), [['click', 'mouse'], ['type', 'keys']])
    assert.deepEqual(result.cursor, [220, 330])
    assert.equal(result.opened[0].title, 'Save')
    assert.equal(result.look?.outline?.elements.length, 4)
    const [request] = await sent('act')
    assert.deepEqual(request.args, {
      window: 'w1',
      allowed: NOTEPAD,
      steps: ACT.steps,
      expectCursor: [220, 330],
      look: { image: 'changed', outline: 'full', maxElements: 300, maxImageEdge: 1568, maxImagePixels: 1_150_000 },
      settleMs: 1_200,
      pace: 'smooth',
    })
    await desktop.act({ ...ACT, expectCursor: undefined, look: { ...ACT.look, outline: { query: 'edit' } } }, never())
    const second = (await sent('act'))[1].args as { look: { outline: string; maxElements: number }; expectCursor?: unknown }
    assert.equal('expectCursor' in second, false)
    assert.equal(second.look.outline, 'full', 'the helper reads everything and the backend picks')
    assert.equal(second.look.maxElements, 2_500)
  })

  it('goes on numbering windows after a restart, so an old id never names another window', async () => {
    const { desktop, state, sent } = scene()
    const before = await desktop.windows(never())
    assert.deepEqual(before.map((window) => window.id), ['w1', 'w2'])
    await desktop.act(ACT, never())
    const child = state.child!
    child.kill()
    await once(child, 'exit')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const after = await desktop.windows(never())
    assert.equal(state.spawns, 2, 'a helper that died is started again')
    assert.deepEqual(after.map((window) => window.id), ['w4', 'w5'], 'the dialog the last helper opened was w3')
    const asked = await sent('ready')
    assert.equal((asked[1].args as { firstWindow: number }).firstWindow, 4)
  })

  it('does not try again at once to start a helper that could not be built', async () => {
    let builds = 0
    const { desktop, state } = scene({}, {
      ensure: async () => {
        builds++
        throw new DesktopError('unavailable', 'The desktop helper could not be built: CS1002')
      },
    })
    const first = await failure(desktop.ready(never()))
    assert.match(first.message, /CS1002/)
    const second = await failure(desktop.windows(never()))
    assert.equal(second, first, 'the same answer, without another build')
    assert.equal(builds, 1)
    state.clock += 31_000
    await failure(desktop.ready(never()))
    assert.equal(builds, 2, 'after a while it tries again')
  })

  it('turns anything that is not a DesktopError into one', async () => {
    const { desktop } = scene({}, {
      ensure: async () => {
        throw new Error('EPERM: operation not permitted')
      },
    })
    const error = await failure(desktop.ready(never()))
    assert.equal(error.code, 'unavailable')
    assert.match(error.message, /EPERM/)
  })

  it('keeps the helper when the screen is locked and asks again on the next call', async () => {
    const stateFile = path.join(folder, `locked-${counter + 1}.count`)
    const { desktop, state, sent } = scene({ FAKE_READY_FAILS: '2', FAKE_STATE: stateFile })
    for (let n = 0; n < 2; n++) {
      const locked = await failure(desktop.ready(never()))
      assert.equal(locked.code, 'unavailable')
      assert.match(locked.message, /locked/)
    }
    assert.equal(state.spawns, 1, 'the helper is fine; the screen was not')
    assert.equal((await desktop.ready(never())).scale, 125)
    assert.equal((await sent('ready')).length, 3)
  })

  it('refuses an answer that is not what the contract says', async () => {
    const { desktop } = scene()
    const client = await (desktop as unknown as { connect(signal: AbortSignal): Promise<{ client: { request(op: string, args: unknown, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown> } }> }).connect(never())
    // The fake answers this one with a look that has no capture.
    const bad = await client.client.request('bad-look', {}, { signal: never(), timeoutMs: 5_000 })
    assert.deepEqual(bad, { window: 'nope' })
    const backend = desktop as unknown as { call(op: string, args: unknown, signal: AbortSignal, timeoutMs: number, parse: (value: unknown) => unknown): Promise<unknown> }
    const { asLook } = await import('./validate')
    const error = await failure(backend.call('bad-look', {}, never(), 5_000, asLook))
    assert.equal(error.code, 'failed')
    assert.match(error.message, /look\.window/)
  })

  it('stops waiting when the caller does, and the helper still starts for the next', async () => {
    const { desktop, state } = scene()
    const controller = new AbortController()
    const waiting = desktop.ready(controller.signal)
    controller.abort(new Error('the user pressed stop'))
    await assert.rejects(waiting, /the user pressed stop/)
    assert.equal((await desktop.ready(never())).scale, 125)
    assert.equal(state.spawns, 1)
  })

  it('stops the helper on dispose and refuses later calls', async () => {
    const { desktop, state } = scene()
    await desktop.ready(never())
    const child = state.child!
    await desktop.dispose()
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal((await failure(desktop.windows(never()))).code, 'unavailable')
    await desktop.dispose()
  })

  it('does not leave a helper behind when it is disposed while starting', async () => {
    const { desktop, state } = scene()
    const starting = desktop.ready(never()).catch((error: unknown) => error)
    await desktop.dispose()
    await starting
    const child = state.child
    const gone = () => !child || child.exitCode !== null || child.signalCode !== null
    for (let n = 0; n < 100 && !gone(); n++) await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(gone(), 'the helper that was started for nobody is stopped')
  })
})

describe('the helper\'s environment', () => {
  it('holds what .NET and the screen need and none of eNCode\'s secrets', () => {
    const env = helperEnvironment({ SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', OPENROUTER_API_KEY: 'sk-or-secret', ENCODE_TOKEN: 'x', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://proxy' })
    assert.deepEqual(env, { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })
  })
})
