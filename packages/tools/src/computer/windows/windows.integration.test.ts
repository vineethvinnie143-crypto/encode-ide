/// <reference path="./assets.d.ts" />
/**
 * The helper on a real Windows desktop: it is built with the compiler Windows ships, started the way eNCode starts
 * it, and made to use a small window of ours (fixture/Fixture.cs) that writes down everything that reaches it.
 * What the helper says it did is never taken for what it did: each check reads the fixture's own record.
 *
 * Skipped anywhere but Windows. It needs a desktop that is logged in and unlocked, as a CI runner or a person's
 * computer has. Pictures of what the helper saw are kept in ENCODE_SHOTS when it is set.
 */
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { DesktopError, type ActRequest, type Capture, type Look, type LookRequest, type Point, type Step, type WindowInfo } from '../contract'
import { toImage } from '../geometry'
import { findCompiler } from './build'
import { createWindowsDesktop, type WindowsDesktop } from './desktop'
import fixtureText from './fixture/Fixture.cs'

const run = promisify(execFile)
const onWindows = process.platform === 'win32'

interface State {
  pid: number
  title: string
  activated: number
  focused: boolean
  dialogOpen: boolean
  menuOpen: boolean
  minimized: boolean
  box: number[]
  canvas: number[]
  notes: string
  subject: string
  secret: string
  remember: boolean
  color: string
  selected: string
  status: string
  items: string[]
  events: string[]
}

interface Fixture {
  title: string
  child: ChildProcess
  file: string
  state(): Promise<State>
  /** The first record in which `check` holds: the fixture writes its record a moment after something happens to it. */
  until(check: (state: State) => boolean, what: string): Promise<State>
  window(): Promise<WindowInfo>
}

// ---------------------------------------------------------------- small tools

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const SIGNAL = new AbortController().signal
const MASK = [0x6e, 0x6e, 0x76]

