import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Settings } from '@shared/types'
import { dialogOpen } from '../../commands/useKeymap'
import { useSettings } from '../../stores/settings'
import { useUi, type SettingsSection } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Archive, ArrowLeft, BarChart, Bell, Bot, Code2, FileCode2, Gear, Keyboard, Layers, MousePointer, Network, Package, Palette, Puzzle, Search, Shield, Sparkles, UserRound, type Icon } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { keyToMove, moveIndex } from '../../ui/nav'
import { Spinner } from '../../ui/Spinner'
import { LanguageServersSection } from '../../editor/surface-view'
import McpPane from '../mcp/McpPane'
import RolesSettings from '../models/RolesSettings'
import PermissionsPane from '../permissions/PermissionsPane'
import SandboxPane from '../sandbox/SandboxPane'
import { AgentSection } from './AgentSection'
import { AppearanceSection } from './AppearanceSection'
import { ArchivedSection } from './ArchivedSection'
import { ComputerSection } from './ComputerSection'
import { EditorSection } from './EditorSection'
import { GeneralSection } from './GeneralSection'
import { ModelsSection } from './ModelsSection'
import { NotificationsSection } from './NotificationsSection'
import { PersonalizationSection } from './PersonalizationSection'
import { SECTIONS, searchSettings, sectionInfo, type SettingInfo } from './sections'
import { ShortcutsSection } from './ShortcutsSection'
import { SkillsSection } from './SkillsSection'
import { UsageSection } from './UsageSection'

const ICONS: Record<SettingsSection, Icon> = {
  general: Gear,
  personalization: UserRound,
  notifications: Bell,
  appearance: Palette,
  editor: FileCode2,
  shortcuts: Keyboard,
  models: Bot,
  roles: Layers,
  usage: BarChart,
  agent: Sparkles,
  computer: MousePointer,
  skills: Puzzle,
  permissions: Shield,
  mcp: Network,
  sandbox: Package,
  code: Code2,
  archived: Archive,
}

/** How long a setting chosen from the search stays marked. */
const FOUND_MS = 1600
/** Frames to wait for a setting in a section that loads its contents first. */
const FIND_FRAMES = 40
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Settings as a page over the sessions and the work area, which stay as they are under it: sections on the left with
 * a search over every setting, the section on the right. A change is kept as it is made. Esc goes back to the app.
 */
