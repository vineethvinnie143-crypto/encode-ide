import { useEffect, useRef, useState } from 'react'
import { Copy, Maximize2, Menu, Minus, X } from 'lucide-react'
import { api } from '../api'
import { useSessions } from '../stores/sessions'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'

type MenuName = 'application' | 'edit'

export default function AppMenuBar() {
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null)
  const [maximized, setMaximized] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const newSession = useSessions((state) => state.newSession)
  const openDialog = useWorkspace((state) => state.openDialog)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const toggleRight = useUi((state) => state.toggleRight)

  useEffect(() => {
    return api.window.onStateChange((state) => setMaximized(state.maximized))
  }, [])

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [])

  const runEdit = (command: string) => {
    try {
      document.execCommand(command)
    } catch {
      /* selection may not support it */
    }
    setOpenMenu(null)
  }

  return (
    <header className="menubar" ref={rootRef}>
      <div className="menubar-left">
        <button className="menubar-icon" onClick={toggleRight} title="Toggle right panel">
          <Menu size={15} />
        </button>
        <div className="menubar-menu-wrap">
          <button
            className={`menubar-item ${openMenu === 'application' ? 'is-open' : ''}`}
            onClick={() => setOpenMenu(openMenu === 'application' ? null : 'application')}
          >
            Application
          </button>
          {openMenu === 'application' && (
            <div className="menubar-dropdown">
              <button onClick={() => { setOpenMenu(null); newSession() }}>
                New Session <span>Ctrl+N</span>
              </button>
              <button onClick={() => { setOpenMenu(null); void openDialog() }}>Open Folder…</button>
              <button onClick={() => { setOpenMenu(null); setSettingsOpen(true) }}>Settings…</button>
              <div className="menubar-sep" />
              <button onClick={() => { setOpenMenu(null); void api.window.close() }}>Quit eNCode</button>
            </div>
          )}
        </div>

        <div className="menubar-menu-wrap">
          <button
            className={`menubar-item ${openMenu === 'edit' ? 'is-open' : ''}`}
            onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
          >
            Edit
          </button>
          {openMenu === 'edit' && (
            <div className="menubar-dropdown">
              <button onClick={() => runEdit('undo')}>Undo <span>Ctrl+Z</span></button>
              <button onClick={() => runEdit('redo')}>Redo <span>Ctrl+Y</span></button>
              <div className="menubar-sep" />
              <button onClick={() => runEdit('cut')}>Cut <span>Ctrl+X</span></button>
              <button onClick={() => runEdit('copy')}>Copy <span>Ctrl+C</span></button>
              <button onClick={() => runEdit('paste')}>Paste <span>Ctrl+V</span></button>
            </div>
          )}
        </div>
      </div>

      <div className="window-controls">
        <button onClick={() => void api.window.minimize()} title="Minimize">
          <Minus size={14} />
        </button>
        <button
          onClick={() => void api.window.toggleMaximize().then(setMaximized)}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy size={12} /> : <Maximize2 size={12} />}
        </button>
        <button className="window-close" onClick={() => void api.window.close()} title="Close">
          <X size={14} />
        </button>
      </div>
    </header>
  )
}
