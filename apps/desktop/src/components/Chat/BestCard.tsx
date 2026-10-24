import { useState } from 'react'
import type { BestAttempt, ConversationEntry, EntryBest } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { getActiveSessionId } from '../../stores/active'
import { Check, ChevronDown, Layers, X } from '../../ui/icons'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { cx } from '../../ui/cx'

function title(best: EntryBest): string {
  const count = best.attempts.length
  switch (best.state) {
    case 'running':
      return `Making ${count} attempts side by side`
    case 'judging':
      return 'The Reviewer is comparing the attempts'
    case 'ready':
      return best.pick ? `Attempt ${best.pick} looks best` : 'The attempts are ready'
    case 'kept':
      return `Kept attempt ${best.kept}`
    case 'discarded':
      return `Discarded ${count === 2 ? 'both attempts' : `the ${count} attempts`}`
    case 'failed':
      return 'The attempts could not finish'
  }
}

const CHECKS: Record<BestAttempt['checks'], string> = { passed: 'Checks passed', failed: 'Checks failed', none: 'No checks run' }

function totals(attempt: BestAttempt): { added: number; removed: number } {
  return attempt.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 })
}

function AttemptRow({
  attempt,
  best,
  busy,
  onKeep,
}: {
  attempt: BestAttempt
  best: EntryBest
  busy: number | 'discard' | null
  onKeep: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
  const running = attempt.state === 'running'
  const picked = best.pick === attempt.n
  const kept = best.kept === attempt.n
  const sum = totals(attempt)
  const canKeep = best.state === 'ready' && attempt.files.length > 0
  return (
    <li className={cx('best-attempt', picked && 'is-picked', kept && 'is-kept')} data-attempt={attempt.n} data-state={attempt.state}>
      <div className="best-row">
        <span className="best-mark" aria-hidden>
          {running ? <Spinner size={13} /> : attempt.state === 'done' ? <Check size={13} /> : <X size={13} />}
        </span>
        <span className="best-name">Attempt {attempt.n}</span>
        {picked && best.state !== 'kept' && <span className="best-tag">{best.pickedBy === 'reviewer' ? 'Reviewer’s pick' : 'Best by the checks'}</span>}
        {kept && <span className="best-tag">Kept</span>}
        {!running && (
          <span className={cx('best-checks', `is-${attempt.checks}`)} title={attempt.checksText}>
            {CHECKS[attempt.checks]}
          </span>
        )}
        {attempt.files.length > 0 && (
          <span className="result-stats">
            <span className="add-stat">+{sum.added}</span>
            <span className="del-stat">−{sum.removed}</span>
          </span>
        )}
        <span className="result-actions">
          {(attempt.reply || attempt.files.length > 0 || attempt.error) && !running && (
            <Button size="sm" variant="ghost" aria-expanded={open} aria-label={open ? `Hide attempt ${attempt.n}` : `Show attempt ${attempt.n}`} onClick={() => setOpen(!open)}>
              <ChevronDown size={14} className={cx('result-chevron', open && 'is-open')} />
            </Button>
          )}
          {canKeep && (
            <Button size="sm" variant={picked ? 'primary' : 'default'} busy={busy === attempt.n} disabled={busy !== null} onClick={() => onKeep(attempt.n)}>
              Keep
            </Button>
          )}
        </span>
      </div>
      {running && attempt.activity && <div className="best-activity">{attempt.activity}</div>}
      {!running && (attempt.note || attempt.error) && <div className={cx('best-note', attempt.error && !attempt.note && 'is-error')}>{attempt.note ?? attempt.error}</div>}
      {open && (
        <div className="best-detail">
          {attempt.reply && <p className="best-reply">{attempt.reply}</p>}
          {attempt.files.map((file) => (
            <div key={file.path} className="result-file">
              <span className="result-path">{file.path}</span>
              <span className="result-stats">
                <span className="add-stat">+{file.added}</span>
                <span className="del-stat">−{file.removed}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * Best of N (ADR 0098): the attempts as they run, then the Reviewer's pick and why, and Keep on each attempt that
 * changed files. The project changes only on Keep; a file the person changed meanwhile asks again before it is
 * written over. Discard all removes every attempt.
 */
export function BestCard({ entry }: { entry: ConversationEntry }) {
  const best = entry.best!
  const [busy, setBusy] = useState<number | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ n: number; files: string[] } | null>(null)

  const answer = async (keep: number | 'discard', force = false) => {
    setBusy(keep)
    setError(null)
    try {
      const outcome = await api.agent.answerBest(getActiveSessionId(), entry.id, keep === 'discard' ? 0 : keep, force)
      if (outcome.ok) setConflict(null)
      else if (outcome.conflicts?.length && keep !== 'discard') setConflict({ n: keep, files: outcome.conflicts })
      else setError(outcome.error)
    } catch (thrown) {
      setError(errorText(thrown))
    } finally {
      setBusy(null)
    }
  }

  const open = best.state === 'ready' || (best.state === 'failed' && best.attempts.some((attempt) => attempt.worktree))
  const working = best.state === 'running' || best.state === 'judging'
  return (
    <div className="result-card best-card" data-state={best.state}>
      <div className="result-head">
        <span className="result-icon">{working ? <Spinner size={15} /> : best.state === 'kept' ? <Check size={16} /> : <Layers size={16} />}</span>
        <span className="best-title">{title(best)}</span>
        {open && (
          <span className="result-actions">
            <Button size="sm" variant="ghost" busy={busy === 'discard'} disabled={busy !== null} onClick={() => void answer('discard')}>
              {best.state === 'failed' ? 'Remove the attempts' : 'Discard all'}
            </Button>
          </span>
        )}
      </div>
      {best.state === 'ready' && best.reason && <p className="best-reason">{best.reason}</p>}
      {best.state === 'failed' && best.error && <p className="best-reason is-error">{best.error}</p>}
      <ul className="best-attempts">
        {best.attempts.map((attempt) => (
          <AttemptRow key={attempt.n} attempt={attempt} best={best} busy={busy} onKeep={(n) => void answer(n)} />
        ))}
      </ul>
      {conflict && (
        <div className="best-conflict" role="alert">
          <span>
            Changed in the project since the attempts started: {conflict.files.join(', ')}. Keeping attempt {conflict.n} writes over {conflict.files.length === 1 ? 'it' : 'them'}.
          </span>
          <span className="result-actions">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" busy={busy === conflict.n} disabled={busy !== null} onClick={() => void answer(conflict.n, true)}>
              Keep anyway
            </Button>
          </span>
        </div>
      )}
      {error && (
        <div className="best-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