export function SettingsPage() {
  const section = useUi((state) => state.settingsSection)
  const focus = useUi((state) => state.settingsFocus)
  const settings = useSettings((state) => state.settings)
  const [query, setQuery] = useState('')
  // Read while rendering, before the work area under the page turns inert and loses the focus.
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null)
  const nav = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const info = sectionInfo(section)
  const searching = query.trim().length > 0
  const hits = useMemo(() => searchSettings(query), [query])

  // Back in the app, the focus goes where it was, or to the message box.
  useEffect(
    () => () => {
      const back = returnTo?.isConnected && !returnTo.closest('[inert]') ? returnTo : document.querySelector<HTMLElement>('.composer-input')
      back?.focus({ preventScroll: true })
    },
    [returnTo],
  )

  // Esc leaves the page, once whatever is open on it (a menu, a dialog, a field's edit) has had it. Nothing else on the
  // window gets that Esc: an approval card that came up while the page was open listens after this, and would take the
  // page as gone and deny the approval.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
      if (dialogOpen() || useUi.getState().connectOpen || document.querySelector('.ui-backdrop')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      useUi.getState().setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useLayoutEffect(() => {
    content.current?.scrollTo({ top: 0 })
  }, [section])

  // Each request to open the page puts the focus somewhere: on the setting asked for, scrolled to and marked, or at
  // the start of the section (its own field when it has one, such as the shortcuts' search, else the page's search).
  const focusId = focus?.id
  useEffect(() => {
    const request = useUi.getState().settingsFocus
    if (!request) return
    let frame = 0
    let frames = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const place = () => {
      const root = content.current
      if (!root) return
      if (request.setting === null) {
        const start = root.querySelector<HTMLElement>('[data-autofocus]') ?? search.current
        start?.focus({ preventScroll: true })
        return
      }
      const row = root.querySelector<HTMLElement>(`[data-setting="${CSS.escape(request.setting)}"]`)
      if (!row) {
        if (++frames < FIND_FRAMES) frame = requestAnimationFrame(place)
        return
      }
      row.scrollIntoView({ block: 'center' })
      row.classList.add('is-found')
      timer = setTimeout(() => row.classList.remove('is-found'), FOUND_MS)
      const control = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE)
      control?.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(place)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [focusId])

  const go = (next: SettingsSection) => useUi.getState().setSettingsSection(next)
  const find = (setting: SettingInfo) => useUi.getState().openSettings(setting.section, setting.id)

  const items = () => [...(nav.current?.querySelectorAll<HTMLElement>('.settings-nav-list button') ?? [])]
  const moveInNav = (event: KeyboardEvent<HTMLElement>) => {
    const move = keyToMove(event.key, 'vertical')
    if (!move || !(event.target instanceof HTMLElement) || !event.target.closest('.settings-nav-list')) return
    event.preventDefault()
    const list = items()
    list[moveIndex(list.indexOf(event.target), move, list.length)]?.focus()
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && query) {
      // The first Esc empties the search; the next one leaves the page.
      event.preventDefault()
      setQuery('')
    } else if (event.key === 'Enter' && searching && hits.length) {
      event.preventDefault()
      const [first] = hits
      if (first.settings.length) find(first.settings[0])
      else go(first.section.id)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      items()[0]?.focus()
    }
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <nav ref={nav} className="settings-nav" aria-label="Settings sections" onKeyDown={moveInNav}>
        <button type="button" className="settings-back" onClick={() => useUi.getState().setSettingsOpen(false)}>
          <ArrowLeft size={15} aria-hidden="true" />
          <span className="settings-back-text">Back to app</span>
          <Kbd keys="Esc" plain />
        </button>
        <div className="settings-search">
          <Search size={14} className="settings-search-icon" aria-hidden="true" />
          <input
            ref={search}
            className="settings-search-input"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <div className="settings-nav-list">
          {searching
            ? hits.map((hit) => (
                <div key={hit.section.id} className="settings-nav-hit">
                  <NavItem section={hit.section.id} title={hit.section.title} active={hit.section.id === section} onClick={() => go(hit.section.id)} />
                  {hit.settings.map((setting) => (
                    <button key={setting.id} type="button" className="settings-nav-sub" onClick={() => find(setting)}>
                      {setting.label}
                    </button>
                  ))}
                </div>
              ))
            : SECTIONS.map((item) => (
                <Fragment key={item.id}>
                  {item.startsCluster && <div className="settings-nav-sep" role="separator" />}
                  <NavItem section={item.id} title={item.title} active={item.id === section} onClick={() => go(item.id)} />
                </Fragment>
              ))}
          {searching && !hits.length && <div className="settings-nav-empty">No setting matches “{query.trim()}”.</div>}
        </div>
      </nav>

      <div ref={content} className="settings-content">
        <div className="settings-column" data-section={section}>
          <header className="settings-head">
            <h1 className="settings-heading">{info.title}</h1>
            <p className="settings-description">{info.description}</p>
          </header>
          {settings ? (
            <SectionBody section={section} settings={settings} />
          ) : (
            <div className="settings-loading" role="status">
              <Spinner size={14} /> Loading settings…
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function NavItem({ section, title, active, onClick }: { section: SettingsSection; title: string; active: boolean; onClick: () => void }) {
  const SectionIcon = ICONS[section]
  return (
    <button type="button" className={cx('settings-nav-item', active && 'is-active')} aria-current={active ? 'page' : undefined} data-section={section} onClick={onClick}>
      <SectionIcon size={16} aria-hidden="true" />
      <span>{title}</span>
    </button>
  )
}

function SectionBody({ section, settings }: { section: SettingsSection; settings: Settings }) {
  const save = useSettings((state) => state.save)
  switch (section) {
    case 'general':
      return <GeneralSection settings={settings} />
    case 'personalization':
      return <PersonalizationSection />
    case 'notifications':
      return <NotificationsSection settings={settings} />
    case 'appearance':
      return <AppearanceSection settings={settings} />
    case 'editor':
      return <EditorSection />
    case 'shortcuts':
      return <ShortcutsSection />
    case 'models':
      return <ModelsSection settings={settings} />
    case 'roles':
      return <RolesSettings draft={settings} onChange={(patch) => void save(patch)} onConnect={() => useUi.getState().setConnectOpen(true)} />
    case 'usage':
      return <UsageSection settings={settings} />
    case 'agent':
      return <AgentSection settings={settings} />
    case 'computer':
      return <ComputerSection settings={settings} />
    case 'skills':
      return <SkillsSection />
    case 'permissions':
      return (
        <div className="settings-pane" data-setting="permissions.rules">
          <PermissionsPane />
        </div>
      )
    case 'mcp':
      return (
        <div className="settings-pane" data-setting="mcp.servers">
          <McpPane onOpenTab={(next) => useUi.getState().openSettings(next)} />
        </div>
      )
    case 'sandbox':
      return (
        <div className="settings-pane" data-setting="sandbox.settings">
          <SandboxPane />
        </div>
      )
    case 'code':
      return <LanguageServersSection settings={settings} />
    case 'archived':
      return <ArchivedSection settings={settings} />
  }
}
