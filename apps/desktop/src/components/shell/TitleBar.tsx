import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../../api'
import { commandRegistry } from '../../commands/app'
import { MENUS, menuEntries } from '../../commands/menus'
import { useSessions } from '../../stores/sessions'
import { canGoBack, canGoForward } from '../../stores/history'
import { useUi } from '../../stores/ui'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { ArrowLeft, ArrowRight, Copy, Maximize2, Minus, PanelLeft, X } from '../../ui/icons'
import { LogoMark } from '../../ui/Logo'
import { MenuPanel } from '../../ui/Menu'
import type { Rect } from '../../ui/place'

interface OpenMenu {
  index: number
  start: 'none' | 'first'
  anchor: Rect
}

/** File, Edit, View, Session and Help. Opens on click, then follows the pointer or the arrow keys from menu to menu. */
function MenuBar() {
  const [open, setOpen] = useState<OpenMenu | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const restoreFocus = useRef<HTMLElement | null>(null)

  const show = (index: number, start: 'none' | 'first') => {
    const box = buttons.current[index]?.getBoundingClientRect()
    if (!box) return
    if (!open) {
      const active = document.activeElement as HTMLElement | null
      restoreFocus.current = active && !barRef.current?.contains(active) ? active : null
    }
    setOpen({ index, start, anchor: { left: box.left, top: box.top, width: box.width, height: box.height } })
  }

  // Focus goes back to where it was (the editor, the composer), so Edit commands act on it.
  const close = useCallback((refocus: boolean) => {
    setOpen(null)
    if (refocus && restoreFocus.current?.isConnected) restoreFocus.current.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      show(index, 'first')
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = (index + (event.key === 'ArrowLeft' ? -1 : 1) + MENUS.length) % MENUS.length
      buttons.current[next]?.focus()
    }
  }

  return (
    <div className="menubar" role="menubar" aria-label="Application menu" ref={barRef}>
      {MENUS.map((menu, index) => (
        <button
          key={menu.label}
          ref={(node) => {
            buttons.current[index] = node
          }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open?.index === index}
          className={cx('tb-menu', open?.index === index && 'is-open')}
          // Keep focus in the editor or composer: a menu click should not take it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (open?.index === index ? close(false) : show(index, 'none'))}
          onPointerEnter={() => open && open.index !== index && show(index, 'none')}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {menu.label}
        </button>
      ))}
      {open && (
        <MenuPanel
          key={open.index}
          entries={menuEntries(commandRegistry, MENUS[open.index])}
          anchor={open.anchor}
          label={MENUS[open.index].label}
          width={280}
          start={open.start}
          ignore={barRef}
          onClose={close}
          onHorizontal={(direction) => show((open.index + direction + MENUS.length) % MENUS.length, 'first')}
        />
      )}
    </div>
  )
}

function CaptionButtons() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => api.window.onStateChange((state) => setMaximized(state.maximized)), [])
  return (
    <div className="caption">
      <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void api.window.minimize()}>
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void api.window.toggleMaximize().then(setMaximized)}
      >
        {maximized ? <Copy size={12} /> : <Maximize2 size={12} />}
      </button>
      <button type="button" className="close" aria-label="Close" title="Close" onClick={() => void api.window.close()}>
        <X size={14} />
      </button>
    </div>
  )
}

/** The 44 px bar: logo, Back and Forward over the sessions you opened, the sidebar toggle, the menus, window buttons. */
export default function TitleBar() {
  const back = useSessions((state) => canGoBack(state.history))
  const forward = useSessions((state) => canGoForward(state.history))
  const sidebarVisible = useUi((state) => state.sidebarVisible)
  const shortcut = (id: string) => commandRegistry.shortcut(id)

  return (
    <header className="titlebar">
      <LogoMark size={22} className="titlebar-logo" />
      <IconButton label="Back" shortcut={shortcut('session.back')} size="md" disabled={!back} onClick={() => commandRegistry.run('session.back')}>
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton label="Forward" shortcut={shortcut('session.forward')} size="md" disabled={!forward} onClick={() => commandRegistry.run('session.forward')}>
        <ArrowRight size={16} />
      </IconButton>
      <IconButton
        label="Toggle sidebar"
        shortcut={shortcut('view.sidebar')}
        size="md"
        active={sidebarVisible}
        onClick={() => commandRegistry.run('view.sidebar')}
      >
        <PanelLeft size={16} />
      </IconButton>
      <span className="tb-sep" />
      <MenuBar />
      <div className="tb-drag" />
      <CaptionButtons />
    </header>
  )
}
