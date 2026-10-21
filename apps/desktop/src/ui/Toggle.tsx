import { cx } from './cx'

/** An on/off switch. Give it `label` unless a visible <label htmlFor> names it. */
export function Toggle({
  checked,
  onChange,
  label,
  id,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  id?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ui-toggle', checked && 'is-on', className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-thumb" />
    </button>
  )
}
