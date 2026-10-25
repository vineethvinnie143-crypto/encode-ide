import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, MessageCircleQuestion } from '../../ui/icons'
import { useChat } from '../../stores/chat'
import { useFind } from '../../stores/find'
import { useWorkspace } from '../../stores/workspace'
import { LogoMark } from '../../ui/Logo'
import { reducedMotion, scrollBehavior } from '../../ui/motion'
import TrustBanner from '../permissions/TrustBanner'
import ApprovalCard from './ApprovalCard'
import Composer from './Composer'
import FindBar from './FindBar'
import { followsAfterScroll, YOURS_MS } from './follow'
import GoalCard from './GoalCard'
import PlanCard from './PlanCard'
import TodoCard from './TodoCard'
import { WorkRoot } from './shown-path'
import TurnView from './TurnView'
import { buildTurns, latestEditTurn, latestSearchOffer, reuseTurns, type Turn } from './turns'

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
  const ask = useChat((state) => state.ask)
  const answer = useChat((state) => state.answer)
  const setDraft = useChat((state) => state.setDraft)
  const workspace = useWorkspace((state) => state.workspace)
  const loadedFor = useChat((state) => state.loadedFor)

  const listRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // Whether the thread follows new text (follow.ts), and where the list was when it last scrolled.
  const follow = useRef(true)
  const lastTop = useRef(0)
  const [following, setFollowing] = useState(true)
  // When you last scrolled the list yourself (the wheel, a key, a touch, a find), and whether you hold it (a press on
  // the list or its scrollbar): only a move up of yours stops the thread following.
  const touched = useRef(-Infinity)
  const pressed = useRef(false)
  const touch = () => {
    touched.current = performance.now()
  }

  // A turn that did not change stays the same object, so a streaming answer redraws only its own turn.
  const shown = useRef<Turn[]>([])
  const turns = useMemo(() => (shown.current = reuseTurns(shown.current, buildTurns(entries, running))), [entries, running])
  // The last request that edited files: its change card offers Undo.
  const latestEdit = useMemo(() => latestEditTurn(turns)?.id ?? null, [turns])
  // The last request whose search a free key would have made work: it offers the key, once for the conversation.
  const searchOffer = useMemo(() => latestSearchOffer(turns)?.id ?? null, [turns])
  // The last message you sent, at the start or while the agent worked: the thread goes down to it and follows on.
  const lastSent = useMemo(() => {
    for (let at = entries.length - 1; at >= 0; at--) if (entries[at].kind === 'user' || entries[at].kind === 'steer') return entries[at].id
    return null
  }, [entries])

  const scrollToEnd = (smooth = false) => {
    const list = listRef.current
    if (!list) return
    if (smooth) list.scrollTo({ top: list.scrollHeight, behavior: scrollBehavior() })
    else list.scrollTop = list.scrollHeight
    lastTop.current = list.scrollTop
  }

  const stopFollowing = () => {
    follow.current = false
    setFollowing(false)
  }

  // Stay at the end while the thread grows (streaming, a step opening, a log folding) or the list shrinks (a card
  // opening under it, the window made smaller), unless you scrolled up.
  useEffect(() => {
    const thread = threadRef.current
    const list = listRef.current
    if (!thread || !list) return
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollToEnd()
    })
    observer.observe(thread)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  // Letting go of the list counts as yours for a moment after, while the scroll it made is reported. A press the page
  // never hears end (a scrollbar dragged out of the window) ends at the next move with no button down.
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (!pressed.current || (event.type === 'pointermove' && event.buttons)) return
      pressed.current = false
      touch()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('pointermove', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('pointermove', release)
    }
  }, [])

  // Find moves the list to a match: that is you reading back too.
  useEffect(() => {
    let seen = useFind.getState()
    return useFind.subscribe(() => {
      const state = useFind.getState()
      if (state.open && (state.needle !== seen.needle || state.index !== seen.index || state.step !== seen.step)) touch()
      seen = state
    })
  }, [])

  // A different session starts at its end, and comes in with a short fade rather than a cut.
  useEffect(() => {
    follow.current = true
    setFollowing(true)
    scrollToEnd()
    if (loadedFor && !reducedMotion()) listRef.current?.animate({ opacity: [0.3, 1] }, { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }, [loadedFor])

  // Sending a message goes to the end and follows what comes back, wherever you had scrolled to.
  useEffect(() => {
    if (!lastSent) return
    follow.current = true
    setFollowing(true)
    scrollToEnd()
  }, [lastSent])

  const jumpTo = (id: string) => {
    stopFollowing()
    listRef.current?.querySelector(`[data-turn="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  }

  return (
    <div className="chat-panel" data-status={status}>
      <div className="chat-scroll" onKeyDown={touch}>
        <div
          className="chat-list"
          ref={listRef}
          onScroll={() => {
            const list = listRef.current
            if (!list) return
            const top = list.scrollTop
            const end = list.scrollHeight - list.clientHeight
            const yours = pressed.current || performance.now() - touched.current < YOURS_MS
            follow.current = followsAfterScroll(follow.current, lastTop.current, top, end, yours)
            // The page moved the list up while it followed (something above got shorter as text came in below): back to
            // the end at once, rather than at the next text.
            if (follow.current && !yours && top < lastTop.current - 1 && top < end - 1) scrollToEnd()
            else lastTop.current = top
            setFollowing(follow.current)
          }}
          // A turn of the wheel up stops the thread following at once, before the scroll it starts is reported, so a
          // stream that grows the thread in the same frame cannot pull the list back down under your hand.
          onWheel={(event) => {
            if (event.ctrlKey) return
            touch()
            if (event.deltaY < 0 && (listRef.current?.scrollTop ?? 0) > 0) stopFollowing()
          }}
          onPointerDown={() => {
            pressed.current = true
          }}
          onTouchMove={touch}
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

            <WorkRoot.Provider value={workspace?.root ?? null}>
              {turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} latest={turn.id === latestEdit} offerSearchKey={turn.id === searchOffer} />
              ))}
            </WorkRoot.Provider>
          </div>
        </div>

        <FindBar thread={threadRef} scroller={listRef} />

        {turns.length >= 3 && (
          <div className="turn-ticks" role="navigation" aria-label="Turns">
            {turns.map((turn) =>
              turn.user ? (
                <button key={turn.id} type="button" className="turn-tick" title={turn.user.text?.slice(0, 80)} aria-label={`Jump to: ${turn.user.text?.slice(0, 60)}`} onClick={() => jumpTo(turn.id)} />
              ) : null,
            )}
          </div>
        )}

        {!following && (
          <button
            type="button"
            className="latest-btn"
            aria-label="Jump to the latest"
            title="Jump to the latest"
            onClick={() => {
              follow.current = true
              setFollowing(true)
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
            {ask.background && (
              <em className="approval-tag" title="A subagent working in the background asks. It waits for you; nothing else does.">
                Background
              </em>
            )}
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
