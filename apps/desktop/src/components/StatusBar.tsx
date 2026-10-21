import { CircleDot, GitBranch, Bot, Wifi } from '../ui/icons'
import { useEditor } from '../stores/editor'
import { useGit } from '../stores/git'
import { useSettings } from '../stores/settings'
import { useChat } from '../stores/chat'

const STATUS_LABEL: Record<string, string> = {
  idle: 'ready',
  thinking: 'thinking',
  'running-tool': 'working',
  'awaiting-approval': 'needs approval',
  'awaiting-user': 'needs answer',
  done: 'done',
  error: 'error',
}

export default function StatusBar() {
  const cursor = useEditor((state) => state.cursor)
  const activePath = useEditor((state) => state.activePath)
  const tabs = useEditor((state) => state.tabs)
  const git = useGit((state) => state.status)
  const activeProfile = useSettings((state) => state.activeProfile())
  const status = useChat((state) => state.status)

  const tab = tabs.find((item) => item.path === activePath)
  const language = tab?.language ?? 'plaintext'

  return (
    <footer className="statusbar">
      <div className="status-left">
        <button className="status-item" title="Branch">
          <GitBranch size={13} />
          <span>{git.isRepo ? git.branch ?? 'detached' : 'no repo'}</span>
          {git.isRepo && git.changes.length > 0 && <span className="status-badge">{git.changes.length}</span>}
        </button>
        <span className="status-item muted">
          <CircleDot size={12} />
          <span>{git.ahead ? `↑${git.ahead} ` : ''}{git.behind ? `↓${git.behind}` : ''}</span>
        </span>
      </div>

      <div className="status-right">
        <span className={`status-item agent-status agent-${status}`} title="Agent status">
          <Bot size={13} />
          <span>{STATUS_LABEL[status] ?? status}</span>
        </span>
        <span className="status-item" title="Active model">
          <Wifi size={12} />
          <span>{activeProfile ? activeProfile.model || activeProfile.name : 'no model'}</span>
        </span>
        <span className="status-item">{language}</span>
        <span className="status-item">Ln {cursor.line}, Col {cursor.column}</span>
        <span className="status-item">Spaces: 2</span>
        <span className="status-item">UTF-8</span>
      </div>
    </footer>
  )
}
