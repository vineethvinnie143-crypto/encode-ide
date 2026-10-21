import { Code2, Files, GitBranch, Search, SquareTerminal } from '../ui/icons'
import type { SidebarView } from '../stores/ui'
import { useUi } from '../stores/ui'
import CodeEditor from './CodeEditor'
import EditorTabs from './EditorTabs'
import Sidebar from './Sidebar/Sidebar'
import TerminalPanel from './Terminal/TerminalPanel'
import { useEditor } from '../stores/editor'

const FILE_VIEWS: { view: SidebarView; icon: typeof Files; label: string }[] = [
  { view: 'explorer', icon: Files, label: 'Files' },
  { view: 'search', icon: Search, label: 'Search' },
  { view: 'git', icon: GitBranch, label: 'Source control' },
]

export default function WorkspacePanel() {
  const workspaceTab = useUi((state) => state.workspaceTab)
  const setWorkspaceTab = useUi((state) => state.setWorkspaceTab)
  const sidebarView = useUi((state) => state.sidebarView)
  const setSidebarView = useUi((state) => state.setSidebarView)

  const tabs = useEditor((state) => state.tabs)
  const activePath = useEditor((state) => state.activePath)
  const cursor = useEditor((state) => state.cursor)
  const active = tabs.find((tab) => tab.path === activePath) ?? null

  return (
    <div className="workspace-panel">
      <div className="workspace-tabs">
        <button className={workspaceTab === 'files' ? 'is-active' : ''} onClick={() => setWorkspaceTab('files')}>
          <Files size={13} /> Files
        </button>
        <button className={workspaceTab === 'editor' ? 'is-active' : ''} onClick={() => setWorkspaceTab('editor')}>
          <Code2 size={13} /> Editor
        </button>
        <button className={workspaceTab === 'shell' ? 'is-active' : ''} onClick={() => setWorkspaceTab('shell')}>
          <SquareTerminal size={13} /> Shell
        </button>
      </div>

      <div className={`workspace-pane files-pane ${workspaceTab === 'files' ? 'is-active' : ''}`}>
        <div className="files-switcher">
          {FILE_VIEWS.map(({ view, icon: Icon, label }) => (
            <button
              key={view}
              className={sidebarView === view ? 'is-active' : ''}
              onClick={() => setSidebarView(view)}
              title={label}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="files-body">
          <Sidebar />
        </div>
      </div>

      <div className={`workspace-pane editor-pane ${workspaceTab === 'editor' ? 'is-active' : ''}`}>
        <EditorTabs />
        <div className="editor-host">
          <CodeEditor tab={active} />
          {!active && (
            <div className="editor-empty">
              <Code2 size={18} />
              <span>Open a file from Files or Quick Open</span>
            </div>
          )}
        </div>
        <div className="editor-footer">
          <span>{active ? active.language : 'plaintext'}</span>
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
          <span>{active ? (active.dirty ? 'unsaved' : 'saved') : '—'}</span>
        </div>
      </div>

      <div className={`workspace-pane shell-pane ${workspaceTab === 'shell' ? 'is-active' : ''}`}>
        <TerminalPanel />
      </div>
    </div>
  )
}