async function eventually<T>(work: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  for (;;) {
    try {
      const value = await work()
      if (value) return value as T
    } catch (error) {
      last = error
    }
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.${last ? ` The last error was: ${String(last)}` : ''}`)
    await sleep(100)
  }
}

async function failure(work: Promise<unknown>): Promise<DesktopError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof DesktopError, `Expected a DesktopError, got ${String(error)}`)
    return error
  }
  return assert.fail('The call should have been refused.')
}

interface Picture {
  width: number
  height: number
  pixel(x: number, y: number): number[]
}

/** PNG as the Windows imaging code writes it: 8 bits, RGB or RGBA, no interlacing. */
function decodePng(base64: string): Picture {
  const bytes = Buffer.from(base64, 'base64')
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the image is a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let type = 0
  let interlace = 0
  const data: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const kind = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      type = body[9]
      interlace = body[12]
    } else if (kind === 'IDAT') data.push(body)
    else if (kind === 'IEND') break
    offset += 12 + length
  }
  assert.equal(depth, 8, 'bit depth')
  assert.equal(interlace, 0, 'interlacing')
  const channels = type === 6 ? 4 : type === 2 ? 3 : 0
  assert.ok(channels > 0, `colour type ${type}`)
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      let value = raw[y * (stride + 1) + 1 + x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const guess = left + up - upLeft
        const toLeft = Math.abs(guess - left)
        const toUp = Math.abs(guess - up)
        const toUpLeft = Math.abs(guess - upLeft)
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      } else assert.equal(filter, 0, 'PNG filter')
      pixels[y * stride + x] = value & 255
    }
  }
  return { width, height, pixel: (x, y) => [pixels[y * stride + x * channels], pixels[y * stride + x * channels + 1], pixels[y * stride + x * channels + 2]] }
}

function imagePoint(capture: Capture, screen: Point): Point {
  return toImage(screen, capture)
}

// ---------------------------------------------------------------- requests

const IMAGE = { maxImageEdge: 1568, maxImagePixels: 1_150_000 }

function lookOf(window: WindowInfo, extra: Partial<LookRequest> = {}): LookRequest {
  return { window: window.id, allowed: [window.app], image: true, outline: 'full', maxElements: 300, ...IMAGE, ...extra }
}

function actOf(window: WindowInfo, steps: Step[], extra: Partial<ActRequest> = {}): ActRequest {
  return { window: window.id, allowed: [window.app], steps, look: { image: false, outline: 'full', maxElements: 300, ...IMAGE }, settleMs: 700, pace: 'instant', ...extra }
}

const clickElement = (element: string, button: 'left' | 'right' | 'middle' = 'left', count: 1 | 2 | 3 = 1): Step => ({ kind: 'click', target: { element }, button, count })
const clickPoint = (capture: Capture, screen: Point, button: 'left' | 'right' | 'middle' = 'left', count: 1 | 2 | 3 = 1): Step => ({
  kind: 'click',
  target: { point: imagePoint(capture, screen), capture: capture.id },
  button,
  count,
})
const keys = (...combos: { modifiers: ('ctrl' | 'alt' | 'shift')[]; key: string }[]): Step => ({ kind: 'key', combos })

function named(look: Look | null, name: string) {
  const found = look?.outline?.elements.find((element) => element.name === name)
  assert.ok(found, `the outline lists "${name}": ${look?.outline?.elements.map((element) => `${element.ref} ${element.role} "${element.name}"`).join('; ') ?? 'no outline'}`)
  return found
}

function eventPoint(event: string): Point {
  const match = /^\w+ (-?\d+),(-?\d+)/.exec(event)
  assert.ok(match, `an event with a position: ${event}`)
  return [Number(match[1]), Number(match[2])]
}

// ---------------------------------------------------------------- the setup

let folder: string
let fixtureExe: string
let desktop: WindowsDesktop
let counter = 0
const children: ChildProcess[] = []
let a: Fixture
let shots: string | undefined

async function readState(file: string): Promise<State | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as State
    } catch {
      await sleep(30)
    }
  }
  return undefined
}

async function launch(title: string, left: number, top: number): Promise<Fixture> {
  const file = path.join(folder, `state-${++counter}.json`)
  const child = spawn(fixtureExe, [file, String(left), String(top), title], { stdio: 'ignore' })
  children.push(child)
  const fixture: Fixture = {
    title,
    child,
    file,
    state: () => eventually(() => readState(file), `the record of "${title}"`),
    until: (check, what) =>
      eventually(async () => {
        const now = await readState(file)
        return now && check(now) ? now : undefined
      }, what),
    window: () => eventually(async () => (await desktop.windows(SIGNAL)).find((window) => window.title === title && window.app === 'fixture.exe'), `"${title}" to be listed among the windows`),
  }
  await fixture.window()
  await fixture.state()
  return fixture
}

async function keep(name: string, look: Look): Promise<void> {
  if (!shots || !look.capture.data) return
  await fs.mkdir(shots, { recursive: true })
  await fs.writeFile(path.join(shots, `desktop-${name}.png`), Buffer.from(look.capture.data, 'base64'))
}

/** Something to do to the fixture's own window that does not go through the helper. */
async function command(fixture: Fixture, text: string): Promise<void> {
  await fs.writeFile(`${fixture.file}.cmd`, text, 'utf8')
  await eventually(async () => !(await fs.access(`${fixture.file}.cmd`).then(() => true, () => false)), `"${fixture.title}" to take the command "${text}"`)
}

/**
 * Empties the multi-line Notes box the way a person does. It is a document, not a field with a value, so it cannot be set
 * whole: it is clicked, everything is selected and deleted.
 */
async function clearNotes(window: WindowInfo, ref: string): Promise<void> {
  await desktop.act(actOf(window, [clickElement(ref), keys({ modifiers: ['ctrl'], key: 'a' }), keys({ modifiers: [], key: 'delete' })]), SIGNAL)
  await a.until((now) => now.notes === '', 'the notes to be empty')
}

/** Waits until the fixture has recorded `count` more events than it had, and returns them. */
async function eventsAfter(fixture: Fixture, before: number, count: number): Promise<string[]> {
  const state = await eventually(async () => {
    const now = await fixture.state()
    return now.events.length >= before + count ? now : undefined
  }, `${count} more events from "${fixture.title}"`)
  return state.events.slice(before)
}

before(
  async () => {
    if (!onWindows) return
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-desktop-it-'))
    shots = process.env.ENCODE_SHOTS
    const compiler = await findCompiler()
    const source = path.join(folder, 'Fixture.cs')
    await fs.writeFile(source, fixtureText, 'utf8')
    fixtureExe = path.join(folder, 'fixture.exe')
    await run(compiler.csc, ['/nologo', '/noconfig', '/target:winexe', `/out:${fixtureExe}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', source], { windowsHide: true })
    desktop = createWindowsDesktop({ cacheDir: path.join(folder, 'helper'), allowElevated: true, log: (message) => console.log(`[desktop helper] ${message}`) })
    a = await launch('eNCode Fixture A', 40, 40)
  },
  { timeout: 240_000 },
)

after(async () => {
  if (!onWindows) return
  await desktop?.dispose()
  for (const child of children) child.kill()
  await sleep(300)
  await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
})

// ---------------------------------------------------------------- the tests

