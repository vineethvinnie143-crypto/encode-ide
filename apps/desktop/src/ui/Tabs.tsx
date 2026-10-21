import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'
import { keyToMove, moveIndex } from './nav'

export interface TabItem<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  /** A count or dot after the label. */
  badge?: ReactNode
  disabled?: boolean
}

/**
 * A tab strip. Arrow keys, Home and End move between tabs and open them;
 * the panel it controls should carry role="tabpanel" and id `${id}-panel`.
 */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
  id,
  className,
}: {
  value: T
  tabs: readonly TabItem<T>[]
  onChange: (value: T) => void
  label: string
  id?: string
  className?: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = tabs.findIndex((tab) => tab.value === value)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'horizontal')
    if (!move) return
    event.preventDefault()
    const next = moveIndex(selected, move, tabs.length, (index) => Boolean(tabs[index].disabled))
    if (next < 0) return
    onChange(tabs[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div role="tablist" aria-label={label} className={cx('ui-tabs', className)} onKeyDown={onKeyDown}>
      {tabs.map((tab, index) => {
        const isSelected = index === selected
        return (
          <button
            key={tab.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="tab"
            id={id ? `${id}-tab-${tab.value}` : undefined}
            aria-selected={isSelected}
            aria-controls={id ? `${id}-panel` : undefined}
            tabIndex={isSelected || (selected < 0 && index === 0) ? 0 : -1}
            disabled={tab.disabled}
            className={cx('ui-tab', isSelected && 'is-on')}
            onClick={() => onChange(tab.value)}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge}
          </button>
        )
      })}
    </div>
  )
}
