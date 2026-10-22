import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { api } from '../../api'
import { commandRegistry } from '../../commands/app'
import { activeKind } from '../../panels/model'
import { usePanels } from '../../stores/panels'
import { useSessions } from '../../stores/sessions'
import { attentionCount } from '../../stores/sidebar-model'
import { useStatus } from '../../stores/status'
import { useUi } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Bot, Clock, GitPullRequest, Home, MoreHorizontal, Puzzle, Settings } from '../../ui/icons'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { Tooltip } from '../../ui/Tooltip'

type ButtonProps = ComponentProps<'button'>

function RailButton({
  label,
  shortcut,
  active,
  badge,
  children,
  ...rest
}: ButtonProps & { label: string; shortcut?: string; active?: boolean; badge?: boolean; children: ReactNode }) {
  return (
    <Tooltip label={label} shortcut={shortcut} side="right">
      <button type="button" aria-label={label} className={cx('rail-btn', active && 'is-active')} {...rest}>
        {children}
        {badge && <span className="rail-badge" />}
      </button>
    </Tooltip>
  )
}

/** The 52 px strip of places: Home, Automations, Review, Plugins and skills, Models and roles, More, then Settings and you. */
export default function IconRail() {
  const settingsOpen = useUi((state) => state.settingsOpen)
  const settingsTab = useUi((state) => state.settingsTab)
  const pluginsOpen = useUi((state) => state.pluginsOpen)
  const automationOpen = useUi((state) => state.automationOpen)
  const sidebarMode = useUi((state) => state.sidebarMode)
  const sourceControlShown = useUi((state) => state.sidebarView === 'git')
  const filesShown = usePanels((state) => state.side.layout !== 'hidden' && activeKind(state.side) === 'files')
  const reviewOpen = filesShown && sourceControlShown
  const sessions = useSessions((state) => state.sessions)
  const statuses = useStatus((state) => state.statusById)
  const [user, setUser] = useState('developer')
  useEffect(() => {
    void api.app.user().then(setUser).catch(() => setUser('developer'))
  }, [])

  const ui = useUi.getState
  const waiting = attentionCount(sessions, statuses)
  const modalOpen = settingsOpen || pluginsOpen || automationOpen
  const shortcut = (id: string) => commandRegistry.shortcut(id)

  const run = (id: string) => () => commandRegistry.run(id)
  const moreEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-sessions', label: 'Sessions' },
    { id: 'projects', label: 'Projects', checked: sidebarMode === 'projects', onSelect: () => ui().setSidebarMode('projects') },
    { id: 'activity', label: 'Activity', shortcut: shortcut('view.activity'), checked: sidebarMode === 'activity', onSelect: () => ui().setSidebarMode('activity') },
    { id: 'archived', label: 'Archived', checked: sidebarMode === 'archived', onSelect: () => ui().setSidebarMode('archived') },
    { kind: 'separator', id: 'sep-more' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', shortcut: shortcut('help.shortcuts'), onSelect: run('help.shortcuts') },
  ]
  const accountEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-user', label: user },
    { id: 'settings', label: 'Settings…', shortcut: shortcut('app.settings'), onSelect: run('app.settings') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', shortcut: shortcut('help.shortcuts'), onSelect: run('help.shortcuts') },
    { id: 'about', label: 'About eNCode', onSelect: run('help.about') },
    { kind: 'separator', id: 'sep-quit' },
    { id: 'quit', label: 'Quit eNCode', shortcut: shortcut('app.quit'), onSelect: run('app.quit') },
  ]

  return (
    <nav className="icon-rail" aria-label="Primary">
      <RailButton
        label="Home"
        active={!modalOpen && !reviewOpen}
        badge={waiting > 0}
        onClick={() => {
          ui().setSidebarMode('projects')
          // A full-width side panel covers the thread; Home is the thread.
          if (usePanels.getState().side.layout === 'full') usePanels.getState().setLayout('split')
          ui().setSettingsOpen(false)
          ui().setPluginsOpen(false)
          ui().setAutomationOpen(false)
        }}
      >
        <Home size={18} />
      </RailButton>
      <RailButton label="Automations" active={automationOpen} onClick={() => ui().setAutomationOpen(true)}>
        <Clock size={18} />
      </RailButton>
      <RailButton
        label="Review"
        active={reviewOpen}
        onClick={() => usePanels.getState().open('files', { view: 'git' })}
      >
        <GitPullRequest size={18} />
      </RailButton>
      <RailButton label="Plugins and skills" active={pluginsOpen} onClick={() => ui().setPluginsOpen(true)}>
        <Puzzle size={18} />
      </RailButton>
      <RailButton label="Models and roles" active={settingsOpen && settingsTab === 'models'} onClick={() => ui().openSettings('models')}>
        <Bot size={18} />
      </RailButton>
      <Menu
        label="More"
        side="right"
        align="start"
        width={240}
        entries={moreEntries}
        trigger={(props) => (
          <RailButton label="More" {...props}>
            <MoreHorizontal size={18} />
          </RailButton>
        )}
      />

      <div className="rail-spacer" />

      <RailButton label="Settings" shortcut={shortcut('app.settings')} active={settingsOpen && settingsTab !== 'models'} onClick={run('app.settings')}>
        <Settings size={18} />
      </RailButton>
      <Menu
        label="Account"
        side="right"
        align="end"
        width={240}
        entries={accountEntries}
        trigger={(props) => (
          <Tooltip label={user} side="right">
            <button type="button" aria-label={`Account: ${user}`} className="avatar" {...props}>
              {user.slice(0, 1).toUpperCase()}
            </button>
          </Tooltip>
        )}
      />
    </nav>
  )
}
