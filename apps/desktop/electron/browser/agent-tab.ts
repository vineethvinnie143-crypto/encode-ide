/**
 * The agent's Browser tab of one chat, driven from the main process (ADR 0103). The page lives in a <webview> of the
 * window, so the person sees what the agent does; this side reads it through scripts in an isolated world
 * (page-scripts.ts) and acts on it through the DevTools protocol, whose clicks and keys are the browser's own input:
 * they reach the page as a person's would, whether or not the window has the focus, and take nothing from the composer.
 *
 * The tab follows a link, a script or a redirect on its own only to this computer or a host the agent opened; anywhere
 * else it stays, and the agent's next answer says what was held back. Dialogs answer themselves, downloads are not
 * kept, and a password field is never typed into.
 */
import path from 'node:path'
import type { NativeImage, WebContents } from 'electron'
import type { BrowserAnswer, BrowserElement, BrowserPage, BrowserRequest, ConsoleLine } from '@encode/tools'
import { AGENT_WORLD, DIALOGS_SCRIPT, hasTextScript, outlineScript, refScript, scrollPageScript, type RefAction, type RefAnswer } from './page-scripts'
import { followsOnItsOwn, isWebUrl, keyStroke, openedHost, type KeyStroke } from './rules'

const LOAD_TIMEOUT_MS = 15_000
const SCRIPT_TIMEOUT_MS = 5_000
const IMAGE_TIMEOUT_MS = 4_000
/** After a click or a key: long enough for a page to start what it does about it. */
const ACT_SETTLE_MS = 150
/** And after that, for what it started (a render, a request) to show. */
const SHOW_SETTLE_MS = 250
const MAX_CONSOLE = 200
const IMAGE_WIDTH = 1280
/** ERR_ABORTED: a load replaced by another, or held back here; not the page failing. */
const ABORTED = -3

interface Outline {
  elements: BrowserElement[]
  more: number
  text: string
  next: number
  title: string
  width: number
}

class Stopped extends Error {
  constructor() {
    super('Stopped.')
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(new Stopped())
    }
    signal?.addEventListener('abort', stop, { once: true })
  })

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]).finally(() => clearTimeout(timer))
}

const levelOf = (level: string): ConsoleLine['level'] => (level === 'error' ? 'error' : level === 'warning' ? 'warning' : level === 'debug' ? 'log' : 'info')

