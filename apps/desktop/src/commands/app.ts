/**
 * The app's commands, bound to the real stores. Importing this module
 * registers them; the title bar menus, the keymap and the shortcut list all
 * read `commandRegistry`.
 */
import { inlineState } from '@shared/inline'
import type { SessionSummary, Settings } from '@shared/types'
import { api } from '../api'
import { canReportIssue, hasShownEditor, runEditorCommand } from '../editor/surface'
import { getActiveSessionId } from '../stores/active'
import { useChat } from '../stores/chat'
import { useDebug } from '../stores/debug'
import { currentRun, toolbarMode } from '../panels/debug'
import { useEditor } from '../stores/editor'
import { focusBreadcrumbs, useEditorLayout } from '../stores/editor-layout'
import { useFind } from '../stores/find'
import { usePanels } from '../stores/panels'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useStatus } from '../stores/status'
import { adjacentRecent, buildSidebar, nextAttention, placeRecents, visibleOrder } from '../stores/sidebar-model'
import { useUi, type TurnReportTarget } from '../stores/ui'
import { useRemote } from '../stores/remote'
import { useWorkspace } from '../stores/workspace'
import { agentActions } from './agent'
import { buildCommands, type AppActions } from './commands'
import { CommandRegistry, type Command } from './registry'
import { errorText } from '../ipc-error'

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
      ui().notify('error', `Could not save diagnostics: ${errorText(error)}`)
    }
  },
  async showLogs(): Promise<void> {
    try {
      await api.app.openLogs()
    } catch (error) {
      ui().notify('error', `Could not open the log folder: ${errorText(error)}`)
    }
  },
}

