import { useEffect } from 'react'
import { EFFORT_INFO, mainLabel } from '@shared/models'
import { POLICY_LABELS } from '../../policies'
import { useChat } from '../../stores/chat'
import { useGit } from '../../stores/git'
import { useModels } from '../../stores/models'
import { useSandbox } from '../../stores/sandbox'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { CONTEXT_WINDOW, conversationStats } from './stats'

interface Fact {
  label: string
  value: string
  mono?: boolean
  tone?: 'warning'
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

const SANDBOX_STATES = { active: 'On', off: 'Off', unavailable: 'Not available on this computer' } as const

/** /status: what this session runs with (folder, model, permissions, sandbox) and how much of the context it uses. */
export function StatusDialog() {
  const open = useUi((state) => state.statusOpen)
  const close = () => useUi.getState().setStatusOpen(false)
  const settings = useSettings((state) => state.settings)
  const workspace = useWorkspace((state) => state.workspace)
  const git = useGit((state) => state.status)
  const sandbox = useSandbox((state) => state.report)
  const models = useModels((state) => state.status)
  const title = useSessions((state) => state.sessions.find((session) => session.id === state.activeId)?.title)
  const entries = useChat((state) => state.entries)
  const usage = useChat((state) => state.usageTotals)
  const goal = useChat((state) => state.goal)

  // What can have changed since it was last read is read again while the dialog opens.
  useEffect(() => {
    if (!open) return
    void useModels.getState().loadStatus()
    if (useWorkspace.getState().workspace) {
      void useGit.getState().refresh()
      void useSandbox.getState().refresh()
    }
  }, [open])

  const stats = conversationStats(entries, usage)
  const facts: Fact[] = [
    { label: 'Session', value: title ?? 'New session' },
    { label: 'Folder', value: workspace?.root ?? 'No folder open', mono: Boolean(workspace) },
  ]
  if (workspace && git.isRepo) {
    const moved = [git.ahead ? `${git.ahead} ahead` : '', git.behind ? `${git.behind} behind` : ''].filter(Boolean).join(', ')
    facts.push({ label: 'Branch', value: `${git.branch ?? 'detached'}${moved ? ` (${moved})` : ''} · ${git.changes.length ? plural(git.changes.length, 'change') : 'no changes'}` })
  }
  if (settings) {
    facts.push(
      { label: 'Model', value: mainLabel(settings) },
      { label: 'Effort', value: settings.efforts.main ? EFFORT_INFO[settings.efforts.main].label : 'Model default' },
      { label: 'Mode', value: settings.agentMode === 'plan' ? 'Plan first, then build' : 'Code' },
      { label: 'Permissions', value: POLICY_LABELS[settings.policy ?? 'workspace-write'], ...(settings.policy === 'full-access' ? { tone: 'warning' as const } : {}) },
    )
  }
  if (workspace && sandbox) {
    facts.push({ label: 'Sandbox', value: `${SANDBOX_STATES[sandbox.state]}${sandbox.state !== 'active' && sandbox.reason ? `: ${sandbox.reason}` : ''}`, ...(sandbox.state === 'active' ? {} : { tone: 'warning' as const }) })
  }
  if (goal) facts.push({ label: 'Goal', value: `${goal.text} (${goal.status})` })
  facts.push(
    { label: 'Context', value: `${stats.context}% of ${Math.round(CONTEXT_WINDOW / 1000)}k tokens` },
    { label: 'Usage', value: `${plural(stats.totalTokens, 'token')}${stats.cacheHit ? `, ${stats.cacheHit}% from cache` : ''} · ${plural(stats.turns, 'turn')} · ${plural(stats.steps, 'step')}` },
  )
  for (const provider of models?.providers ?? []) {
    const parts = [
      provider.blocked ? `paused until ${new Date(provider.blocked.until).toLocaleTimeString(undefined, { timeStyle: 'short' })}: ${provider.blocked.message}` : 'ready',
      provider.freeLeft !== undefined ? `${provider.freeLeft.toLocaleString()} free requests left today` : '',
      provider.catalogError ? `model list: ${provider.catalogError}` : '',
    ].filter(Boolean)
    facts.push({ label: provider.name, value: parts.join(' · '), ...(provider.blocked || provider.catalogError ? { tone: 'warning' as const } : {}) })
  }
  for (const problem of models?.problems ?? []) facts.push({ label: 'Problem', value: problem, tone: 'warning' })

  const copy = () => {
    const text = facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n')
    void navigator.clipboard.writeText(text).then(() => useUi.getState().notify('success', 'Status copied.'))
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Status"
      width={520}
      className="status-dialog"
      footer={
        <>
          <Button onClick={copy}>Copy</Button>
          <Button variant="primary" data-autofocus onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <dl className="status-facts">
        {facts.map((fact, index) => (
          <div key={`${fact.label}-${index}`}>
            <dt>{fact.label}</dt>
            <dd className={cx(fact.mono && 'is-mono', fact.tone === 'warning' && 'is-warning')}>
              {fact.label === 'Context' && <span className="status-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, stats.context)}%` }} /></span>}
              <span>{fact.value}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}
