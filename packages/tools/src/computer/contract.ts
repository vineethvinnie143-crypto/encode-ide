/**
 * What the Computer tool needs from the machine, and the words both sides use.
 *
 * The tool (tool.ts) decides what to do and how it reads to the model; a backend does it on the
 * desktop: it lists windows, takes screenshots, reads the accessibility tree and sends mouse and
 * keyboard input. The Windows backend is a small program of our own (windows/); the fake in fake.ts
 * stands in for it in tests. Nothing here imports Electron or touches the operating system.
 *
 * Three things keep a call accurate, and each is the backend's job because only it sees the desktop
 * at the moment of the call:
 *   - every input names the window it is for and the applications it may reach (`allowed`), and the
 *     backend refuses when the window under the pointer or in the foreground belongs to another one;
 *   - a coordinate belongs to one capture (`CaptureId`), and is refused when the window has moved
 *     since, so a click never lands where the model did not look;
 *   - an element is addressed by the ref of the latest outline, and a ref whose element is gone is
 *     refused rather than guessed at.
 */

/** A rectangle in screen pixels: left, top, width, height. */
export type Box = readonly [x: number, y: number, width: number, height: number]
export type Point = readonly [x: number, y: number]

/** A program as the user knows it: its file name in lower case, such as "notepad.exe". */
export type AppId = string
/** A top-level window, such as "w3". Stable while the window lives. */
export type WindowId = string
/** An element of a window's outline, such as "e12". Stable while the element lives. */
export type ElementRef = string
/** One screenshot (or one outline that stands in for it), such as "s7". */
export type CaptureId = string

export type WindowState = 'normal' | 'minimized' | 'maximized'

export interface WindowInfo {
  id: WindowId
  app: AppId
  /** The program's name for people, such as "Notepad". */
  label: string
  title: string
  pid: number
  box: Box
  state: WindowState
  foreground: boolean
  /** Why the window can never be used, when it cannot: eNCode's own window, a program running as administrator, the taskbar. */
  blocked?: string
}

/** The roles an outline uses. A backend may add others; the tool prints them as they come. */
export const ROLES = [
  'window',
  'dialog',
  'pane',
  'group',
  'toolbar',
  'menubar',
  'menu',
  'menuitem',
  'button',
  'checkbox',
  'radio',
  'combobox',
  'edit',
  'document',
  'list',
  'listitem',
  'tab',
  'tabitem',
  'tree',
  'treeitem',
  'table',
  'row',
  'cell',
  'header',
  'link',
  'text',
  'image',
  'slider',
  'spinner',
  'progress',
  'scrollbar',
  'statusbar',
  'titlebar',
  'tooltip',
] as const

/** What is worth knowing about an element besides its name. */
export type ElementState = 'disabled' | 'focused' | 'checked' | 'mixed' | 'selected' | 'expanded' | 'collapsed' | 'readonly' | 'password' | 'busy' | 'required' | 'invalid'

/** What the element can do through the application's own accessibility interface, without the mouse. */
export type ElementAction = 'invoke' | 'toggle' | 'select' | 'expand' | 'set_value' | 'scroll'

export interface Element {
  ref: ElementRef
  role: string
  /** What the user reads on it. Empty when it has no name. */
  name: string
  /** The text of an edit, the position of a slider. Never a password's. */
  value?: string
  /** How deep it sits in the tree, after the outline left out the containers that say nothing. */
  depth: number
  box: Box
  states: readonly ElementState[]
  can: readonly ElementAction[]
}

export interface Capture {
  id: CaptureId
  /** The screen area the image shows. */
  box: Box
  /** The image's size. */
  width: number
  height: number
  /** Image pixels per screen pixel; 1 unless the area was too big to send whole. */
  scale: number
  mediaType: 'image/png' | 'image/jpeg'
  /** Base64. Absent when no image was asked for: the numbers still say how coordinates map. */
  data?: string
  /** How many areas were painted over because they belong to other applications or are password fields. */
  masked: number
}

export interface Outline {
  elements: Element[]
  /** How many elements the window has in view; more than `elements.length` when the outline was cut. */
  total: number
  focused?: ElementRef
}

export interface Look {
  window: WindowInfo
  /** Other windows of the same application that are showing: its dialogs and menus. */
  related: WindowInfo[]
  capture: Capture
  outline?: Outline
  /** The window looks different from the last time the backend looked. */
  changed: boolean
  /** False when the window was still changing when the wait for it ran out. */
  stable: boolean
}

export interface LookRequest {
  window: WindowId
  /** The applications this call may reach. The window's own must be among them. */
  allowed: readonly AppId[]
  /**
   * Send the image: `true` always, `'changed'` only when the window looks different from the last look (so an input that did
   * nothing costs no image), `false` never. Without an image the answer still says where the window is, so coordinates keep working.
   */
  image: boolean | 'changed'
  outline: 'none' | 'full' | { query?: string; role?: string }
  maxElements: number
  maxImageEdge: number
  maxImagePixels: number
  /** Show only this part of an earlier capture, at full detail. */
  zoom?: { capture: CaptureId; box: Box }
  /** Wait up to this long for the window to stop changing before looking. */
  settleMs?: number
}

/** Where an input goes: an element of the latest outline, or a pixel of a capture. */
export type Target = { element: ElementRef } | { point: Point; capture: CaptureId }

export type MouseButton = 'left' | 'right' | 'middle'

