import { cx } from './cx'
import { ChevronDown } from './icons'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

/** The native select, drawn to match: it keeps Windows' keyboard and screen reader support. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  className,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** Needed unless a visible <label htmlFor={id}> names it. */
  label?: string
  id?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <span className={cx('ui-select', disabled && 'is-disabled', className)}>
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="ui-select-caret" />
    </span>
  )
}
