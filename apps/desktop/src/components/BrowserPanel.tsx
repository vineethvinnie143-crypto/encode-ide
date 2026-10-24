import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { addressOf, shownAddress } from '../panels/browser-url'
import { hostOf, usePanels } from '../stores/panels'
import { useUi } from '../stores/ui'
import { cx } from '../ui/cx'
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, Lock, RotateCw, X } from '../ui/icons'
import { Tooltip } from '../ui/Tooltip'

/** The person's tabs share this session, kept on disk, so a sign-in lasts (electron/browser/rules.ts). */
const PERSON_PARTITION = 'persist:encode-browser'
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
/** ERR_ABORTED: a load replaced by another, or held back; not the page failing. */
const ABORTED = -3

/** The parts of Electron's <webview> element a tab uses. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  setZoomFactor(factor: number): void
  getWebContentsId(): number
}

/** React sets an attribute it does not know only from a string; the <webview> reads only whether it is there. */
const POPUPS = { allowpopups: 'true' } as unknown as { allowpopups: boolean }

type Failure = { code: number; description: string; url: string }
type WebviewEvent = Event & { url?: string; isMainFrame?: boolean; isInPlace?: boolean; title?: string; errorCode?: number; errorDescription?: string; validatedURL?: string }

/**
 * One Browser tab: a real page in a process of its own (a <webview>, ADR 0103), with the bar a browser has. The
 * person's tabs remember their address, so they come back on it after Reopen or a restart, and share one session, so
 * a sign-in lasts. A chat's agent tab is the agent's: it starts blank, the agent opens pages in it, and it has a
 * session of its own in memory, signed in to nothing.
 */
