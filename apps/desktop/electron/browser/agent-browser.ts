/**
 * The agent tabs of all chats: the Browser tool's requests, as the agent host sends them, go to the tab of their chat.
 * A chat's first `open` asks the window for its tab and waits for the <webview> to attach; later steps go to that tab
 * while it lives. A tab the person closed is gone: the next `open` makes a new one.
 */
import type { WebContents } from 'electron'
import type { BrowserAnswer, BrowserRequest } from '@encode/tools'
import { AgentTab } from './agent-tab'
import { agentKey } from './rules'

/** How long a new tab may take to show up in the window. */
const ATTACH_TIMEOUT_MS = 10_000

export interface AgentBrowserOptions {
  /** Asks the window to show the agent tab of `key`, opening it if it is not open; false when there is no window to ask. */
  show(key: string): boolean
  /** Asks the window to close the agent tab of `key`. */
  close(key: string): void
  log(message: string): void
}

export class AgentBrowser {
  private readonly tabs = new Map<string, AgentTab>()
  private readonly waiting = new Map<string, ((tab: AgentTab) => void)[]>()

  constructor(private readonly o: AgentBrowserOptions) {}

  /** A <webview> of the agent partition of `key` attached to the window: it is that chat's tab from now on. */
  attached(key: string, contents: WebContents): void {
    const live = this.live(key)
    if (live && live.contents !== contents) {
      // The window shows a chat's tab once; a second one is the person's to look at, and the agent keeps the first.
      this.o.log('a second agent tab of the same chat attached; the first one stays the agent’s')
      return
    }
    const tab = new AgentTab(contents, this.o.log, () => this.o.show(key))
    this.tabs.set(key, tab)
    contents.once('destroyed', () => {
      if (this.tabs.get(key) === tab) this.tabs.delete(key)
    })
    for (const resolve of this.waiting.get(key) ?? []) resolve(tab)
    this.waiting.delete(key)
  }

  /** Something an agent tab's page did that was not followed (a download), for that tab's next answer. */
  hold(contents: WebContents, text: string): void {
    for (const tab of this.tabs.values()) if (tab.contents === contents) tab.hold(text)
  }

  isAgentTab(contents: WebContents): boolean {
    for (const tab of this.tabs.values()) if (tab.contents === contents) return true
    return false
  }

  async call(sessionId: string, request: BrowserRequest, signal: AbortSignal): Promise<BrowserAnswer> {
    const key = agentKey(sessionId)
    let tab = this.live(key)
    if (request.step.type === 'close') {
      if (tab) this.o.close(key)
      return { ok: true, page: null }
    }
    if (!tab) {
      if (request.step.type !== 'open') return { ok: false, code: 'no-page', message: 'There is no page in your browser tab.' }
      const attaching = this.attach(key, signal)
      if (!this.o.show(key)) return { ok: false, code: 'unavailable', message: 'eNCode’s window is closed, so there is no browser tab to show.' }
      tab = await attaching
      if (!tab) return { ok: false, code: 'unavailable', message: 'The browser tab did not open. The side panel may have no room for another tab: close one.' }
    } else if (request.step.type === 'open') {
      // The person sees where the agent goes.
      this.o.show(key)
    }
    return tab.run(request, signal)
  }

  private live(key: string): AgentTab | undefined {
    const tab = this.tabs.get(key)
    if (tab && tab.gone) this.tabs.delete(key)
    return tab && !tab.gone ? tab : undefined
  }

  private attach(key: string, signal: AbortSignal): Promise<AgentTab | undefined> {
    return new Promise((resolve) => {
      const done = (tab: AgentTab | undefined) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        const list = this.waiting.get(key)?.filter((waiter) => waiter !== got)
        if (list?.length) this.waiting.set(key, list)
        else this.waiting.delete(key)
        resolve(tab)
      }
      const got = (tab: AgentTab) => done(tab)
      const stop = () => done(undefined)
      const timer = setTimeout(stop, ATTACH_TIMEOUT_MS)
      signal.addEventListener('abort', stop, { once: true })
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), got])
    })
  }
}
