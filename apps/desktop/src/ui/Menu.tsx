import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { Check } from './icons'
import { Kbd } from './Kbd'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'
import { place, type Align, type Side } from './place'

export interface MenuAction {
  kind?: 'item'
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  /** A second line under the label, such as what a policy allows. */
  description?: string
  /** Set (true or false) for an item that shows a check mark. */
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuAction | { kind: 'separator'; id: string } | { kind: 'group'; id: string; label: string }

export interface MenuTriggerProps {
  ref: (node: HTMLElement | null) => void
  onClick: () => void
  onKeyDown: (event: ReactKeyboardEvent) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string | undefined
}

const isAction = (entry: MenuEntry): entry is MenuAction => entry.kind === undefined || entry.kind === 'item'

/**
 * A menu that opens from a trigger. Arrow keys, Home, End and typing move
 * through it, Enter or Space chooses, Escape closes and returns focus to the
 * trigger, and a click anywhere else closes it.
 */
export function Menu({
  trigger,
  entries,
  label,
  side = 'bottom',
  align = 'start',
  width,
  className,
}: {
  trigger: (props: MenuTriggerProps) => ReactNode
  entries: readonly MenuEntry[]
  /** Names the menu for screen readers. */
  label: string
  side?: Side
  align?: Align
  width?: number
  className?: string
}) {
  const menuId = useId()
  const triggerNode = useRef<HTMLElement | null>(null)
  const menuNode = useRef<HTMLDivElement>(null)
  const itemNodes = useRef<(HTMLButtonElement | null)[]>([])
  const typed = useRef({ text: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [spot, setSpot] = useState<{ left: number; top: number; side: Side } | null>(null)

  const actions = entries.filter(isAction)
  const isDisabled = (index: number) => Boolean(actions[index]?.disabled)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setActive(-1)
    setSpot(null)
    if (refocus) triggerNode.current?.focus()
  }, [])

  const openAt = (start: 'first' | 'last' | 'none') => {
    setOpen(true)
    setActive(start === 'none' ? -1 : moveIndex(-1, start, actions.length, isDisabled))
  }

  useLayoutEffect(() => {
    if (!open) return
    const anchor = triggerNode.current?.getBoundingClientRect()
    const menu = menuNode.current
    if (!anchor || !menu) return
    setSpot(
      place(
        { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align, gap: 4 },
      ),
    )
  }, [open, side, align, entries.length])

  // Focus follows the active item; with none active the menu itself holds focus for the keyboard.
  useEffect(() => {
    if (!open || !spot) return
    const target = active >= 0 ? itemNodes.current[active] : menuNode.current
    target?.focus({ preventScroll: true })
  }, [open, spot, active])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuNode.current?.contains(target) || triggerNode.current?.contains(target)) return
      close(false)
    }
    const onBlur = () => close(false)
    const onResize = () => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  const choose = (action: MenuAction) => {
    if (action.disabled) return
    close(true)
    action.onSelect()
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'vertical')
    if (move) {
      event.preventDefault()
      setActive((current) => moveIndex(current, move, actions.length, isDisabled))
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && active >= 0) {
      event.preventDefault()
      choose(actions[active])
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const now = Date.now()
      typed.current = { text: now - typed.current.at > 500 ? event.key : typed.current.text + event.key, at: now }
      const found = typeaheadIndex(
        actions.map((action) => action.label),
        typed.current.text,
        typed.current.text.length > 1 ? active - 1 : active,
        isDisabled,
      )
      if (found >= 0) setActive(found)
    }
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt('last')
    }
  }

  let actionIndex = -1
  return (
    <>
      {trigger({
        ref: (node) => {
          triggerNode.current = node
        },
        onClick: () => (open ? close(false) : openAt('none')),
        onKeyDown: onTriggerKeyDown,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
      })}
      {open &&
        createPortal(
          <div
            ref={menuNode}
            id={menuId}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            data-side={spot?.side ?? side}
            className={cx('ui-menu', className)}
            style={{ width, left: spot?.left ?? 0, top: spot?.top ?? 0, visibility: spot ? undefined : 'hidden' }}
            onKeyDown={onMenuKeyDown}
          >
            {entries.map((entry) => {
              if (entry.kind === 'separator') return <div key={entry.id} role="separator" className="ui-menu-separator" />
              if (entry.kind === 'group')
                return (
                  <div key={entry.id} role="presentation" className="ui-menu-group">
                    {entry.label}
                  </div>
                )
              actionIndex += 1
              const index = actionIndex
              const action = entry
              return (
                <button
                  key={action.id}
                  ref={(node) => {
                    itemNodes.current[index] = node
                  }}
                  type="button"
                  role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={action.checked}
                  aria-disabled={action.disabled || undefined}
                  tabIndex={-1}
                  className={cx(
                    'ui-menu-item',
                    index === active && 'is-active',
                    action.danger && 'is-danger',
                    action.disabled && 'is-disabled',
                  )}
                  onPointerMove={() => {
                    if (!action.disabled && index !== active) setActive(index)
                  }}
                  onClick={() => choose(action)}
                >
                  {action.checked !== undefined && (
                    <span className="ui-menu-check">{action.checked && <Check size={14} />}</span>
                  )}
                  {action.icon && <span className="ui-menu-icon">{action.icon}</span>}
                  <span className="ui-menu-text">
                    <span className="ui-menu-label">{action.label}</span>
                    {action.description && <span className="ui-menu-description">{action.description}</span>}
                  </span>
                  {action.shortcut && <Kbd keys={action.shortcut} className="ui-menu-shortcut" />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