export type Step =
  | { kind: 'click'; target: Target; button: MouseButton; count: 1 | 2 | 3 }
  | { kind: 'move'; target: Target }
  | { kind: 'drag'; from: Target; to: Target }
  | { kind: 'scroll'; target?: Target; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  /** Types text; with a target, that element gets the focus first. */
  | { kind: 'type'; text: string; target?: Target }
  | { kind: 'key'; combos: readonly KeyCombo[] }
  | { kind: 'set_value'; element: ElementRef; text: string }
  | { kind: 'select'; element: ElementRef }

export interface KeyCombo {
  modifiers: readonly ('ctrl' | 'alt' | 'shift')[]
  /** A name from keys.ts. */
  key: string
}

export interface ActRequest {
  window: WindowId
  allowed: readonly AppId[]
  steps: readonly Step[]
  /** Where the agent left the cursor, when the same task is still going: anywhere else means the user moved it. */
  expectCursor?: Point
  look: Pick<LookRequest, 'image' | 'outline' | 'maxElements' | 'maxImageEdge' | 'maxImagePixels'>
  /** The longest to wait for the window to stop changing after the input. */
  settleMs: number
  /** `smooth` moves the pointer along a path a person can follow; `instant` jumps (tests). */
  pace: 'smooth' | 'instant'
}

export interface Performed {
  kind: Step['kind']
  /** How it was done: through the element's own interface, or with the mouse or keys. */
  via: 'invoke' | 'toggle' | 'value' | 'select' | 'expand' | 'mouse' | 'keys'
  /** Something the model should know about how it went, such as why the mouse was used instead of the element's own interface. */
  detail?: string
}

export interface ActResult {
  performed: Performed[]
  /** The window after the input; null when the input closed it. */
  look: Look | null
  /** Windows that were not there before the input. */
  opened: WindowInfo[]
  closed: WindowId[]
  /** Where the cursor ended. */
  cursor: Point
}

/** An application the person can start from the Start menu: a program, or an app from the Store. */
export interface StartApp {
  /** As the Start menu shows it: "Discord". */
  name: string
  /** The shell's own id for it, which is what starts it. Never a command line. */
  id: string
  /** The program it runs, when the shell says: "discord.exe". A Store app has none. */
  app?: AppId
}

export interface OpenRequest {
  /** The id of an application from `apps`. */
  id: string
  /** For the answer: "Discord". */
  name: string
  /** How long to wait for a window of it, ms. */
  waitMs: number
}

export interface BackendInfo {
  platform: NodeJS.Platform
  /** The backend's version, so a stale copy is told from a fresh one. */
  version: string
  /** Screen scaling in percent for the primary display. */
  scale: number
  monitors: readonly Box[]
}

export type DesktopErrorCode =
  /** There is no desktop to use: the helper cannot start, the screen is locked or the session is disconnected. */
  | 'unavailable'
  | 'window-gone'
  /** The window belongs to an application the call may not reach. */
  | 'not-allowed'
  /** Another window is on top of the place the input would land. */
  | 'covered'
  /** The window moved or changed size since the capture the coordinate belongs to. */
  | 'stale-capture'
  | 'stale-element'
  | 'no-element'
  /** The application does not answer. */
  | 'hung'
  /** The focused field is a password field. */
  | 'password'
  /** The user used the mouse or the keyboard while the agent worked. */
  | 'interrupted'
  /** Another chat holds the desktop. */
  | 'busy'
  | 'timeout'
  /** The backend never works on this window: eNCode's own, an administrator's. */
  | 'refused'
  | 'failed'

/** A failure the model can be told about. The message is written for it. */
export class DesktopError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DesktopError'
  }
}

export interface DesktopBackend {
  /** Starts the backend if it is not running (the first call compiles and starts the helper). */
  ready(signal: AbortSignal): Promise<BackendInfo>
  /** The windows on the desktop, front to back. */
  windows(signal: AbortSignal): Promise<WindowInfo[]>
  /** Restores the window if it is minimized and brings it to the front. */
  focus(request: { window: WindowId; allowed: readonly AppId[] }, signal: AbortSignal): Promise<WindowInfo>
  look(request: LookRequest, signal: AbortSignal): Promise<Look>
  /** Does the steps in order, stops at the first that fails, then waits for the window to settle and looks. */
  act(request: ActRequest, signal: AbortSignal): Promise<ActResult>
  /** The cursor, in screen pixels. */
  cursor(signal: AbortSignal): Promise<Point>
  /** The applications of the Start menu that can be started. */
  apps(signal: AbortSignal): Promise<StartApp[]>
  /**
   * Starts an application the way the Start menu does: the shell starts it, so it is the person's own program and not
   * eNCode's, and one that already runs, in the notification area or behind other windows, shows its window again.
   * Resolves with that window once it shows, or null when none did in time.
   */
  open(request: OpenRequest, signal: AbortSignal): Promise<WindowInfo | null>
  dispose(): Promise<void>
}

/** Knobs a person can turn, with the defaults the tool ships. */
export interface DesktopOptions {
  /** Actions a turn may take before the tool stops and asks the user. */
  maxActionsPerTurn: number
  /** The longest an input waits for the window to settle, ms. */
  settleMs: number
  pace: 'smooth' | 'instant'
}

export const DEFAULT_DESKTOP_OPTIONS: DesktopOptions = {
  maxActionsPerTurn: 150,
  settleMs: 1_200,
  pace: 'smooth',
}
