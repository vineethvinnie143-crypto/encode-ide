import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import type { AgentMode, BackgroundJob } from '@shared/types'
import { api } from '../api'
import { commandRegistry, sessionActions } from '../commands/app'
import { useChat } from '../stores/chat'
import { useGit } from '../stores/git'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'
import { IconButton } from '../ui/Button'
import { cx } from '../ui/cx'
import { Activity, ChevronDown, ExternalLink, GitBranch, MoreHorizontal, PanelRight, ShieldCheck, Sparkles, ScrollText } from '../ui/icons'
import { Menu, type MenuEntry } from '../ui/Menu'
import { Spinner } from '../ui/Spinner'
import { editTotals } from './Chat/turns'

const MODES: { value: AgentMode; label: string; description: string }[] = [
  { value: 'code', label: 'Standard mode', description: 'Reads, edits and runs commands.' },
  { value: 'ask', label: 'Ask mode', description: 'Reads and answers. Never edits or runs commands.' },
  { value: 'plan', label: 'Plan mode', description: 'Plans first, then asks before building.' },
]

function liveState(status: string): { tone: 'accent' | 'warning' | 'danger'; label: string; spinner?: boolean } | null {
  if (status === 'thinking' || status === 'running-tool') return { tone: 'accent', label: 'Working', spinner: true }
  if (status === 'awaiting-approval') return { tone: 'warning', label: 'Needs approval' }
  if (status === 'awaiting-user') return { tone: 'warning', label: 'Waiting for you' }
  if (status === 'error') return { tone: 'danger', label: 'Error' }
  return null
}

/** A 24 px chip you can click, used to open a small menu from the header. */
function ChipButton({ className, children, ...rest }: ComponentProps<'button'>) {
  return (
    <button type="button" className={cx('ui-chip', 'is-button', className)} {...rest}>
      {children}
    </button>
  )
}

