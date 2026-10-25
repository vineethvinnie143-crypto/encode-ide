/**
 * What the Computer tool remembers between its calls in one session: which window it is working on,
 * what it last saw of each (so a coordinate means the pixel the model looked at), and how many inputs
 * the turn has made. The backend is shared by every session; this is the session's own.
 */
import type { AppId, Capture, DesktopBackend, DesktopOptions, Element, Look, Point, StartApp, WindowId, WindowInfo } from './contract'

/** A capture without its image: enough to map a coordinate. */
export type CaptureRef = Omit<Capture, 'data' | 'mediaType'>

export class ComputerState {
  /** The window the next call works on when it names none. */
  target: WindowId | undefined
  /** The user took over in this turn: no more inputs until they speak again. */
  takenOverIn: string | undefined
  /** Where the agent left the cursor, and in which turn. */
  cursor: { at: Point; turnId: string; time: number } | undefined
  /** The Start menu as last read, and when: asked before an open is approved and again when it runs. */
  startMenu: { apps: StartApp[]; at: number } | undefined

  private readonly windows = new Map<WindowId, WindowInfo>()
  private readonly captures = new Map<WindowId, CaptureRef>()
  private readonly outlines = new Map<WindowId, Element[]>()
  private turnId: string | undefined
  private count = 0

  window(id: WindowId): WindowInfo | undefined {
    return this.windows.get(id)
  }

  /** Every window of the latest listing. */
  knownWindows(): WindowInfo[] {
    return [...this.windows.values()]
  }

  replaceWindows(list: readonly WindowInfo[]): void {
    const alive = new Set(list.map((window) => window.id))
    for (const id of [...this.windows.keys()]) if (!alive.has(id)) this.forget(id)
    for (const window of list) this.windows.set(window.id, window)
  }

  /** Adds windows to what is known without dropping the others. */
  noteWindows(list: readonly WindowInfo[]): void {
    for (const window of list) this.windows.set(window.id, window)
  }

  forget(id: WindowId): void {
    this.windows.delete(id)
    this.captures.delete(id)
    this.outlines.delete(id)
    if (this.target === id) this.target = undefined
  }

  /** Remembers a look: the window, how the capture maps, and, for a whole outline, the elements to compare the next one with. */
  remember(look: Look, options: { whole: boolean; zoom?: boolean }): void {
    this.windows.set(look.window.id, look.window)
    for (const related of look.related) this.windows.set(related.id, related)
    if (!options.zoom) {
      const { data: _data, mediaType: _type, ...ref } = look.capture
      this.captures.set(look.window.id, ref)
    }
    if (options.whole && look.outline) this.outlines.set(look.window.id, look.outline.elements)
  }

  capture(id: WindowId): CaptureRef | undefined {
    return this.captures.get(id)
  }

  outline(id: WindowId): Element[] | undefined {
    return this.outlines.get(id)
  }

  /** Counts an input of this turn. False when the turn has made all it may. */
  countInput(turnId: string, limit: number): boolean {
    if (this.turnId !== turnId) {
      this.turnId = turnId
      this.count = 0
    }
    if (this.count >= limit) return false
    this.count++
    return true
  }

  /** The cursor the agent left, when this is the same task: a different turn, or a long pause, says nothing about where it should be. */
  expectedCursor(turnId: string, now: number, withinMs = 20_000): Point | undefined {
    const cursor = this.cursor
    return cursor && cursor.turnId === turnId && now - cursor.time <= withinMs ? cursor.at : undefined
  }
}

/** What a session holds for the Computer tool. */
export interface DesktopServices {
  backend: DesktopBackend
  state: ComputerState
  options: DesktopOptions
}

/** What the tool sees of it in one call: the services, and two answers only the running loop can give. */
export interface DesktopHandle extends DesktopServices {
  /** Whether the agent may use the application now: the user approved it, or the approval policy is Full access. */
  permitted(app: AppId): boolean
  /** Whether the model can read the images in a result. */
  vision(): boolean
}
