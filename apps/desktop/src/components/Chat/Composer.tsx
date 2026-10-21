import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Paperclip, Plus, Shield, Sparkles, Square, X } from 'lucide-react'
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

export default function Composer() {
  const draft = useChat((state) => state.draft)
  const setDraft = useChat((state) => state.setDraft)
  const send = useChat((state) => state.send)
  const stop = useChat((state) => state.stop)
  const running = useChat((state) => state.running)
  const ask = useChat((state) => state.ask)
  const answer = useChat((state) => state.answer)
  const entries = useChat((state) => state.entries)
  const tokensPerSecond = useChat((state) => state.tokensPerSecond)
  const usageTotals = useChat((state) => state.usageTotals)
  const activePath = useEditor((state) => state.activePath)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const activeProfile = useSettings((state) => state.activeProfile())
  const workspace = useWorkspace((state) => state.workspace)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const notify = useUi((state) => state.notify)
  const askText = useUi((state) => state.askText)

  const [attachments, setAttachments] = useState<{ path: string; content: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(200, Math.max(42, element.scrollHeight))}px`
  }, [draft])

  const policy = settings?.policy ?? 'workspace-write'
  const [policyOpen, setPolicyOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

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

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    if (ask) {
      void answer(text)
      setDraft('')
      return
    }
    if (running) return
    if (!workspace) {
      notify('info', 'Open a workspace first so the agent has a project to work on.')
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
    const sessionId = useSessions.getState().activeId
    switch (action) {
      case 'file':
        await attachActiveFile()
        break
      case 'goal': {
        const current = useChat.getState().goal
        const text = await askText(current ? 'Goal' : 'Set a goal', 'Goal', current?.text ?? '')
        if (text && sessionId) {
          void api.agent.setGoal(sessionId, {
            text,
            status: 'active',
            rounds: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        }
        break
      }
      case 'plan':
        void save({ agentMode: (settings?.agentMode ?? 'code') === 'plan' ? 'code' : 'plan' })
        break
      case 'feedback': {
        const text = await askText('Feedback', 'What went well or badly?')
        if (text) {
          await api.app.feedback(text)
          notify('success', 'Feedback recorded')
        }
        break
      }
      case 'compact': {
        try {
          const result = await api.agent.compact(sessionId)
          notify('success', result.removed ? `Compacted ${result.removed} messages` : 'Nothing to compact yet')
        } catch (error) {
          notify('error', (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        }
        break
      }
      case 'permission':
        setPolicyOpen(true)
        break
      case 'model':
        setSettingsOpen(true)
        break
      case 'export': {
        const file = await api.agent.export(sessionId)
        if (file) notify('success', `Exported to ${file}`)
        break
      }
    }
  }

  const placeholder = !workspace
    ? 'Open a workspace to start…'
    : ask
      ? "Answer the agent's question…"
      : running
        ? 'eNCode is working…'
        : 'Message or run a task. / commands, @ files or sessions'

  return (
    <div className="composer-dock">
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

      <div className={`composer-card ${running ? 'is-running' : ''}`}>
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
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-toolbar">
          <button className="composer-plus" onClick={() => setPaletteOpen(true)} title="Commands (/)">
            <Plus size={15} />
          </button>

          <span className="session-chip-wrap">
            <button className="policy-chip" onClick={() => setPolicyOpen((value) => !value)} title="Tool permission policy">
              <Shield size={13} />
              {POLICY_LABELS[policy]}
              <ChevronDown size={12} />
            </button>
            {policyOpen && (
              <div className="session-popover policy-menu">
                {POLICY_OPTIONS.map((option) => (
                  <button
                    key={option}
                    className={policy === option ? 'is-selected' : ''}
                    title={POLICY_DESCRIPTIONS[option]}
                    onClick={() => {
                      setPolicyOpen(false)
                      void save({ policy: option })
                    }}
                  >
                    <Shield size={13} /> {POLICY_LABELS[option]}
                    {policy === option && <span>selected</span>}
                  </button>
                ))}
              </div>
            )}
          </span>

          <span className="composer-spacer" />

          <button className="model-chip" onClick={() => setSettingsOpen(true)} title="Model settings">
            <Sparkles size={12} />
            {activeProfile ? `${activeProfile.name}: ${activeProfile.model || 'pick a model'}` : 'No model'}
            <ChevronDown size={12} />
          </button>

          {running && !ask ? (
            <button className="composer-send is-stop" onClick={() => void stop()} title="Stop">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="composer-send" onClick={submit} disabled={!draft.trim() || !workspace} title="Send (Enter)">
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onAction={(action) => void runPaletteAction(action)} />
      )}

      <div className="composer-stats">
        <span>{stats.turns} turns</span>
        <span>{stats.steps} steps</span>
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
