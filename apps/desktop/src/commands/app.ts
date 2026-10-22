/**
 * The app's commands, bound to the real stores. Importing this module
 * registers them; the title bar menus, the keymap and the shortcut list all
 * read `commandRegistry`.
 */
import type { SessionSummary } from '@shared/types'
import { api } from '../api'
import { useEditor } from '../stores/editor'
import { usePanels } from '../stores/panels'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useStatus } from '../stores/status'
import { adjacentRecent, buildSidebar, nextAttention, visibleOrder } from '../stores/sidebar-model'
import { useUi } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'
import { agentActions } from './agent'
import { buildCommands, type AppActions } from './commands'
import { CommandRegistry } from './registry'

const ui = () => useUi.getState()
const panels = () => usePanels.getState()
const sessions = () => useSessions.getState()
const activeSession = (): SessionSummary | undefined => sessions().sessions.find((session) => session.id === sessions().activeId)

/** Help: the report a tester sends when something goes wrong, and the log files behind it. */
export const helpActions = {
  async saveDiagnostics(): Promise<void> {
    try {
      const file = await api.app.exportDiagnostics()
      if (file) ui().notify('success', `Saved diagnostics to ${file}`)
    } catch (error) {
      ui().notify('error', `Could not save diagnostics: ${(error as Error).message}`)
    }
  },
  async showLogs(): Promise<void> {
    try {
      await api.app.openLogs()
    } catch (error) {
      ui().notify('error', `Could not open the log folder: ${(error as Error).message}`)
    }
  },
}

/** Session ids in the order the sidebar lists them, for Alt+1 to Alt+9. */
function sidebarOrder(): string[] {
  const model = buildSidebar(sessions().sessions, {
    workspaceRoot: useWorkspace.getState().workspace?.root ?? null,
    recentRoots: useSettings.getState().settings?.recentWorkspaces ?? [],
  })
  return visibleOrder(model, new Set(ui().collapsedProjects))
}

