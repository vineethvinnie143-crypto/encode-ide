/**
 * A desktop in memory, for tests and for running the app without a real one.
 *
 * It keeps the promises the real backend makes (see contract.ts): it refuses a window outside `allowed`,
 * a coordinate whose capture is stale or unknown, an element that is gone, and an input that would land
 * under another window. What the windows hold is a small tree of elements a test describes; invoking an
 * element can change the scene, so a flow (open a dialog, type, confirm) can be played through the tool.
 */
import {
  DesktopError,
  type ActRequest,
  type ActResult,
  type AppId,
  type BackendInfo,
  type Box,
  type Capture,
  type DesktopBackend,
  type Element,
  type ElementAction,
  type ElementState,
  type Look,
  type LookRequest,
  type Performed,
  type Point,
  type Step,
  type Target,
  type WindowId,
  type WindowInfo,
  type WindowState,
} from './contract'
import { contains, fitImage, sameBox, toScreen } from './geometry'
import { matchElements } from './outline'

export interface FakeElement {
  role: string
  name?: string
  value?: string
  states?: ElementState[]
  can?: ElementAction[]
  box?: Box
  children?: FakeElement[]
  /** What clicking or invoking the element does to the scene. */
  invoke?: (desktop: FakeDesktop) => void
}

export interface FakeWindow {
  app: AppId
  label?: string
  title: string
  box?: Box
  state?: WindowState
  blocked?: string
  elements: FakeElement[]
}

interface Entry {
  info: WindowInfo
  elements: FakeElement[]
  version: number
  seen: number
  captures: Map<string, Box>
}

export interface FakeCall {
  op: 'ready' | 'windows' | 'focus' | 'look' | 'act' | 'cursor'
  request?: unknown
}

const ROW = 24

export class FakeDesktop implements DesktopBackend {
  readonly calls: FakeCall[] = []
  /** Areas of the screen that another window covers: an input landing in one is refused. */
  readonly covers: Box[] = []
  cursorAt: Point = [0, 0]
  private readonly entries = new Map<WindowId, Entry>()
  private readonly refs = new Map<FakeElement, string>()
  private readonly byRef = new Map<string, FakeElement>()
  private windowCount = 0
  private elementCount = 0
  private captureCount = 0
  private failure: DesktopError | undefined
  private foreground: WindowId | undefined
  disposed = false

  constructor(windows: readonly FakeWindow[] = [], private readonly options: { unavailable?: string; scale?: number } = {}) {
    for (const window of windows) this.add(window)
  }

  // ---------------------------------------------------------------- the scene

  /** Opens a window and returns its id. */
  add(window: FakeWindow): WindowId {
    const id = `w${++this.windowCount}`
    const box: Box = window.box ?? [100 * this.windowCount, 80, 800, 600]
    const info: WindowInfo = {
      id,
      app: window.app,
      label: window.label ?? window.app.replace(/\.exe$/, ''),
      title: window.title,
      pid: 1000 + this.windowCount,
      box,
      state: window.state ?? 'normal',
      foreground: false,
      ...(window.blocked ? { blocked: window.blocked } : {}),
    }
    this.entries.set(id, { info, elements: window.elements, version: 1, seen: 0, captures: new Map() })
    this.foreground = id
    return id
  }

  close(id: WindowId): void {
    this.entries.delete(id)
    if (this.foreground === id) this.foreground = [...this.entries.keys()].pop()
  }

  move(id: WindowId, box: Box): void {
    const entry = this.entry(id)
    entry.info = { ...entry.info, box }
    entry.version++
  }

  /** Changes the scene of a window: the next look sees a change. */
  change(id: WindowId, update: (elements: FakeElement[]) => void): void {
    const entry = this.entry(id)
    update(entry.elements)
    entry.version++
  }

  /** The next call fails with this. */
  failNext(code: DesktopError['code'], message: string): void {
    this.failure = new DesktopError(code, message)
  }

  /** The ref the tool saw for an element, once an outline listed it. */
  refOf(element: FakeElement): string | undefined {
    return this.refs.get(element)
  }