export default function BrowserPanel({ tabId }: { tabId: string }) {
  const agent = usePanels((state) => state.side.tabs.find((tab) => tab.id === tabId)?.agent)
  const [start, setStart] = useState(() => (agent ? 'about:blank' : (usePanels.getState().side.tabs.find((tab) => tab.id === tabId)?.url ?? '')))
  const view = useRef<WebviewElement | null>(null)
  const ready = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  const [address, setAddress] = useState(shownAddress(start))
  const [url, setUrl] = useState(start)
  const editing = useRef(false)
  const zoomRef = useRef(1)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [failure, setFailure] = useState<Failure | null>(null)
  const [zoom, setZoom] = useState(1)

  const sync = useCallback(() => {
    const webview = view.current
    if (!webview || !ready.current) return
    try {
      setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() })
    } catch {
      /* not attached yet */
    }
  }, [])

  const reached = useCallback(
    (next: string) => {
      setUrl(next)
      if (!editing.current) setAddress(shownAddress(next))
      if (/^https?:/i.test(next)) usePanels.getState().visit(tabId, next, hostOf(next))
      sync()
    },
    [sync, tabId],
  )

  const navigate = (raw: string) => {
    const target = addressOf(raw)
    if (!target) {
      useUi.getState().notify('error', 'Enter a web address, such as localhost:5173 or example.com.')
      return
    }
    editing.current = false
    setFailure(null)
    setUrl(target)
    setAddress(shownAddress(target))
    input.current?.blur()
    if (!view.current) setStart(target)
    else void view.current.loadURL(target).catch(() => undefined)
    usePanels.getState().visit(tabId, target, hostOf(target))
  }

  const zoomBy = useCallback((step: number) => {
    const index = ZOOMS.findIndex((value) => value >= zoomRef.current - 0.001)
    const next = step === 0 ? 1 : (ZOOMS[Math.min(Math.max(index + step, 0), ZOOMS.length - 1)] ?? 1)
    zoomRef.current = next
    setZoom(next)
    if (ready.current) view.current?.setZoomFactor(next)
  }, [])

  // The page's events: where it is, whether it loads, what it is called, and a load that failed.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      const node = element as WebviewElement | null
      view.current = node
      ready.current = false
      if (!node) return
      const on = (name: string, handler: (event: WebviewEvent) => void) => node.addEventListener(name, handler as EventListener)
      on('dom-ready', () => {
        ready.current = true
        node.setZoomFactor(zoomRef.current)
        sync()
      })
      on('did-start-loading', () => setLoading(true))
      on('did-stop-loading', () => {
        setLoading(false)
        sync()
      })
      on('did-start-navigation', (event) => {
        if (event.isMainFrame && !event.isInPlace) setFailure(null)
      })
      on('did-navigate', (event) => event.url && reached(event.url))
      on('did-navigate-in-page', (event) => event.isMainFrame && event.url && reached(event.url))
      on('page-title-updated', (event) => {
        const current = node.getURL()
        if (/^https?:/i.test(current)) usePanels.getState().visit(tabId, current, event.title?.trim() || hostOf(current))
      })
      on('did-fail-load', (event) => {
        if (!event.isMainFrame || event.errorCode === ABORTED) return
        setFailure({ code: event.errorCode ?? 0, description: event.errorDescription ?? '', url: event.validatedURL ?? '' })
        if (event.validatedURL) reached(event.validatedURL)
      })
    },
    [reached, sync, tabId],
  )

  // Keys pressed in the page that the app answers to (electron/browser/guard.ts).
  useEffect(
    () =>
      api.browser.onKey(({ contentsId, action }) => {
        const webview = view.current
        if (!webview || !ready.current) return
        try {
          if (webview.getWebContentsId() !== contentsId) return
        } catch {
          return
        }
        if (action === 'address') {
          input.current?.focus()
          input.current?.select()
        } else if (action === 'reload') webview.reload()
        else if (action === 'back') {
          if (webview.canGoBack()) webview.goBack()
        } else if (action === 'forward') {
          if (webview.canGoForward()) webview.goForward()
        } else if (action === 'zoom-in') zoomBy(1)
        else if (action === 'zoom-out') zoomBy(-1)
        else if (action === 'zoom-reset') zoomBy(0)
        else if (action === 'close') usePanels.getState().close(tabId)
        else if (action === 'new-tab') usePanels.getState().open('new')
      }),
    [tabId, zoomBy],
  )

  const secure = url.startsWith('https://')
  const showing = Boolean(start)

  return (
    <div className={cx('browser-panel', agent && 'is-agent')}>
      <div className="browser-bar">
        <button className="browser-nav" onClick={() => view.current?.goBack()} disabled={!history.back} title="Back (Alt+Left)" aria-label="Back">
          <ArrowLeft size={14} />
        </button>
        <button className="browser-nav" onClick={() => view.current?.goForward()} disabled={!history.forward} title="Forward (Alt+Right)" aria-label="Forward">
          <ArrowRight size={14} />
        </button>
        <button
          className="browser-nav"
          onClick={() => (loading ? view.current?.stop() : view.current?.reload())}
          disabled={!showing}
          title={loading ? 'Stop' : 'Reload (Ctrl+R)'}
          aria-label={loading ? 'Stop' : 'Reload'}
        >
          {loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <div className="browser-address">
          {agent ? (
            <Tooltip label="The agent’s own tab: signed in to nothing, forgotten when eNCode closes">
              <span className="browser-agent-chip">
                <Bot size={12} aria-hidden="true" />
                Agent
              </span>
            </Tooltip>
          ) : secure ? (
            <Lock size={12} className="browser-lock" aria-label="Secure connection" />
          ) : (
            <Globe size={12} className="browser-lock" aria-hidden="true" />
          )}
          <input
            ref={input}
            value={address}
            placeholder={agent ? 'The agent opens pages here' : 'Enter an address'}
            spellCheck={false}
            aria-label="Address"
            onFocus={(event) => {
              editing.current = true
              if (url && url !== 'about:blank') setAddress(url)
              const field = event.currentTarget
              requestAnimationFrame(() => field.select())
            }}
            onBlur={() => {
              editing.current = false
              setAddress(shownAddress(url))
            }}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate(address)
              else if (event.key === 'Escape') event.currentTarget.blur()
            }}
          />
          {zoom !== 1 && (
            <button className="browser-zoom" onClick={() => zoomBy(0)} title="Back to 100% (Ctrl+0)">
              {Math.round(zoom * 100)}%
            </button>
          )}
          {/^https?:/i.test(url) && (
            <button className="browser-go" onClick={() => window.open(url, '_blank')} title="Open in your browser" aria-label="Open in your browser">
              <ExternalLink size={12} />
            </button>
          )}
        </div>
        {loading && <span className="browser-progress" aria-hidden="true" />}
      </div>

      <div className="browser-stage">
        {showing ? (
          <webview ref={attach} className="browser-view" src={start} partition={agent ? `encode-agent-${agent}` : PERSON_PARTITION} {...POPUPS} />
        ) : (
          <div className="browser-empty">
            <Globe size={18} />
            <span>Enter an address to start browsing</span>
          </div>
        )}
        {failure && (
          <div className="browser-failure" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div className="browser-failure-title">This page did not load</div>
            <div className="browser-failure-detail">
              {failure.description || `Error ${failure.code}`}
              {failure.url ? ` · ${shownAddress(failure.url)}` : ''}
            </div>
            <button
              type="button"
              className="browser-failure-retry"
              onClick={() => {
                setFailure(null)
                view.current?.reload()
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
