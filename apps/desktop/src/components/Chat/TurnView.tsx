import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Copy, CornerDownRight, GitFork, Info, Pencil, Undo2 } from '../../ui/icons'
import type { ConversationEntry } from '@shared/types'
import { sessionActions } from '../../commands/app'
import { getActiveSessionId } from '../../stores/active'
import { useChat } from '../../stores/chat'
import { useReview } from '../../stores/review'
import { useRewind } from '../../stores/rewind'
import { useSessions } from '../../stores/sessions'
import { useFoldFind, useRevealRef } from '../../find/hooks'
import { foldText } from '../../find/text'
import { Button, IconButton } from '../../ui/Button'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import WorkLog from './WorkLog'
import { editedFiles, editTotals, type Turn, type TurnPart } from './turns'

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
      <div className="msg-actions is-right" data-find-skip>
        <span className="msg-time">{timeOf(entry.createdAt)}</span>
        <CopyButton text={entry.text ?? ''} label="Copy message" />
        <RewindButton entry={entry} />
      </div>
    </div>
  )
}

/** A message you sent while the agent worked, where the running request took it. Rewinding goes by request, so it has no Rewind. */
function SteerMessage({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="turn-user is-steer">
      <div className="bubble-row">
        <div className="chat-user-bubble">{entry.text}</div>
      </div>
      <div className="msg-actions is-right" data-find-skip>
        <span className="msg-steer-tag" title="You sent this while eNCode worked; it read it after the step it was on">
          <CornerDownRight size={12} />
          Steered
        </span>
        <span className="msg-time">{timeOf(entry.createdAt)}</span>
        <CopyButton text={entry.text ?? ''} label="Copy message" />
      </div>
    </div>
  )
}

/** What the agent wrote after its last step: answers, and the notices and errors among them. */
function ReplyEntry({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'assistant') {
    return (
      <div className="msg msg-assistant">
        <Markdown text={entry.text ?? ''} />
        {entry.streaming && <span className="stream-caret" />}
      </div>
    )
  }
  if (entry.kind === 'error') {
    return (
      <div className="msg msg-error">
        <AlertTriangle size={14} />
        <span>{entry.text}</span>
      </div>
    )
  }
  return (
    <div className="msg msg-notice">
      <Info size={13} />
      <span>{entry.text}</span>
    </div>
  )
}

/** One part of a turn: the message that started it when you sent it while the agent worked, the work log, and the reply. */
const PartView = memo(function PartView({ part }: { part: TurnPart }) {
  const replyEntries = part.reply.filter((entry) => entry.kind !== 'assistant' || entry.text?.trim() || entry.streaming)
  return (
    <>
      {part.steer && <SteerMessage entry={part.steer} />}
      <WorkLog log={part.log} active={part.active} startedAt={part.startedAt} endedAt={part.endedAt} />
      {replyEntries.map((entry) => (
        <ReplyEntry key={entry.id} entry={entry} />
      ))}
    </>
  )
})

/**
 * "Edited 2 files +12 −3" with a button to review them: the Review tab's Turn view, which shows what this request
 * changed (and lets each change be reverted), with or without git. The latest one also offers Undo, which opens the
 * Rewind dialog on putting this request's files back, keeping the conversation.
 */
function ResultCard({ turn, latest }: { turn: Turn; latest: boolean }) {
  const totals = useMemo(() => editTotals(turn.log), [turn.log])
  const files = useMemo(() => editedFiles(turn.log), [turn.log])
  const running = useChat((state) => state.running)
  const [own, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const reveal = useCallback(() => setOpen(true), [])
  const cardRef = useRevealRef(toggle, reveal)
  const { found, dismiss } = useFoldFind(useCallback((needle: string) => files.some((file) => foldText(file.path).text.includes(needle)), [files]))
  const open = own || found
  if (!totals.files) return null
  const user = turn.user
  return (
    <div ref={cardRef} className="result-card">
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
          {latest && user && !turn.active && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Undo2 size={14} />}
              disabled={running}
              title={running ? 'Stop the agent to undo' : 'Put back the files this request changed'}
              onClick={() => void useRewind.getState().show(getActiveSessionId(), user.id, user.text ?? '', 'code')}
            >
              Undo
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              if (user) useReview.getState().showTurn(user.id, files[0]?.path)
              else if (files[0]) useReview.getState().showFile(files[0].path, 'folder')
            }}
          >
            Review changes
          </Button>
          <IconButton
            ref={toggle}
            label={open ? 'Hide files' : 'Show files'}
            size="sm"
            onClick={() => {
              if (found) {
                dismiss()
                setOpen(false)
              } else setOpen((value) => !value)
            }}
          >
            <ChevronDown size={14} className={cx('result-chevron', open && 'is-open')} />
          </IconButton>
        </span>
      </div>
      <Collapse open={open} instant={found}>
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

/**
 * One turn: your message, its parts (the work log and reply after it, and after each message you sent while the agent
 * worked), what it changed, and (on hover) copy, fork, time and model. `latest` marks the last turn that edited files,
 * whose change card offers Undo.
 */
function TurnView({ turn, latest = false }: { turn: Turn; latest?: boolean }) {
  const answer = turn.reply.filter((entry) => entry.kind === 'assistant' && entry.text?.trim())
  const lastAnswer = answer[answer.length - 1]
  const answerText = answer.map((entry) => entry.text).join('\n\n')

  return (
    <section className="turn" data-turn={turn.id}>
      {turn.user && <UserMessage entry={turn.user} />}
      {turn.parts.map((part) => (
        <PartView key={part.id} part={part} />
      ))}

      <ResultCard turn={turn} latest={latest} />

      {!turn.active && lastAnswer && (
        <div className="msg-actions" data-find-skip>
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
