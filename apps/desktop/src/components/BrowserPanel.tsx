import { useState } from 'react'
import { hostOf, usePanels } from '../stores/panels'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from '../ui/icons'

/**
 * One page in a Browser tab. The tab remembers its address, so it comes back on that page after
 * Reopen or a restart, and takes the site's name as its title. Back and Forward walk the pages
 * this tab has shown since it was opened.
 */
export default function BrowserPanel({ tabId }: { tabId: string }) {
  const [start] = useState(() => usePanels.getState().side.tabs.find((tab) => tab.id === tabId)?.url ?? '')
  const [address, setAddress] = useState(start)
  const [src, setSrc] = useState(start)
  const [history, setHistory] = useState<string[]>(start ? [start] : [])
  const [index, setIndex] = useState(start ? 0 : -1)
  const [reloadKey, setReloadKey] = useState(0)

  const show = (target: string) => {
    setSrc(target)
    setAddress(target)
    usePanels.getState().visit(tabId, target, hostOf(target))
  }

  const navigate = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    const target = /^https?:\/\//i.test(value) ? value : `https://${value}`
    show(target)
    setHistory((previous) => [...previous.slice(0, index + 1), target])
    setIndex((previous) => previous + 1)
  }

  const go = (offset: number) => {
    const next = index + offset
    if (next < 0 || next >= history.length) return
    setIndex(next)
    show(history[next])
  }

  return (
    <div className="browser-panel">
      <div className="browser-bar">
        <button className="browser-nav" onClick={() => go(-1)} disabled={index <= 0} title="Back">
          <ArrowLeft size={14} />
        </button>
        <button className="browser-nav" onClick={() => go(1)} disabled={index >= history.length - 1} title="Forward">
          <ArrowRight size={14} />
        </button>
        <button className="browser-nav" onClick={() => setReloadKey((value) => value + 1)} title="Reload">
          <RotateCw size={13} />
        </button>
        <div className="browser-address">
          <input
            value={address}
            placeholder="Enter an HTTP(S) address"
            spellCheck={false}
            aria-label="Address"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate(address)
            }}
          />
          {address && (
            <button className="browser-go" onClick={() => navigate(address)} title="Open">
              ↵
            </button>
          )}
          {src && (
            <button className="browser-go" onClick={() => window.open(src, '_blank')} title="Open in system browser">
              <ExternalLink size={12} />
            </button>
          )}
        </div>
      </div>

      {src ? (
        <iframe
          key={`${src}-${reloadKey}`}
          className="browser-frame"
          src={src}
          title="Browser"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      ) : (
        <div className="browser-empty">
          <Globe size={18} />
          <span>Enter an HTTP(S) address to start browsing</span>
        </div>
      )}
    </div>
  )
}
