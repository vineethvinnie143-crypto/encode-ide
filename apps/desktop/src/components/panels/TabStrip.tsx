import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { PanelTab, PanelTabKind } from '../../panels/model'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Activity, Code2, Files, Globe, ListTree, Plus, SquareTerminal, X } from '../../ui/icons'
import { keyToMove, moveIndex } from '../../ui/nav'

const ICONS: Record<PanelTabKind, typeof Files> = {
  new: Plus,
  browser: Globe,
  files: Files,
  editor: Code2,
  terminal: SquareTerminal,
  trajectory: ListTree,
  jobs: Activity,
}

/**
 * A strip of tabs: 30 px tall, at most 170 px wide, the active one on a raised surface, a close
 * button on hover. Arrow keys, Home and End move between them; Delete closes the one in focus.
 * `children` are the controls at the right end.
 */
export function TabStrip({
  tabs,
  activeId,
  label,
  addLabel,
  compact,
  onSelect,
  onClose,
  onAdd,
  children,
}: {
  tabs: readonly PanelTab[]
  activeId: string | null
  label: string
  /** The add button's name; only shown when `onAdd` is given. */
  addLabel?: string
  /** The bottom panel's lower strip. */
  compact?: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd?: () => void
  children?: ReactNode
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'horizontal')
    if (move) {
      event.preventDefault()
      const current = tabs.findIndex((tab) => tab.id === activeId)
      const next = moveIndex(current, move, tabs.length)
      if (next >= 0) {
        onSelect(tabs[next].id)
        buttons.current[next]?.focus()
      }
    } else if (event.key === 'Delete') {
      const focused = buttons.current.findIndex((button) => button === document.activeElement)
      if (focused >= 0) {
        event.preventDefault()
        onClose(tabs[focused].id)
      }
    }
  }

  return (
    <div className={cx('panel-strip', compact && 'is-compact')}>
      <div className="panel-tabs">
        <div className="panel-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
          {tabs.map((tab, index) => {
            const Icon = ICONS[tab.kind]
            const active = tab.id === activeId
            return (
              <div key={tab.id} className={cx('panel-tab', active && 'is-active')}>
                <button
                  ref={(node) => {
                    buttons.current[index] = node
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active || (activeId === null && index === 0) ? 0 : -1}
                  className="panel-tab-main"
                  title={tab.title}
                  onClick={() => onSelect(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onClose(tab.id)
                  }}
                >
                  <Icon size={14} />
                  <span className="panel-tab-title">{tab.title}</span>
                </button>
                <button type="button" className="panel-tab-close" aria-label={`Close ${tab.title}`} tabIndex={-1} onClick={() => onClose(tab.id)}>
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
        {onAdd && (
          <IconButton label={addLabel ?? 'New tab'} size="md" onClick={onAdd}>
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      <div className="panel-strip-end">{children}</div>
    </div>
  )
}
