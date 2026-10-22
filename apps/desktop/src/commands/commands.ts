/**
 * Every command eNCode has, built from the actions the app provides, so the
 * menus, the shortcut list and the keymap read one definition (and tests can
 * build them without Electron).
 */
import type { SessionSummary, ZoomAction } from '@shared/types'
import type { Command } from './registry'

export const GROUPS = ['File', 'Edit', 'View', 'Session', 'Help'] as const

export interface AppActions {
  activeSession(): SessionSummary | undefined
  hasWorkspace(): boolean
  canGoBack(): boolean
  canGoForward(): boolean

  newSession(): void
  openFolder(): void
  quickOpen(): void
  save(): void
  openSettings(): void
  quit(): void

  edit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void
  searchInFiles(): void

  toggleSidebar(): void
  toggleSidePanel(): void
  toggleBottomPanel(): void
  showActivity(): void
  showChat(): void
  showFiles(): void
  showReview(): void
  showTerminal(): void
  zoom(action: ZoomAction): void
  toggleFullScreen(): void
  showPalette(): void
  /** The theme on screen now: a System theme is shown as what it resolved to. */
  theme(): 'light' | 'dark'
  toggleTheme(): void
  showPlugins(): void
  showAutomations(): void

  renameSession(): void
  togglePin(): void
  archiveSession(): void
  markUnread(): void
  forkSession(): void
  exportSession(): void
  deleteSession(): void
  back(): void
  forward(): void
  nextRecent(): void
  previousRecent(): void
  nextAttention(): void
  goToSession(position: number): void

  /** The agent in the open session. */
  isRunning(): boolean
  inPlanMode(): boolean
  togglePlan(): void
  setGoal(): void
  compact(): void
  stop(): void
  chooseModel(): void
  choosePermissions(): void
  reviewLastTurn(): void
  canUndo(): boolean
  undoLastTurn(): void
  canRewind(): boolean
  rewind(): void
  showStatus(): void
  writeInstructions(): void

  /** The side panel's tabs: a tab is open to close, one was closed to bring back. */
  canClosePanelTab(): boolean
  canReopenPanelTab(): boolean
  newPanelTab(): void
  closePanelTab(): void
  reopenPanelTab(): void
  stepPanelTab(direction: 1 | -1): void
  goToPanelTab(position: number): void
  cyclePanelLayout(): void
  toggleFullPanel(): void

  showShortcuts(): void
  showAbout(): void
  feedback(): void
  saveDiagnostics(): void
  showLogs(): void
}

