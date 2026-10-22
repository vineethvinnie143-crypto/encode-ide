import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, MessageCircleQuestion } from '../../ui/icons'
import { useChat } from '../../stores/chat'
import { useWorkspace } from '../../stores/workspace'
import { LogoMark } from '../../ui/Logo'
import { reducedMotion, scrollBehavior } from '../../ui/motion'
import TrustBanner from '../permissions/TrustBanner'
import ApprovalCard from './ApprovalCard'
import Composer from './Composer'
import GoalCard from './GoalCard'
import PlanCard from './PlanCard'
import TodoCard from './TodoCard'
import TurnView from './TurnView'
import { buildTurns, latestEditTurn, reuseTurns, type Turn } from './turns'

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
  const ask = useChat((state) => state.ask)
  const answer = useChat((state) => state.answer)
  const setDraft = useChat((state) => state.setDraft)
  const workspace = useWorkspace((state) => state.workspace)
  const loadedFor = useChat((state) => state.loadedFor)

  const listRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // A turn that did not change stays the same object, so a streaming answer redraws only its own turn.
  const shown = useRef<Turn[]>([])
  const turns = useMemo(() => (shown.current = reuseTurns(shown.current, buildTurns(entries, running))), [entries, running])
  // The last request that edited files: its change card offers Undo.
  const latestEdit = useMemo(() => latestEditTurn(turns)?.id ?? null, [turns])

  const scrollToEnd = (smooth = false) => {
    const list = listRef.current
    if (!list) return
    if (smooth) list.scrollTo({ top: list.scrollHeight, behavior: scrollBehavior() })
    else list.scrollTop = list.scrollHeight
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

  // A different session starts at its end, and comes in with a short fade rather than a cut.
  useEffect(() => {
    follow.current = true
    setAtBottom(true)
    scrollToEnd()
    if (loadedFor && !reducedMotion()) listRef.current?.animate({ opacity: [0.3, 1] }, { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }, [loadedFor])

  const jumpTo = (id: string) => {
    follow.current = false
    setAtBottom(false)
    listRef.current?.querySelector(`[data-turn="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  }

  return (
    <div className="chat-panel" data-status={status}>
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
              <TurnView key={turn.id} turn={turn} latest={turn.id === latestEdit} />
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
              scrollToEnd(!running)
            }}
          >
            <ArrowDown size={16} />
          </button>
        )}
      </div>

      <TrustBanner />
      <ApprovalCard />

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

      <GoalCard />
      <TodoCard />
      <PlanCard />
      <Composer />
    </div>
  )
}
