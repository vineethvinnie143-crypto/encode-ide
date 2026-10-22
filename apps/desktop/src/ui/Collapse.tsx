import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'

/**
 * Where a collapse is: `start` is mounted but still closed (a frame for the growth to start from),
 * `opening` and `closing` are moving, `open` has settled.
 */
export type Phase = 'closed' | 'start' | 'opening' | 'open' | 'closing'

/** The phase after `open` changed to what it is now. A fold that is moving turns round where it is. */
export function phaseFor(phase: Phase, open: boolean): Phase {
  if (open) {
    if (phase === 'closed') return 'start'
    return phase === 'closing' ? 'opening' : phase
  }
  return phase === 'closed' || phase === 'closing' ? phase : 'closing'
}

/** A little more than --dur-3, which the CSS moves in. */
const MOVE_MS = 240

/**
 * Content that opens and closes by growing and shrinking instead of appearing and vanishing, as a folded
 * work log, a step's output or a list of files does. Closed it holds nothing in the page, so a log of a
 * thousand steps costs nothing while it is folded; open at the start it is simply there, with no motion.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed')

  useLayoutEffect(() => {
    setPhase((current) => phaseFor(current, open))
  }, [open])

  useLayoutEffect(() => {
    if (phase !== 'start') return
    // The browser needs to have seen the closed fold before it can move out of it.
    void root.current?.offsetHeight
    setPhase('opening')
  }, [phase])

  useEffect(() => {
    if (phase !== 'opening' && phase !== 'closing') return
    const timer = window.setTimeout(() => setPhase(phase === 'opening' ? 'open' : 'closed'), MOVE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === 'closed') return null
  return (
    <div ref={root} className={cx('collapse', (phase === 'opening' || phase === 'open') && 'is-open', phase === 'open' && 'is-settled')}>
      <div className="collapse-inner">{children}</div>
    </div>
  )
}
