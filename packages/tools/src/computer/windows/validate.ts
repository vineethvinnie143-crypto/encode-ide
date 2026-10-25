/**
 * What the helper sends is checked before the tool uses it. The helper is our own program, but it is a separate
 * process written in another language: a field of the wrong kind should stop at the door with a message that says
 * where, not turn into a coordinate that is NaN three calls later.
 */
import {
  DesktopError,
  type ActResult,
  type BackendInfo,
  type Box,
  type Capture,
  type Element,
  type ElementAction,
  type ElementState,
  type Look,
  type Outline,
  type Performed,
  type Point,
  type StartApp,
  type WindowInfo,
} from '../contract'

type Fields = Record<string, unknown>

function bad(where: string): never {
  throw new DesktopError('failed', `The desktop helper answered something unexpected (${where}).`)
}

function record(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(where)
  return value as Fields
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') bad(where)
  return value
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, where)
}

function integer(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) bad(where)
  return value
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') bad(where)
  return value
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) bad(where)
  return value
}

function texts(value: unknown, where: string): string[] {
  return list(value, where).map((item, index) => text(item, `${where}[${index}]`))
}

export function asBox(value: unknown, where: string): Box {
  const numbers = list(value, where)
  if (numbers.length !== 4) bad(where)
  return [integer(numbers[0], where), integer(numbers[1], where), integer(numbers[2], where), integer(numbers[3], where)]
}

export function asPoint(value: unknown, where: string): Point {
  const numbers = list(value, where)
  if (numbers.length !== 2) bad(where)
  return [integer(numbers[0], where), integer(numbers[1], where)]
}

const WINDOW_ID = /^w\d{1,9}$/
const ELEMENT_REF = /^e\d{1,9}$/
const CAPTURE_ID = /^s\d{1,9}$/

export function asWindow(value: unknown, where = 'window'): WindowInfo {
  const source = record(value, where)
  const id = text(source.id, `${where}.id`)
  if (!WINDOW_ID.test(id)) bad(`${where}.id`)
  const state = text(source.state, `${where}.state`)
  if (state !== 'normal' && state !== 'minimized' && state !== 'maximized') bad(`${where}.state`)
  const blocked = optionalText(source.blocked, `${where}.blocked`)
  return {
    id,
    app: text(source.app, `${where}.app`),
    label: text(source.label, `${where}.label`),
    title: text(source.title, `${where}.title`),
    pid: integer(source.pid, `${where}.pid`),
    box: asBox(source.box, `${where}.box`),
    state,
    foreground: bool(source.foreground, `${where}.foreground`),
    ...(blocked ? { blocked } : {}),
  }
}

export function asWindows(value: unknown): WindowInfo[] {
  return list(value, 'windows').map((item, index) => asWindow(item, `windows[${index}]`))
}

function asElement(value: unknown, where: string): Element {
  const source = record(value, where)
  const ref = text(source.ref, `${where}.ref`)
  if (!ELEMENT_REF.test(ref)) bad(`${where}.ref`)
  const value_ = optionalText(source.value, `${where}.value`)
  return {
    ref,
    role: text(source.role, `${where}.role`),
    name: text(source.name, `${where}.name`),
    ...(value_ !== undefined ? { value: value_ } : {}),
    depth: integer(source.depth, `${where}.depth`),
    box: asBox(source.box, `${where}.box`),
    states: texts(source.states, `${where}.states`) as ElementState[],
    can: texts(source.can, `${where}.can`) as ElementAction[],
  }
}

function asOutline(value: unknown): Outline {
  const source = record(value, 'outline')
  const elements = list(source.elements, 'outline.elements').map((item, index) => asElement(item, `outline.elements[${index}]`))
  const focused = optionalText(source.focused, 'outline.focused')
  return { elements, total: integer(source.total, 'outline.total'), ...(focused ? { focused } : {}) }
}