/** Archive, delete and export are offered for any session; this runs them for the open one or a given one. */
export const sessionActions = {
  async rename(session: SessionSummary): Promise<void> {
    const title = await ui().askText('Rename session', 'Session name', session.title)
    if (title?.trim()) await sessions().rename(session.id, title)
  },
  togglePin: (session: SessionSummary) => sessions().update(session.id, { pinned: !session.pinned }),
  async archive(session: SessionSummary): Promise<void> {
    await sessions().update(session.id, { archived: true })
    ui().notify('info', `Archived “${session.title}”. Restore it from the Archived view.`)
  },
  restore: (session: SessionSummary) => sessions().update(session.id, { archived: false }),
  async toggleUnread(session: SessionSummary): Promise<void> {
    await sessions().update(session.id, { unread: !session.unread })
  },
  fork: (session: SessionSummary) => sessions().fork(session.id),
  async export(session: SessionSummary): Promise<void> {
    try {
      const target = await api.agent.export(session.id)
      if (target) ui().notify('success', `Exported to ${target}`)
    } catch (error) {
      ui().notify('error', `Could not export: ${(error as Error).message}`)
    }
  },
  async remove(session: SessionSummary): Promise<void> {
    const ok = await ui().askConfirm({
      title: 'Delete this session?',
      body: `“${session.title}” and everything in it will be deleted. This cannot be undone. Archive it instead to keep it out of the way.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) await sessions().remove(session.id)
  },
  async moveToProject(session: SessionSummary, root: string | null): Promise<void> {
    await sessions().update(session.id, { projectRoot: root })
  },
}

function withActive(run: (session: SessionSummary) => void | Promise<void>): () => void {
  return () => {
    const session = activeSession()
    if (session) void run(session)
  }
}

function createAppActions(): AppActions {
  const go = (id: string | undefined) => {
    if (id) void sessions().select(id)
  }
  return {
    activeSession,
    hasWorkspace: () => useWorkspace.getState().workspace !== null,
    canGoBack: () => sessions().canGoBack(),
    canGoForward: () => sessions().canGoForward(),

    newSession: () => void sessions().newSession(),
    openFolder: () => void useWorkspace.getState().openDialog(),
    quickOpen: () => ui().setQuickOpenOpen(true),
    save: () => void useEditor.getState().saveActive(),
    openSettings: () => ui().setSettingsOpen(true),
    quit: () => void api.window.close(),

    edit: (command) => {
      try {
        document.execCommand(command)
      } catch {
        /* the focused element may not support it */
      }
    },
    searchInFiles: () => panels().open('files', { view: 'search' }),

    toggleSidebar: () => ui().toggleSidebar(),
    toggleSidePanel: () => panels().toggleHidden(),
    toggleBottomPanel: () => panels().toggleBottom(),
    showActivity: () => ui().setSidebarMode(ui().sidebarMode === 'activity' ? 'projects' : 'activity'),
    showChat: () => {
      // A full-width side panel covers the thread.
      if (panels().side.layout === 'full') panels().setLayout('split')
      document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()
    },
    showFiles: () => panels().open('files', { view: 'explorer' }),
    showReview: () => panels().open('review'),
    showTerminal: () => panels().openBottom('terminal'),
    zoom: (action) => void api.window.zoom(action),
    toggleFullScreen: () => void api.window.toggleFullScreen(),
    showPalette: () => ui().setPaletteOpen(true),
    theme: () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
    toggleTheme: () => {
      const settings = useSettings.getState()
      const appearance = settings.settings?.appearance
      if (!appearance) return
      const light = document.documentElement.dataset.theme === 'light'
      void settings.save({ appearance: { ...appearance, mode: light ? 'dark' : 'light' } })
    },
    showPlugins: () => ui().setPluginsOpen(true),
    showAutomations: () => ui().setAutomationOpen(true),

    renameSession: withActive(sessionActions.rename),
    togglePin: withActive(sessionActions.togglePin),
    archiveSession: withActive(sessionActions.archive),
    markUnread: withActive(sessionActions.toggleUnread),
    forkSession: withActive(sessionActions.fork),
    exportSession: withActive(sessionActions.export),
    deleteSession: withActive(sessionActions.remove),
    back: () => void sessions().back(),
    forward: () => void sessions().forward(),
    nextRecent: () => go(adjacentRecent(sessions().sessions, sessions().activeId, 1)),
    previousRecent: () => go(adjacentRecent(sessions().sessions, sessions().activeId, -1)),
    nextAttention: () => {
      const id = nextAttention(sessions().sessions, useStatus.getState().statusById, sessions().activeId)
      if (id) go(id)
      else ui().notify('info', 'No other session is waiting for you.')
    },
    goToSession: (position) => go(sidebarOrder()[position - 1]),

    isRunning: agentActions.isRunning,
    inPlanMode: agentActions.inPlanMode,
    togglePlan: agentActions.togglePlan,
    setGoal: () => void agentActions.setGoal(),
    compact: () => void agentActions.compact(),
    stop: agentActions.stop,
    chooseModel: () => agentActions.openMenu('model'),
    chooseEffort: () => agentActions.chooseEffort(),
    choosePermissions: () => agentActions.openMenu('policy'),
    reviewLastTurn: agentActions.reviewLastTurn,
    askReviewer: () => void agentActions.askReviewer(),
    canUndo: agentActions.canUndo,
    undoLastTurn: agentActions.undo,
    canRewind: agentActions.canRewind,
    rewind: agentActions.rewind,
    showStatus: () => ui().setStatusOpen(true),
    writeInstructions: agentActions.writeInstructions,

    canClosePanelTab: () => panels().side.layout !== 'hidden' && panels().side.tabs.length > 0,
    canReopenPanelTab: () => panels().side.closed.length > 0,
    newPanelTab: () => panels().open('new'),
    closePanelTab: () => {
      const id = panels().side.activeId
      if (id) panels().close(id)
    },
    reopenPanelTab: () => panels().reopen(),
    stepPanelTab: (direction) => panels().step(direction),
    goToPanelTab: (position) => {
      if (panels().side.layout === 'hidden') return
      panels().activateAt(position - 1)
    },
    cyclePanelLayout: () => panels().cycleLayout(),
    toggleFullPanel: () => panels().toggleFull(),

    showShortcuts: () => ui().setShortcutsOpen(true),
    showAbout: () => ui().setAboutOpen(true),
    feedback: () => void agentActions.feedback(),
    saveDiagnostics: () => void helpActions.saveDiagnostics(),
    showLogs: () => void helpActions.showLogs(),
  }
}

export const commandRegistry = new CommandRegistry()
commandRegistry.register(...buildCommands(createAppActions()))
