import { Fragment, useEffect, useMemo, useRef } from 'react'
import { MessageCircleQuestion, ShieldAlert, Sparkles } from 'lucide-react'
import type { ConversationEntry } from '@shared/types'
import { useChat } from '../../stores/chat'
import { useWorkspace } from '../../stores/workspace'
import ChatMessage from './ChatMessage'
import Composer from './Composer'
import DiffView from './DiffView'
import EditSummary from './EditSummary'
import GoalCard from './GoalCard'
import PlanCard from './PlanCard'
import TodoCard from './TodoCard'

const SUGGESTIONS = [
  'Explain the structure of this project',
  'Write a README for this project',
  'Find and fix an obvious bug in this codebase',
  'Add tests for the main module',
]

export default function ChatPanel() {
  const entries = useChat((state) => state.entries)
  const status = useChat((state) => state.status)
  const running = useChat((state) => state.running)
  const approval = useChat((state) => state.approval)
  const ask = useChat((state) => state.ask)
  const approve = useChat((state) => state.approve)
  const answer = useChat((state) => state.answer)
  const setDraft = useChat((state) => state.setDraft)
  const workspace = useWorkspace((state) => state.workspace)

  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    if (!stickRef.current) return
    const element = listRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries, status])

  const last = entries[entries.length - 1]
  const showThinking = running && status === 'thinking' && last?.kind !== 'assistant'

  const turns = useMemo(() => {
    const groups: { id: string; entries: ConversationEntry[] }[] = []
    for (const entry of entries) {
      if (entry.kind === 'user' || !groups.length) {
        groups.push({ id: entry.id, entries: [entry] })
      } else {
        groups[groups.length - 1].entries.push(entry)
      }
    }
    return groups
  }, [entries])

  return (
    <div className="chat-panel" data-status={status}>
      <GoalCard />
      <TodoCard />
      <PlanCard />
      <div
        className="chat-list"
        ref={listRef}
        onScroll={() => {
          const element = listRef.current
          if (!element) return
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90
        }}
      >
        {entries.length === 0 && !running && (
          <div className="chat-empty">
            <div className="chat-empty-kicker">
              <Sparkles size={14} />
              eNCode
            </div>
            <h2>What are we building?</h2>
            <p>
              {workspace
                ? 'Describe a task. eNCode reads your files, edits them and runs commands in its own shell — with your approval.'
                : 'Open a workspace, then describe what you want eNCode to build or fix.'}
            </p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} className="suggestion" onClick={() => setDraft(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <Fragment key={turn.id}>
            {turn.entries.map((entry) => (
              <ChatMessage key={entry.id} entry={entry} />
            ))}
            <EditSummary entries={turn.entries} />
          </Fragment>
        ))}

        {showThinking && (
          <div className="msg msg-assistant">
            <div className="thinking-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {approval && (
        <div className="approval-card">
          <div className="approval-head">
            <ShieldAlert size={14} />
            <span>{approval.title}</span>
          </div>
          {approval.reason && <div className="approval-reason">{approval.reason}</div>}
          <pre className="approval-detail">{approval.detail}</pre>
          {approval.preview && approval.preview.length > 0 && (
            <div className="approval-preview">
              <DiffView diff={approval.preview} />
            </div>
          )}
          <div className="approval-actions">
            <button className="btn primary sm" onClick={() => void approve(true)}>
              Approve
            </button>
            <button className="btn ghost sm" onClick={() => void approve(false)}>
              Deny
            </button>
          </div>
        </div>
      )}

      {ask && (
        <div className="ask-card">
          <div className="ask-head">
            <MessageCircleQuestion size={14} />
            <span>{ask.question}</span>
          </div>
          {ask.options && ask.options.length > 0 && (
            <div className="ask-options">
              {ask.options.map((option, index) => (
                <button key={option} className="ask-option" onClick={() => void answer(option)}>
                  <span className="ask-option-index">{index + 1}</span>
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="ask-hint">Type an answer below, or pick one of the options.</div>
        </div>
      )}

      <Composer />
    </div>
  )
}
