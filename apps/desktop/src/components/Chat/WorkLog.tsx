import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, Info } from '../../ui/icons'
import { useNow } from '../../hooks/useNow'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import Markdown from './Markdown'
import StepRow, { GroupRow } from './StepRow'
import { formatClock, formatDuration, logItems, stepsOf, summarizeSteps, type Turn } from './turns'

type WorkLogProps = Pick<Turn, 'log' | 'active' | 'startedAt' | 'endedAt'>

/**
 * What the agent did in a turn. While it works the log is open and a clock runs;
 * when the turn ends it folds to "Worked for 2m 14s", and a click opens it again.
 */
function WorkLog({ log, active, startedAt, endedAt }: WorkLogProps) {
  const now = useNow(active)
  const items = useMemo(() => logItems(log), [log])
  const [open, setOpen] = useState(active)
  const touched = useRef(false)

  // The log folds when the turn ends, unless you opened or closed it yourself.
  useEffect(() => {
    if (!active && !touched.current) setOpen(false)
  }, [active])

  if (!active && !log.length) return null

  const label = active ? `Working for ${formatClock(now - startedAt)}` : `Worked for ${formatDuration(endedAt - startedAt)}`

  return (
    <div className={cx('worklog', active && 'is-live')}>
      <button
        type="button"
        className="worklog-head"
        aria-expanded={open}
        title={summarizeSteps(stepsOf({ log }))}
        onClick={() => {
          touched.current = true
          setOpen((value) => !value)
        }}
      >
        <span className={cx('worklog-label', active && 'shimmer')}>{label}</span>
        <span className="worklog-rule" />
        {log.length > 0 && <ChevronRight size={14} className={cx('worklog-chevron', open && 'is-open')} />}
      </button>

      <Collapse open={open && items.length > 0}>
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
      </Collapse>
    </div>
  )
}

/** Skips a log whose steps are the ones it drew last: the answer after it may stream, the log stays. */
export default memo(WorkLog)
