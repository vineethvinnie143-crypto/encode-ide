import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useModels } from '../../stores/models'
import { useSettings } from '../../stores/settings'
import { cx } from '../../ui/cx'
import { AlertTriangle, Check, Plus, Search, Settings2 } from '../../ui/icons'
import { moveIndex } from '../../ui/nav'
import { place, type Align, type Rect, type Side } from '../../ui/place'
import { Spinner } from '../../ui/Spinner'
import { flatten, isListed, pickerGroups, type PickerItem } from './model-list'
import { ModelBadges } from './ModelItem'

export interface ModelPickerProps {
  anchor: Rect
  /** `refocus` asks the opener to take focus back, as after Escape. */
  onClose: (refocus: boolean) => void
  onPick: (item: PickerItem) => void
  /** The references to mark as in use. */
  selected: readonly string[]
  /** Offer "Free models" and the offline demo as choices. */
  free?: boolean
  demo?: boolean
  /** "Connect a model…" and "Roles…" at the foot of the list. */
  footer?: { onConnect: () => void; onRoles: () => void }
  side?: Side
  align?: Align
  width?: number
  label?: string
  /** Clicks inside this element do not close the picker; its owner handles them. */
  ignore?: { current: HTMLElement | null }
}

/**
 * The list of models to choose from: what is in use, the free models, then each connection's models, narrowed by
 * what is typed. Arrow keys move, Enter chooses, Escape closes. It reads each connection's list when it opens.
 */
export function ModelPicker({ anchor, onClose, onPick, selected, free = true, demo = false, footer, side = 'top', align = 'end', width = 420, label = 'Choose a model', ignore }: ModelPickerProps) {
  const settings = useSettings((state) => state.settings)
  const catalogs = useModels((state) => state.catalogs)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [spot, setSpot] = useState<{ left: number; top: number; side: Side } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const profiles = useSettings.getState().settings?.profiles ?? []
    void useModels.getState().loadAll(profiles.filter(isListed))
  }, [])

  const groups = useMemo(() => (settings ? pickerGroups({ settings, catalogs, query, selected, free, demo }) : []), [settings, catalogs, query, selected, free, demo])
  const flat = useMemo(() => flatten(groups), [groups])
  const usable = (index: number) => !flat[index]?.noTools

  // The list changes under the cursor as lists arrive and the query narrows: keep the highlight on something that can be chosen.
  useEffect(() => {
    setActive((current) => {
      if (current >= 0 && current < flat.length && usable(current)) return current
      return moveIndex(-1, 'first', flat.length, (index) => !usable(index))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat])

  useLayoutEffect(() => {
    const node = panel.current
    if (!node) return
    setSpot(place(anchor, { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side, align, gap: 6 }))
  }, [anchor.left, anchor.top, anchor.width, anchor.height, side, align, groups.length, flat.length])

  useEffect(() => {
    if (spot) input.current?.focus({ preventScroll: true })
  }, [spot !== null])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || ignore?.current?.contains(target)) return
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

  const choose = (item: PickerItem | undefined) => {
    if (!item || item.noTools) return
    onClose(true)
    onPick(item)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => moveIndex(current, event.key === 'ArrowDown' ? 'next' : 'prev', flat.length, (index) => !usable(index)))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      choose(flat[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    } else if (event.key === 'Tab') {
      onClose(false)
    }
  }

  let index = -1
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      data-side={spot?.side ?? side}
      className="model-picker"
      style={{ width, left: spot?.left ?? 0, top: spot?.top ?? 0, visibility: spot ? undefined : 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <div className="model-picker-search">
        <Search size={14} />
        <input ref={input} type="search" placeholder="Search models" aria-label="Search models" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div ref={list} className="model-picker-list" role="listbox" aria-label="Models">
        {groups.map((group) => (
          <section key={group.id} className="model-picker-group">
            <h3 className="model-picker-heading">
              {group.title}
              {group.state === 'loading' && <Spinner size={12} label={`Reading the models of ${group.title}`} />}
            </h3>
            {group.items.map((item) => {
              index += 1
              const here = index
              return (
                <button
                  key={item.ref}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={item.selected}
                  aria-disabled={item.noTools || undefined}
                  data-ref={item.ref}
                  data-active={here === active}
                  className={cx('model-picker-item', here === active && 'is-active', item.selected && 'is-selected', item.noTools && 'is-disabled')}
                  onPointerMove={() => !item.noTools && here !== active && setActive(here)}
                  onClick={() => choose(item)}
                >
                  <span className="model-picker-check">{item.selected && <Check size={14} />}</span>
                  <span className="model-picker-text">
                    <span className="model-picker-title">{item.title}</span>
                    {item.detail && <span className="model-picker-detail">{item.detail}</span>}
                  </span>
                  <ModelBadges item={item} />
                </button>
              )
            })}
            {group.message && (
              <div className={cx('model-picker-note', group.state === 'error' && 'is-warn')}>
                {group.state === 'error' && <AlertTriangle size={13} />}
                <span>{group.message}</span>
              </div>
            )}
            {group.hidden > 0 && <div className="model-picker-note">{group.hidden} more. Type to narrow the list.</div>}
          </section>
        ))}
        {!flat.length && !groups.some((group) => group.message || group.state === 'loading') && (
          <div className="model-picker-empty">{query ? `No model matches “${query}”.` : 'No models yet. Connect one below.'}</div>
        )}
      </div>

      {footer && (
        <div className="model-picker-footer">
          <button
            type="button"
            className="model-picker-link"
            onClick={() => {
              onClose(false)
              footer.onConnect()
            }}
          >
            <Plus size={14} /> Connect a model…
          </button>
          <button
            type="button"
            className="model-picker-link"
            onClick={() => {
              onClose(false)
              footer.onRoles()
            }}
          >
            <Settings2 size={14} /> Roles
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
