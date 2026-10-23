import { useEffect, useState } from 'react'
import type { BackgroundJob } from '@shared/types'
import { api } from '../../api'
import { useEditor } from '../../stores/editor'
import { usePanels } from '../../stores/panels'
import { useUi } from '../../stores/ui'
import type { SidebarView } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { Activity, Bot, Clock, Code2, Eye, GitBranch, GitPullRequest, Files, Globe, ListTree, Search, SquareTerminal } from '../../ui/icons'
import type { PanelTabKind } from '../../panels/model'
import CodeEditor from '../CodeEditor'
import { jobText } from '../jobs-text'
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
  const info = useEditor((state) => state.info)
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
        {active && <span>{info.indent}</span>}
        {active && <span>{info.eol}</span>}
        <span>{active ? (active.dirty ? 'unsaved' : 'saved') : '—'}</span>
      </div>
    </div>
  )
}

const JOB_ICONS = { command: SquareTerminal, monitor: Eye, agent: Bot, wakeup: Clock } as const

/** One thing the agent left running: what it is, how it stands, and a way to stop it. */
function JobCard({ job }: { job: BackgroundJob }) {
  const { kind, name, mono, badge, command, status } = jobText(job)
  const Icon = JOB_ICONS[kind]
  const running = job.status === 'running'
  return (
    <div className="job-card" data-kind={kind}>
      <div className="job-card-head">
        <Icon size={14} className="job-kind" />
        <span className={mono ? 'job-name is-mono' : 'job-name'} title={name}>
          {name}
        </span>
        {badge && <span className="job-badge">{badge}</span>}
        <span className={`job-status job-${job.status}`}>{status}</span>
        {running && (
          <Button size="sm" variant={kind === 'wakeup' ? 'ghost' : 'danger'} onClick={() => void api.jobs.kill(job.id)}>
            {kind === 'wakeup' ? 'Cancel' : 'Stop'}
          </Button>
        )}
      </div>
      {command && (
        <div className="job-command" title={command}>
          {command}
        </div>
      )}
      {job.output && <pre className={kind === 'wakeup' ? 'job-output is-prompt' : 'job-output'}>{job.output.slice(-1200)}</pre>}
    </div>
  )
}

/** What the agents left running in the background: commands, monitors, subagents and wake-ups, the next wake-up first. */
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
        <span>Nothing in the background. Commands, monitors, subagents and wake-ups the agent leaves running show up here.</span>
      </div>
    )
  }
  return (
    <div className="jobs-pane">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  )
}

const CHOICES: { kind: PanelTabKind; label: string; description: string; icon: typeof Files }[] = [
  { kind: 'terminal', label: 'Terminal', description: 'A shell in the project folder', icon: SquareTerminal },
  { kind: 'files', label: 'Files', description: 'The explorer, search and source control', icon: Files },
  { kind: 'editor', label: 'Editor', description: 'The files you have open', icon: Code2 },
  { kind: 'review', label: 'Review', description: 'The changes to stage, commit or send back', icon: GitPullRequest },
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