/** Session ids in the order the sidebar lists them, for Alt+1 to Alt+9. */
function sidebarOrder(): string[] {
  const model = buildSidebar(sessions().sessions, {
    workspaceRoot: useWorkspace.getState().workspace?.root ?? null,
    recentRoots: placeRecents(useSettings.getState().settings?.recentWorkspaces ?? [], useWorkspace.getState().workspace),
    chatsFolder: useSettings.getState().settings?.chatsFolder,
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
    ui().notify('info', `Archived “${session.title}”.`, { label: 'Undo', run: () => void sessionActions.restore(session) })
  },
  restore: (session: SessionSummary) => sessions().update(session.id, { archived: false }),
  async toggleUnread(session: SessionSummary): Promise<void> {
    await sessions().update(session.id, { unread: !session.unread })
  },
  fork: (session: SessionSummary) => sessions().fork(session.id),
  /** A side chat of the session (ADR 0104), with a first question or none. */
  side: (session: SessionSummary, question?: string) => usePanels.getState().openSideChat(session.id, question),
  async export(session: SessionSummary): Promise<void> {
    try {
      const target = await api.agent.export(session.id)
      if (target) ui().notify('success', `Exported to ${target}`)
    } catch (error) {
      ui().notify('error', `Could not export: ${errorText(error)}`)
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

const files = (count: number) => (count === 1 ? 'one file' : `${count} files`)

/**
 * A session's worktree from the chat (ADR 0105): work in a new one, in the project folder again, remove it, or copy
 * what it changed into the project folder. Each says what happened, or why not.
 */
export const worktreeActions = {
  async enter(session: SessionSummary, name?: string): Promise<void> {
    try {
      const outcome = await api.agent.worktree(session.id, { action: 'enter', ...(name ? { name } : {}) })
      if (!outcome.ok) ui().notify('error', outcome.error)
      else if (outcome.worktree) ui().notify('success', `This session works in the worktree ${outcome.worktree.name} now, on the branch ${outcome.worktree.branch}. Your checkout stays as it is.`)
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },
  async leave(session: SessionSummary): Promise<void> {
    try {
      const outcome = await api.agent.worktree(session.id, { action: 'leave' })
      if (!outcome.ok) ui().notify('error', outcome.error)
      else ui().notify('success', `This session works in the project folder again. The worktree ${session.worktree ?? ''} stays; /worktree makes a new one.`.replace('  ', ' '))
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },
  async remove(session: SessionSummary): Promise<void> {
    try {
      let outcome = await api.agent.worktree(session.id, { action: 'remove' })
      if (!outcome.ok && outcome.work) {
        const { changed, commits } = outcome.work
        const holds = [changed.length ? `${files(changed.length)} not committed` : '', commits ? `${commits === 1 ? 'one commit' : `${commits} commits`} no other branch has` : ''].filter(Boolean).join(' and ')
        const ok = await ui().askConfirm({
          title: 'Remove the worktree with its work?',
          body: `The worktree ${session.worktree ?? ''} holds ${holds}. Removing it deletes them. Bring its changes into the project first to keep them.`,
          confirmLabel: 'Remove',
          danger: true,
        })
        if (!ok) return
        outcome = await api.agent.worktree(session.id, { action: 'remove', discard: true })
      }
      if (!outcome.ok) ui().notify('error', outcome.error)
      else ui().notify('success', 'The worktree was removed. This session works in the project folder again.')
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },
  async bring(session: SessionSummary): Promise<void> {
    try {
      let outcome = await api.agent.worktree(session.id, { action: 'bring' })
      if (!outcome.ok && outcome.conflicts?.length) {
        const shown = outcome.conflicts.slice(0, 5).join(', ') + (outcome.conflicts.length > 5 ? ` and ${outcome.conflicts.length - 5} more` : '')
        const ok = await ui().askConfirm({
          title: 'Write over your changes?',
          body: `You changed ${shown} in the project after the worktree was made. Bringing the worktree's changes in writes over yours.`,
          confirmLabel: 'Write over them',
          danger: true,
        })
        if (!ok) return
        outcome = await api.agent.worktree(session.id, { action: 'bring', force: true })
      }
      if (!outcome.ok) ui().notify('error', outcome.error)
      else if (!outcome.files?.length) ui().notify('info', 'The worktree has no change the project folder does not have already.')
      else ui().notify('success', `Brought ${files(outcome.files.length)} into the project folder. The worktree keeps its own copy.`)
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },
}

/** Words selected in the thread, which Ctrl+F looks for: one line, and not a whole page. */
function threadSelection(): string | undefined {
  const selection = window.getSelection()
  const text = selection?.toString().trim() ?? ''
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return undefined
  const node = selection?.anchorNode
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest('.thread') ? text : undefined
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
    newChat: () => void sessions().newChat(),
    openFolder: () => void useWorkspace.getState().openDialog(),
    openRemote: () => useRemote.getState().show(),
    quickOpen: (query) => ui().setQuickOpenOpen(true, query),
    save: () => {
      // Out of habit, on the Settings page: it keeps each change as it is made.
      if (ui().settingsOpen) ui().notify('info', 'Settings are kept as you change them.')
      else void useEditor.getState().saveActive()
    },
    openSettings: () => ui().setSettingsOpen(true),
    quit: () => void api.window.close(),

    edit: (command) => {
      try {
        document.execCommand(command)
      } catch {
        /* the focused element may not support it */
      }
    },
    hasEditor: () => hasShownEditor(),
    editorCommand: (name) => void runEditorCommand(name),
    editorLayout: () => useEditorLayout.getState(),
    toggleEditorPart: (part) => {
      const layout = useEditorLayout.getState()
      layout.set({ [part]: !layout[part] })
    },
    inlineSuggestOn: () => {
      const settings = useSettings.getState().settings
      return settings ? inlineState(settings).on : false
    },
    toggleInlineSuggest: () => {
      const store = useSettings.getState()
      const settings = store.settings
      if (!settings) return
      if (inlineState(settings).on) {
        void store.save({ inlineSuggest: 'off' })
        return
      }
      void store.save({ inlineSuggest: 'on' })
      // Still off with them on (no model, or none the settings let answer): Settings > Editor says why.
      if (!inlineState({ ...settings, inlineSuggest: 'on' }).on) ui().openSettings('editor', 'editor.inlineSuggest')
    },
    focusBreadcrumbs: () => {
      const layout = useEditorLayout.getState()
      if (!layout.breadcrumbs) layout.set({ breadcrumbs: true })
      focusBreadcrumbs()
    },
    searchInFiles: () => panels().open('files', { view: 'search' }),
    canFind: () => ui().settingsOpen || panels().side.layout !== 'full',
    isFinding: () => useFind.getState().open,
    find: () => {
      // On the Settings page, Ctrl+F goes to its search.
      const search = ui().settingsOpen ? document.querySelector<HTMLInputElement>('.settings-search-input') : null
      if (search) {
        search.focus()
        search.select()
      } else useFind.getState().show(threadSelection())
    },
    findStep: (direction) => useFind.getState().move(direction),

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
    showProblems: () => panels().openBottom('problems'),
    showDebug: () => panels().openBottom('debug'),
    debugMode: () => {
      const { state, frame } = useDebug.getState()
      return toolbarMode(currentRun(state, frame))
    },
    debugContinue: () => void useDebug.getState().continueOrStart(),
    debugAct: (action) => void useDebug.getState().act(action),
    toggleBreakpoint: () => {
      const { activePath, cursor } = useEditor.getState()
      if (activePath) useDebug.getState().toggleBreakpoint(activePath, cursor.line)
    },
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
    showSkills: () => ui().openSettings('skills'),
    showAutomations: () => ui().setAutomationOpen(true),

    renameSession: withActive(sessionActions.rename),
    togglePin: withActive(sessionActions.togglePin),
    archiveSession: withActive(sessionActions.archive),
    markUnread: withActive(sessionActions.toggleUnread),
    forkSession: withActive(sessionActions.fork),
    sideChat: withActive((session) => void sessionActions.side(session)),
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

    showShortcuts: () => ui().openSettings('shortcuts'),
    showAbout: () => ui().setAboutOpen(true),
    feedback: () => void agentActions.feedback(),
    saveDiagnostics: () => void helpActions.saveDiagnostics(),
    canReportEditorIssue: () => canReportIssue(useEditor.getState().activePath),
    reportEditorIssue: () => {
      const path = useEditor.getState().activePath
      if (canReportIssue(path)) ui().setEditorIssueFor(path)
    },
    canReportTurn: () => lastRequest() !== null,
    reportTurn: () => {
      const target = lastRequest()
      if (target) ui().setTurnReportFor(target)
    },
    showLogs: () => void helpActions.showLogs(),
  }
}

/** The shown session's last request, unless it is still running. */
function lastRequest(): TurnReportTarget | null {
  const { entries, running } = useChat.getState()
  const sessionId = getActiveSessionId()
  if (running || !sessionId) return null
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.kind === 'user') return { sessionId, turn: entry.id, text: entry.text ?? '' }
  }
  return null
}

/**
 * Commands that run over the Settings page: the palette, the page itself, the window (zoom, full screen, theme, quit),
 * the field that has the focus (Edit) and Help. Every other one closes the page first, so what it does shows.
 */
const OVER_SETTINGS = /^(app\.(palette|settings|quit)|file\.save|view\.(zoom|fullScreen|theme)|edit\.|help\.)/

function closingSettings(command: Command): Command {
  if (OVER_SETTINGS.test(command.id)) return command
  return {
    ...command,
    run: () => {
      if (ui().settingsOpen) ui().setSettingsOpen(false)
      return command.run()
    },
  }
}

export const commandRegistry = new CommandRegistry()
commandRegistry.register(...buildCommands(createAppActions()).map(closingSettings))

// The person's own shortcuts apply as soon as the settings load, and whenever they change.
let appliedKeybindings: Settings['keybindings'] | undefined
useSettings.subscribe(() => {
  const keybindings = useSettings.getState().settings?.keybindings
  if (!keybindings || keybindings === appliedKeybindings) return
  appliedKeybindings = keybindings
  commandRegistry.setOverrides(keybindings)
})