export function buildCommands(a: AppActions): Command[] {
  const hasSession = () => a.activeSession() !== undefined
  const session: Pick<Command, 'group' | 'enabled'> = { group: 'Session', enabled: hasSession }
  // Copy, Paste and the like act on the field that had focus: the palette has nothing to give them.
  const edit: Pick<Command, 'group' | 'palette'> = { group: 'Edit', palette: false }

  const commands: Command[] = [
    { id: 'file.newSession', title: 'New session', group: 'File', keys: ['Ctrl+N'], run: () => a.newSession() },
    { id: 'file.openFolder', title: 'Open folder…', group: 'File', keys: ['Ctrl+O'], run: () => a.openFolder() },
    { id: 'file.quickOpen', title: 'Go to file…', group: 'File', keys: ['Ctrl+P'], enabled: () => a.hasWorkspace(), run: () => a.quickOpen() },
    { id: 'file.save', title: 'Save', group: 'File', keys: ['Ctrl+S'], run: () => a.save() },
    { id: 'app.settings', title: 'Settings…', group: 'File', keys: ['Ctrl+,'], run: () => a.openSettings() },
    { id: 'app.quit', title: 'Quit eNCode', group: 'File', keys: ['Ctrl+Q'], global: true, run: () => a.quit() },

    { id: 'edit.undo', title: 'Undo', hint: 'Ctrl+Z', run: () => a.edit('undo'), ...edit },
    { id: 'edit.redo', title: 'Redo', hint: 'Ctrl+Y', run: () => a.edit('redo'), ...edit },
    { id: 'edit.cut', title: 'Cut', hint: 'Ctrl+X', run: () => a.edit('cut'), ...edit },
    { id: 'edit.copy', title: 'Copy', hint: 'Ctrl+C', run: () => a.edit('copy'), ...edit },
    { id: 'edit.paste', title: 'Paste', hint: 'Ctrl+V', run: () => a.edit('paste'), ...edit },
    { id: 'edit.selectAll', title: 'Select all', hint: 'Ctrl+A', run: () => a.edit('selectAll'), ...edit },
    {
      id: 'edit.searchInFiles',
      title: 'Search in files',
      group: 'Edit',
      keys: ['Ctrl+Shift+F'],
      enabled: () => a.hasWorkspace(),
      run: () => a.searchInFiles(),
    },

    {
      id: 'app.palette',
      title: 'Command palette…',
      group: 'View',
      keys: ['Ctrl+K', 'Ctrl+Shift+P'],
      palette: false,
      run: () => a.showPalette(),
    },
    { id: 'view.sidebar', title: 'Toggle sidebar', group: 'View', keys: ['Ctrl+B', 'Ctrl+Shift+S'], run: () => a.toggleSidebar() },
    { id: 'view.sidePanel', title: 'Toggle side panel', group: 'View', keys: ['Ctrl+Alt+B'], run: () => a.toggleSidePanel() },
    { id: 'view.bottomPanel', title: 'Toggle bottom panel', group: 'View', keys: ['Ctrl+J'], run: () => a.toggleBottomPanel() },
    { id: 'view.activity', title: 'Activity view', group: 'View', keys: ['Ctrl+Alt+U'], run: () => a.showActivity() },
    { id: 'view.chat', title: 'Show chat', group: 'View', keys: ['Ctrl+Shift+X'], run: () => a.showChat() },
    { id: 'view.files', title: 'Show files', group: 'View', keys: ['Ctrl+Shift+E'], enabled: () => a.hasWorkspace(), run: () => a.showFiles() },
    { id: 'view.review', title: 'Show review', group: 'View', keys: ['Ctrl+Shift+G'], enabled: () => a.hasWorkspace(), run: () => a.showReview() },
    { id: 'view.terminal', title: 'Show terminal', group: 'View', keys: ['Ctrl+`'], run: () => a.showTerminal() },
    { id: 'view.plugins', title: 'Plugins and skills', group: 'View', keywords: 'skills providers', run: () => a.showPlugins() },
    { id: 'view.automations', title: 'Automations', group: 'View', keywords: 'scheduled tasks later every', run: () => a.showAutomations() },
    { id: 'panel.newTab', title: 'New tab', group: 'View', keys: ['Ctrl+T'], run: () => a.newPanelTab() },
    { id: 'panel.closeTab', title: 'Close tab', group: 'View', keys: ['Ctrl+W'], enabled: () => a.canClosePanelTab(), run: () => a.closePanelTab() },
    { id: 'panel.reopenTab', title: 'Reopen closed tab', group: 'View', keys: ['Ctrl+Shift+T'], enabled: () => a.canReopenPanelTab(), run: () => a.reopenPanelTab() },
    { id: 'panel.nextTab', title: 'Next tab', group: 'View', keys: ['Ctrl+Shift+]'], run: () => a.stepPanelTab(1) },
    { id: 'panel.prevTab', title: 'Previous tab', group: 'View', keys: ['Ctrl+Shift+['], run: () => a.stepPanelTab(-1) },
    { id: 'panel.cycle', title: 'Cycle side panel layout', group: 'View', keys: ['Ctrl+Shift+B'], run: () => a.cyclePanelLayout() },
    { id: 'panel.full', title: 'Side panel full width', group: 'View', keys: ['Ctrl+Alt+F'], run: () => a.toggleFullPanel() },
    {
      id: 'view.theme',
      title: 'Switch theme',
      label: () => (a.theme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme'),
      group: 'View',
      keywords: 'appearance dark light mode colours colors',
      run: () => a.toggleTheme(),
    },
    { id: 'view.zoomIn', title: 'Zoom in', group: 'View', keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+Plus'], global: true, run: () => a.zoom('in') },
    { id: 'view.zoomOut', title: 'Zoom out', group: 'View', keys: ['Ctrl+-'], global: true, run: () => a.zoom('out') },
    { id: 'view.zoomReset', title: 'Actual size', group: 'View', keys: ['Ctrl+0'], global: true, run: () => a.zoom('reset') },
    { id: 'view.fullScreen', title: 'Full screen', group: 'View', keys: ['F11'], global: true, run: () => a.toggleFullScreen() },

    { id: 'session.rename', title: 'Rename session', keys: ['Ctrl+Alt+R'], run: () => a.renameSession(), ...session },
    {
      id: 'session.pin',
      title: 'Pin or unpin session',
      label: () => (a.activeSession()?.pinned ? 'Unpin session' : 'Pin session'),
      keys: ['Ctrl+Alt+P'],
      run: () => a.togglePin(),
      ...session,
    },
    { id: 'session.archive', title: 'Archive session', keys: ['Ctrl+Shift+A'], run: () => a.archiveSession(), ...session },
    { id: 'session.unread', title: 'Mark as unread', keys: ['Ctrl+Shift+U'], run: () => a.markUnread(), ...session },
    { id: 'session.fork', title: 'Fork session', run: () => a.forkSession(), ...session },
    { id: 'session.export', title: 'Export session…', run: () => a.exportSession(), ...session },
    { id: 'session.delete', title: 'Delete session…', run: () => a.deleteSession(), ...session },
    {
      id: 'agent.plan',
      title: 'Plan mode',
      label: () => (a.inPlanMode() === true ? 'Leave plan mode' : 'Plan mode'),
      hint: 'Shift+Tab',
      keywords: 'plan first and ask before building',
      run: () => a.togglePlan(),
      ...session,
    },
    { id: 'agent.goal', title: 'Set a goal…', keywords: 'objective long task', run: () => a.setGoal(), ...session },
    { id: 'agent.model', title: 'Choose model…', group: 'Session', keys: ['Alt+M'], keywords: 'models provider builder', run: () => a.chooseModel() },
    { id: 'agent.permissions', title: 'Choose permissions…', group: 'Session', keywords: 'approval policy access ask', run: () => a.choosePermissions() },
    { id: 'agent.compact', title: 'Compact the conversation', keywords: 'context summary free up', run: () => a.compact(), ...session },
    { id: 'agent.stop', title: 'Stop the agent', group: 'Session', keywords: 'cancel interrupt', enabled: () => a.isRunning() === true, run: () => a.stop() },
    {
      id: 'agent.reviewTurn',
      title: 'Review the last turn',
      group: 'Session',
      keywords: 'changes diff agent request',
      enabled: () => a.hasWorkspace(),
      run: () => a.reviewLastTurn(),
    },
    { id: 'agent.undo', title: 'Undo the last turn…', group: 'Session', keywords: 'revert changes files', enabled: () => a.canUndo() === true, run: () => a.undoLastTurn() },
    { id: 'agent.rewind', title: 'Rewind…', group: 'Session', keywords: 'go back earlier message restore', enabled: () => a.canRewind() === true, run: () => a.rewind() },
    { id: 'agent.status', title: 'Session status', group: 'Session', keywords: 'context tokens usage model', run: () => a.showStatus() },
    {
      id: 'agent.init',
      title: 'Write project instructions',
      group: 'Session',
      keywords: 'init agents.md encode.md',
      enabled: () => a.hasWorkspace(),
      run: () => a.writeInstructions(),
    },
    { id: 'session.back', title: 'Back', group: 'Session', keys: ['Ctrl+['], enabled: () => a.canGoBack(), run: () => a.back() },
    { id: 'session.forward', title: 'Forward', group: 'Session', keys: ['Ctrl+]'], enabled: () => a.canGoForward(), run: () => a.forward() },
    { id: 'session.nextRecent', title: 'Next recent session', group: 'Session', keys: ['Ctrl+Tab'], run: () => a.nextRecent() },
    { id: 'session.prevRecent', title: 'Previous recent session', group: 'Session', keys: ['Ctrl+Shift+Tab'], run: () => a.previousRecent() },
    { id: 'session.attention', title: 'Next session that needs you', group: 'Session', keys: ['Ctrl+Alt+A'], run: () => a.nextAttention() },

    { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', keys: ['Ctrl+/'], run: () => a.showShortcuts() },
    { id: 'help.feedback', title: 'Send feedback…', group: 'Help', run: () => a.feedback() },
    { id: 'help.diagnostics', title: 'Save diagnostics…', group: 'Help', run: () => a.saveDiagnostics() },
    { id: 'help.logs', title: 'Show log files', group: 'Help', run: () => a.showLogs() },
    { id: 'help.about', title: 'About eNCode', group: 'Help', run: () => a.showAbout() },
  ]

  for (let position = 1; position <= 9; position++) {
    commands.push({
      id: `session.go${position}`,
      title: `Go to session ${position}`,
      group: 'Session',
      keys: [`Alt+${position}`],
      hidden: true,
      run: () => a.goToSession(position),
    })
    commands.push({
      id: `panel.tab${position}`,
      title: `Go to tab ${position}`,
      group: 'View',
      keys: [`Ctrl+${position}`],
      hidden: true,
      run: () => a.goToPanelTab(position),
    })
  }
  return commands
}
