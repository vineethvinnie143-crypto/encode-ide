import { symbolGlyph } from '../../editor/symbols'
import { cx } from '../../ui/cx'

/** A symbol's kind as a letter on a tile tinted like the code it names: functions as functions, types as types. */
export function SymbolIcon({ kind, className }: { kind: string; className?: string }) {
  const { letter, tone } = symbolGlyph(kind)
  return (
    <span className={cx('sym-icon', `is-${tone}`, className)} aria-hidden="true">
      {letter}
    </span>
  )
}
