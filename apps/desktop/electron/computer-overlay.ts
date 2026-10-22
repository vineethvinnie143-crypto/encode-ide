/**
 * Electron's side of the banner shown while the agent uses the computer (see services/computer-control.ts for when it
 * is shown, services/computer-overlay-page.ts for what it looks like).
 *
 * The window never takes the keyboard or the mouse focus: the agent is typing into some other program, and a banner
 * that stole the focus would send its keys here. It is kept out of screenshots (the agent should not see it or try to
 * click it, and a model reading pixels has no use for it), out of the taskbar and out of Alt+Tab, and its page may
 * run one script and reach nothing: no network, no permissions, no new windows.
 */
import { BrowserWindow, globalShortcut, ipcMain, screen, type Display, type IpcMainEvent } from 'electron'
import path from 'node:path'
import type { Overlay, OverlayState, Shortcuts } from './services/computer-control'
import { OVERLAY_CHANNELS, OVERLAY_MIN_WIDTH, overlayBounds, overlayUrl } from './services/computer-overlay-page'

/** The banner is shown without waiting for its page to say how wide it is after this long, ms. */
const SHOW_ANYWAY_AFTER_MS = 1_500
/** A banner whose window disappears is made again this many times in a row. */
const MAX_REOPENS = 3

export const electronShortcuts: Shortcuts = {
  register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
  unregister: (accelerator) => globalShortcut.unregister(accelerator),
}

export interface BannerOptions {
  /** The screen the person is looking at, where the banner goes. It is asked when the banner appears and the banner stays on it. */
  display?(): Display
  /** The Stop button was pressed. */
  onStop(): void
  log?(message: string): void
}

export class Banner implements Overlay {
  private win: BrowserWindow | null = null
  private state: OverlayState | null = null
  private pageReady = false
  private visible = false
  private width = OVERLAY_MIN_WIDTH
  private reopens = 0
  private showTimer: NodeJS.Timeout | undefined
  private displayId: number | undefined

  constructor(private readonly o: BannerOptions) {
    ipcMain.on(OVERLAY_CHANNELS.ready, this.onReady)
    ipcMain.on(OVERLAY_CHANNELS.size, this.onSize)
    ipcMain.on(OVERLAY_CHANNELS.stop, this.onStop)
  }

  show(state: OverlayState): void {
    this.state = state
    this.reopens = 0
    if (!this.win) this.open()
    else this.push()
  }

  update(state: OverlayState): void {
    this.state = state
    this.place()
    this.push()
  }

  hide(): void {
    this.state = null
    this.close()
  }

  dispose(): void {
    ipcMain.removeListener(OVERLAY_CHANNELS.ready, this.onReady)
    ipcMain.removeListener(OVERLAY_CHANNELS.size, this.onSize)
    ipcMain.removeListener(OVERLAY_CHANNELS.stop, this.onStop)
    this.hide()
  }

  /** The work area of the screen the banner is on; the main screen if that one was unplugged. */
  private workArea() {
    const displays = screen.getAllDisplays()
    return (displays.find((display) => display.id === this.displayId) ?? screen.getPrimaryDisplay()).workArea
  }

  private open(): void {
    this.displayId = (this.o.display?.() ?? screen.getPrimaryDisplay()).id
    const win = new BrowserWindow({
      ...overlayBounds(this.workArea(), OVERLAY_MIN_WIDTH),
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      title: 'eNCode',
      // A tool window is left out of Alt+Tab.
      ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webviewTag: false,
        devTools: false,
        // Its own session: the rules below must not replace the main window's.
        partition: 'eNCode-computer-banner',
      },
    })
    this.win = win
    this.pageReady = false
    this.visible = false
    this.width = OVERLAY_MIN_WIDTH
    this.o.log?.('the computer banner opens')

    // Above everything, including a full-screen program, and invisible to screenshots and screen sharing.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setContentProtection(true)

    const session = win.webContents.session
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    // The page is a data: address with everything in it; any other request is not from it.
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    // A page that died leaves a blank banner; closing the window puts a new one in its place (below).
    win.webContents.on('render-process-gone', (_event, details) => {
      this.o.log?.(`the banner's page is gone: ${details.reason}`)
      if (!win.isDestroyed()) win.destroy()
    })

    win.once('closed', () => {
      if (this.win !== win) return
      // Closed from outside (the graphics driver, a crash): put it back while the agent is still at work.
      this.release()
      if (this.state && this.reopens++ < MAX_REOPENS) {
        this.o.log?.('the computer banner was closed; opening it again')
        this.open()
      }
    })

    screen.on('display-metrics-changed', this.place)
    screen.on('display-added', this.place)
    screen.on('display-removed', this.place)

    // If the page never says how wide it is, the banner still appears.
    this.showTimer = setTimeout(() => this.reveal(), SHOW_ANYWAY_AFTER_MS)
    this.showTimer.unref?.()

    win.loadURL(overlayUrl()).catch((error) => this.o.log?.(`could not load the computer banner: ${error instanceof Error ? error.message : String(error)}`))
  }

  private close(): void {
    const win = this.win
    this.release()
    if (win && !win.isDestroyed()) {
      this.o.log?.('the computer banner closes')
      win.removeAllListeners('closed')
      win.destroy()
    }
  }

  /** Forgets the window and what was attached to it. */
  private release(): void {
    if (this.showTimer) clearTimeout(this.showTimer)
    this.showTimer = undefined
    screen.removeListener('display-metrics-changed', this.place)
    screen.removeListener('display-added', this.place)
    screen.removeListener('display-removed', this.place)
    this.win = null
    this.pageReady = false
    this.visible = false
  }

  private reveal(): void {
    const win = this.win
    if (!win || win.isDestroyed() || this.visible) return
    this.visible = true
    this.place()
    // Shown without taking the focus; the order of windows is set again because showing can reset it.
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }

  private place = (): void => {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.setBounds(overlayBounds(this.workArea(), this.width))
  }

  private push(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.pageReady || !this.state) return
    win.webContents.send(OVERLAY_CHANNELS.state, this.state)
  }

  /** Only the banner's own page may speak to us: this window, its top frame. */
  private fromBanner(event: IpcMainEvent): boolean {
    const win = this.win
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  }

  private onReady = (event: IpcMainEvent): void => {
    if (!this.fromBanner(event)) return
    this.pageReady = true
    this.push()
  }

  private onSize = (event: IpcMainEvent, width: unknown): void => {
    if (!this.fromBanner(event)) return
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) this.width = Math.min(width, 10_000)
    this.place()
    this.reveal()
  }

  private onStop = (event: IpcMainEvent): void => {
    if (!this.fromBanner(event)) return
    this.o.onStop()
  }
}
