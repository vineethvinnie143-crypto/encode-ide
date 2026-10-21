import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Clock, Folder, FolderOpen, GitFork, Plus, Puzzle, RefreshCw, Search, Settings, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useChat } from '../stores/chat'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'

export default function HarnessSidebar() {
  const workspace = useWorkspace((state) => state.workspace)
  const openDialog = useWorkspace((state) => state.openDialog)
  const openPath = useWorkspace((state) => state.openPath)
  const refreshAll = useWorkspace((state) => state.refreshAll)
  const settings = useSettings((state) => state.settings)
  const loadSettings = useSettings((state) => state.load)
  const sessions = useSessions((state) => state.sessions)
  const activeId = useSessions((state) => state.activeId)
  const newSession = useSessions((state) => state.newSession)
  const selectSession = useSessions((state) => state.select)
  const forkSession = useSessions((state) => state.fork)
  const removeSession = useSessions((state) => state.remove)
  const status = useChat((state) => state.status)
  const openSettings = useUi((state) => state.openSettings)
  const setPluginsOpen = useUi((state) => state.setPluginsOpen)
  const setAutomationOpen = useUi((state) => state.setAutomationOpen)

  const [user, setUser] = useState('developer')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.app.user().then(setUser).catch(() => setUser('developer'))
  }, [])

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [])

  const workspaces = useMemo(() => {
    const roots = new Set<string>()
    if (workspace) roots.add(workspace.root)
    for (const recent of settings?.recentWorkspaces ?? []) roots.add(recent)
    const list = [...roots].map((root) => ({
      root,
      name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    }))
    const needle = query.trim().toLowerCase()
    return needle ? list.filter((item) => item.name.toLowerCase().includes(needle)) : list
  }, [workspace, settings?.recentWorkspaces, query])

  const activeSession = sessions.find((session) => session.id === activeId)
  const awaiting = status === 'awaiting-approval' || status === 'awaiting-user'
  const busy = status === 'thinking' || status === 'running-tool'
  const badge = awaiting ? 'Answer' : busy ? 'Working' : status === 'error' ? 'Error' : 'now'

  return (
    <aside className="harness-sidebar">
      <div className="hs-brand">
        <span className="hs-logo">eN</span>
        <span className="hs-brand-name">eNCode</span>
        <span className="hs-brand-tag">HARNESS</span>
      </div>

      <button className="hs-new-session" onClick={newSession}>
        <Plus size={15} />
        New Session
      </button>

      <nav className="hs-nav">
        <button onClick={() => setPluginsOpen(true)}>
          <Puzzle size={15} /> Plugins
        </button>
        <button onClick={() => setAutomationOpen(true)}>
          <Clock size={15} /> Automation tasks
        </button>
      </nav>

      <div className="hs-section hs-workspaces">
        <div className="hs-section-head">
          <span>Workspaces</span>
          <span className="hs-section-actions">
            <button title="Search workspaces" onClick={() => setSearchOpen((value) => !value)}>
              <Search size={13} />
            </button>
            <button
              title="Refresh"
              onClick={() => {
                void refreshAll()
                void loadSettings()
              }}
            >
              <RefreshCw size={13} />
            </button>
            <button title="Open folder" onClick={() => void openDialog()}>
              <Plus size={13} />
            </button>
          </span>
        </div>

        {searchOpen && (
          <input
            className="hs-filter"
            autoFocus
            placeholder="Filter workspaces"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearchOpen(false)
            }}
          />
        )}

        <div className="hs-list">
          {workspaces.map((item) => (
            <button
              key={item.root}
              className={`hs-workspace ${workspace?.root === item.root ? 'is-active' : ''}`}
              title={item.root}
              onClick={() => void openPath(item.root)}
            >
              {workspace?.root === item.root ? <FolderOpen size={14} /> : <Folder size={14} />}
              <span className="hs-workspace-name">{item.name}</span>
            </button>
          ))}
          {workspaces.length === 0 && <div className="hs-empty">No workspace open</div>}
        </div>
      </div>

      <div className="hs-section hs-sessions">
        <div className="hs-section-head">
          <span>Sessions</span>
        </div>
        <div className="hs-list">
          {sessions.map((session) => (
            <div key={session.id} className={`hs-session ${session.id === activeId ? 'is-active' : ''}`}>
              <button className="hs-session-main" onClick={() => void selectSession(session.id)}>
                <span className={`hs-session-dot ${session.id === activeId && busy ? 'is-busy' : ''}`} />
                <span className="hs-session-title">{session.title}</span>
                {session.id === activeId && (
                  <span className={`hs-session-badge ${awaiting ? 'is-answer' : ''}`}>{badge}</span>
                )}
              </button>
              <span className="hs-session-actions">
                <button title="Fork session" onClick={() => void forkSession(session.id)}>
                  <GitFork size={11} />
                </button>
                <button title="Delete session" onClick={() => void removeSession(session.id)}>
                  <Trash2 size={11} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="hs-footer" ref={profileRef}>
        <button className="hs-profile" onClick={() => setProfileOpen((value) => !value)}>
          <span className="hs-avatar">{user.slice(0, 1).toUpperCase()}</span>
          <span className="hs-username">{user}</span>
          <ChevronDown size={13} className="hs-profile-chevron" />
        </button>
        {profileOpen && (
          <div className="hs-profile-menu">
            <button onClick={() => { setProfileOpen(false); openSettings('models') }}>
              <Settings size={13} /> Settings…
            </button>
            <button onClick={() => { setProfileOpen(false); void openDialog() }}>
              <FolderOpen size={13} /> Open folder…
            </button>
            <button onClick={() => { setProfileOpen(false); void api.window.close() }}>Quit eNCode</button>
          </div>
        )}
        {activeSession ? null : null}
      </div>
    </aside>
  )
}
