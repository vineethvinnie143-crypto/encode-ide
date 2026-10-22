import { useEffect } from 'react'
import { GitBranch, RefreshCw } from '../../ui/icons'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { usePanels } from '../../stores/panels'
import { useWorkspace } from '../../stores/workspace'

const STATUS_COLOR: Record<string, string> = {
  modified: 'mod',
  added: 'add',
  deleted: 'del',
  renamed: 'ren',
  untracked: 'unt',
}

const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  updated: 'U',
  untracked: 'U',
  ignored: '!',
}

export default function GitPanel() {
  const status = useGit((state) => state.status)
  const refresh = useGit((state) => state.refresh)
  const workspace = useWorkspace((state) => state.workspace)
  const openFile = useEditor((state) => state.openFile)

  useEffect(() => {
    if (workspace) void refresh()
  }, [workspace, refresh])

  if (!workspace) {
    return <div className="panel-empty">Open a folder to see source control.</div>
  }

  if (!status.isRepo) {
    return (
      <div className="git-panel">
        <div className="panel-header">
          <span className="panel-title">Source control</span>
        </div>
        <div className="panel-empty">
          <GitBranch size={22} />
          <div>This folder is not a git repository.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="panel-header">
        <span className="panel-title">
          <GitBranch size={13} /> {status.branch ?? 'detached'}
        </span>
        <div className="panel-actions">
          <button className="icon-btn" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="git-summary">
        <span>{status.changes.length} changed</span>
        {status.ahead ? <span>↑{status.ahead}</span> : null}
        {status.behind ? <span>↓{status.behind}</span> : null}
      </div>

      <div className="git-changes">
        {status.changes.map((change) => (
          <button
            key={`${change.path}:${change.status}`}
            className="git-change"
            onClick={() => {
              usePanels.getState().open('editor')
              void openFile(change.path)
            }}
            title={`${change.status}: ${change.path}`}
          >
            <span className={`git-status ${STATUS_COLOR[change.status] ?? 'mod'}`}>
              {STATUS_LETTER[change.status] ?? 'M'}
            </span>
            <span className="git-path">{change.path}</span>
          </button>
        ))}
        {status.changes.length === 0 && <div className="tree-note">Working tree clean.</div>}
      </div>
    </div>
  )
}
