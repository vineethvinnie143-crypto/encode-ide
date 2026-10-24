import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentStatus, ApprovalRequest, ConversationEntry } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { usePanels } from '../stores/panels'
import { appendTexts } from '../stores/deltas'
import { useSessions } from '../stores/sessions'
import { useWorkspace } from '../stores/workspace'
import { Button, IconButton } from '../ui/Button'
import { cx } from '../ui/cx'
import { ArrowUp, MessageSquare, Square } from '../ui/icons'
import Markdown from './Chat/Markdown'
import { WorkRoot } from './Chat/shown-path'
import WorkLog from './Chat/WorkLog'
import { buildTurns } from './Chat/turns'

type Ask = { id: string; question: string; options?: string[] }

/** Questions a side chat is good for, to start one with a click. */
const STARTERS = ['Why was it done this way?', 'What is left to do?', 'Explain the last change']

const RUNNING: readonly AgentStatus[] = ['thinking', 'running-tool', 'awaiting-approval', 'awaiting-user']

function upsert(entries: ConversationEntry[], entry: ConversationEntry): ConversationEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

/**
 * A side chat (ADR 0104): a copy of a chat's conversation, to ask about it on the side. It shows only what is said in
 * it, runs in Ask mode (it reads and searches, and changes nothing), and nothing said in it goes back to the chat.
 * Closing the tab deletes it.
 */
