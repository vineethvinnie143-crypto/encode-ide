import { useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from '../ui/icons'

export default function BrowserPanel() {
  const [address, setAddress] = useState('')
  const [src, setSrc] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const [reloadKey, setReloadKey] = useState(0)

  const navigate = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    const target = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setSrc(target)
    setAddress(target)
    setHistory((previous) => [...previous.slice(0, index + 1), target])
    setIndex((previous) => previous + 1)
  }

  const go = (offset: number) => {
    const next = index + offset
    if (next < 0 || next >= history.length) return
    setIndex(next)
    setSrc(history[next])
    setAddress(history[next])
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