describe('the Windows helper on real windows', { skip: onWindows ? false : 'these tests drive a real Windows desktop' }, () => {
  it('starts, describes the machine and lists the window with the program it belongs to', async () => {
    const info = await desktop.ready(SIGNAL)
    assert.equal(info.platform, 'win32')
    assert.ok(info.scale >= 100 && info.scale <= 500, `scale ${info.scale}`)
    assert.ok(info.monitors.length >= 1)
    assert.ok(info.monitors[0][2] > 0 && info.monitors[0][3] > 0)

    const window = await a.window()
    assert.equal(window.app, 'fixture.exe')
    assert.equal(window.pid, (await a.state()).pid)
    assert.equal(window.state, 'normal')
    assert.equal(window.blocked, undefined)
    assert.ok(window.box[2] >= 600 && window.box[3] >= 400, `box ${window.box}`)
    const ids = (await desktop.windows(SIGNAL)).map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'every window has its own id')
    assert.match(window.id, /^w\d+$/)
  })

  it('shows a window as a picture and as an outline, with the password field painted over', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window), SIGNAL)
    await keep('window', look)
    assert.equal(look.capture.mediaType, 'image/png')
    assert.deepEqual(look.capture.box, window.box, 'the picture is of the window')
    assert.equal(look.capture.scale, 1)
    const picture = decodePng(look.capture.data!)
    assert.deepEqual([picture.width, picture.height], [look.capture.width, look.capture.height])

    const state = await a.state()
    const canvasCentre: Point = [state.canvas[0] + Math.floor(state.canvas[2] / 2), state.canvas[1] + Math.floor(state.canvas[3] / 2)]
    const [cx, cy] = imagePoint(look.capture, canvasCentre)
    assert.deepEqual(picture.pixel(cx, cy), [200, 220, 255], 'the canvas is where the picture says it is')

    const secret = named(look, 'Secret')
    assert.ok(secret.states.includes('password'))
    assert.equal(secret.value, undefined, 'a password\'s text is never read')
    const [sx, sy] = imagePoint(look.capture, [secret.box[0] + Math.floor(secret.box[2] / 2), secret.box[1] + Math.floor(secret.box[3] / 2)])
    assert.deepEqual(picture.pixel(sx, sy), MASK, 'the password field is painted over')
    assert.ok(look.capture.masked >= 1)

    assert.deepEqual(named(look, 'Add item').can, ['invoke'])
    assert.equal(named(look, 'Add item').role, 'button')
    assert.ok(named(look, 'Remember me').can.includes('toggle'))
    assert.equal(named(look, 'Remember me').role, 'checkbox')
    assert.equal(named(look, 'Notes').role, 'document', 'a multi-line box is a document')
    assert.ok(!named(look, 'Notes').can.includes('set_value'), 'and has no value to set')
    assert.equal(named(look, 'Subject').role, 'edit')
    assert.ok(named(look, 'Subject').can.includes('set_value'))
    assert.equal(named(look, 'Items').role, 'list')
    assert.equal(named(look, 'Color').role, 'combobox')
    assert.equal(named(look, 'Ready').role, 'text')
    const refs = look.outline!.elements.map((element) => element.ref)
    assert.equal(new Set(refs).size, refs.length, 'refs are unique')
    assert.ok(look.outline!.total >= refs.length)
    for (const element of look.outline!.elements) assert.match(element.ref, /^e\d+$/)
  })

  it('finds an element by a word of its name, best match first', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: { query: 'add' } }), SIGNAL)
    assert.equal(look.outline?.elements[0].name, 'Add item')
    assert.equal(look.capture.data, undefined, 'no picture was asked for')
    const buttons = await desktop.look(lookOf(window, { image: false, outline: { role: 'button' } }), SIGNAL)
    assert.ok(buttons.outline!.elements.length >= 2)
    assert.ok(buttons.outline!.elements.every((element) => element.role === 'button'))
  })

  it('says a window has not changed when it has not, caret and all, and says so when it has', async () => {
    const window = await a.window()
    const notes = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Notes')
    await desktop.act(actOf(window, [clickElement(notes.ref)]), SIGNAL)
    await desktop.look(lookOf(window, { image: 'changed' }), SIGNAL)
    for (let n = 0; n < 3; n++) {
      await sleep(350)
      const again = await desktop.look(lookOf(window, { image: 'changed' }), SIGNAL)
      assert.equal(again.changed, false, `look ${n + 1}: a blinking caret is not a change`)
      assert.equal(again.capture.data, undefined, 'and then no picture is sent')
    }
    const typed = await desktop.act(actOf(window, [{ kind: 'type', text: 'x' }], { look: { image: 'changed', outline: 'full', maxElements: 300, ...IMAGE } }), SIGNAL)
    await a.until((now) => now.notes === 'x', 'the letter to arrive')
    assert.equal(typed.look?.changed, true, 'one typed letter is a change')
    assert.ok(typed.look?.capture.data, 'a changed window comes with its picture')
    assert.equal(named(typed.look ?? null, 'Notes').value, 'x', 'the focused text area shows what it holds')
    await clearNotes(window, notes.ref)
  })

  it('uses a button through its own interface, without moving the mouse', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    const add = named(look, 'Add item')
    const cursor = await desktop.cursor(SIGNAL)
    const result = await desktop.act(actOf(window, [clickElement(add.ref)]), SIGNAL)
    assert.deepEqual(result.performed.map((done) => [done.kind, done.via]), [['click', 'invoke']])
    assert.deepEqual(await desktop.cursor(SIGNAL), cursor, 'the pointer stayed where it was')
    const state = await a.until((now) => now.items.length === 1, 'the item to be added')
    assert.deepEqual(state.items, ['Item 1'])
    assert.equal(state.status, 'Added Item 1')
    assert.ok(result.look?.outline?.elements.some((element) => element.role === 'text' && element.name === 'Added Item 1'), 'the new outline shows it')
    assert.ok(result.look?.outline?.elements.some((element) => element.role === 'listitem' && element.name === 'Item 1'))
  })

  it('clicks a button with the mouse where the picture shows it, at the pixel it aimed for', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window), SIGNAL)
    const add = named(look, 'Add item')
    const centre: Point = [add.box[0] + Math.floor(add.box[2] / 2), add.box[1] + Math.floor(add.box[3] / 2)]
    const result = await desktop.act(actOf(window, [clickPoint(look.capture, centre)]), SIGNAL)
    assert.deepEqual(result.performed.map((done) => done.via), ['mouse'])
    assert.ok(Math.abs(result.cursor[0] - centre[0]) <= 1 && Math.abs(result.cursor[1] - centre[1]) <= 1, `the pointer ended at ${result.cursor}, not ${centre}`)
    assert.deepEqual((await a.until((now) => now.items.length === 2, 'the second item to be added')).items, ['Item 1', 'Item 2'])
  })

  it('lands every click on the pixel it was aimed at, in a picture at full size and in one shrunk to fit', async () => {
    const window = await a.window()
    for (const maxImageEdge of [1568, 400]) {
      const look = await desktop.look(lookOf(window, { image: false, outline: 'none', maxImageEdge }), SIGNAL)
      if (maxImageEdge === 400) assert.ok(look.capture.scale < 1, 'the picture is smaller than the window')
      const state = await a.state()
      const [x, y, w, h] = state.canvas
      const tolerance = Math.ceil(1 / look.capture.scale)
      for (const target of [[x + 10, y + 10], [x + w - 12, y + h - 12], [x + 123, y + 77]] as Point[]) {
        const before = (await a.state()).events.length
        await desktop.act(actOf(window, [clickPoint(look.capture, target)], { look: { image: false, outline: 'none', maxElements: 10, ...IMAGE } }), SIGNAL)
        const [down] = await eventsAfter(a, before, 2)
        const [landedX, landedY] = eventPoint(down)
        assert.ok(down.startsWith('down ') && down.endsWith(' left'), down)
        assert.ok(Math.abs(landedX - target[0]) <= tolerance && Math.abs(landedY - target[1]) <= tolerance, `aimed at ${target}, landed at ${landedX},${landedY} (scale ${look.capture.scale})`)
      }
    }
  })

  it('double-clicks, right-clicks and middle-clicks, and closes the menu it opened', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const centre: Point = [state.canvas[0] + Math.floor(state.canvas[2] / 2), state.canvas[1] + Math.floor(state.canvas[3] / 2)]
    let before = state.events.length
    await desktop.act(actOf(window, [clickPoint(look.capture, centre, 'left', 2)]), SIGNAL)
    let events = await eventsAfter(a, before, 5)
    assert.equal(events.filter((event) => event.startsWith('down ')).length, 2)
    assert.ok(events.some((event) => event.startsWith('double ')), `a double click: ${events.join(' | ')}`)

    before = (await a.state()).events.length
    await desktop.act(actOf(window, [clickPoint(look.capture, centre, 'middle')]), SIGNAL)
    events = await eventsAfter(a, before, 2)
    assert.ok(events[0].endsWith(' middle'))

    before = (await a.state()).events.length
    await desktop.act(actOf(window, [clickPoint(look.capture, centre, 'right')]), SIGNAL)
    events = await eventsAfter(a, before, 2)
    assert.ok(events[0].startsWith('down ') && events[0].endsWith(' right'))
    // The menu opens a moment after the button comes up; it belongs to the window, so keys reach it. Escape sent before
    // it shows is lost, and a menu left open takes the next test's wheel.
    await a.until((now) => now.menuOpen, 'the menu to open')
    await desktop.act(actOf(window, [keys({ modifiers: [], key: 'escape' })]), SIGNAL)
    await a.until((now) => !now.menuOpen, 'the menu to close')
  })

  it('scrolls the way it is told, a notch at a time, up and down and sideways', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const centre: Point = [state.canvas[0] + 60, state.canvas[1] + 60]
    assert.equal(state.menuOpen, false, 'no menu is open to take the wheel')
    // The click gives the canvas the focus; the wheel is sent once the canvas has seen it.
    await desktop.act(actOf(window, [clickPoint(look.capture, centre)]), SIGNAL)
    await eventsAfter(a, state.events.length, 2)
    const deltas = async (step: Step, kind: 'wheel' | 'hwheel', count: number) => {
      const before = (await a.state()).events.length
      await desktop.act(actOf(window, [step]), SIGNAL)
      const events = await eventsAfter(a, before, count)
      return events.filter((event) => event.startsWith(`${kind} `)).map((event) => Number(event.split(' ').pop()))
    }
    const target = { point: imagePoint(look.capture, centre), capture: look.capture.id }
    assert.deepEqual(await deltas({ kind: 'scroll', target, direction: 'down', amount: 3 }, 'wheel', 3), [-120, -120, -120])
    assert.deepEqual(await deltas({ kind: 'scroll', target, direction: 'up', amount: 2 }, 'wheel', 2), [120, 120])
    assert.deepEqual(await deltas({ kind: 'scroll', target, direction: 'right', amount: 2 }, 'hwheel', 2), [120, 120])
    assert.deepEqual(await deltas({ kind: 'scroll', direction: 'down', amount: 1 }, 'wheel', 1), [-120], 'without a target the wheel goes to where the pointer already is')
  })

  it('drags from one point to another', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const from: Point = [state.canvas[0] + 30, state.canvas[1] + 40]
    const to: Point = [state.canvas[0] + 250, state.canvas[1] + 140]
    const before = state.events.length
    const result = await desktop.act(actOf(window, [{ kind: 'drag', from: { point: imagePoint(look.capture, from), capture: look.capture.id }, to: { point: imagePoint(look.capture, to), capture: look.capture.id } }]), SIGNAL)
    assert.deepEqual(result.performed.map((done) => [done.kind, done.via]), [['drag', 'mouse']])
    const events = await eventsAfter(a, before, 2)
    const down = events.find((event) => event.startsWith('down '))!
    const up = events.find((event) => event.startsWith('up '))!
    assert.ok(Math.abs(eventPoint(down)[0] - from[0]) <= 1 && Math.abs(eventPoint(down)[1] - from[1]) <= 1, `pressed at ${down}, aimed at ${from}`)
    assert.ok(Math.abs(eventPoint(up)[0] - to[0]) <= 1 && Math.abs(eventPoint(up)[1] - to[1]) <= 1, `let go at ${up}, aimed at ${to}`)
  })

  it('moves the pointer along a path a person could follow when asked to', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const target: Point = [state.canvas[0] + state.canvas[2] - 20, state.canvas[1] + state.canvas[3] - 20]
    const started = Date.now()
    const result = await desktop.act(actOf(window, [{ kind: 'move', target: { point: imagePoint(look.capture, target), capture: look.capture.id } }], { pace: 'smooth', settleMs: 100 }), SIGNAL)
    assert.ok(Date.now() - started >= 100, 'a smooth move takes a moment')
    assert.ok(Math.abs(result.cursor[0] - target[0]) <= 1 && Math.abs(result.cursor[1] - target[1]) <= 1)
  })

  it('toggles a check box through its own interface, both ways', async () => {
    const window = await a.window()
    const box = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Remember me')
    const on = await desktop.act(actOf(window, [clickElement(box.ref)]), SIGNAL)
    assert.deepEqual(on.performed.map((done) => done.via), ['toggle'])
    await a.until((now) => now.remember, 'the box to be checked')
    assert.ok(named(on.look, 'Remember me').states.includes('checked'), 'the outline says it is checked')
    await desktop.act(actOf(window, [clickElement(box.ref)]), SIGNAL)
    await a.until((now) => !now.remember, 'the box to be cleared')
  })

  it('sets the text of a field directly, and types after it', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    const subject = named(look, 'Subject')
    const set = await desktop.act(actOf(window, [{ kind: 'set_value', element: subject.ref, text: 'first line' }]), SIGNAL)
    assert.deepEqual(set.performed.map((done) => [done.kind, done.via]), [['set_value', 'value']])
    await a.until((now) => now.subject === 'first line', 'the text to be set')
    assert.equal(named(set.look, 'Subject').value, 'first line', 'the outline shows the text')
    await desktop.act(actOf(window, [clickElement(subject.ref), keys({ modifiers: [], key: 'end' }), { kind: 'type', text: ' + typed' }]), SIGNAL)
    await a.until((now) => now.subject === 'first line + typed', 'the typed text to follow it')
    await desktop.act(actOf(window, [{ kind: 'set_value', element: subject.ref, text: '' }]), SIGNAL)
    await a.until((now) => now.subject === '', 'the field to be empty')
  })

  it('says so when a text area cannot be set whole, and leaves it alone', async () => {
    const window = await a.window()
    const notes = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Notes')
    const error = await failure(desktop.act(actOf(window, [{ kind: 'set_value', element: notes.ref, text: 'nope' }]), SIGNAL))
    assert.equal(error.code, 'failed')
    assert.match(error.message, /cannot be set directly\. Click it and type instead/)
    await sleep(200)
    assert.equal((await a.state()).notes, '')
  })

  it('types every kind of text exactly, long text and new lines and letters from other alphabets included', async () => {
    const window = await a.window()
    const notes = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Notes')
    const text = [
      'line one',
      'tab\there',
      'quote " backslash \\ braces {} brackets [] angle <>',
      `accents ${String.fromCodePoint(0xe9, 0xe8, 0xfc, 0xf1)} and ${String.fromCodePoint(0x20ac, 0xa3)}`,
      `cjk ${String.fromCodePoint(0x65e5, 0x672c, 0x8a9e)}`,
      `emoji ${String.fromCodePoint(0x1f600)} done`,
      'The quick brown fox jumps over the lazy dog. '.repeat(14),
    ].join('\n')
    // The box keeps a new line as \r\n, so the whole text is longer there than here: wait for all of it.
    const expected = text.replace(/\n/g, '\r\n')
    await clearNotes(window, notes.ref)
    await desktop.act(actOf(window, [{ kind: 'type', text }], { settleMs: 400 }), SIGNAL)
    const typed = await eventually(async () => {
      const state = await a.state()
      return state.notes.length >= expected.length ? state : undefined
    }, 'the text to arrive')
    assert.equal(typed.notes, expected)
  })

  it('presses key combinations, and refuses the ones that leave the window', async () => {
    const window = await a.window()
    const notes = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Notes')
    await clearNotes(window, notes.ref)
    await desktop.act(actOf(window, [{ kind: 'type', text: 'abc', target: { element: notes.ref } }]), SIGNAL)
    await a.until((now) => now.notes === 'abc', 'the text to be typed')
    await desktop.act(actOf(window, [keys({ modifiers: ['ctrl'], key: 'a' }, { modifiers: [], key: 'delete' })]), SIGNAL)
    await a.until((now) => now.notes === '', 'select-all and delete to clear the field')
    const before = (await a.state()).events.length
    await desktop.act(actOf(window, [keys({ modifiers: ['ctrl', 'shift'], key: 'f5' }, { modifiers: [], key: 'f2' }, { modifiers: ['alt'], key: 'f3' })]), SIGNAL)
    const events = await eventsAfter(a, before, 3)
    assert.deepEqual(events, ['key ctrl+shift+F5', 'key F2', 'key alt+F3'])
    const away = await failure(desktop.act(actOf(window, [keys({ modifiers: ['alt'], key: 'tab' })]), SIGNAL))
    assert.equal(away.code, 'failed')
    assert.match(away.message, /switches to another window/)
    assert.match((await failure(desktop.act(actOf(window, [keys({ modifiers: ['ctrl', 'alt'], key: 'delete' })]), SIGNAL))).message, /security screen/)
    assert.match((await failure(desktop.act(actOf(window, [keys({ modifiers: [], key: 'banana' })]), SIGNAL))).message, /not a key name/)
    await sleep(300)
    assert.equal((await a.state()).events.length, before + 3, 'none of the refused keys was sent')
  })

  it('never types into a password field, however it is asked', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    const secret = named(look, 'Secret')
    // Putting the focus in the field is allowed; what follows is not.
    await desktop.act(actOf(window, [clickElement(secret.ref)]), SIGNAL)
    for (const step of [
      { kind: 'type', text: 'hunter2' } as Step,
      { kind: 'type', text: 'hunter2', target: { element: secret.ref } } as Step,
      { kind: 'set_value', element: secret.ref, text: 'hunter2' } as Step,
      keys({ modifiers: [], key: 'a' }),
    ]) {
      const error = await failure(desktop.act(actOf(window, [step]), SIGNAL))
      assert.equal(error.code, 'password', `${step.kind}: ${error.message}`)
    }
    await sleep(300)
    assert.equal((await a.state()).secret, '', 'nothing reached the field')
    // Keys that do not type are fine.
    await desktop.act(actOf(window, [keys({ modifiers: [], key: 'home' })]), SIGNAL)
    const notes = named(look, 'Notes')
    await desktop.act(actOf(window, [clickElement(notes.ref)]), SIGNAL)
  })

  it('selects an item of a list through its own interface', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    const item = named(look, 'Item 2')
    assert.ok(item.can.includes('select'))
    const result = await desktop.act(actOf(window, [{ kind: 'select', element: item.ref }]), SIGNAL)
    assert.deepEqual(result.performed.map((done) => [done.kind, done.via]), [['select', 'select']])
    await a.until((now) => now.selected === 'Item 2', 'the item to be selected')
    assert.ok(named(result.look, 'Item 2').states.includes('selected'))
  })

  it('refuses a ref from a window it does not belong to, and a coordinate from a picture that is gone', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    const add = named(look, 'Add item')
    const unknown = await failure(desktop.act(actOf(window, [clickElement('e99999')]), SIGNAL))
    assert.equal(unknown.code, 'stale-element')
    assert.match(unknown.message, /e99999 is no longer in/)
    const gone = await failure(desktop.act(actOf(window, [{ kind: 'click', target: { point: [5, 5], capture: 's99999' }, button: 'left', count: 1 }]), SIGNAL))
    assert.equal(gone.code, 'stale-capture')
    assert.match(gone.message, /Take a new one/)
    assert.ok(add.ref, 'the button was listed and nothing clicked it')
  })

  it('refuses a window it was not allowed to touch, a window that is not there, and the same call twice over', async () => {
    const window = await a.window()
    assert.equal((await failure(desktop.look(lookOf(window, { allowed: ['notepad.exe'] }), SIGNAL))).code, 'not-allowed')
    assert.equal((await failure(desktop.act(actOf(window, [keys({ modifiers: [], key: 'home' })], { allowed: ['notepad.exe'] }), SIGNAL))).code, 'not-allowed')
    const missing = await failure(desktop.look({ ...lookOf(window), window: 'w999999' }, SIGNAL))
    assert.equal(missing.code, 'window-gone')
    assert.match(missing.message, /w999999 is gone/)
  })

  it('refuses the input when the pointer is not where the last input left it', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const target: Point = [state.canvas[0] + 20, state.canvas[1] + 20]
    const first = await desktop.act(actOf(window, [{ kind: 'move', target: { point: imagePoint(look.capture, target), capture: look.capture.id } }]), SIGNAL)
    const before = (await a.state()).events.length
    const error = await failure(desktop.act(actOf(window, [clickPoint(look.capture, target)], { expectCursor: [first.cursor[0] + 40, first.cursor[1]] }), SIGNAL))
    assert.equal(error.code, 'interrupted')
    await sleep(300)
    assert.equal((await a.state()).events.length, before, 'nothing was sent')
    const fine = await desktop.act(actOf(window, [{ kind: 'move', target: { point: imagePoint(look.capture, target), capture: look.capture.id } }], { expectCursor: first.cursor }), SIGNAL)
    assert.deepEqual(fine.cursor, first.cursor)
  })

  it('reports the dialog a click opened, and the dialog it closed', async () => {
    const window = await a.window()
    const open = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Open dialog')
    const result = await desktop.act(actOf(window, [clickElement(open.ref)], { settleMs: 1_000 }), SIGNAL)
    assert.equal(result.performed[0].kind, 'click')
    assert.equal(result.performed[0].via, 'invoke')
    const dialog = result.opened.find((item) => item.title === 'Fixture dialog')
    assert.ok(dialog, `the dialog is reported as opened: ${JSON.stringify(result.opened)}`)
    assert.equal(dialog.app, 'fixture.exe')
    await a.until((now) => now.dialogOpen, 'the dialog to be open')
    assert.ok(result.look?.related.some((item) => item.id === dialog.id), 'and listed with the window it belongs to')

    const inside = await desktop.look(lookOf(dialog, { image: false }), SIGNAL)
    const close = named(inside, 'Close dialog')
    const closed = await desktop.act(actOf(dialog, [clickElement(close.ref)], { settleMs: 1_000 }), SIGNAL)
    assert.ok(closed.closed.includes(dialog.id), `the dialog is reported as closed: ${JSON.stringify(closed.closed)}`)
    assert.equal(closed.look, null, 'the window that closed has no look')
    await a.until((now) => !now.dialogOpen, 'the dialog to be gone')
    const stale = await failure(desktop.look(lookOf(dialog), SIGNAL))
    assert.equal(stale.code, 'window-gone')
    const staleRef = await failure(desktop.act(actOf(window, [clickElement(close.ref)]), SIGNAL))
    assert.equal(staleRef.code, 'stale-element', 'a ref of the dialog means nothing in the window')
  })

  it('stops when the caller gives up, leaves nothing pressed and carries on afterwards', async () => {
    const window = await a.window()
    const notes = named(await desktop.look(lookOf(window, { image: false }), SIGNAL), 'Notes')
    await clearNotes(window, notes.ref)
    const long = 'abcdefghijklmnopqrstuvwxyz'.repeat(1_600)
    const controller = new AbortController()
    const started = Date.now()
    let ended = 'running'
    const typing = desktop.act(actOf(window, [{ kind: 'type', text: long }], { pace: 'smooth' }), controller.signal).then(
      () => {
        ended = 'finished'
      },
      (error: unknown) => {
        ended = error === controller.signal.reason ? 'stopped' : `failed: ${String(error)}`
      },
    )
    await eventually(async () => {
      assert.ok(!ended.startsWith('failed') && ended !== 'finished', `the typing ended before it was stopped: ${ended}`)
      return (await a.state()).notes.length > 200
    }, 'the typing to start')
    controller.abort(new Error('stop'))
    await typing
    assert.equal(ended, 'stopped')
    assert.ok(Date.now() - started < 20_000, 'it did not wait for all the text')
    // What was already sent may still be on its way into the field; the length must settle and stay.
    let settled = -1
    await eventually(async () => {
      const length = (await a.state()).notes.length
      await sleep(500)
      const again = (await a.state()).notes.length
      settled = again
      return length === again ? true : undefined
    }, 'the length of the text to stop growing', 30_000)
    assert.ok(settled < long.length, `only part of the text arrived: ${settled} of ${long.length}`)
    const next = await desktop.act(actOf(window, [keys({ modifiers: ['ctrl'], key: 'a' }), keys({ modifiers: [], key: 'delete' })]), SIGNAL)
    assert.deepEqual(next.performed.map((done) => done.kind), ['key', 'key'])
    await eventually(async () => (await a.state()).notes === '', 'the field to be cleared')
  })

  it('refuses a coordinate when the window has moved since the picture was taken', async () => {
    const window = await a.window()
    const look = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    const before = await a.state()
    await command(a, 'move 30 30')
    const state = await a.until((now) => now.box[0] !== before.box[0], 'the window to move')
    const error = await failure(desktop.act(actOf(window, [clickPoint(look.capture, [state.canvas[0] + 10, state.canvas[1] + 10])]), SIGNAL))
    assert.equal(error.code, 'stale-capture')
    assert.match(error.message, /moved or changed size since/)
    const fresh = await desktop.look(lookOf(window, { image: false, outline: 'none' }), SIGNAL)
    assert.notDeepEqual(fresh.capture.box, look.capture.box)
    const ok = await desktop.act(actOf(window, [clickPoint(fresh.capture, [state.canvas[0] + 10, state.canvas[1] + 10])]), SIGNAL)
    assert.deepEqual(ok.performed.map((done) => done.via), ['mouse'])
  })

  it('restores a minimized window to look at it, without taking the focus', async () => {
    const window = await a.window()
    await command(a, 'minimize')
    await a.until((now) => now.minimized, 'the window to be minimized')
    const listed = await eventually(async () => (await desktop.windows(SIGNAL)).find((item) => item.id === window.id && item.state === 'minimized'), 'the list to say it is minimized')
    assert.equal(listed.state, 'minimized')
    const look = await desktop.look(lookOf(window, { image: false }), SIGNAL)
    assert.equal(look.window.state, 'normal')
    await a.until((now) => !now.minimized, 'the window to be shown again')
    assert.ok(look.outline!.elements.length > 5)
  })
})

