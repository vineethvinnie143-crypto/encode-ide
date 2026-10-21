import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, Info } from '../../ui/icons'
import { useNow } from '../../hooks/useNow'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import StepRow, { GroupRow } from './StepRow'
import { formatClock, formatDuration, logItems, stepsOf, summarizeSteps, type Turn } from './turns'

/**
 * What the agent did in a turn. While it works the log is open and a clock runs;
 * when the turn ends it folds to "Worked for 2m 14s", and a click opens it again.
 */
export default function WorkLog({ turn }: { turn: Turn }) {
  const now = useNow(turn.active)
  const items = useMemo(() => logItems(turn.log), [turn.log])
  const [open, setOpen] = useState(turn.active)
  const touched = useRef(false)

  // The log folds when the turn ends, unless you opened or closed it yourself.
  useEffect(() => {
    if (!turn.active && !touched.current) setOpen(false)
  }, [turn.active])

  if (!turn.active && !turn.log.length) return null

  const label = turn.active
    ? `Working for ${formatClock(now - turn.startedAt)}`
    : `Worked for ${formatDuration(turn.endedAt - turn.startedAt)}`

  return (
    <div className={cx('worklog', turn.active && 'is-live')}>
      <button
        type="button"
        className="worklog-head"
        aria-expanded={open}
        title={summarizeSteps(stepsOf(turn))}
        onClick={() => {
          touched.current = true
          setOpen((value) => !value)
        }}
      >
        <span className={cx('worklog-label', turn.active && 'shimmer')}>{label}</span>
        <span className="worklog-rule" />
        {turn.log.length > 0 && <ChevronRight size={14} className={cx('worklog-chevron', open && 'is-open')} />}
      </button>

      {open && items.length > 0 && (
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
                    <span>{item.entry.text}</span>
                  </div>
                )
              case 'group':
                return <GroupRow key={item.entries[0].id} kind={item.kind} entries={item.entries} />
              default:
                return <StepRow key={item.entry.id} entry={item.entry} />
            }
          })}
        </div>
      )}
    </div>
  )
}
