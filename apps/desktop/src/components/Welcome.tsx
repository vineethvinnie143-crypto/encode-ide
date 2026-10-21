import { ArrowRight, Bot, FolderOpen, Search, Terminal } from 'lucide-react'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'

export default function Welcome() {
  const workspace = useWorkspace((state) => state.workspace)
  const openDialog = useWorkspace((state) => state.openDialog)
  const openPath = useWorkspace((state) => state.openPath)
  const settings = useSettings((state) => state.settings)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const setQuickOpenOpen = useUi((state) => state.setQuickOpenOpen)
  const togglePanel = useUi((state) => state.togglePanel)

  const recent = (settings?.recentWorkspaces ?? []).filter((path) => path !== workspace?.root).slice(0, 6)
  const activeProfile = settings?.profiles.find((profile) => profile.id === settings.activeProfileId)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">F</div>
        <h1 className="welcome-title">eNCode</h1>
        <p className="welcome-sub">An AI-first editor. Bring your own model, keep your files.</p>

        <div className="welcome-actions">
          <button className="btn primary lg" onClick={openDialog}>
            <FolderOpen size={16} />
            Open folder
          </button>
          <button className="btn ghost lg" onClick={() => setQuickOpenOpen(true)}>
            <Search size={16} />
            Quick open
          </button>
        </div>

        <div className="welcome-grid">
          <button className="welcome-card" onClick={() => setSettingsOpen(true)}>
            <Bot size={18} />
            <div>
              <div className="card-title">Connect a model</div>
              <div className="card-sub">
                {activeProfile
                  ? `${activeProfile.name} · ${activeProfile.model || 'no model selected'}`
                  : 'DeepSeek, OpenRouter free models, Ollama or any OpenAI-compatible API'}
              </div>
            </div>
            <ArrowRight size={15} className="card-arrow" />
          </button>

          <button className="welcome-card" onClick={togglePanel}>
            <Terminal size={18} />
            <div>
              <div className="card-title">Integrated terminal</div>
              <div className="card-sub">Ctrl+` opens a real shell in the workspace folder</div>
            </div>
            <ArrowRight size={15} className="card-arrow" />
          </button>

          <div className="welcome-card static">
            <div className="shortcuts">
              <div><kbd>Ctrl</kbd><kbd>S</kbd><span>Save file</span></div>
              <div><kbd>Ctrl</kbd><kbd>P</kbd><span>Quick open</span></div>
              <div><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F</kbd><span>Search across files</span></div>
              <div><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>X</kbd><span>Toggle agent panel</span></div>
            </div>
          </div>
        </div>

        {recent.length > 0 && (
          <div className="welcome-recent">
            <div className="recent-label">Recent folders</div>
            {recent.map((path) => (
              <button key={path} className="recent-item" onClick={() => openPath(path)} title={path}>
                <FolderOpen size={14} />
                <span className="recent-name">{path.split(/[\\/]/).pop()}</span>
                <span className="recent-path">{path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
