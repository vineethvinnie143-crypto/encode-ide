import { FolderOpen, MessageSquare, Settings } from '../ui/icons'
import { LogoMark } from '../ui/Logo'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'

export default function TitleBar() {
  const workspace = useWorkspace((state) => state.workspace)
  const openDialog = useWorkspace((state) => state.openDialog)
  const chatVisible = useUi((state) => state.chatVisible)
  const toggleChat = useUi((state) => state.toggleChat)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const setQuickOpenOpen = useUi((state) => state.setQuickOpenOpen)

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <LogoMark size={24} />
        <span className="brand-name">eNCode</span>
      </div>

      <div className="titlebar-path">
        {workspace ? (
          <>
            <span className="workspace-name">{workspace.name}</span>
            <span className="workspace-root" title={workspace.root}>
              {workspace.root}
            </span>
          </>
        ) : (
          <span className="muted">No folder open</span>
        )}
      </div>

      <div className="titlebar-actions">
        <button className="tb-btn" onClick={() => setQuickOpenOpen(true)} title="Quick open (Ctrl+P)">
          <kbd>Ctrl</kbd>
          <kbd>P</kbd>
        </button>
        <button className="tb-btn" onClick={openDialog} title="Open folder">
          <FolderOpen size={15} />
          <span>Open folder</span>
        </button>
        <button
          className={`tb-btn icon-only ${chatVisible ? 'is-on' : ''}`}
          onClick={toggleChat}
          title="Toggle agent panel (Ctrl+Shift+X)"
        >
          <MessageSquare size={16} />
        </button>
        <button className="tb-btn icon-only" onClick={() => setSettingsOpen(true)} title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </header>
  )
}
