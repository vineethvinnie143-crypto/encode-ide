import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Paperclip, Pencil, Plus, Shield, Sparkles, Square, Target, Trash2, X } from '../../ui/icons'
import { api } from '../../api'
import { POLICY_DESCRIPTIONS, POLICY_LABELS, POLICY_OPTIONS } from '../../policies'
import { useChat } from '../../stores/chat'
import CommandPalette from '../CommandPalette'
import type { CommandPaletteAction } from '../CommandPalette'
import { useEditor } from '../../stores/editor'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { Pill } from '../../ui/Pill'

const MAX_LINES = 12
const LINE = 22

/** A ring that fills with how much of the context window the conversation uses. */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={cx('context-ring', percent >= 80 && 'is-high')} aria-hidden="true">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="context-ring-track" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="context-ring-fill"
        strokeDasharray={`${(Math.min(100, percent) / 100) * circumference} ${circumference}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

export default function Composer() {
  const draft = useChat((state) => state.draft)
  const setDraft = useChat((state) => state.setDraft)
  const send = useChat((state) => state.send)
  const stop = useChat((state) => state.stop)
  const running = useChat((state) => state.running)
  const ask = useChat((state) => state.ask)
  const answer = useChat((state) => state.answer)
  const entries = useChat((state) => state.entries)
  const enqueue = useChat((state) => state.enqueue)
  const removeQueued = useChat((state) => state.removeQueued)
  const moveQueued = useChat((state) => state.moveQueued)
  const editQueued = useChat((state) => state.editQueued)
  const tokensPerSecond = useChat((state) => state.tokensPerSecond)
  const usageTotals = useChat((state) => state.usageTotals)
  const activeId = useSessions((state) => state.activeId)
  const queue = useChat((state) => state.queues[activeId])
  const activePath = useEditor((state) => state.activePath)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const activeProfile = useSettings((state) => state.activeProfile())
  const workspace = useWorkspace((state) => state.workspace)
  const notify = useUi((state) => state.notify)
  const askText = useUi((state) => state.askText)

  const [attachments, setAttachments] = useState<{ path: string; content: string }[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The box grows from one line to twelve, then scrolls.
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(MAX_LINES * LINE, Math.max(LINE, element.scrollHeight))}px`
  }, [draft])

  const policy = settings?.policy ?? 'workspace-write'
  const mode = settings?.agentMode ?? 'code'

  const stats = useMemo(() => {
    const turns = entries.filter((entry) => entry.kind === 'user').length
    const steps = entries.filter((entry) => entry.kind === 'tool').length
    const chars = entries.reduce((total, entry) => total + (entry.text?.length ?? 0), 0)
    const estimated = Math.round(chars / 4)
    const totalTokens = usageTotals.total || estimated
    const cacheHit = usageTotals.total > 0 ? Math.round((usageTotals.cached / usageTotals.total) * 100) : 0
    const context = Math.min(100, Math.round((totalTokens / 128_000) * 100))
    return { turns, steps, totalTokens, cacheHit, context, tokensPerSecond }
  }, [entries, tokensPerSecond, usageTotals])

  const attachActiveFile = async () => {
    if (!activePath) {
      notify('info', 'Open a file to attach it as context.')
      return
    }
    if (attachments.some((file) => file.path === activePath)) return
    try {
      const file = await api.workspace.read(activePath)
      if (file.binary) {
        notify('info', 'Binary files cannot be attached as text context.')
        return
      }
      setAttachments((previous) => [...previous, { path: activePath, content: file.content }])
    } catch (error) {
      notify('error', (error as Error).message)
    }
  }

  const togglePlan = () => void save({ agentMode: mode === 'plan' ? 'code' : 'plan' })

  const setGoal = async () => {
    const sessionId = useSessions.getState().activeId
    const current = useChat.getState().goal
    const text = await askText(current ? 'Goal' : 'Set a goal', 'Goal', current?.text ?? '')
    if (text && sessionId) {
      void api.agent.setGoal(sessionId, { text, status: 'active', rounds: 0, createdAt: Date.now(), updatedAt: Date.now() })
    }
  }

  const compact = async () => {
    const sessionId = useSessions.getState().activeId
    try {
      const result = await api.agent.compact(sessionId)
      notify('success', result.removed ? `Compacted ${result.removed} messages` : 'Nothing to compact yet')
    } catch (error) {
      notify('error', (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const exportSession = async () => {
    const file = await api.agent.export(useSessions.getState().activeId)
    if (file) notify('success', `Exported to ${file}`)
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    if (ask) {
      void answer(text)
      setDraft('')
      return
    }
    if (!workspace) {
      notify('info', 'Open a workspace first so the agent has a project to work on.')
      return
    }
    // While the agent works, a message waits in the queue and goes out when it is done.
    if (running) {
      enqueue(text)
      return
    }
    const sessions = useSessions.getState()
    const current = sessions.sessions.find((session) => session.id === sessions.activeId)
    if (current && current.title === 'New session') void sessions.rename(current.id, text)
    send(text, attachments)
    setAttachments([])
  }

  const runPaletteAction = async (action: CommandPaletteAction) => {
    setPaletteOpen(false)
    switch (action) {
      case 'file':
        await attachActiveFile()
        break
      case 'goal':
        await setGoal()
        break
      case 'plan':
        togglePlan()
        break
      case 'feedback': {
        const text = await askText('Feedback', 'What went well or badly?')
        if (text) {
          await api.app.feedback(text)
          notify('success', 'Feedback recorded')
        }
        break
      }
      case 'compact':
        await compact()
        break
      case 'permission':
        document.querySelector<HTMLButtonElement>('.policy-chip')?.click()
        break
      case 'model':
        useUi.getState().openSettings('models')
        break
      case 'export':
        await exportSession()
        break
    }
  }

  const addEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-add', label: 'Add' },
    { id: 'file', label: 'The open file', description: activePath ?? 'Open a file in the editor first', disabled: !activePath, onSelect: () => void attachActiveFile() },
    { id: 'goal', label: 'A goal for a long task…', icon: <Target size={14} />, onSelect: () => void setGoal() },
    { kind: 'separator', id: 'sep-add' },
    { id: 'plan', label: 'Plan mode', description: 'Plan first, then ask before building.', checked: mode === 'plan', shortcut: 'Shift+Tab', onSelect: togglePlan },
    { kind: 'separator', id: 'sep-session' },
    { id: 'compact', label: 'Compact the conversation', onSelect: () => void compact() },
    { id: 'export', label: 'Export session…', onSelect: () => void exportSession() },
    { id: 'commands', label: 'All commands…', shortcut: '/', onSelect: () => setPaletteOpen(true) },
  ]

  const policyEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-policy', label: 'What eNCode may do without asking' },
    ...POLICY_OPTIONS.map((option) => ({
      id: option,
      label: POLICY_LABELS[option],
      description: POLICY_DESCRIPTIONS[option],
      checked: policy === option,
      onSelect: () => void save({ policy: option }),
    })),
  ]

  const placeholder = !workspace
    ? 'Open a workspace to start…'
    : ask
      ? "Answer the agent's question…"
      : running
        ? 'Queue a message for when eNCode is done…'
        : 'Message or run a task. / commands, @ files or sessions'

  const lastPrompt = [...entries].reverse().find((entry) => entry.kind === 'user')?.text
  const tone = policy === 'full-access' ? 'warning' : policy === 'auto-review' ? 'accent' : 'neutral'

  return (
    <div className="composer-dock">
      {queue && queue.length > 0 && (
        <div className="queue-strip" aria-label="Queued messages">
          <div className="queue-head">
            Queued · {queue.length}
            <span className="queue-note">sent one by one when eNCode is done</span>
          </div>
          {queue.map((item, index) => (
            <div className="queue-row" key={item.id}>
              <span className="queue-text" title={item.text}>
                {item.text}
              </span>
              <span className="queue-actions">
                <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => moveQueued(item.id, -1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label="Move down" size="sm" disabled={index === queue.length - 1} onClick={() => moveQueued(item.id, 1)}>
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton label="Edit queued message" size="sm" onClick={() => editQueued(item.id)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton label="Remove queued message" size="sm" onClick={() => removeQueued(item.id)}>
                  <Trash2 size={14} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((file) => (
            <span className="attachment-chip" key={file.path} title={file.path}>
              <Paperclip size={11} />
              {file.path.split('/').pop()}
              <button
                className="chip-remove"
                onClick={() => setAttachments((previous) => previous.filter((item) => item.path !== file.path))}
                title="Remove attachment"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={cx('composer-card', running && 'is-running')}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          placeholder={placeholder}
          rows={1}
          onChange={(event) => {
            const value = event.target.value
            if (value === '/') {
              setPaletteOpen(true)
              setDraft('')
              return
            }
            setDraft(value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            } else if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault()
              togglePlan()
            } else if (event.key === 'ArrowUp' && !draft && lastPrompt) {
              event.preventDefault()
              setDraft(lastPrompt)
            }
          }}
        />

        <div className="composer-toolbar">
          <Menu
            label="Add"
            side="top"
            width={320}
            entries={addEntries}
            trigger={(props) => (
              <IconButton label="Add" size="md" className="composer-plus" {...props}>
                <Plus size={16} />
              </IconButton>
            )}
          />

          <Menu
            label="Permissions"
            side="top"
            width={360}
            entries={policyEntries}
            trigger={(props) => (
              <Pill className="policy-chip" tone={tone} icon={<Shield size={14} />} caret={<ChevronDown size={12} />} title="What eNCode may do without asking" {...props}>
                {POLICY_LABELS[policy]}
              </Pill>
            )}
          />

          <span className="composer-spacer" />

          <Pill
            className="model-chip"
            icon={<Sparkles size={13} />}
            caret={<ChevronDown size={12} />}
            title="Model settings"
            onClick={() => useUi.getState().openSettings('models')}
          >
            {activeProfile ? `${activeProfile.name}: ${activeProfile.model || 'pick a model'}` : 'No model'}
          </Pill>

          {running && !ask ? (
            <button type="button" className="composer-send is-stop" onClick={() => void stop()} title="Stop" aria-label="Stop">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="composer-send" onClick={submit} disabled={!draft.trim() || !workspace} title="Send (Enter)" aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onAction={(action) => void runPaletteAction(action)} />}

      <div className="composer-stats">
        <ContextRing percent={stats.context} />
        <span>{stats.turns === 1 ? '1 turn' : `${stats.turns} turns`}</span>
        <span>{stats.steps === 1 ? '1 step' : `${stats.steps} steps`}</span>
        <span className="stats-sep">·</span>
        {stats.tokensPerSecond > 0 && (
          <>
            <span>{stats.tokensPerSecond} tok/s</span>
            <span className="stats-sep">·</span>
          </>
        )}
        <span>{stats.totalTokens.toLocaleString()} tok</span>
        {stats.cacheHit > 0 && (
          <>
            <span className="stats-sep">·</span>
            <span>{stats.cacheHit}% cache hit</span>
          </>
        )}
        <span className="stats-sep">·</span>
        <span>{stats.context}% ctx</span>
      </div>
    </div>
  )
}