export class AgentTab {
  /** Hosts the agent opened, or the tab reached: where it may follow a link on its own. */
  private readonly opened = new Set<string>()
  private next = 1
  private status = 0
  private error: string | undefined
  private held: string[] = []
  private lines: ConsoleLine[] = []
  /** Lines before this one were in an earlier answer. */
  private unread = 0
  private loading = false
  private loaded: (() => void)[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ready: Promise<boolean>

  constructor(
    readonly contents: WebContents,
    private readonly log: (message: string) => void,
    /** Brings the tab back into view: a page the person hid with the panel has no size to read. */
    private readonly show: () => void,
  ) {
    contents.on('did-start-loading', () => {
      this.loading = true
    })
    contents.on('did-stop-loading', () => {
      this.loading = false
      for (const done of this.loaded.splice(0)) done()
    })
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.error = undefined
    })
    contents.on('did-navigate', (_event, url, code) => {
      this.status = code > 0 ? code : 0
      // Only allowed navigations get this far, so the host is one the tab may come back to.
      const host = openedHost(url)
      if (host) this.opened.add(host)
    })
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === ABORTED) return
      this.status = 0
      this.error = `${description || `error ${code}`} (${url})`
    })
    const hold = (details: { url: string; isMainFrame: boolean; preventDefault(): void }, how: string) => {
      if (!details.isMainFrame || followsOnItsOwn(this.opened, details.url)) return
      details.preventDefault()
      this.hold(isWebUrl(details.url) ? `the page ${how} ${details.url}; open that address to go there` : `the page ${how} an address that is not a web page`)
    }
    contents.on('will-navigate', (details) => hold(details, 'went to'))
    contents.on('will-redirect', (details) => hold(details, 'was sent on to'))
    contents.setWindowOpenHandler(({ url }) => {
      // The agent has one tab: a page it may follow opens there, any other is held back.
      if (isWebUrl(url) && url !== 'about:blank' && followsOnItsOwn(this.opened, url)) void this.contents.loadURL(url).catch(() => undefined)
      else this.hold(`the page opened a window for ${isWebUrl(url) ? url : 'an address that is not a web page'}`)
      return { action: 'deny' }
    })
    contents.on('console-message', (details) => {
      // Electron's own advice to app developers, shown in a build that is not packaged; not the page's.
      if (details.message.startsWith('%cElectron Security Warning')) return
      const source = details.sourceId ? `${path.posix.basename(details.sourceId.split(/[?#]/)[0] ?? '') || details.sourceId}:${details.lineNumber}` : undefined
      this.lines.push({ level: levelOf(details.level), text: details.message.slice(0, 2_000), ...(source ? { source } : {}) })
      if (this.lines.length > MAX_CONSOLE) {
        const extra = this.lines.length - MAX_CONSOLE
        this.lines.splice(0, extra)
        this.unread = Math.max(0, this.unread - extra)
      }
    })
    this.ready = this.attach()
  }

  get gone(): boolean {
    return this.contents.isDestroyed()
  }

  /** Something the page did that was not followed, for the next answer. */
  hold(text: string): void {
    if (this.held.length < 10) this.held.push(text)
  }

  /** One step at a time: a second waits for the first to answer. */
  run(request: BrowserRequest, signal: AbortSignal): Promise<BrowserAnswer> {
    const result = this.queue.then(() => this.step(request, signal))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async attach(): Promise<boolean> {
    const cdp = this.contents.debugger
    try {
      cdp.attach('1.3')
      await cdp.sendCommand('Page.enable')
      await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DIALOGS_SCRIPT })
      // No focus emulation (Emulation.setFocusEmulationEnabled): a guest's page process crashes with it on its next
      // cross-site load. The page takes focus from the click or the focus() that comes before typing.
      return true
    } catch (error) {
      this.log(`could not drive the agent's tab: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private cdp(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.contents.debugger.sendCommand(method, params)
  }

  private async script<T>(code: string): Promise<T | undefined> {
    if (this.gone) return undefined
    try {
      return (await within(this.contents.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }], false), SCRIPT_TIMEOUT_MS)) as T | undefined
    } catch {
      return undefined
    }
  }

  private onRef(ref: string, action: RefAction): Promise<RefAnswer | undefined> {
    return this.script<RefAnswer>(refScript(ref, action))
  }

  /** Waits for the page to stop loading; false when it was still loading at the end. */
  private async settled(ms: number, signal: AbortSignal): Promise<boolean> {
    if (!this.loading) return true
    const done = new Promise<boolean>((resolve) => this.loaded.push(() => resolve(true)))
    const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Stopped()), { once: true }))
    return (await Promise.race([within(done, ms), stopped])) === true
  }

  /** Acts, then gives the page the moment it takes to answer: a load it started, or a render. */
  private async act(action: () => Promise<unknown>, signal: AbortSignal): Promise<boolean> {
    await action()
    await sleep(ACT_SETTLE_MS, signal)
    const done = await this.settled(LOAD_TIMEOUT_MS, signal)
    await sleep(SHOW_SETTLE_MS, signal)
    return done
  }

  private async mouse(x: number, y: number, clicks: number): Promise<void> {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let count = 1; count <= clicks; count++) {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count })
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count })
    }
  }

  private async press(stroke: KeyStroke): Promise<void> {
    const base = { key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.keyCode, nativeVirtualKeyCode: stroke.keyCode, modifiers: stroke.modifiers }
    await this.cdp('Input.dispatchKeyEvent', { type: stroke.text ? 'keyDown' : 'rawKeyDown', ...base, ...(stroke.text ? { text: stroke.text, unmodifiedText: stroke.text } : {}) })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private refused(answer: RefAnswer | undefined, ref: string): BrowserAnswer | null {
    if (!answer) return { ok: false, code: 'failed', message: 'The page did not answer: it may be busy or still loading.' }
    if (!('error' in answer)) return null
    switch (answer.error) {
      case 'stale':
        return { ok: false, code: 'stale-ref', message: `${ref} is not on the page any more.` }
      case 'password':
        return { ok: false, code: 'password', message: `${ref} takes a password, and the agent never types one.` }
      case 'not-editable':
        return { ok: false, code: 'failed', message: `${ref} is not a field you can type into.` }
      case 'not-a-list':
        return { ok: false, code: 'failed', message: `${ref} is not a list of options: click it, then click the option.` }
      case 'no-option':
        return { ok: false, code: 'failed', message: `${ref} has no such option. It has: ${(answer.options ?? []).join(', ') || 'none'}.` }
    }
  }

  private async step({ step, image }: BrowserRequest, signal: AbortSignal): Promise<BrowserAnswer> {
    if (this.gone) return { ok: false, code: 'no-page', message: 'Your browser tab was closed.' }
    if (!(await this.ready)) return { ok: false, code: 'unavailable', message: 'eNCode could not drive the browser tab.' }
    try {
      if (this.contents.isCrashed() && step.type !== 'close') {
        // A page whose process died shows nothing and answers nothing: load it again, and say so.
        this.hold('the page stopped working (its process crashed), so it was loaded again')
        this.contents.reload()
        await sleep(ACT_SETTLE_MS, signal)
        await this.settled(LOAD_TIMEOUT_MS, signal)
      }
      let done = true
      let consoleAll = false
      switch (step.type) {
        case 'open': {
          const host = openedHost(step.url)
          if (host) this.opened.add(host)
          this.error = undefined
          void this.contents.loadURL(step.url).catch(() => undefined)
          await sleep(ACT_SETTLE_MS, signal)
          done = await this.settled(LOAD_TIMEOUT_MS, signal)
          break
        }
        case 'look':
          break
        case 'click': {
          let point = step.ref ? undefined : { x: step.x ?? 0, y: step.y ?? 0 }
          if (step.ref) {
            const answer = await this.onRef(step.ref, { type: 'point' })
            const refused = this.refused(answer, step.ref)
            if (refused) return refused
            const at = answer as { x: number; y: number; hit: boolean }
            // Something lies over it (a styled checkbox, a label, an overlay that lets clicks through): the page clicks it.
            if (at.hit) point = at
            else done = await this.act(() => this.onRef(step.ref!, { type: 'click' }), signal)
          }
          if (point) {
            const { x, y } = point
            done = await this.act(() => this.mouse(x, y, step.double ? 2 : 1), signal)
          }
          break
        }
        case 'type': {
          if (step.ref) {
            const refused = this.refused(await this.onRef(step.ref, { type: 'focus' }), step.ref)
            if (refused) return refused
          } else if (await this.script<boolean>(`document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'password'`)) {
            return { ok: false, code: 'password', message: 'The field in focus takes a password, and the agent never types one.' }
          }
          await this.cdp('Input.insertText', { text: step.text })
          if (step.ref) {
            // A field that typing did not reach (a custom input that swallows it) gets its value the way a script sets it.
            const now = await this.onRef(step.ref, { type: 'value' })
            if (now && 'value' in now && !now.value.includes(step.text)) await this.onRef(step.ref, { type: 'fill', text: step.text })
          }
          done = await this.act(async () => (step.submit ? this.press(keyStroke('Enter')!) : undefined), signal)
          break
        }
        case 'key': {
          const stroke = keyStroke(step.key)
          if (!stroke) return { ok: false, code: 'failed', message: `${step.key} is not a key the browser presses.` }
          done = await this.act(() => this.press(stroke), signal)
          break
        }
        case 'scroll': {
          const by = (step.direction === 'up' ? -1 : 1) * (step.amount ?? 1)
          if (step.ref) {
            const refused = this.refused(await this.onRef(step.ref, { type: 'scroll', by }), step.ref)
            if (refused) return refused
          } else await this.script(scrollPageScript(by))
          await sleep(SHOW_SETTLE_MS, signal)
          break
        }
        case 'select': {
          const refused = this.refused(await this.onRef(step.ref, { type: 'select', value: step.value }), step.ref)
          if (refused) return refused
          done = await this.act(async () => undefined, signal)
          break
        }
        case 'back':
        case 'forward': {
          const history = this.contents.navigationHistory
          if (step.type === 'back' ? !history.canGoBack() : !history.canGoForward()) return { ok: false, code: 'failed', message: `There is no page to go ${step.type} to.` }
          done = await this.act(async () => (step.type === 'back' ? history.goBack() : history.goForward()), signal)
          break
        }
        case 'reload':
          done = await this.act(async () => this.contents.reload(), signal)
          break
        case 'wait': {
          const until = Date.now() + (step.ms ?? 5_000)
          if (step.text) {
            while (!(await this.script<boolean>(hasTextScript(step.text)))) {
              if (Date.now() >= until) return { ok: false, code: 'timeout', message: `${JSON.stringify(step.text)} did not show on the page.`, page: await this.page(image, false) }
              await sleep(200, signal)
            }
          } else await sleep(Math.max(0, until - Date.now()), signal)
          break
        }
        case 'console':
          consoleAll = true
          break
        case 'close':
          return { ok: true, page: null }
      }
      const page = await this.page(image, consoleAll)
      if (!done) return { ok: false, code: 'timeout', message: 'The page was still loading after 15 seconds.', page }
      return { ok: true, page }
    } catch (error) {
      if (error instanceof Stopped || signal.aborted) {
        if (!this.gone) this.contents.stop()
        throw new Stopped()
      }
      if (this.gone) return { ok: false, code: 'no-page', message: 'Your browser tab was closed.' }
      return { ok: false, code: 'failed', message: `The browser could not do that: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** The page as it stands: its outline, its text, what it logged since the last answer, and a picture when asked. */
  private async page(image: boolean, consoleAll: boolean): Promise<BrowserPage> {
    let outline = await this.script<Outline>(outlineScript(this.next))
    if (outline && outline.width === 0) {
      this.show()
      await sleep(400)
      outline = (await this.script<Outline>(outlineScript(outline.next))) ?? outline
    }
    if (outline) this.next = outline.next
    const fresh = consoleAll ? this.lines.slice(-100) : this.lines.slice(this.unread).filter((line) => line.level === 'error' || line.level === 'warning')
    this.unread = this.lines.length
    const held = this.held.splice(0)
    const page: BrowserPage = {
      url: this.gone ? '' : this.contents.getURL(),
      title: outline?.title || (this.gone ? '' : this.contents.getTitle()),
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      elements: outline?.elements ?? [],
      more: outline?.more ?? 0,
      text: outline?.text ?? '(The page did not answer: it may be busy.)',
      console: fresh,
      ...(held.length ? { held: `${held.join('; ')}.` } : {}),
    }
    if (image) {
      const picture = await this.picture(outline?.width)
      if (picture) page.image = picture
    }
    return page
  }

  /**
   * The page as a picture, its pixels the page's own (CSS pixels) so a coordinate read off it is one the page knows;
   * a page wider than 1280 is scaled down, and the answer says by how much.
   */
  private async picture(pageWidth: number | undefined): Promise<BrowserPage['image']> {
    if (this.gone) return undefined
    const shot: NativeImage | undefined = await within(this.contents.capturePage(), IMAGE_TIMEOUT_MS).catch(() => undefined)
    if (!shot || shot.isEmpty()) return undefined
    const size = shot.getSize()
    const target = Math.min(IMAGE_WIDTH, pageWidth && pageWidth > 0 ? pageWidth : size.width)
    const scaled = size.width !== target ? shot.resize({ width: target, quality: 'good' }) : shot
    const { width, height } = scaled.getSize()
    const scale = pageWidth && pageWidth > 0 ? Math.round((width / pageWidth) * 100) / 100 : 1
    return { mediaType: 'image/jpeg', data: scaled.toJPEG(72).toString('base64'), width, height, ...(scale !== 1 ? { scale } : {}) }
  }
}
