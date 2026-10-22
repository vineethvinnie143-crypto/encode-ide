import { memo, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Copy, GitFork, Info, Pencil, Undo2 } from '../../ui/icons'
import type { ConversationEntry } from '@shared/types'
import { sessionActions } from '../../commands/app'
import { getActiveSessionId } from '../../stores/active'
import { useChat } from '../../stores/chat'
import { useReview } from '../../stores/review'
import { useRewind } from '../../stores/rewind'
import { useSessions } from '../../stores/sessions'
import { Button, IconButton } from '../../ui/Button'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import WorkLog from './WorkLog'
import { editedFiles, editTotals, type Turn } from './turns'

const timeOf = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Copy with a check mark for a moment, so you can tell it worked. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      label={done ? 'Copied' : label}
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  )
}

/** Opens the Rewind dialog for this request: the files the agent changed after it, and the conversation, can go back to before it. */
function RewindButton({ entry }: { entry: ConversationEntry }) {
  const working = useChat((state) => state.running)
  return (
    <IconButton
      label={working ? 'Stop the agent to rewind' : 'Rewind to before this request'}
      size="sm"
      disabled={working}
      onClick={() => void useRewind.getState().show(getActiveSessionId(), entry.id, entry.text ?? '')}
    >
      <Undo2 size={14} />
    </IconButton>
  )
}

function UserMessage({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="turn-user">
      <div className="bubble-row">
        <div className="chat-user-bubble">{entry.text}</div>
      </div>
      <div className="msg-actions is-right">
        <span className="msg-time">{timeOf(entry.createdAt)}</span>
        <CopyButton text={entry.text ?? ''} label="Copy message" />
        <RewindButton entry={entry} />
      </div>
    </div>
  )
}

/** "Edited 2 files +12 −3" with a button to review them. */
function ResultCard({ turn }: { turn: Turn }) {
  const totals = useMemo(() => editTotals(turn.log), [turn.log])
  const files = useMemo(() => editedFiles(turn.log), [turn.log])
  const [open, setOpen] = useState(false)
  if (!totals.files) return null
  return (
    <div className="result-card">
      <div className="result-head">
        <span className="result-icon">
          <Pencil size={16} />
        </span>
        <span className="result-title">
          Edited {totals.files} file{totals.files === 1 ? '' : 's'}
        </span>
        <span className="result-stats">
          <span className="add-stat">+{totals.additions}</span>
          <span className="del-stat">−{totals.deletions}</span>
        </span>
        <span className="result-actions">
          <Button size="sm" onClick={() => useReview.getState().showFile(files[0].path, 'folder')}>
            Review changes
          </Button>
          <IconButton label={open ? 'Hide files' : 'Show files'} size="sm" onClick={() => setOpen((value) => !value)}>
            <ChevronDown size={14} className={cx('result-chevron', open && 'is-open')} />
          </IconButton>
        </span>
      </div>
      <Collapse open={open}>
        <div className="result-files">
          {files.map((file) => (
            <div className="result-file" key={file.path}>
              <span className="result-path" title={file.path}>
                {file.path}
              </span>
              <span className="result-stats">
                <span className="add-stat">+{file.additions}</span>
                <span className="del-stat">−{file.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  )
}

/** One turn: your message, the work log, the reply, what it changed, and (on hover) copy, fork, time and model. */
function TurnView({ turn }: { turn: Turn }) {
  const replyEntries = turn.reply.filter((entry) => entry.kind !== 'assistant' || entry.text?.trim() || entry.streaming)
  const answer = turn.reply.filter((entry) => entry.kind === 'assistant' && entry.text?.trim())
  const lastAnswer = answer[answer.length - 1]
  const answerText = answer.map((entry) => entry.text).join('\n\n')

  return (
    <section className="turn" data-turn={turn.id}>
      {turn.user && <UserMessage entry={turn.user} />}
      <WorkLog log={turn.log} active={turn.active} startedAt={turn.startedAt} endedAt={turn.endedAt} />

      {replyEntries.map((entry) => {
        if (entry.kind === 'assistant') {
          return (
            <div className="msg msg-assistant" key={entry.id}>
              <Markdown text={entry.text ?? ''} />
              {entry.streaming && <span className="stream-caret" />}
            </div>
          )
        }
        if (entry.kind === 'error') {
          return (
            <div className="msg msg-error" key={entry.id}>
              <AlertTriangle size={14} />
              <span>{entry.text}</span>
            </div>
          )
        }
        return (
          <div className="msg msg-notice" key={entry.id}>
            <Info size={13} />
            <span>{entry.text}</span>
          </div>
        )
      })}

      <ResultCard turn={turn} />

      {!turn.active && lastAnswer && (
        <div className="msg-actions">
          <CopyButton text={answerText} label="Copy reply" />
          <IconButton
            label="Fork session"
            size="sm"
            onClick={() => {
              const { sessions, activeId } = useSessions.getState()
              const current = sessions.find((session) => session.id === activeId)
              if (current) void sessionActions.fork(current)
            }}
          >
            <GitFork size={14} />
          </IconButton>
          <span className="msg-time">{timeOf(lastAnswer.createdAt)}</span>
          {lastAnswer.model && <span className="msg-model">{lastAnswer.model}</span>}
        </div>
      )}
    </section>
  )
}

/** Skips a turn whose object is the one it drew last (see reuseTurns). */
export default memo(TurnView)
