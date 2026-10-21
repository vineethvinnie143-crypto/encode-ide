import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, MessageCircleQuestion, ShieldAlert } from '../../ui/icons'
import { useChat } from '../../stores/chat'
import { useSessions } from '../../stores/sessions'
import { useWorkspace } from '../../stores/workspace'
import { LogoMark } from '../../ui/Logo'
import Composer from './Composer'
import DiffView from './DiffView'
import GoalCard from './GoalCard'
import PlanCard from './PlanCard'
import TodoCard from './TodoCard'
import TurnView from './TurnView'
import { buildTurns } from './turns'

const SUGGESTIONS = [
  'Explain the structure of this project',
  'Write a README for this project',
  'Find and fix an obvious bug in this codebase',
  'Add tests for the main module',
]

/** Within this many pixels of the bottom, the thread follows new text. */
const FOLLOW_WITHIN = 90

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
  const activeId = useSessions((state) => state.activeId)

  const listRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const turns = useMemo(() => buildTurns(entries, running), [entries, running])

  const scrollToEnd = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }

  // Stay at the bottom while the thread grows (streaming, a step opening, a log folding), unless you scrolled up.
  useEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollToEnd()
    })
    observer.observe(thread)
    return () => observer.disconnect()
  }, [])

  // A different session starts at its end.
  useEffect(() => {
    follow.current = true
    setAtBottom(true)
    scrollToEnd()
  }, [activeId])

  const jumpTo = (id: string) => {
    follow.current = false
    setAtBottom(false)
    listRef.current?.querySelector(`[data-turn="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
  }

  return (
    <div className="chat-panel" data-status={status}>
      <GoalCard />
      <TodoCard />
      <PlanCard />

      <div className="chat-scroll">
        <div
          className="chat-list"
          ref={listRef}
          onScroll={() => {
            const list = listRef.current
            if (!list) return
            const near = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_WITHIN
            follow.current = near
            setAtBottom(near)
          }}
        >
          <div className="thread" ref={threadRef}>
            {entries.length === 0 && !running && (
              <div className="chat-empty">
                <LogoMark size={44} className="chat-empty-mark" />
                <h2>{workspace ? `What are we building in ${workspace.name}?` : 'What are we building?'}</h2>
                <p>
                  {workspace
                    ? 'Describe a task. eNCode reads your files, edits them and runs commands in its own shell, with your approval.'
                    : 'Open a folder, then describe what you want eNCode to build or fix.'}
                </p>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" className="suggestion" onClick={() => setDraft(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} />
            ))}
          </div>
        </div>

        {turns.length >= 3 && (
          <div className="turn-ticks" role="navigation" aria-label="Turns">
            {turns.map((turn) =>
              turn.user ? (
                <button key={turn.id} type="button" className="turn-tick" title={turn.user.text?.slice(0, 80)} aria-label={`Jump to: ${turn.user.text?.slice(0, 60)}`} onClick={() => jumpTo(turn.id)} />
              ) : null,
            )}
          </div>
        )}

        {!atBottom && (
          <button
            type="button"
            className="latest-btn"
            aria-label="Jump to the latest"
            title="Jump to the latest"
            onClick={() => {
              follow.current = true
              setAtBottom(true)
              scrollToEnd()
            }}
          >
            <ArrowDown size={16} />
          </button>
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