describe('the Windows helper with more than one window', { skip: onWindows ? false : 'these tests drive a real Windows desktop' }, () => {
  let b: Fixture

  before(async () => {
    if (!onWindows) return
    // On top of the first window, over its canvas. A program started in the background does not take the front on its
    // own (another window may be above it, such as the console the tests run in), so it is brought there.
    b = await launch('eNCode Fixture B', 200, 200)
    const second = await b.window()
    await desktop.focus({ window: second.id, allowed: [second.app] }, SIGNAL)
    await b.until((now) => now.focused, 'the second window to be in front')
  })

  after(async () => {
    if (!onWindows) return
    b?.child.kill()
  })

  it('paints over what another program shows on top of the window, so the picture holds nothing the call was not allowed to see', async () => {
    const first = await a.window()
    const second = await b.window()
    const look = await desktop.look(lookOf(first), SIGNAL)
    await keep('covered', look)
    assert.ok(look.capture.masked >= 1, 'something is painted over')
    const picture = decodePng(look.capture.data!)
    const inside: Point = [second.box[0] + 100, second.box[1] + 100]
    assert.ok(inside[0] > first.box[0] && inside[0] < first.box[0] + first.box[2] && inside[1] > first.box[1] && inside[1] < first.box[1] + first.box[3], 'the point is in both windows')
    const [x, y] = imagePoint(look.capture, inside)
    assert.deepEqual(picture.pixel(x, y), MASK)
    assert.equal(look.related.some((item) => item.id === second.id), true, 'and the window is listed as another window of the program')
  })

  it('refuses to click where another window is on top, and says whose it is', async () => {
    const first = await a.window()
    const look = await desktop.look(lookOf(first, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const centre: Point = [state.canvas[0] + Math.floor(state.canvas[2] / 2), state.canvas[1] + Math.floor(state.canvas[3] / 2)]
    const before = (await a.state()).events.length
    const error = await failure(desktop.act(actOf(first, [clickPoint(look.capture, centre)]), SIGNAL))
    assert.equal(error.code, 'covered')
    assert.match(error.message, /Another window of .* is on top of/)
    assert.equal((await a.state()).events.length, before, 'the click went nowhere')
    assert.equal((await b.state()).events.length, 0, 'and not to the window on top either')
  })

  it('brings a window to the front, and then input reaches it', async () => {
    const first = await a.window()
    const focused = await desktop.focus({ window: first.id, allowed: [first.app] }, SIGNAL)
    assert.equal(focused.foreground, true)
    await eventually(async () => (await a.state()).focused, 'the first window to hold the keyboard focus')
    const look = await desktop.look(lookOf(first, { image: false, outline: 'none' }), SIGNAL)
    const state = await a.state()
    const centre: Point = [state.canvas[0] + Math.floor(state.canvas[2] / 2), state.canvas[1] + Math.floor(state.canvas[3] / 2)]
    const before = state.events.length
    await desktop.act(actOf(first, [clickPoint(look.capture, centre)]), SIGNAL)
    const [down] = await eventsAfter(a, before, 2)
    assert.ok(down.startsWith('down '), down)
  })

  it('sends keys to the window in front only, and brings the window it was asked for forward first', async () => {
    const first = await a.window()
    const second = await b.window()
    await desktop.focus({ window: second.id, allowed: [second.app] }, SIGNAL)
    await eventually(async () => (await b.state()).focused, 'the second window to hold the keyboard focus')
    const before = (await a.state()).events.length
    await desktop.act(actOf(first, [keys({ modifiers: [], key: 'f7' })]), SIGNAL)
    const events = await eventsAfter(a, before, 1)
    assert.deepEqual(events, ['key F7'], 'the key went to the window the call named, which was brought forward')
    assert.equal((await b.state()).events.filter((event) => event === 'key F7').length, 0)
  })

  it('closes a window on request and reports it, with no look at what is gone', async () => {
    const second = await b.window()
    await desktop.focus({ window: second.id, allowed: [second.app] }, SIGNAL)
    const result = await desktop.act(actOf(second, [keys({ modifiers: ['alt'], key: 'f4' })]), SIGNAL)
    assert.ok(result.closed.includes(second.id), JSON.stringify(result.closed))
    assert.equal(result.look, null)
    assert.equal((await failure(desktop.look(lookOf(second), SIGNAL))).code, 'window-gone')
  })
})

describe('the Windows helper and eNCode\'s own windows', { skip: onWindows ? false : 'these tests drive a real Windows desktop' }, () => {
  it('never works on a window of eNCode\'s own, and says why', async () => {
    const own = await launch('eNCode Fixture Own', 120, 120)
    try {
      const guarded = createWindowsDesktop({ cacheDir: path.join(folder, 'helper'), allowElevated: true, ownPids: [(await own.state()).pid] })
      try {
        const window = (await guarded.windows(SIGNAL)).find((item) => item.title === 'eNCode Fixture Own')
        assert.ok(window)
        assert.match(window.blocked ?? '', /eNCode's own window/)
        const error = await failure(guarded.look(lookOf(window), SIGNAL))
        assert.equal(error.code, 'refused')
        assert.equal((await failure(guarded.act(actOf(window, [keys({ modifiers: [], key: 'home' })]), SIGNAL))).code, 'refused')
        assert.equal((await own.state()).events.length, 0)
      } finally {
        await guarded.dispose()
      }
    } finally {
      own.child.kill()
    }
  })

  it('does not work on a program running as administrator unless it is told to', async () => {
    let elevated = false
    try {
      await run('net', ['session'], { windowsHide: true })
      elevated = true
    } catch {
      elevated = false
    }
    const strict = createWindowsDesktop({ cacheDir: path.join(folder, 'helper') })
    try {
      const window = (await strict.windows(SIGNAL)).find((item) => item.title === 'eNCode Fixture A')
      assert.ok(window)
      if (elevated) {
        assert.match(window.blocked ?? '', /administrator/)
        assert.equal((await failure(strict.look(lookOf(window), SIGNAL))).code, 'refused')
      } else {
        assert.equal(window.blocked, undefined, 'an ordinary program is not blocked')
      }
    } finally {
      await strict.dispose()
    }
  })
})
