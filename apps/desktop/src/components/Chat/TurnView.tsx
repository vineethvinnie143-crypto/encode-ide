import { memo, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, CornerDownRight, FileText, Flag, GitFork, Globe, Paperclip, Pencil, Picture, Undo2 } from '../../ui/icons'
import { FREE_KEY_PROVIDER, isKeyedSearchProvider, searchProviderInfo } from '@shared/search'
import type { ConversationEntry } from '@shared/types'
import { sessionActions } from '../../commands/app'
import { getActiveSessionId } from '../../stores/active'
import { useChat } from '../../stores/chat'
import { useReview } from '../../stores/review'
import { useRewind } from '../../stores/rewind'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { copyText } from '../../copy'
import { useFoldFind, useRevealRef } from '../../find/hooks'
import { foldText } from '../../find/text'
import { Button, IconButton } from '../../ui/Button'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import { NoticeLine, ProblemCard, StepLimitLine } from './ProblemCard'
import { WorkRoot, shownPath } from './shown-path'
import { BestCard } from './BestCard'
import { SuggestionCard } from './SuggestionCard'
import WorkLog, { LiveLine, WorkedLine } from './WorkLog'
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
        void copyText(text).then((copied) => {
          if (!copied) return
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

/** Opens Report a problem for this request: its steps and the files it read, saved to a file to send (ADR 0092). */
function ReportButton({ entry }: { entry: ConversationEntry }) {
  const working = useChat((state) => state.running)
  return (
    <IconButton
      label={working ? 'Stop the agent to report this request' : 'Report a problem with this request'}
      size="sm"
      disabled={working}
      onClick={() => useUi.getState().setTurnReportFor({ sessionId: getActiveSessionId(), turn: entry.id, text: entry.text ?? '' })}
    >
      <Flag size={14} />
    </IconButton>
  )
}

/** The pictures and files that came with your message (ADR 0113), above it: the pictures first, then the files by name. */
function Attached({ items }: { items: NonNullable<ConversationEntry['attached']> }) {
  const shown = [...items.filter((item) => item.kind === 'picture'), ...items.filter((item) => item.kind !== 'picture')]
  return (
    <div className="bubble-attached" aria-label="Attached">
      {shown.map((item, index) =>
        item.kind === 'picture' && item.preview?.startsWith('data:image/') ? (
          <img key={index} className="attached-picture" src={item.preview} alt={item.name} title={item.name} draggable={false} />
        ) : (
          <span key={index} className="attachment-chip" title={item.name}>
            {item.kind === 'pdf' ? <FileText size={12} /> : item.kind === 'picture' ? <Picture size={12} /> : <Paperclip size={11} />}
            <span className="attachment-name">{item.name}</span>
          </span>
        ),
      )}
    </div>
  )
}

function UserMessage({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="turn-user">
      {entry.attached?.length ? <Attached items={entry.attached} /> : null}
      <div className="bubble-row">
        <div className="chat-user-bubble">{entry.text}</div>
      </div>
      <div className="msg-actions is-right" data-find-skip>
        <span className="msg-time">{timeOf(entry.createdAt)}</span>
        <CopyButton text={entry.text ?? ''} label="Copy message" />
        <RewindButton entry={entry} />
        <ReportButton entry={entry} />
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
  if (entry.kind === 'error') return <ProblemCard entry={entry} />
  if (entry.suggestion) return <SuggestionCard entry={entry} />
  if (entry.best) return <BestCard entry={entry} />
  if (entry.stepLimit) return <StepLimitLine entry={entry} />
  return <NoticeLine entry={entry} />
}

/** One part of a turn: the message that started it when you sent it while the agent worked, the work log, and the reply. */
const PartView = memo(function PartView({ part }: { part: TurnPart }) {
  const replyEntries = part.reply.filter((entry) => entry.kind !== 'assistant' || entry.text?.trim() || entry.streaming)
  return (
    <>
      {part.steer && <SteerMessage entry={part.steer} />}
      <WorkLog log={part.log} />
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
  const root = useContext(WorkRoot)
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
                {shownPath(file.path, root)}
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
 * A search that needs no key could not be made from this computer: the provider limited it, refused it or was down.
 * While search still goes to such a provider, the card offers a free key of the person's own, which Settings takes
 * with the provider chosen and its key field ready (ADR 0123). "Not now" keeps it away until eNCode starts again.
 */
function SearchKeyCard() {
  const provider = useSettings((state) => state.settings?.searchProvider)
  const dismissed = useUi((state) => state.searchOfferDismissed)
  if (!provider || isKeyedSearchProvider(provider) || dismissed) return null
  const free = searchProviderInfo(FREE_KEY_PROVIDER).name
  return (
    <div className="search-offer" role="status">
      <span className="search-offer-icon">
        <Globe size={15} />
      </span>
      <span className="search-offer-text">
        <span className="search-offer-title">Web search did not work from this computer</span>
        <span className="search-offer-detail">
          {searchProviderInfo(provider).name} limited or refused the search. A free {free} key (1,000 searches a month, no card) keeps search working.
        </span>
      </span>
      <span className="search-offer-actions">
        <Button size="sm" variant="primary" onClick={() => useUi.getState().addSearchKey(FREE_KEY_PROVIDER)}>
          Add a free {free} key
        </Button>
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().dismissSearchOffer()}>
          Not now
        </Button>
      </span>
    </div>
  )
}

/**
 * One turn: your message, its parts (the work log and reply after it, and after each message you sent while the agent
 * worked), what it changed, and (on hover) copy, fork, time and model. `latest` marks the last turn that edited files,
 * whose change card offers Undo; `offerSearchKey` the last one whose search a free key would have made work.
 */
function TurnView({ turn, latest = false, offerSearchKey = false }: { turn: Turn; latest?: boolean; offerSearchKey?: boolean }) {
  const live = turn.active ? turn.parts[turn.parts.length - 1] : undefined
  // Only the turn that runs follows the chat's status, so a finished one is not drawn again when it changes.
  const status = useChat((state) => (turn.active ? state.status : undefined))
  const thought = useChat((state) => (turn.active ? state.thinking : null))
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

      {offerSearchKey && <SearchKeyCard />}

      {live ? (
        <LiveLine status={status} log={live.log} reply={live.reply} startedAt={live.startedAt} usage={turn.user?.usage} thought={thought} />
      ) : (
        <WorkedLine turn={turn} usage={turn.user?.usage} />
      )}

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
