import { memo, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { AgentStatus, ConversationEntry, RequestUsage, ThinkingProgress } from '@shared/types'
import { AlertTriangle, ChevronRight, Info, Loader2, XCircle } from '../../ui/icons'
import { useFoldFind, useRevealRef } from '../../find/hooks'
import { useNow } from '../../hooks/useNow'
import { foldText, markdownHaystack } from '../../find/text'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import { Details } from '../../ui/Details'
import ThinkingDice from '../../ui/ThinkingDice'
import StepRow, { GroupRow, RunningFor, stepLine, stepsHold, useRunningSince } from './StepRow'
import { WorkRoot } from './shown-path'
import {
  batchSummary,
  editTotals,
  formatClock,
  formatDuration,
  formatUsage,
  logBlocks,
  logItems,
  summarizeSteps,
  workPhase,
  type LogItem,
  type Turn,
  type TurnPart,
} from './turns'

const texts = new WeakMap<ConversationEntry, string>()

/** True when anything in a log holds the words find looks for: its notes, its steps' rows, or what they show opened. */
export function logHolds(items: readonly LogItem[], needle: string): boolean {
  return items.some((item) => {
    if (item.type === 'group') return foldText(summarizeSteps(item.entries)).text.includes(needle) || stepsHold(item.entries, needle)
    if (item.type === 'step') return stepsHold([item.entry], needle)
    let text = texts.get(item.entry)
    if (text === undefined) {
      text = markdownHaystack(item.entry.text ?? '')
      texts.set(item.entry, text)
    }
    return text.includes(needle)
  })
}

/** A step at work: running, being reviewed, or waiting for the person. */
const AT_WORK = new Set(['running', 'reviewing', 'waiting'])

/**
 * The steps between two things the agent said, folded to one line (ADR 0126): the step itself when there is one,
 * otherwise what they did ("Read loop.ts, ran 2 commands"), with the lines they changed. While one of them is at work
 * the line says that step and how long it has run. A click opens the rows.
 */
function StepBatchView({ entries }: { entries: ConversationEntry[] }) {
  const root = useContext(WorkRoot)
  const items = useMemo(() => logItems(entries), [entries])
  const totals = useMemo(() => editTotals(entries), [entries])
  const [own, setOpen] = useState(false)
  const head = useRef<HTMLButtonElement>(null)
  const reveal = useCallback(() => setOpen(true), [])
  const batchRef = useRevealRef(head, reveal)
  const { found, dismiss } = useFoldFind(useCallback((needle: string) => logHolds(items, needle), [items]))
  const open = own || found
  const live = entries.find((entry) => AT_WORK.has(entry.tool?.state ?? ''))
  const since = useRunningSince(live)
  const line = live ? stepLine(live, root) : entries.length === 1 ? stepLine(entries[0], root) : { words: batchSummary(entries), detail: '' }
  const failed = entries.filter((entry) => entry.tool?.state === 'error' || entry.tool?.state === 'rejected').length
  const state = live?.tool?.state
  return (
    <div ref={batchRef} className={cx('step-batch', live && 'is-live')}>
      <button
        ref={head}
        type="button"
        className="step-batch-head"
        aria-expanded={open}
        title={line.title}
        onClick={() => {
          // Find holds the batch open: closing it by hand keeps it closed for this search.
          if (found) {
            dismiss()
            setOpen(false)
          } else setOpen((value) => !value)
        }}
      >
        <span className="step-batch-words">{line.words}</span>
        {line.detail && <span className="step-batch-detail">{line.detail}</span>}
        {(totals.additions > 0 || totals.deletions > 0) && (
          <span className="diff-stats">
            <span className="add-stat">+{totals.additions}</span>
            <span className="del-stat">−{totals.deletions}</span>
          </span>
        )}
        {failed > 0 && !live && (
          <span className="step-batch-failed" title={`${failed} step${failed === 1 ? '' : 's'} failed or declined`}>
            <XCircle size={13} />
          </span>
        )}
        {state === 'running' && <RunningFor since={since} />}
        {(state === 'running' || state === 'reviewing') && <Loader2 size={13} className="spin step-batch-state" />}
        <ChevronRight size={13} className={cx('step-batch-chevron', open && 'is-open')} />
      </button>
      <Collapse open={open} instant={found}>
        <div className="step-batch-body">
          {items.map((item) =>
            item.type === 'group' ? (
              <GroupRow key={item.entries[0].id} kind={item.kind} entries={item.entries} />
            ) : item.type === 'step' ? (
              <StepRow key={item.entry.id} entry={item.entry} opened={entries.length === 1} />
            ) : null,
          )}
        </div>
      </Collapse>
    </div>
  )
}

const sameEntries = (a: readonly ConversationEntry[], b: readonly ConversationEntry[]) => a.length === b.length && a.every((entry, index) => entry === b[index])

/** Skips a batch whose steps are the ones it drew last, though the list that holds them is new. */
const StepBatch = memo(StepBatchView, (before, after) => sameEntries(before.entries, after.entries))

/**
 * What the agent did in a turn, the way it told it (ADR 0126): what it said between its steps, as plainly as its answer,
 * and the steps between two of those folded to one line each. Nothing folds when the turn ends: the story stays, and
 * how long it worked is said under the answer (WorkedLine).
 */
function WorkLog({ log }: { log: readonly ConversationEntry[] }) {
  const blocks = useMemo(() => logBlocks(log), [log])
  if (!blocks.length) return null
  return (
    <div className="worklog">
      {blocks.map((block) => {
        switch (block.type) {
          case 'text':
            return (
              <div className="msg msg-assistant worklog-say" key={block.entry.id}>
                <Markdown text={block.entry.text ?? ''} />
              </div>
            )
          case 'notice':
            return (
              <div className={cx('worklog-notice', block.entry.kind === 'error' && 'is-error')} key={block.entry.id}>
                {block.entry.kind === 'error' ? <AlertTriangle size={13} /> : <Info size={13} />}
                <div className="notice-body">
                  <span>{block.entry.text}</span>
                  {block.entry.details && <Details text={block.entry.details} />}
                </div>
              </div>
            )
          default:
            return <StepBatch key={block.entries[0].id} entries={block.entries} />
        }
      })}
    </div>
  )
}

/** Skips a log whose entries are the ones it drew last: the answer after it may stream, the log stays. */
export default memo(WorkLog)

/**
 * Under a finished turn that took steps (ADR 0126), where the live line was while it worked: how long it worked, and
 * what the request used.
 */
export function WorkedLine({ turn, usage }: { turn: Pick<Turn, 'log' | 'startedAt' | 'endedAt'>; usage?: RequestUsage }) {
  if (!turn.log.some((entry) => entry.kind === 'tool' && entry.tool)) return null
  const spent = formatUsage(usage)
  return (
    <div className="turn-worked">
      <span className="worklog-label">Worked for {formatDuration(turn.endedAt - turn.startedAt)}</span>
      {spent && <span className="worklog-usage">{spent}</span>}
    </div>
  )
}

/**
 * The last line of a turn the agent is working on (ADR 0116): the dice rolling beside what it is doing ("Thinking",
 * "Working", "Writing", or at rest while it waits on you), the clock of the part it is on and what the request has
 * used. It sits under the latest step and the answer streaming in, so it is where you look as the thread follows, at
 * every step and not only at the top of the turn.
 */
export function LiveLine({
  status,
  log,
  reply,
  startedAt,
  usage,
  thought,
}: Pick<TurnPart, 'log' | 'reply' | 'startedAt'> & { status?: AgentStatus; usage?: RequestUsage; thought?: ThinkingProgress | null }) {
  const now = useNow(true)
  const writing = reply.some((entry) => entry.kind === 'assistant' && entry.streaming && Boolean(entry.text?.trim()))
  const phase = workPhase(status, log, writing)
  const spent = formatUsage(usage)
  // While the model thinks before it writes, its latest words show under the line, so a long think reads as one (ADR 0125).
  const thinking = status === 'thinking' && !writing && thought?.latest ? thought : null
  return (
    <>
      <div className="turn-live">
        <ThinkingDice rolling={phase.rolling} className="worklog-dice" />
        <span className={cx('worklog-label', phase.rolling && 'shimmer')}>{phase.words}</span>
        <span className="worklog-clock">{formatClock(now - startedAt)}</span>
        {spent && <span className="worklog-usage">{spent}</span>}
      </div>
      {thinking && (
        <div className="turn-thought" title={thinking.latest}>
          {thinking.cut ? `…${thinking.latest}` : thinking.latest}
        </div>
      )}
    </>
  )
}
