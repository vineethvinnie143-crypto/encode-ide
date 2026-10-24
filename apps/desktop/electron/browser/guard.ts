/**
 * What a Browser tab may be (ADR 0103). The window's page asks for a <webview>; this decides what it gets, whatever the
 * page asked: no preload, no Node, a sandboxed process with context isolation and web security, and one of two kinds of
 * session. The person's tabs share a session kept on disk; an agent tab gets one in memory, its own (rules.ts). Any other
 * partition, or a first address that is not a web page, and there is no tab.
 *
 * Once a tab is attached, its page loads only web pages; a new window it opens is a new tab (the person's) or is up to
 * the agent tab's rules (agent-tab.ts); it asks for no permission but full screen and writing the clipboard; the keys
 * the app answers to (Ctrl+L, Ctrl+R, Alt+Left...) go to the app; and it has a context menu.
 */
import { Menu, clipboard, session as sessions, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type Session, type WebContents, type WebPreferences } from 'electron'
import type { BrowserKeyAction } from '../../shared/types'
import type { AgentBrowser } from './agent-browser'
import { PERSON_PARTITION, agentKeyOf, isWebUrl, permits, plainUserAgent } from './rules'


export interface BrowserGuardOptions {
  /** A page of the person's asked for a new window: it opens as a new Browser tab. */
  openTab(url: string): void
  /** A key the app answers to was pressed in the page of `contentsId`. */
  key(contentsId: number, action: BrowserKeyAction): void
  log(message: string): void
}

const KEYS: { action: BrowserKeyAction; test: (input: Electron.Input) => boolean; agent: boolean }[] = [
  { action: 'address', agent: true, test: (input) => input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'l' },
  { action: 'reload', agent: true, test: (input) => (input.control && !input.alt && input.key.toLowerCase() === 'r') || input.key === 'F5' },
  { action: 'back', agent: true, test: (input) => input.alt && !input.control && input.key === 'ArrowLeft' },
  { action: 'forward', agent: true, test: (input) => input.alt && !input.control && input.key === 'ArrowRight' },
  { action: 'zoom-in', agent: true, test: (input) => input.control && !input.alt && (input.key === '=' || input.key === '+') },
  { action: 'zoom-out', agent: true, test: (input) => input.control && !input.alt && input.key === '-' },
  { action: 'zoom-reset', agent: true, test: (input) => input.control && !input.alt && input.key === '0' },
  // Not in the agent's tab: a Control+W the agent presses is for its page, not to close its tab.
  { action: 'close', agent: false, test: (input) => input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'w' },
  { action: 'new-tab', agent: false, test: (input) => input.control && !input.shift && !input.alt && input.key.toLowerCase() === 't' },
]

/** The settings a tab's page runs with, whatever the <webview> asked for. */
export function lockPreferences(preferences: WebPreferences): void {
  delete preferences.preload
  Object.assign(preferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    plugins: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  } satisfies WebPreferences)
  delete preferences.enableBlinkFeatures
  delete preferences.disableBlinkFeatures
}

export function guardBrowserTabs(win: BrowserWindow, agents: AgentBrowser, options: BrowserGuardOptions): void {
  /** The sessions of the tabs, each with its agent key, or null for the person's. */
  const kinds = new WeakMap<Session, string | null>()
  const prepare = (session: Session, key: string | null) => {
    if (kinds.has(session)) return
    kinds.set(session, key)
    const agent = key !== null
    session.setPermissionRequestHandler((_contents, permission, callback) => callback(permits(permission, agent)))
    session.setPermissionCheckHandler((_contents, permission) => permits(permission, agent))
    session.setDevicePermissionHandler(() => false)
    session.setUserAgent(plainUserAgent(session.getUserAgent()))
    session.on('will-download', (event, item, contents) => {
      if (!agent) return
      // The agent's tab keeps nothing on the disk.
      event.preventDefault()
      agents.hold(contents, `a download of ${item.getFilename() || 'a file'} was not kept`)
    })
  }

  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    const partition = params.partition ?? ''
    const key = agentKeyOf(partition)
    if (partition !== PERSON_PARTITION && key === null) {
      event.preventDefault()
      options.log(`refused a browser tab in partition ${JSON.stringify(partition.slice(0, 60))}`)
      return
    }
    if (!isWebUrl(params.src || 'about:blank')) {
      event.preventDefault()
      options.log('refused a browser tab whose first address is not a web page')
      return
    }
    lockPreferences(preferences)
    delete params.preload
    prepare(sessions.fromPartition(partition), key)
  })

  win.webContents.on('did-attach-webview', (_event, contents) => {
    const key = kinds.get(contents.session)
    if (key === undefined) {
      // Not a session this guard prepared: there is no such tab.
      options.log('closed a browser tab of an unknown session')
      contents.close()
      return
    }
    const agent = key !== null
    // Only web pages in the tab, for either kind; an agent tab adds its own rules about where. Frames in a page are
    // the page's business (srcdoc, blob:), as in any browser.
    const webOnly = (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
      if (details.isMainFrame && !isWebUrl(details.url)) details.preventDefault()
    }
    contents.on('will-navigate', webOnly)
    contents.on('will-redirect', webOnly)
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const match = KEYS.find((entry) => (entry.agent || !agent) && entry.test(input))
      if (!match) return
      event.preventDefault()
      options.key(contents.id, match.action)
    })
    contents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate(contextMenu(contents, params, agent, options))
      menu.popup({ window: win })
    })
    if (agent) agents.attached(key, contents)
    else
      contents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url) && url !== 'about:blank') options.openTab(url)
        return { action: 'deny' }
      })
  })
}

function contextMenu(contents: WebContents, params: ContextMenuParams, agent: boolean, options: BrowserGuardOptions): MenuItemConstructorOptions[] {
  const history = contents.navigationHistory
  const items: MenuItemConstructorOptions[] = []
  if (params.linkURL && isWebUrl(params.linkURL)) {
    if (!agent) items.push({ label: 'Open link in a new tab', click: () => options.openTab(params.linkURL) })
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' })
  }
  if (params.isEditable) {
    items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' })
  } else if (params.selectionText) {
    items.push({ role: 'copy' }, { type: 'separator' })
  }
  items.push(
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) },
  )
  return items
}
