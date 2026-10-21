import { Files, GitBranch, PanelBottom, Search, Settings } from '../ui/icons'
import { useUi } from '../stores/ui'
import type { SidebarView } from '../stores/ui'

const ITEMS: { view: SidebarView; label: string; icon: typeof Files; shortcut: string }[] = [
  { view: 'explorer', label: 'Explorer', icon: Files, shortcut: 'Ctrl+B' },
  { view: 'search', label: 'Search', icon: Search, shortcut: 'Ctrl+Shift+F' },
  { view: 'git', label: 'Source control', icon: GitBranch, shortcut: '' },
]

export default function ActivityBar() {
  const sidebarView = useUi((state) => state.sidebarView)
  const sidebarVisible = useUi((state) => state.sidebarVisible)
  const setSidebarView = useUi((state) => state.setSidebarView)
  const togglePanel = useUi((state) => state.togglePanel)
  const panelVisible = useUi((state) => state.panelVisible)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)

  return (
    <nav className="activitybar">
      <div className="activitybar-top">
        {ITEMS.map(({ view, label, icon: Icon, shortcut }) => (
          <button
            key={view}
            className={`activity-btn ${sidebarVisible && sidebarView === view ? 'is-active' : ''}`}
            onClick={() => setSidebarView(view)}
            title={shortcut ? `${label} (${shortcut})` : label}
          >
            <Icon size={20} strokeWidth={1.7} />
          </button>
        ))}
      </div>

      <div className="activitybar-bottom">
        <button
          className={`activity-btn ${panelVisible ? 'is-active' : ''}`}
          onClick={togglePanel}
          title="Terminal (Ctrl+`)"
        >
          <PanelBottom size={19} strokeWidth={1.7} />
        </button>
        <button className="activity-btn" onClick={() => setSettingsOpen(true)} title="Settings">
          <Settings size={19} strokeWidth={1.7} />
        </button>
      </div>
    </nav>
  )
}
