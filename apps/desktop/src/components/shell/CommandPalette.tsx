import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { commandRegistry } from '../../commands/app'
import { flatten, rankPalette, remember, type PaletteItem } from '../../palette/model'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { isChat, projectName } from '../../stores/sidebar-model'
import { useUi } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Bolt, Gear, MessageSquare, Search } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { SECTIONS, SETTINGS, sectionInfo } from '../settings/sections'

interface Entry extends PaletteItem {
  kind: 'session' | 'command' | 'settings'
  run(): void
}

const RECENT_KEY = 'eNCode.palette.recent.v1'

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

/**
 * Everything the palette can find, read when it opens: the other open sessions, newest first, the commands that can
 * run now, the settings sections and, once something is typed, each setting in them.
 */
function paletteEntries(): Entry[] {
  const { sessions, activeId } = useSessions.getState()
  const chatsFolder = useSettings.getState().settings?.chatsFolder
  const chats: Entry[] = sessions
    .filter((session) => !session.archived && session.id !== activeId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      id: `session:${session.id}`,
      group: 'Sessions',
      kind: 'session',
      title: session.title,
      detail: isChat(session, chatsFolder) || !session.projectRoot ? 'Chat' : projectName(session.projectRoot),
      run: () => {
        useUi.getState().setSettingsOpen(false)
        void useSessions.getState().select(session.id)
      },
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
  const pages: Entry[] = SECTIONS.map((section) => ({
    id: `settings:${section.id}`,
    group: 'Settings',
    kind: 'settings',
    title: section.title,
    detail: 'Settings',
    keywords: section.keywords,
    run: () => useUi.getState().openSettings(section.id),
  }))
  const settings: Entry[] = SETTINGS.map((setting) => ({
    id: `setting:${setting.id}`,
    group: 'Settings',
    kind: 'settings',
    title: setting.label,
    detail: sectionInfo(setting.section).title,
    ...(setting.keywords ? { keywords: setting.keywords } : {}),
    searchOnly: true,
    run: () => useUi.getState().openSettings(setting.section, setting.id),
  }))
  return [...chats, ...actions, ...pages, ...settings]
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
