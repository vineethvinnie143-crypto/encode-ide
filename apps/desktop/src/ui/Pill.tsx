import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from './cx'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  tone?: Tone
  /** A trailing chevron, for pills that open a menu. */
  caret?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** A rounded 28 px button for composer settings such as the policy and the model. */
export function Pill({ icon, tone = 'neutral', caret, className, children, type = 'button', ref, ...rest }: PillProps) {
  return (
    <button ref={ref} type={type} className={cx('ui-pill', `tone-${tone}`, className)} {...rest}>
      {icon}
      <span className="ui-pill-label">{children}</span>
      {caret}
    </button>
  )
}

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  icon?: ReactNode
  tone?: Tone
  /** Set for code-like values such as a branch name. */
  mono?: boolean
}

/** A 22 px label for states and values: a branch, "Running", "Free". */
export function Chip({ icon, tone = 'neutral', mono, className, children, ...rest }: ChipProps) {
  return (
    <span className={cx('ui-chip', `tone-${tone}`, mono && 'is-mono', className)} {...rest}>
      {icon}
      {children}
    </span>
  )
}
