import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from './cx'
import type { Side } from './place'
import { Spinner } from './Spinner'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Drawn before the label; replaced by a spinner while busy. */
  icon?: ReactNode
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** 28 / 32 / 38 px buttons. Renders the .btn classes the rest of the app already uses. */
export function Button({
  variant = 'default',
  size = 'md',
  icon,
  busy = false,
  className,
  children,
  type = 'button',
  disabled,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', variant !== 'default' && variant, size !== 'md' && size, busy && 'is-busy', className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  /** Read by screen readers and shown in the tooltip. Required: an icon alone says nothing. */
  label: string
  shortcut?: string
  /** 24, 28 or 32 px square. */
  size?: 'sm' | 'md' | 'lg'
  /** A toggle that is on. */
  active?: boolean
  tooltipSide?: Side
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  shortcut,
  size = 'sm',
  active,
  tooltipSide = 'bottom',
  className,
  children,
  type = 'button',
  disabled,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide} disabled={disabled}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        className={cx('icon-btn', size !== 'sm' && size, active && 'is-on', className)}
        disabled={disabled}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
}