/** 52 px: the session's title, where it runs and what it is doing, and its menus. */
export default function SessionHeader() {
  const sessions = useSessions((state) => state.sessions)
  const activeId = useSessions((state) => state.activeId)
  const entries = useChat((state) => state.entries)
  const status = useChat((state) => state.status)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const branch = useGit((state) => state.status.branch)
  const workspace = useWorkspace((state) => state.workspace)
  const mainView = useUi((state) => state.mainView)
  const rightVisible = useUi((state) => state.rightVisible)
  const [jobs, setJobs] = useState<BackgroundJob[]>([])

  useEffect(() => {
    void api.jobs.list().then(setJobs).catch(() => setJobs([]))
    return api.jobs.onChange(setJobs)
  }, [])

  const session = sessions.find((item) => item.id === activeId)
  const mode = settings?.agentMode ?? 'code'
  const live = liveState(status)
  const runningJobs = jobs.filter((job) => job.status === 'running')

  useEffect(() => {
    document.title = `${session?.title ?? 'New session'} — eNCode`
  }, [session?.title])

  const totals = useMemo(() => editTotals(entries), [entries])
  const commands = entries.filter((entry) => entry.tool && (entry.tool.name === 'pwsh' || entry.tool.name === 'run_command')).length
  const subagents = entries.filter((entry) => entry.tool?.name === 'task').length

  const openInEntries = (): MenuEntry[] => [
    { id: 'explorer', label: 'File Explorer', disabled: !workspace, onSelect: () => void api.workspace.reveal('') },
    { id: 'copy-path', label: 'Copy folder path', disabled: !workspace, onSelect: () => void navigator.clipboard.writeText(workspace?.root ?? '') },
  ]

  const summaryEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-summary', label: 'This session' },
    {
      id: 'files',
      label: 'Files changed',
      description: totals.files ? `${totals.files} file${totals.files === 1 ? '' : 's'}, +${totals.additions} −${totals.deletions}` : 'None yet',
      disabled: !totals.files,
      onSelect: () => {
        useUi.getState().setSidebarView('git')
        useUi.getState().setWorkspaceTab('files')
      },
    },
    { id: 'commands', label: 'Commands run', description: String(commands), onSelect: () => useUi.getState().setMainView('trajectory') },
    { id: 'subagents', label: 'Subagents', description: String(subagents), onSelect: () => useUi.getState().setMainView('trajectory') },
    {
      id: 'jobs',
      label: 'Background jobs',
      description: runningJobs.length ? `${runningJobs.length} running` : 'None running',
      disabled: !runningJobs.length,
      onSelect: () => {
        for (const job of runningJobs) void api.jobs.kill(job.id)
      },
    },
    { kind: 'separator', id: 'sep-trajectory' },
    {
      id: 'trajectory',
      label: mainView === 'trajectory' ? 'Show the conversation' : 'Show the trajectory',
      onSelect: () => useUi.getState().setMainView(mainView === 'trajectory' ? 'chat' : 'trajectory'),
    },
  ]

  const actionEntries = (): MenuEntry[] => {
    if (!session) return []
    return [
      { id: 'rename', label: 'Rename', shortcut: commandRegistry.shortcut('session.rename'), onSelect: () => void sessionActions.rename(session) },
      { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin', shortcut: commandRegistry.shortcut('session.pin'), onSelect: () => void sessionActions.togglePin(session) },
      { id: 'unread', label: 'Mark as unread', shortcut: commandRegistry.shortcut('session.unread'), onSelect: () => void sessionActions.toggleUnread(session) },
      { kind: 'separator', id: 'sep-a' },
      {
        id: 'compact',
        label: 'Compact the conversation',
        description: 'Summarise older messages to free up context.',
        onSelect: () => {
          void api.agent
            .compact(session.id)
            .then((result) => useUi.getState().notify('success', result.removed ? `Compacted ${result.removed} messages` : 'Nothing to compact yet'))
            .catch((error: Error) => useUi.getState().notify('error', error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
        },
      },
      { id: 'fork', label: 'Fork session', onSelect: () => void sessionActions.fork(session) },
      { id: 'export', label: 'Export session…', onSelect: () => void sessionActions.export(session) },
      { kind: 'separator', id: 'sep-b' },
      { id: 'archive', label: 'Archive', shortcut: commandRegistry.shortcut('session.archive'), onSelect: () => void sessionActions.archive(session) },
      { id: 'delete', label: 'Delete…', danger: true, onSelect: () => void sessionActions.remove(session) },
    ]
  }

  const modeEntries = (): MenuEntry[] =>
    MODES.map((item) => ({
      id: item.value,
      label: item.label,
      description: item.description,
      checked: mode === item.value,
      onSelect: () => void save({ agentMode: item.value }),
    }))

  const ModeIcon = mode === 'plan' ? ScrollText : mode === 'ask' ? Sparkles : ShieldCheck

  return (
    <header className="session-header">
      <div className="session-heading">
        <h1 className="session-title" title={session?.title} onDoubleClick={() => session && void sessionActions.rename(session)}>
          {session?.title ?? 'New session'}
        </h1>
        {branch && (
          <span className="ui-chip is-mono" title={`Branch ${branch}`}>
            <GitBranch size={12} />
            {branch}
          </span>
        )}
        {live && (
          <span className={cx('ui-chip', `tone-${live.tone}`)} role="status">
            {live.spinner && <Spinner size={12} />}
            {live.label}
          </span>
        )}
        <Menu
          label="Mode"
          width={300}
          entries={modeEntries}
          trigger={(props) => (
            <ChipButton {...props}>
              <ModeIcon size={12} />
              {MODES.find((item) => item.value === mode)?.label}
              <ChevronDown size={12} />
            </ChipButton>
          )}
        />
        {runningJobs.length > 0 && (
          <span className="ui-chip tone-accent">
            <Activity size={12} />
            {runningJobs.length} job{runningJobs.length === 1 ? '' : 's'} running
          </span>
        )}
      </div>

      <div className="session-actions">
        <Menu
          label="Open in"
          align="end"
          width={220}
          entries={openInEntries}
          trigger={(props) => (
            <IconButton label="Open in" size="md" {...props}>
              <ExternalLink size={16} />
            </IconButton>
          )}
        />
        <Menu
          label="Summary"
          align="end"
          width={300}
          entries={summaryEntries}
          trigger={(props) => (
            <IconButton label="Summary" size="md" active={mainView === 'trajectory'} {...props}>
              <Activity size={16} />
            </IconButton>
          )}
        />
        <Menu
          label="Session actions"
          align="end"
          width={280}
          entries={actionEntries}
          trigger={(props) => (
            <IconButton label="More" size="md" {...props}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        />
        <IconButton
          label="Show or hide the side panel"
          shortcut={commandRegistry.shortcut('view.sidePanel')}
          size="md"
          active={rightVisible}
          onClick={() => commandRegistry.run('view.sidePanel')}
        >
          <PanelRight size={16} />
        </IconButton>
      </div>
    </header>
  )
}