function asCapture(value: unknown): Capture {
  const source = record(value, 'capture')
  const id = text(source.id, 'capture.id')
  if (!CAPTURE_ID.test(id)) bad('capture.id')
  const mediaType = text(source.mediaType, 'capture.mediaType')
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') bad('capture.mediaType')
  const scale = source.scale
  // A zoom enlarges up to four times (ADR 0121); a screenshot is never larger than the screen.
  if (typeof scale !== 'number' || !(scale > 0) || scale > 4) bad('capture.scale')
  const data = optionalText(source.data, 'capture.data')
  const marks = source.marks === undefined ? undefined : integer(source.marks, 'capture.marks')
  if (marks !== undefined && marks < 0) bad('capture.marks')
  let grid: Capture['grid']
  if (source.grid !== undefined) {
    const fields = record(source.grid, 'capture.grid')
    const step = integer(fields.step, 'capture.grid.step')
    const of = text(fields.of, 'capture.grid.of')
    if (step <= 0 || !CAPTURE_ID.test(of)) bad('capture.grid')
    grid = { step, of }
  }
  return {
    id,
    box: asBox(source.box, 'capture.box'),
    width: integer(source.width, 'capture.width'),
    height: integer(source.height, 'capture.height'),
    scale,
    mediaType,
    ...(data ? { data } : {}),
    masked: integer(source.masked, 'capture.masked'),
    ...(marks ? { marks } : {}),
    ...(grid ? { grid } : {}),
  }
}

export function asLook(value: unknown): Look {
  const source = record(value, 'look')
  return {
    window: asWindow(source.window, 'look.window'),
    related: list(source.related, 'look.related').map((item, index) => asWindow(item, `look.related[${index}]`)),
    capture: asCapture(source.capture),
    ...(source.outline !== undefined ? { outline: asOutline(source.outline) } : {}),
    changed: bool(source.changed, 'look.changed'),
    stable: bool(source.stable, 'look.stable'),
  }
}

const KINDS = new Set(['click', 'move', 'drag', 'scroll', 'type', 'key', 'set_value', 'select'])
const VIAS = new Set(['invoke', 'toggle', 'value', 'select', 'expand', 'mouse', 'keys'])

function asPerformed(value: unknown, where: string): Performed {
  const source = record(value, where)
  const kind = text(source.kind, `${where}.kind`)
  const via = text(source.via, `${where}.via`)
  if (!KINDS.has(kind) || !VIAS.has(via)) bad(where)
  const detail = optionalText(source.detail, `${where}.detail`)
  let on: Performed['on']
  if (source.on !== undefined) {
    const fields = record(source.on, `${where}.on`)
    const ref = optionalText(fields.ref, `${where}.on.ref`)
    if (ref !== undefined && !ELEMENT_REF.test(ref)) bad(`${where}.on.ref`)
    on = { ...(ref ? { ref } : {}), role: text(fields.role, `${where}.on.role`), name: text(fields.name, `${where}.on.name`) }
  }
  return { kind: kind as Performed['kind'], via: via as Performed['via'], ...(detail ? { detail } : {}), ...(on ? { on } : {}) }
}

export function asAct(value: unknown): ActResult {
  const source = record(value, 'act')
  return {
    performed: list(source.performed, 'act.performed').map((item, index) => asPerformed(item, `act.performed[${index}]`)),
    look: source.look === null || source.look === undefined ? null : asLook(source.look),
    opened: list(source.opened, 'act.opened').map((item, index) => asWindow(item, `act.opened[${index}]`)),
    closed: texts(source.closed, 'act.closed'),
    cursor: asPoint(source.cursor, 'act.cursor'),
  }
}

export function asInfo(value: unknown): BackendInfo {
  const source = record(value, 'ready')
  return {
    platform: 'win32',
    version: text(source.version, 'ready.version'),
    scale: integer(source.scale, 'ready.scale'),
    monitors: list(source.monitors, 'ready.monitors').map((item, index) => asBox(item, `ready.monitors[${index}]`)),
  }
}

/** The Start menu's applications: at most a few thousand, each with a name and the shell's id for it. */
export function asApps(value: unknown, where = 'apps'): StartApp[] {
  const items = list(value, where)
  if (items.length > 5_000) bad(where)
  return items.map((item, index) => {
    const source = record(item, `${where}[${index}]`)
    const name = text(source.name, `${where}[${index}].name`)
    const id = text(source.id, `${where}[${index}].id`)
    const app = optionalText(source.app, `${where}[${index}].app`)
    if (!name.trim() || !id || id.length > 2_048 || name.length > 512) bad(`${where}[${index}]`)
    return { name, id, ...(app ? { app } : {}) }
  })
}

/** The window an application showed when it was opened, or null when none did in time. */
export function asOpened(value: unknown): WindowInfo | null {
  return value === null ? null : asWindow(value, 'opened')
}
