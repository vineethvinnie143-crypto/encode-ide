import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatus, ConversationEntry, RequestUsage } from '@shared/types'
import { AlertTriangle, ChevronRight, Info } from '../../ui/icons'
import { useFoldFind, useRevealRef } from '../../find/hooks'
import { foldText, markdownHaystack } from '../../find/text'
import { useNow } from '../../hooks/useNow'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import { Details } from '../../ui/Details'
import ThinkingDice from '../../ui/ThinkingDice'
import StepRow, { GroupRow, stepsHold } from './StepRow'
import { formatClock, formatDuration, formatUsage, logItems, stepsOf, summarizeSteps, workPhase, type LogItem, type Turn } from './turns'

type WorkLogProps = Pick<Turn, 'log' | 'active' | 'startedAt' | 'endedAt'> & {
  /** What the request cost, on the log of its last part. */
  usage?: RequestUsage
  /** The chat's status, while this log's part is the one running: what the head says the agent is doing. */
  status?: AgentStatus
}

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

/**
 * What the agent did in a turn. While it works the log is open, the dice rolls beside what it is doing ("Thinking",
 * "Working") and a clock runs; when the turn ends it folds to "Worked for 2m 14s", and a click opens it again.
 */
function WorkLog({ log, active, startedAt, endedAt, usage, status }: WorkLogProps) {
  const now = useNow(active)
  const items = useMemo(() => logItems(log), [log])
  const [own, setOpen] = useState(active)
  const touched = useRef(false)
  const head = useRef<HTMLButtonElement>(null)
  const reveal = useCallback(() => {
    touched.current = true
    setOpen(true)
  }, [])
  const logRef = useRevealRef(head, reveal)
  const { found, dismiss } = useFoldFind(useCallback((needle: string) => logHolds(items, needle), [items]))
  const open = own || found

  // The log folds when the turn ends, unless you opened or closed it yourself.
  useEffect(() => {
    if (!active && !touched.current) setOpen(false)
  }, [active])

  if (!active && !log.length) return null

  const phase = active ? workPhase(status, log) : null
  const spent = formatUsage(usage)

  return (
    <div ref={logRef} className={cx('worklog', active && 'is-live')}>
      <button
        ref={head}
        type="button"
        className="worklog-head"
        aria-expanded={open}
        title={summarizeSteps(stepsOf({ log }))}
        onClick={() => {
          touched.current = true
          // Find holds the log open: closing it by hand keeps it closed for this search.
          if (found) {
            dismiss()
            setOpen(false)
          } else setOpen((value) => !value)
        }}
      >
        {phase ? (
          <>
            <ThinkingDice rolling={phase.rolling} className="worklog-dice" />
            <span className={cx('worklog-label', phase.rolling && 'shimmer')}>{phase.words}</span>
            <span className="worklog-clock">{formatClock(now - startedAt)}</span>
          </>
        ) : (
          <span className="worklog-label">Worked for {formatDuration(endedAt - startedAt)}</span>
        )}
        {spent && <span className="worklog-usage">{spent}</span>}
        <span className="worklog-rule" />
        {log.length > 0 && <ChevronRight size={14} className={cx('worklog-chevron', open && 'is-open')} />}
      </button>

      <Collapse open={open && items.length > 0} instant={found}>
        <div className="worklog-body">
          {items.map((item) => {
            switch (item.type) {
              case 'text':
                return (
                  <div className="worklog-text" key={item.entry.id}>
                    <Markdown text={item.entry.text ?? ''} />
                  </div>
                )
              case 'notice':
                return (
                  <div className={cx('worklog-notice', item.entry.kind === 'error' && 'is-error')} key={item.entry.id}>
                    {item.entry.kind === 'error' ? <AlertTriangle size={13} /> : <Info size={13} />}
                    <div className="notice-body">
                      <span>{item.entry.text}</span>
                      {item.entry.details && <Details text={item.entry.details} />}
                    </div>
                  </div>
                )
              case 'group':
                return <GroupRow key={item.entries[0].id} kind={item.kind} entries={item.entries} />
              default:
                return <StepRow key={item.entry.id} entry={item.entry} />
            }
          })}
        </div>
      </Collapse>
    </div>
  )
}

/** Skips a log whose steps are the ones it drew last: the answer after it may stream, the log stays. */
export default memo(WorkLog)
