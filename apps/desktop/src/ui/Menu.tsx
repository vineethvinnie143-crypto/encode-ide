import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { Check } from './icons'
import { Kbd } from './Kbd'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'
import { place, type Align, type Rect, type Side } from './place'

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

const isAction = (entry: MenuEntry): entry is MenuAction => entry.kind === undefined || entry.kind === 'item'

/**
 * The open menu: a floating list placed next to `anchor`. Arrow keys, Home,
 * End and typing move through it, Enter or Space chooses, Escape closes, and a
 * click anywhere else closes it. The component that opens it decides where
 * focus goes afterwards (`onClose(true)` asks for it to return to the trigger).
 */
export function MenuPanel({
  entries,
  anchor,
  label,
  side = 'bottom',
  align = 'start',
  width,
  className,
  start = 'none',
  ignore,
  onClose,
  onHorizontal,
}: {
  entries: readonly MenuEntry[]
  anchor: Rect
  /** Names the menu for screen readers. */
  label: string
  side?: Side
  align?: Align
  width?: number
  className?: string
  /** Which item starts active: none (pointer opened it), the first or the last (keyboard did). */
  start?: 'none' | 'first' | 'last'
  /** Clicks inside this element do not close the menu; its owner handles them. */
  ignore?: RefObject<HTMLElement | null>
  onClose: (refocus: boolean) => void
  /** Left and right arrows, for a menu bar that moves to the next menu. */
  onHorizontal?: (direction: -1 | 1) => void
}) {
  const menuId = useId()
  const menuNode = useRef<HTMLDivElement>(null)
  const itemNodes = useRef<(HTMLButtonElement | null)[]>([])
  const typed = useRef({ text: '', at: 0 })
  const actions = entries.filter(isAction)
  const isDisabled = (index: number) => Boolean(actions[index]?.disabled)
  const [active, setActive] = useState(() => (start === 'none' ? -1 : moveIndex(-1, start, actions.length, isDisabled)))
  const [spot, setSpot] = useState<{ left: number; top: number; side: Side } | null>(null)

  useLayoutEffect(() => {
    const menu = menuNode.current
    if (!menu) return
    setSpot(
      place(
        anchor,
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align, gap: 4 },
      ),
    )
  }, [anchor.left, anchor.top, anchor.width, anchor.height, side, align, entries.length])

  // Focus follows the active item; with none active the menu itself holds focus for the keyboard.
  useEffect(() => {
    if (!spot) return
    const target = active >= 0 ? itemNodes.current[active] : menuNode.current
    target?.focus({ preventScroll: true })
  }, [spot, active])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuNode.current?.contains(target) || ignore?.current?.contains(target)) return
      onClose(false)
    }
    const dismiss = () => onClose(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [ignore, onClose])

  const choose = (action: MenuAction) => {
    if (action.disabled) return
    onClose(true)
    action.onSelect()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'vertical')
    if (move) {
      event.preventDefault()
      setActive((current) => moveIndex(current, move, actions.length, isDisabled))
      return
    }
    if (onHorizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      onHorizontal(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
      return
    }
    if (event.key === 'Tab') {
      onClose(false)
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

  let actionIndex = -1
  return createPortal(
    <div
      ref={menuNode}
      id={menuId}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-side={spot?.side ?? side}
      className={cx('ui-menu', className)}
      style={{ width, left: spot?.left ?? 0, top: spot?.top ?? 0, visibility: spot ? undefined : 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
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
            {action.checked !== undefined && <span className="ui-menu-check">{action.checked && <Check size={14} />}</span>}
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
  )
}

export interface MenuTriggerProps {
  ref: (node: HTMLElement | null) => void
  onClick: () => void
  onKeyDown: (event: ReactKeyboardEvent) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
}

/** A menu that opens from a trigger: `trigger` draws the button and spreads the props it is given. */
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
  entries: readonly MenuEntry[] | (() => readonly MenuEntry[])
  label: string
  side?: Side
  align?: Align
  width?: number
  className?: string
}) {
  const triggerNode = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState<{ start: 'none' | 'first' | 'last'; anchor: Rect } | null>(null)

  const show = (start: 'none' | 'first' | 'last') => {
    const box = triggerNode.current?.getBoundingClientRect()
    if (box) setOpen({ start, anchor: { left: box.left, top: box.top, width: box.width, height: box.height } })
  }
  const close = useCallback((refocus: boolean) => {
    setOpen(null)
    if (refocus) triggerNode.current?.focus()
  }, [])
  const ignore = useRef<HTMLElement | null>(null)
  ignore.current = triggerNode.current

  return (
    <>
      {trigger({
        ref: (node) => {
          triggerNode.current = node
        },
        onClick: () => (open ? close(false) : show('none')),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            show('first')
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            show('last')
          }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open !== null,
      })}
      {open && (
        <MenuPanel
          entries={typeof entries === 'function' ? entries() : entries}
          anchor={open.anchor}
          label={label}
          side={side}
          align={align}
          width={width}
          className={className}
          start={open.start}
          ignore={ignore}
          onClose={close}
        />
      )}
    </>
  )
}

/** A menu at a point, for right-click. `onClose(true)` asks the opener to take focus back, as after Escape. */
export function ContextMenu({
  x,
  y,
  entries,
  label,
  onClose,
}: {
  x: number
  y: number
  entries: readonly MenuEntry[]
  label: string
  onClose: (refocus: boolean) => void
}) {
  return (
    <MenuPanel
      entries={entries}
      anchor={{ left: x, top: y, width: 0, height: 0 }}
      label={label}
      side="bottom"
      align="start"
      onClose={onClose}
    />
  )
}

/** Unique id for the entries of one menu, so keys stay stable when labels change. */
export function menuId(prefix: string, index: number): string {
  return `${prefix}-${index}`
}

/** Hook-free helper used where an id is needed outside a component. */
export function useMenuId(): string {
  return useId()
}
