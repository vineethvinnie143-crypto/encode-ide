import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { commandRegistry } from '../../commands/app'
import { flatten, rankPalette, remember, type PaletteItem } from '../../palette/model'
import { useSessions } from '../../stores/sessions'
import { useUi, type SettingsTab } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Bolt, Gear, MessageSquare, Search } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'

interface Entry extends PaletteItem {
  kind: 'session' | 'command' | 'settings'
  run(): void
}

const RECENT_KEY = 'eNCode.palette.recent.v1'

/** The settings pages, with the words people look for them by. */
const SETTINGS_PAGES: readonly { tab: SettingsTab; title: string; keywords: string }[] = [
  { tab: 'models', title: 'Models', keywords: 'providers api keys openrouter free connect' },
  { tab: 'roles', title: 'Roles', keywords: 'builder reviewer tools small tasks model per role' },
  { tab: 'agent', title: 'Agent', keywords: 'approval policy computer use steps limits steer queue follow-up enter' },
  { tab: 'permissions', title: 'Permissions', keywords: 'rules trust protected folders allow deny' },
  { tab: 'mcp', title: 'MCP servers', keywords: 'mcp tools servers' },
  { tab: 'sandbox', title: 'Sandbox', keywords: 'isolation commands network' },
  { tab: 'appearance', title: 'Appearance', keywords: 'theme dark light font size accent density motion' },
]

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function saveRecent(recent: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    /* storage may be unavailable */
  }
}

const folderName = (root: string | null) => (root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : 'No project')

/** Everything the palette can find, read when it opens: the other open sessions, newest first, the commands that can run now, and the settings pages. */
function paletteEntries(): Entry[] {
  const { sessions, activeId } = useSessions.getState()
  const chats: Entry[] = sessions
    .filter((session) => !session.archived && session.id !== activeId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      id: `session:${session.id}`,
      group: 'Sessions',
      kind: 'session',
      title: session.title,
      detail: folderName(session.projectRoot),
      run: () => void useSessions.getState().select(session.id),
    }))
  const actions: Entry[] = commandRegistry
    .all()
    .filter((command) => !command.hidden && command.palette !== false && commandRegistry.isEnabled(command.id))
    .map((command) => ({
      id: `command:${command.id}`,
      group: 'Actions',
      kind: 'command',
      title: commandRegistry.titleOf(command.id),
      detail: command.group,
      ...(command.keywords ? { keywords: command.keywords } : {}),
      ...(commandRegistry.shortcut(command.id) ? { shortcut: commandRegistry.shortcut(command.id) } : {}),
      run: () => void commandRegistry.run(command.id),
    }))
  const pages: Entry[] = SETTINGS_PAGES.map((page) => ({
    id: `settings:${page.tab}`,
    group: 'Settings',
    kind: 'settings',
    title: page.title,
    detail: 'Settings',
    keywords: page.keywords,
    run: () => useUi.getState().openSettings(page.tab),
  }))
  return [...chats, ...actions, ...pages]
}

const ICONS: Record<Entry['kind'], ReactNode> = {
  session: <MessageSquare size={15} />,
  command: <Bolt size={15} />,
  settings: <Gear size={15} />,
}

/** Ctrl+K (or Ctrl+Shift+P): sessions, actions and settings pages, found by name. */
export function CommandPalette() {
  const open = useUi((state) => state.paletteOpen)
  return open ? <PalettePanel /> : null
}

function PalettePanel() {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [items] = useState(paletteEntries)
  const [recent] = useState(loadRecent)
  const sections = useMemo(() => rankPalette(items, query, recent), [items, query, recent])
  const rows = useMemo(() => flatten(sections), [sections])
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()

  // Focus comes back to where it was; a command picked here runs after that, so a dialog it opens keeps focus.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => returnTo?.focus?.({ preventScroll: true })
  }, [])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    list.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, rows])

  const close = () => useUi.getState().setPaletteOpen(false)

  const pick = (entry: Entry | undefined) => {
    if (!entry) return
    saveRecent(remember(recent, entry.id))
    close()
    setTimeout(() => entry.run(), 0)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    const move = (step: number) => {
      event.preventDefault()
      if (rows.length) setIndex((current) => (current + step + rows.length) % rows.length)
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(1)
      case 'ArrowUp':
        return move(-1)
      case 'PageDown':
        event.preventDefault()
        return setIndex((current) => Math.min(rows.length - 1, current + 8))
      case 'PageUp':
        event.preventDefault()
        return setIndex((current) => Math.max(0, current - 8))
      case 'Enter':
        event.preventDefault()
        return pick(rows[index])
      case 'Escape':
        event.preventDefault()
        return close()
      case 'Tab':
        // Focus stays in the palette: its list is driven from the field.
        event.preventDefault()
        return
    }
  }

  let position = 0
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? `${listId}-${index}` : undefined}
            placeholder="Search sessions, actions and settings"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list" id={listId} role="listbox" aria-label="Results" ref={list}>
          {sections.map((section) => (
            <div key={section.group} role="group" aria-label={section.group}>
              <div className="palette-group" aria-hidden="true">
                {section.group}
              </div>
              {section.items.map((item) => {
                const row = position++
                return (
                  <div
                    key={item.id}
                    id={`${listId}-${row}`}
                    data-row={row}
                    role="option"
                    aria-selected={row === index}
                    className={cx('palette-row', row === index && 'is-active')}
                    onMouseMove={() => row !== index && setIndex(row)}
                    onClick={() => pick(item)}
                  >
                    <span className="palette-icon">{ICONS[item.kind]}</span>
                    <span className="palette-title">{item.title}</span>
                    {item.detail && <span className="palette-detail">{item.detail}</span>}
                    {item.shortcut && <Kbd keys={item.shortcut} className="palette-keys" />}
                  </div>
                )
              })}
            </div>
          ))}
          {!rows.length && <div className="palette-empty">Nothing matches “{query.trim()}”.</div>}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <Kbd keys="↑" />
            <Kbd keys="↓" /> to move
          </span>
          <span>
            <Kbd keys="Enter" /> to open
          </span>
          <span>
            <Kbd keys="Esc" /> to close
          </span>
        </div>
      </div>
    </div>
  )
}