  private entry(id: WindowId): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new DesktopError('window-gone', `Window ${id} is gone.`)
    return entry
  }

  private check(id: WindowId, allowed: readonly AppId[]): Entry {
    this.throwPending()
    const entry = this.entry(id)
    if (entry.info.blocked) throw new DesktopError('refused', entry.info.blocked)
    if (!allowed.includes(entry.info.app)) throw new DesktopError('not-allowed', `${entry.info.app} is not allowed for this call.`)
    return entry
  }

  private throwPending(): void {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
  }

  // ---------------------------------------------------------------- outlines

  private flatten(entry: Entry): { element: FakeElement; depth: number; box: Box }[] {
    const out: { element: FakeElement; depth: number; box: Box }[] = []
    const walk = (list: FakeElement[], depth: number) => {
      for (const element of list) {
        const row = out.length
        const box: Box = element.box ?? [entry.info.box[0] + 8 + depth * 12, entry.info.box[1] + 30 + row * ROW, 200, ROW - 2]
        out.push({ element, depth, box })
        if (element.children) walk(element.children, depth + 1)
      }
    }
    walk(entry.elements, 0)
    return out
  }

  private elementsOf(entry: Entry): Element[] {
    return this.flatten(entry).map(({ element, depth, box }) => {
      let ref = this.refs.get(element)
      if (!ref) {
        ref = `e${++this.elementCount}`
        this.refs.set(element, ref)
        this.byRef.set(ref, element)
      }
      return {
        ref,
        role: element.role,
        name: element.name ?? '',
        ...(element.value !== undefined && !element.states?.includes('password') ? { value: element.value } : {}),
        depth,
        box,
        states: element.states ?? [],
        can: element.can ?? [],
      }
    })
  }

  private find(entry: Entry, ref: string): { element: FakeElement; box: Box } {
    const found = this.flatten(entry).find((item) => this.refs.get(item.element) === ref)
    if (!found) throw new DesktopError('stale-element', `Element ${ref} is no longer in ${entry.info.id}.`)
    return found
  }

  // ---------------------------------------------------------------- the backend

  async ready(): Promise<BackendInfo> {
    this.calls.push({ op: 'ready' })
    if (this.options.unavailable) throw new DesktopError('unavailable', this.options.unavailable)
    return { platform: 'win32', version: 'fake', scale: this.options.scale ?? 100, monitors: [[0, 0, 1920, 1080]] }
  }

  async windows(): Promise<WindowInfo[]> {
    this.calls.push({ op: 'windows' })
    this.throwPending()
    return [...this.entries.values()].map((entry) => ({ ...entry.info, foreground: this.foreground === entry.info.id }))
  }

  async focus(request: { window: WindowId; allowed: readonly AppId[] }): Promise<WindowInfo> {
    this.calls.push({ op: 'focus', request })
    const entry = this.check(request.window, request.allowed)
    this.foreground = entry.info.id
    entry.info = { ...entry.info, state: entry.info.state === 'minimized' ? 'normal' : entry.info.state }
    return { ...entry.info, foreground: true }
  }

  private look_(entry: Entry, request: Pick<LookRequest, 'image' | 'outline' | 'maxElements' | 'maxImageEdge' | 'maxImagePixels'> & { zoom?: LookRequest['zoom'] }): Look {
    const changed = entry.version !== entry.seen
    entry.seen = entry.version
    const box = request.zoom ? this.zoomBox(entry, request.zoom) : entry.info.box
    const fit = fitImage(box[2], box[3], request.maxImageEdge, request.maxImagePixels)
    const id = `s${++this.captureCount}`
    if (!request.zoom) entry.captures.set(id, box)
    const wantsImage = request.image === true || (request.image === 'changed' && changed) || Boolean(request.zoom)
    const capture: Capture = {
      id,
      box,
      width: fit.width,
      height: fit.height,
      scale: fit.scale,
      mediaType: 'image/png',
      ...(wantsImage ? { data: Buffer.from(`${entry.info.id}:${entry.version}`).toString('base64') } : {}),
      masked: 0,
    }
    const all = this.elementsOf(entry)
    let outline: Look['outline']
    if (request.outline === 'full') {
      outline = { elements: all.slice(0, request.maxElements), total: all.length, ...this.focusedRef(entry, all) }
    } else if (request.outline !== 'none') {
      const found = matchElements(all, request.outline)
      outline = { elements: found, total: found.length }
    }
    const related = [...this.entries.values()].filter((other) => other !== entry && other.info.app === entry.info.app).map((other) => other.info)
    return { window: { ...entry.info, foreground: this.foreground === entry.info.id }, related, capture, ...(outline ? { outline } : {}), changed, stable: true }
  }

  private focusedRef(entry: Entry, all: Element[]): { focused?: string } {
    const focused = all.find((element) => element.states.includes('focused'))
    return focused ? { focused: focused.ref } : {}
  }

  private zoomBox(entry: Entry, zoom: NonNullable<LookRequest['zoom']>): Box {
    const source = entry.captures.get(zoom.capture)
    if (!source) throw new DesktopError('stale-capture', `Capture ${zoom.capture} is unknown.`)
    const fit = fitImage(source[2], source[3])
    const scale = fit.scale
    return [source[0] + Math.round(zoom.box[0] / scale), source[1] + Math.round(zoom.box[1] / scale), Math.round(zoom.box[2] / scale), Math.round(zoom.box[3] / scale)]
  }

  async look(request: LookRequest): Promise<Look> {
    this.calls.push({ op: 'look', request })
    const entry = this.check(request.window, request.allowed)
    return this.look_(entry, request)
  }

  private screenPoint(entry: Entry, target: Target): { point: Point; element?: FakeElement } {
    if ('element' in target) {
      const found = this.find(entry, target.element)
      return { point: [found.box[0] + Math.floor(found.box[2] / 2), found.box[1] + Math.floor(found.box[3] / 2)], element: found.element }
    }
    const box = entry.captures.get(target.capture)
    if (!box) throw new DesktopError('stale-capture', `Screenshot ${target.capture} is unknown. Take a new one.`)
    if (!sameBox(box, entry.info.box)) throw new DesktopError('stale-capture', `${entry.info.id} moved or changed size since screenshot ${target.capture}.`)
    const fit = fitImage(box[2], box[3])
    const point = toScreen(target.point, { box, scale: fit.scale })
    const hit = this.flatten(entry).filter((item) => contains(item.box, point)).pop()
    return { point, ...(hit ? { element: hit.element } : {}) }
  }

  private land(entry: Entry, point: Point): void {
    if (!contains(entry.info.box, point)) throw new DesktopError('covered', `(${point[0]}, ${point[1]}) is outside ${entry.info.id}.`)
    if (this.covers.some((box) => contains(box, point))) throw new DesktopError('covered', `Another window is on top of (${point[0]}, ${point[1]}).`)
  }

  private perform(entry: Entry, step: Step): Performed {
    switch (step.kind) {
      case 'click':
      case 'move': {
        const { point, element } = this.screenPoint(entry, step.target)
        this.land(entry, point)
        this.cursorAt = point
        if (step.kind === 'move') return { kind: 'move', via: 'mouse' }
        if (element) {
          if (element.states?.includes('disabled')) throw new DesktopError('failed', `${element.name ?? element.role} is disabled.`)
          for (const other of this.flatten(entry)) if (other.element.states?.includes('focused')) other.element.states = other.element.states.filter((state) => state !== 'focused')
          if (element.role === 'edit') element.states = [...(element.states ?? []), 'focused']
          const invokes = element.can?.includes('invoke') || element.can?.includes('toggle')
          if (element.can?.includes('toggle')) {
            element.states = element.states?.includes('checked') ? element.states.filter((state) => state !== 'checked') : [...(element.states ?? []), 'checked']
          }
          element.invoke?.(this)
          entry.version++
          return { kind: 'click', via: 'element' in step.target && invokes ? (element.can?.includes('toggle') ? 'toggle' : 'invoke') : 'mouse' }
        }
        return { kind: 'click', via: 'mouse' }
      }
      case 'drag': {
        const from = this.screenPoint(entry, step.from).point
        const to = this.screenPoint(entry, step.to).point
        this.land(entry, from)
        this.land(entry, to)
        this.cursorAt = to
        entry.version++
        return { kind: 'drag', via: 'mouse' }
      }
      case 'scroll': {
        if (step.target) {
          const { point } = this.screenPoint(entry, step.target)
          this.land(entry, point)
          this.cursorAt = point
        }
        entry.version++
        return { kind: 'scroll', via: 'mouse' }
      }
      case 'type': {
        if (step.target) {
          const { point, element } = this.screenPoint(entry, step.target)
          this.land(entry, point)
          this.cursorAt = point
          for (const other of this.flatten(entry)) if (other.element.states?.includes('focused')) other.element.states = other.element.states.filter((state) => state !== 'focused')
          if (element) element.states = [...(element.states ?? []), 'focused']
        }
        const focused = this.flatten(entry).find((item) => item.element.states?.includes('focused'))?.element
        if (!focused) throw new DesktopError('failed', 'Nothing has the keyboard focus.')
        if (focused.states?.includes('password')) throw new DesktopError('password', 'The focused field is a password field.')
        focused.value = (focused.value ?? '') + step.text
        entry.version++
        return { kind: 'type', via: 'keys' }
      }
      case 'key':
        entry.version++
        return { kind: 'key', via: 'keys' }
      case 'set_value': {
        const { element } = this.find(entry, step.element)
        if (!element.can?.includes('set_value')) throw new DesktopError('failed', `${element.name ?? element.role} cannot be set directly.`)
        element.value = step.text
        entry.version++
        return { kind: 'set_value', via: 'value' }
      }
      case 'select': {
        const { element } = this.find(entry, step.element)
        element.states = [...(element.states ?? []), 'selected']
        element.invoke?.(this)
        entry.version++
        return { kind: 'select', via: 'select' }
      }
    }
  }

  async act(request: ActRequest): Promise<ActResult> {
    this.calls.push({ op: 'act', request })
    const entry = this.check(request.window, request.allowed)
    if (request.expectCursor && (Math.abs(request.expectCursor[0] - this.cursorAt[0]) > 6 || Math.abs(request.expectCursor[1] - this.cursorAt[1]) > 6)) {
      throw new DesktopError('interrupted', 'The mouse is not where I left it.')
    }
    const before = new Set(this.entries.keys())
    const performed = request.steps.map((step) => this.perform(entry, step))
    const opened = [...this.entries.values()].filter((other) => !before.has(other.info.id)).map((other) => other.info)
    const closed = [...before].filter((id) => !this.entries.has(id))
    const look = this.entries.has(entry.info.id) ? this.look_(entry, request.look) : null
    return { performed, look, opened, closed, cursor: this.cursorAt }
  }

  async cursor(): Promise<Point> {
    this.calls.push({ op: 'cursor' })
    return this.cursorAt
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}
