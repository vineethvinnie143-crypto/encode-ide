import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'
import { keyToMove, moveIndex } from './nav'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  disabled?: boolean
}

/**
 * A row of mutually exclusive choices (a radio group). Arrow keys move and
 * choose, as with radio buttons; only the chosen segment is a tab stop.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  /** Names the group for screen readers. */
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((option) => option.value === value)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'horizontal') ?? keyToMove(event.key, 'vertical')
    if (!move) return
    event.preventDefault()
    const next = moveIndex(selected, move, options.length, (index) => Boolean(options[index].disabled))
    if (next < 0) return
    onChange(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx('ui-segmented', size === 'sm' && 'sm', className)} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const checked = index === selected
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (selected < 0 && index === 0) ? 0 : -1}
            disabled={option.disabled}
            className={cx('ui-segment', checked && 'is-on')}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
