import { useEffect, useState } from 'react'
import type { BackgroundJob } from '@shared/types'
import { api } from '../../api'
import { useEditor } from '../../stores/editor'
import { usePanels } from '../../stores/panels'
import { useUi } from '../../stores/ui'
import type { SidebarView } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { Activity, Code2, GitBranch, Files, Globe, ListTree, Search, SquareTerminal } from '../../ui/icons'
import type { PanelTabKind } from '../../panels/model'
import CodeEditor from '../CodeEditor'
import EditorTabs from '../EditorTabs'
import Sidebar from '../Sidebar/Sidebar'

const FILE_VIEWS: { view: SidebarView; icon: typeof Files; label: string }[] = [
  { view: 'explorer', icon: Files, label: 'Files' },
  { view: 'search', icon: Search, label: 'Search' },
  { view: 'git', icon: GitBranch, label: 'Source control' },
]

/** The project's files: the explorer, a search across them, and source control. */
export function FilesPane() {
  const sidebarView = useUi((state) => state.sidebarView)
  const setSidebarView = useUi((state) => state.setSidebarView)
  return (
    <div className="files-pane">
      <div className="files-switcher">
        {FILE_VIEWS.map(({ view, icon: Icon, label }) => (
          <button key={view} className={sidebarView === view ? 'is-active' : ''} onClick={() => setSidebarView(view)} title={label}>
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="files-body">
        <Sidebar />
      </div>
    </div>
  )
}

/** The open files, with the editor's status line. */
export function EditorPane() {
  const tabs = useEditor((state) => state.tabs)
  const activePath = useEditor((state) => state.activePath)
  const cursor = useEditor((state) => state.cursor)
  const active = tabs.find((tab) => tab.path === activePath) ?? null
  return (
    <div className="editor-pane">
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
  )
}

/** Background commands the agent started, with the tail of their output. */
export function JobsPane() {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  useEffect(() => {
    void api.jobs.list().then(setJobs).catch(() => setJobs([]))
    return api.jobs.onChange(setJobs)
  }, [])
  if (!jobs.length) {
    return (
      <div className="panel-empty">
        <Activity size={18} />
        <span>No background jobs. Commands the agent runs in the background show up here.</span>
      </div>
    )
  }
  return (
    <div className="jobs-pane">
      {jobs.map((job) => (
        <div className="job-card" key={job.id}>
          <div className="job-card-head">
            <span className={`job-status job-${job.status}`}>{job.status}</span>
            <span className="job-command" title={job.command}>
              {job.command}
            </span>
            {job.status === 'running' && (
              <Button size="sm" variant="danger" onClick={() => void api.jobs.kill(job.id)}>
                Stop
              </Button>
            )}
          </div>
          {job.output && <pre className="job-output">{job.output.slice(-1200)}</pre>}
        </div>
      ))}
    </div>
  )
}

const CHOICES: { kind: PanelTabKind; label: string; description: string; icon: typeof Files }[] = [
  { kind: 'terminal', label: 'Terminal', description: 'A shell in the project folder', icon: SquareTerminal },
  { kind: 'files', label: 'Files', description: 'The explorer, search and source control', icon: Files },
  { kind: 'editor', label: 'Editor', description: 'The files you have open', icon: Code2 },
  { kind: 'browser', label: 'Browser', description: 'Preview a page next to the thread', icon: Globe },
  { kind: 'trajectory', label: 'Trajectory', description: 'Every step this session took', icon: ListTree },
]

/** What a new tab can become, and the pages you opened lately. */
export function NewTabPane() {
  const recent = usePanels((state) => state.recentPages)
  return (
    <div className="newtab">
      <h2 className="newtab-title">Open in the side panel</h2>
      <div className="newtab-grid">
        {CHOICES.map(({ kind, label, description, icon: Icon }) => (
          <button key={kind} type="button" className="newtab-card" onClick={() => usePanels.getState().open(kind)}>
            <span className="newtab-icon">
              <Icon size={16} />
            </span>
            <span className="newtab-text">
              <span className="newtab-label">{label}</span>
              <span className="newtab-description">{description}</span>
            </span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h3 className="newtab-subtitle">Recent pages</h3>
          <div className="newtab-recent">
            {recent.map((url) => (
              <button key={url} type="button" className="newtab-page" title={url} onClick={() => usePanels.getState().openPage(url)}>
                <Globe size={14} />
                <span>{url.replace(/^https?:\/\//, '')}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
