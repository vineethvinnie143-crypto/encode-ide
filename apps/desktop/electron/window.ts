import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { appearanceParams, type Appearance } from '../shared/appearance'
import { NATIVE_CAPTIONS, captionOverlay, windowBackground } from './appearance'
import { allowFraming } from './framing'

/** The Vite dev server, honoured only by an unpackaged build. */
const devServer = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** True for the app's own pages: the bundled renderer, or the dev server in development. */
export function isRendererUrl(url: string): boolean {
  // Origins, not prefixes: http://localhost:5173 must not admit http://localhost:51730.
  if (devServer) {
    const origin = originOf(url)
    return origin !== null && origin === originOf(devServer)
  }
  return url.startsWith('app://renderer/')
}

/** The renderer's address. It carries the appearance, so the first frame is drawn in the right theme. */
function rendererUrl(appearance: Appearance): string {
  const url = new URL(devServer ?? 'app://renderer/index.html')
  for (const [name, value] of Object.entries(appearanceParams(appearance))) url.searchParams.set(name, value)
  return url.toString()
}

/**
 * A page can ask for permissions (camera, location, notifications, the list of installed fonts). eNCode's
 * own page may list the fonts, for Settings > Appearance; no other page or frame, such as one in the
 * browser panel, gets anything.
 */
function restrictPermissions(win: BrowserWindow): void {
  const allowed = (permission: string, url: string | undefined, mainFrame: boolean | undefined) =>
    permission === 'local-fonts' && mainFrame === true && url !== undefined && isRendererUrl(url)
  const session = win.webContents.session
  session.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl, details.isMainFrame)))
  session.setPermissionCheckHandler((_contents, permission, _origin, details) => allowed(permission, details.requestingUrl, details.isMainFrame))
}

/**
 * A Browser tab shows its page in a frame of this window, and a site that forbids being framed
 * (X-Frame-Options, frame-ancestors) would leave it blank white. The responses of those frames, and
 * only of those, lose the two rules; every other header stays (see `allowFraming`).
 */
function allowBrowserFrames(win: BrowserWindow): void {
  const contentsId = win.webContents.id
  win.webContents.session.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.resourceType !== 'subFrame' || details.webContentsId !== contentsId || !details.responseHeaders) {
      callback({})
      return
    }
    callback({ responseHeaders: allowFraming(details.responseHeaders) })
  })
}

/** Call after applyNativeAppearance, so the window starts in the colour of the chosen theme. */
export function createMainWindow(appearance: Appearance): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'eNCode',
    backgroundColor: windowBackground(),
    // On Windows the system draws the window buttons over our title bar: the right glyphs, hover and press
    // states, and the snap layouts of Windows 11. Elsewhere the title bar draws its own (TitleBar.tsx).
    ...(NATIVE_CAPTIONS ? { titleBarStyle: 'hidden' as const, titleBarOverlay: captionOverlay() } : { frame: false }),
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  })

  restrictPermissions(win)
  allowBrowserFrames(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  void win.loadURL(rendererUrl(appearance))

  return win
}
