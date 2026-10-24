import { memo } from 'react'
import { cx } from './cx'

/** The cells of a 3 by 3 grid, 1 to 9 row by row, that hold a pip for each number. */
const PIPS: Record<number, readonly number[]> = {
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

/** Opposite faces add up to seven, as on a real die; </> stands for the one, on top as in the logo. */
const FACES: readonly { side: string; pips: number }[] = [
  { side: 'top', pips: 1 },
  { side: 'bottom', pips: 6 },
  { side: 'front', pips: 3 },
  { side: 'back', pips: 4 },
  { side: 'right', pips: 5 },
  { side: 'left', pips: 2 },
]

/**
 * The eNCode dice, rolling while the agent works (ADR 0112). It is the logo (build/logo-source.png) drawn in CSS 3D:
 * black faces in a chrome rim, white pips, </> on top, and the three and the five towards you at rest. It rolls a
 * quarter turn at a time, settling on each face before the next, with a small hop on every roll; `rolling` false
 * leaves it at rest. Where motion is reduced it rests too (theme/tokens.css). Decorative: the words beside it say what
 * is happening.
 */
function ThinkingDice({ rolling = true, className }: { rolling?: boolean; className?: string }) {
  return (
    <span className={cx('think-dice', rolling && 'is-rolling', className)} aria-hidden="true">
      <span className="think-dice-hop">
        <span className="think-dice-view">
          <span className="think-dice-cube">
            {FACES.map(({ side, pips }) => (
              <span key={side} className={`think-dice-face is-${side}`}>
                {pips === 1 ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13" />
                  </svg>
                ) : (
                  (PIPS[pips] ?? []).map((cell) => <i key={cell} className={`at-${cell}`} />)
                )}
              </span>
            ))}
          </span>
        </span>
      </span>
    </span>
  )
}

export default memo(ThinkingDice)
