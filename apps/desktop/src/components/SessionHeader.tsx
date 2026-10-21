import { useEffect, useState } from 'react'
import { Activity, BookOpen, ChevronDown, MoreHorizontal, Plus, ScrollText, ShieldCheck, Sparkles } from '../ui/icons'
import type { BackgroundJob } from '@shared/types'
import { api } from '../api'
import { useChat } from '../stores/chat'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

export default function SessionHeader() {
  const sessions = useSessions((state) => state.sessions)
  const activeId = useSessions((state) => state.activeId)
  const newSession = useSessions((state) => state.newSession)
  const entries = useChat((state) => state.entries)
  const running = useChat((state) => state.running)
  const status = useChat((state) => state.status)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const mainView = useUi((state) => state.mainView)
  const setMainView = useUi((state) => state.setMainView)

  const [modeOpen, setModeOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [jobs, setJobs] = useState<BackgroundJob[]>([])

  useEffect(() => {
    void api.jobs.list().then(setJobs).catch(() => setJobs([]))
    return api.jobs.onChange(setJobs)
  }, [])

  const runningJobs = jobs.filter((job) => job.status === 'running').length

  useEffect(() => {
    const close = () => {
      setModeOpen(false)
      setMenuOpen(false)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const session = sessions.find((item) => item.id === activeId)
  const mode = settings?.agentMode ?? 'code'
  const toolCount = entries.filter((entry) => entry.kind === 'tool').length

  useEffect(() => {
    document.title = `${session?.title ?? 'New session'} — eNCode`
  }, [session?.title])

  return (
    <header className="session-header">
      <div className="session-heading">
        <h1 className="session-title">{session?.title ?? 'New session'}</h1>

        <div className="session-chip-wrap" onClick={(event) => event.stopPropagation()}>
          <button className="session-chip" onClick={() => setModeOpen((value) => !value)}>
            <ShieldCheck size={13} />
            {mode === 'code' ? 'Standard mode' : 'Ask mode'}
            <ChevronDown size={12} />
          </button>
          {modeOpen && (
            <div className="session-popover">
              <button
                className={mode === 'code' ? 'is-selected' : ''}
                onClick={() => {
                  void save({ agentMode: 'code' })
                  setModeOpen(false)
                }}
              >
                <ShieldCheck size={13} /> Standard mode
                <span>read · edit · run</span>
              </button>
              <button
                className={mode === 'ask' ? 'is-selected' : ''}
                onClick={() => {
                  void save({ agentMode: 'ask' })
                  setModeOpen(false)
                }}
              >
                <Sparkles size={13} /> Ask mode
                <span>read-only analysis</span>
              </button>
              <button
                className={mode === 'plan' ? 'is-selected' : ''}
                onClick={() => {
                  void save({ agentMode: 'plan' })
                  setModeOpen(false)
                }}
              >
                <ScrollText size={13} /> Plan mode
                <span>plan, then approve</span>
              </button>
            </div>
          )}
        </div>

        <span className={`session-chip ${running ? 'is-live' : ''}`}>
          <Activity size={13} />
          {running ? '1 background job running' : `${toolCount} tool step${toolCount === 1 ? '' : 's'}`}
        </span>

        {jobs.length > 0 && (
          <span className="session-chip-wrap">
            <span className="session-chip">
              <Activity size={13} />
              {runningJobs} job{runningJobs === 1 ? '' : 's'}
            </span>
            <div className="session-popover right job-popover">
              {jobs.slice(0, 8).map((job) => (
                <div className="job-row" key={job.id}>
                  <span className={`job-status job-${job.status}`}>{job.status}</span>
                  <span className="job-command" title={job.command}>
                    {job.command}
                  </span>
                  {job.output ? <span className="job-preview">{job.output.slice(-160)}</span> : null}
                  {job.status === 'running' && (
                    <button className="icon-btn tiny" title="Stop job" onClick={() => void api.jobs.kill(job.id)}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </span>
        )}
        {status === 'awaiting-approval' && <span className="session-chip is-warn">Approval needed</span>}
        {status === 'awaiting-user' && <span className="session-chip is-warn">Waiting for you</span>}
      </div>

      <div className="session-actions" onClick={(event) => event.stopPropagation()}>
        <button
          className={`icon-btn ${mainView === 'trajectory' ? 'is-on' : ''}`}
          title="Trajectory"
          onClick={() => setMainView(mainView === 'trajectory' ? 'chat' : 'trajectory')}
        >
          <BookOpen size={15} />
        </button>
        <button className="icon-btn" title="New session" onClick={newSession}>
          <Plus size={15} />
        </button>
        <div className="session-chip-wrap">
          <button className="icon-btn" title="Session menu" onClick={() => setMenuOpen((value) => !value)}>
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="session-popover right">
              <button onClick={() => { setMenuOpen(false); setSettingsOpen(true) }}>
                Model settings
              </button>
              <button onClick={() => { setMenuOpen(false); newSession() }}>
                Clear session
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
