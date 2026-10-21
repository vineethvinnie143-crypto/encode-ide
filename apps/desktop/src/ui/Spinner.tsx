import { cx } from './cx'

/** A 0.9 s spinner; with reduced motion it shows as a still ring. */
export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx('ui-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle className="ui-spinner-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.25" />
      <path className="ui-spinner-arc" d="M12 3a9 9 0 0 1 9 9" fill="none" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  )
}