export default function SideChatPanel({ tabId }: { tabId: string }) {
  const chat = usePanels((state) => state.side.tabs.find((tab) => tab.id === tabId)?.chat)
  const parent = useSessions((state) => state.sessions.find((session) => session.id === chat?.of))
  const open = useWorkspace((state) => state.workspace?.root ?? null)
  const root = parent?.projectRoot ?? open
  const [entries, setEntries] = useState<ConversationEntry[]>([])
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [ended, setEnded] = useState(false)
  const [draft, setDraft] = useState('')
  const thread = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const session = chat?.session ?? ''
  const since = chat?.at ?? 0
  const running = RUNNING.includes(status)

  // What was said before the side chat began is the chat's; this shows what is said in it.
  const own = useCallback((list: ConversationEntry[]) => list.filter((entry) => entry.createdAt >= since), [since])

  useEffect(() => {
    if (!session) return
    let live = true
    api.agent
      .history(session)
      .then((history) => {
        if (!live) return
        setEntries(own(history.entries))
        setStatus(history.status)
        setApprovals(history.approvals ?? (history.approval ? [history.approval] : []))
        setAsk(history.ask ? { id: history.ask.id, question: history.ask.question, options: history.ask.options } : null)
      })
      .catch(() => live && setEnded(true))
    const off = api.agent.onEvent((event: AgentEvent) => {
      if (event.sessionId !== session) return
      switch (event.type) {
        case 'delta':
          setEntries((list) => appendTexts(list, new Map([[event.entryId, event.text]])))
          break
        case 'entry':
          if (event.entry.createdAt >= since) setEntries((list) => upsert(list, event.entry))
          break
        case 'status':
          setStatus(event.status)
          if (!RUNNING.includes(event.status)) {
            setApprovals([])
            setAsk(null)
          }
          break
        case 'approval-request':
          setApprovals((list) => [...list.filter((item) => item.id !== event.request.id), event.request])
          break
        case 'ask':
          setAsk({ id: event.id, question: event.question, options: event.options })
          break
        case 'done':
          setStatus('done')
          break
        case 'error':
          setStatus('error')
          if (!event.entryId) setEntries((list) => [...list, problem(event.message)])
          break
        default:
          break
      }
    })
    return () => {
      live = false
      off()
    }
  }, [own, session, since])

  // The newest words stay in view while they come in.
  useEffect(() => {
    const node = thread.current
    if (node) node.scrollTop = node.scrollHeight
  }, [entries, approvals, ask])

  const turns = useMemo(() => buildTurns(entries, running), [entries, running])

  const send = (text: string) => {
    const words = text.trim()
    if (!words || !session || ended) return
    if (ask) {
      void api.agent.answer(ask.id, words).catch((error) => setEntries((list) => [...list, problem(errorText(error))]))
      setAsk(null)
    } else if (running) return
    else
      void api.agent.start(session, { text: words, mode: 'ask' }).catch((error) => {
        if (errorText(error).includes('does not exist')) setEnded(true)
        else setEntries((list) => [...list, problem(errorText(error))])
      })
    setDraft('')
  }

  const approval = approvals[0]
  const answer = (allow: boolean) => {
    if (!approval) return
    setApprovals((list) => list.filter((item) => item.id !== approval.id))
    void api.agent.approve(approval.id, allow).catch(() => undefined)
  }

  if (!chat) return null
  return (
    <div className="side-chat">
      <div className="side-chat-head">
        <MessageSquare size={13} aria-hidden="true" />
        <span className="side-chat-of" title={parent?.title}>
          Side chat{parent ? <> of <strong>{parent.title}</strong></> : null}
        </span>
        <span className="side-chat-note">Reads only · nothing goes back to the chat</span>
      </div>

      <WorkRoot.Provider value={root}>
        <div ref={thread} className="side-chat-thread" aria-live="polite">
          {!turns.length && !ended && (
            <div className="side-chat-empty">
              <div className="side-chat-empty-title">Ask about this chat</div>
              <div className="side-chat-empty-text">The side chat knows everything said so far. It looks things up in the project, and changes nothing.</div>
              <div className="side-chat-starters">
                {STARTERS.map((text) => (
                  <button key={text} type="button" className="side-chat-starter" onClick={() => send(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <section key={turn.id} className="side-chat-turn">
              {turn.user && (
                <div className="bubble-row">
                  <div className="chat-user-bubble">{turn.user.text}</div>
                </div>
              )}
              <WorkLog log={turn.log} active={turn.active} startedAt={turn.startedAt} endedAt={turn.endedAt} status={turn.active ? status : undefined} />
              {turn.reply.map((entry) =>
                entry.kind === 'assistant' ? (
                  entry.text?.trim() || entry.streaming ? (
                    <div key={entry.id} className="msg msg-assistant">
                      <Markdown text={entry.text ?? ''} />
                      {entry.streaming && <span className="stream-caret" />}
                    </div>
                  ) : null
                ) : (
                  <div key={entry.id} className={cx('side-chat-line', entry.kind === 'error' && 'is-error')}>
                    {entry.text}
                  </div>
                ),
              )}
            </section>
          ))}
          {approval && (
            <div className="side-chat-card" role="group" aria-label="Approval">
              <div className="side-chat-card-title">{approval.title}</div>
              {approval.detail && <div className="side-chat-card-detail">{approval.detail}</div>}
              {approval.reason && <div className="side-chat-card-detail">{approval.reason}</div>}
              <div className="side-chat-card-actions">
                <Button size="sm" variant="primary" onClick={() => answer(true)}>
                  Allow once
                </Button>
                <Button size="sm" onClick={() => answer(false)}>
                  Deny
                </Button>
              </div>
            </div>
          )}
          {ask && (
            <div className="side-chat-card" role="group" aria-label="Question">
              <div className="side-chat-card-title">{ask.question}</div>
              {ask.options?.length ? (
                <div className="side-chat-card-actions">
                  {ask.options.map((option) => (
                    <Button key={option} size="sm" onClick={() => send(option)}>
                      {option}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          {ended && (
            <div className="side-chat-ended">
              This side chat has ended.
              <Button size="sm" onClick={() => usePanels.getState().close(tabId)}>
                Close
              </Button>
            </div>
          )}
        </div>
      </WorkRoot.Provider>

      <div className={cx('side-chat-composer', ended && 'is-disabled')}>
        <textarea
          ref={field}
          value={draft}
          rows={1}
          disabled={ended}
          placeholder={ask ? 'Answer the question' : 'Ask on the side'}
          aria-label="Side chat message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send(draft)
            }
          }}
        />
        {running && !ask ? (
          <IconButton label="Stop" size="sm" className="side-chat-send" onClick={() => void api.agent.cancel(session)}>
            <Square size={12} />
          </IconButton>
        ) : (
          <IconButton label="Send" size="sm" className="side-chat-send" disabled={!draft.trim() || ended} onClick={() => send(draft)}>
            <ArrowUp size={14} />
          </IconButton>
        )}
      </div>
    </div>
  )
}

function problem(text: string): ConversationEntry {
  return { id: `side-problem-${Date.now()}`, kind: 'error', text, createdAt: Date.now() }
}
