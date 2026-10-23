/**
 * Every command eNCode has, built from the actions the app provides, so the
 * menus, the shortcut list and the keymap read one definition (and tests can
 * build them without Electron).
 */
import type { SessionSummary, ZoomAction } from '@shared/types'
import type { EditorPart } from '../stores/editor-layout'
import type { Command } from './registry'

export const GROUPS = ['File', 'Edit', 'View', 'Go', 'Session', 'Help'] as const

export interface AppActions {
  activeSession(): SessionSummary | undefined
  hasWorkspace(): boolean
  canGoBack(): boolean
  canGoForward(): boolean

  newSession(): void
  /** A session that belongs to no project, in the chats folder. */
  newChat(): void
  openFolder(): void
  /** Go to file; '@' starts it on the file's symbols, '#' on the folder's. */
  quickOpen(query?: string): void
  save(): void
  openSettings(): void
  quit(): void

  edit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void
  /** The code editor shows a file, so its commands (Go to definition) have something to act on. */
  hasEditor(): boolean
  /** Runs one of the code editor's commands, as its key would. */
  editorCommand(name: string): void
  /**
   * Which of the editor's parts are on: the breadcrumbs, the outline, folding, sticky scroll, bracket colours, the
   * minimap, inlay hints, semantic colours, word wrap and its indent, and every space shown.
   */
  editorLayout(): Record<EditorPart, boolean>
  toggleEditorPart(part: EditorPart): void
  /** The keyboard to the breadcrumbs, shown first if they were hidden. */
  focusBreadcrumbs(): void
  searchInFiles(): void
  /** Find in the open session: the thread is on screen, not under a full-width panel. */
  canFind(): boolean
  /** The find bar is open. */
  isFinding(): boolean
  find(): void
  findStep(direction: 1 | -1): void

  toggleSidebar(): void
  toggleSidePanel(): void
  toggleBottomPanel(): void
  showActivity(): void
  showChat(): void
  showFiles(): void
  showReview(): void
  showTerminal(): void
  /** The Problems panel: what the language servers found in the folder's files. */
  showProblems(): void
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
  chooseEffort(): void
  choosePermissions(): void
  reviewLastTurn(): void
  askReviewer(): void
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

/**
 * What the language servers add to the editor, in the palette too. The editor binds their keys itself (they mean
 * something only there), so the palette shows them as hints.
 */
function editorCommands(a: AppActions): Command[] {
  const command = (id: string, title: string, name: string, hint: string | undefined, keywords: string, group: Command['group'] = 'Go'): Command => ({
    id: `editor.${id}`,
    title,
    group,
    ...(hint ? { hint } : {}),
    keywords,
    enabled: () => a.hasEditor(),
    run: () => a.editorCommand(name),
  })
  // Folding commands, in the View menu as the editor's own keys: they act only while folding is on.
  const fold = (name: string, title: string, hint: string | undefined, keywords: string): Command => ({
    ...command(name, title, name, hint, keywords, 'View'),
    enabled: () => a.hasEditor() && a.editorLayout().folding,
  })
  return [
    command('rename', 'Rename symbol', 'renameSymbol', 'F2', 'code refactor rename across files', 'Edit'),
    command('quickFix', 'Quick fix…', 'quickFix', 'Ctrl+.', 'code action lightbulb fix error problem', 'Edit'),
    command('refactor', 'Refactor…', 'refactor', 'Ctrl+Shift+R', 'code action extract move inline', 'Edit'),
    command('sourceAction', 'Source action…', 'sourceAction', undefined, 'code action file imports', 'Edit'),
    command('organizeImports', 'Organize imports', 'organizeImports', 'Shift+Alt+O', 'code sort remove unused imports', 'Edit'),
    command('fixAll', 'Fix all', 'fixAll', undefined, 'code action auto fix problems file', 'Edit'),
    command('formatDocument', 'Format document', 'formatDocument', 'Shift+Alt+F', 'code prettier beautify indent style', 'Edit'),
    command('formatSelection', 'Format selection', 'formatSelection', undefined, 'code prettier beautify indent style range line', 'Edit'),
    command('nextProblem', 'Next problem', 'nextProblem', 'F8', 'code error warning diagnostic marker'),
    command('previousProblem', 'Previous problem', 'previousProblem', 'Shift+F8', 'code error warning diagnostic marker'),
    command('goToDefinition', 'Go to definition', 'goToDefinition', 'F12', 'code symbol declaration jump navigate'),
    command('peekDefinition', 'Peek definition', 'peekDefinition', 'Alt+F12', 'code symbol declaration inline'),
    command('goToReferences', 'Go to references', 'goToReferences', 'Shift+F12', 'code symbol usages find all callers'),
    command('goToImplementation', 'Go to implementation', 'goToImplementation', 'Ctrl+F12', 'code symbol interface implementations'),
    command('goToTypeDefinition', 'Go to type definition', 'goToTypeDefinition', undefined, 'code symbol type'),
    command('callHierarchy', 'Show call hierarchy', 'callHierarchy', 'Shift+Alt+H', 'code callers calls incoming outgoing who calls function'),
    command('triggerSuggest', 'Show suggestions', 'triggerSuggest', 'Ctrl+Space', 'code completion autocomplete intellisense'),
    command('parameterHints', 'Show parameter hints', 'triggerParameterHints', 'Ctrl+Shift+Space', 'code signature arguments call'),
    command('navigateBack', 'Go back in the editor', 'navigateBack', 'Alt+Left', 'code navigate previous location'),
    command('navigateForward', 'Go forward in the editor', 'navigateForward', 'Alt+Right', 'code navigate next location'),
    fold('fold', 'Fold', 'Ctrl+Shift+[', 'code collapse block region hide'),
    fold('unfold', 'Unfold', 'Ctrl+Shift+]', 'code expand block region show'),
    fold('foldAll', 'Fold all', 'Ctrl+Alt+[', 'code collapse every block'),
    fold('unfoldAll', 'Unfold all', 'Ctrl+Alt+]', 'code expand every block'),
    ...(
      [
        ['toggleFold', 'Toggle fold', 'code collapse expand block'],
        ['foldRecursively', 'Fold recursively', 'code collapse block and every block in it'],
        ['unfoldRecursively', 'Unfold recursively', 'code expand block and every block in it'],
        ['foldAllComments', 'Fold all block comments', 'code collapse comments docs'],
        ['foldAllRegions', 'Fold all regions', 'code collapse #region markers'],
        ['unfoldAllRegions', 'Unfold all regions', 'code expand #region markers'],
        ['foldImports', 'Fold imports', 'code collapse import require using'],
        ...[1, 2, 3, 4, 5, 6, 7].map((level) => [`foldLevel${level}`, `Fold level ${level}`, `code collapse depth nesting ${level}`]),
      ] as const
    ).map(([name, title, keywords]): Command => ({ ...fold(name, title, undefined, keywords), menu: false })),
    {
      id: 'editor.goToSymbol',
      title: 'Go to symbol in file…',
      group: 'Go',
      keys: ['Ctrl+Shift+O'],
      keywords: 'code outline function class method jump @',
      enabled: () => a.hasEditor(),
      run: () => a.quickOpen('@'),
    },
    {
      id: 'editor.goToFolderSymbol',
      title: 'Go to symbol in folder…',
      group: 'Go',
      keys: ['Ctrl+Alt+T'],
      keywords: 'code workspace project function class search #',
      enabled: () => a.hasWorkspace(),
      run: () => a.quickOpen('#'),
    },
    {
      id: 'editor.focusBreadcrumbs',
      title: 'Focus breadcrumbs',
      group: 'Go',
      keys: ['Ctrl+Shift+.'],
      keywords: 'code path symbols navigation bar',
      enabled: () => a.hasEditor(),
      run: () => a.focusBreadcrumbs(),
    },
  ]
}

export function buildCommands(a: AppActions): Command[] {
  const hasSession = () => a.activeSession() !== undefined
  const session: Pick<Command, 'group' | 'enabled'> = { group: 'Session', enabled: hasSession }
  // Copy, Paste and the like act on the field that had focus: the palette has nothing to give them.
  const edit: Pick<Command, 'group' | 'palette'> = { group: 'Edit', palette: false }

  const commands: Command[] = [
    { id: 'file.newSession', title: 'New session', group: 'File', keys: ['Ctrl+N'], run: () => a.newSession() },
    { id: 'file.newChat', title: 'New chat', group: 'File', keys: ['Ctrl+Alt+O'], keywords: 'standalone session without a project conversation', run: () => a.newChat() },
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
      id: 'edit.find',
      title: 'Find in session',
      group: 'Edit',
      keys: ['Ctrl+F'],
      keywords: 'search words text conversation messages thread',
      enabled: () => a.canFind(),
      run: () => a.find(),
    },
    { id: 'edit.findNext', title: 'Find next', group: 'Edit', keys: ['F3'], palette: false, enabled: () => a.isFinding(), run: () => a.findStep(1) },
    { id: 'edit.findPrevious', title: 'Find previous', group: 'Edit', keys: ['Shift+F3'], palette: false, enabled: () => a.isFinding(), run: () => a.findStep(-1) },
    ...editorCommands(a),
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
    {
      id: 'view.problems',
      title: 'Show problems',
      group: 'View',
      keys: ['Ctrl+Shift+Y'],
      keywords: 'errors warnings diagnostics language server markers',
      run: () => a.showProblems(),
    },
    {
      id: 'view.breadcrumbs',
      title: 'Toggle breadcrumbs',
      label: () => (a.editorLayout().breadcrumbs ? 'Hide breadcrumbs' : 'Show breadcrumbs'),
      group: 'View',
      keywords: 'editor path symbols navigation bar',
      run: () => a.toggleEditorPart('breadcrumbs'),
    },
    {
      id: 'view.outline',
      title: 'Toggle outline',
      label: () => (a.editorLayout().outline ? 'Hide outline' : 'Show outline'),
      group: 'View',
      keywords: 'editor symbols structure tree functions classes',
      run: () => a.toggleEditorPart('outline'),
    },
    {
      id: 'view.folding',
      title: 'Toggle folding',
      label: () => (a.editorLayout().folding ? 'Turn folding off' : 'Turn folding on'),
      group: 'View',
      keywords: 'editor fold collapse blocks gutter chevrons',
      run: () => a.toggleEditorPart('folding'),
    },
    {
      id: 'view.stickyScroll',
      title: 'Toggle sticky scroll',
      label: () => (a.editorLayout().stickyScroll ? 'Hide sticky scroll' : 'Show sticky scroll'),
      group: 'View',
      keywords: 'editor pinned headers scope class function lines top',
      run: () => a.toggleEditorPart('stickyScroll'),
    },
    {
      id: 'view.bracketColors',
      title: 'Toggle bracket colours',
      label: () => (a.editorLayout().bracketColors ? 'Turn bracket colours off' : 'Turn bracket colours on'),
      group: 'View',
      keywords: 'editor bracket pair colorization rainbow nesting colors',
      run: () => a.toggleEditorPart('bracketColors'),
    },
    {
      id: 'view.minimap',
      title: 'Toggle minimap',
      label: () => (a.editorLayout().minimap ? 'Hide minimap' : 'Show minimap'),
      group: 'View',
      keywords: 'editor overview map scrollbar picture of the file',
      run: () => a.toggleEditorPart('minimap'),
    },
    {
      id: 'view.wordWrap',
      title: 'Toggle word wrap',
      label: () => (a.editorLayout().wordWrap ? 'Turn word wrap off' : 'Turn word wrap on'),
      group: 'View',
      keys: ['Alt+Z'],
      keywords: 'editor wrap long lines soft wrap rows fit width',
      run: () => a.toggleEditorPart('wordWrap'),
    },
    {
      id: 'view.whitespace',
      title: 'Toggle whitespace',
      label: () => (a.editorLayout().showWhitespace ? 'Hide whitespace' : 'Show whitespace'),
      group: 'View',
      keywords: 'editor render whitespace spaces tabs dots invisible characters',
      run: () => a.toggleEditorPart('showWhitespace'),
    },
    {
      id: 'view.inlayHints',
      title: 'Toggle inlay hints',
      label: () => (a.editorLayout().inlayHints ? 'Hide inlay hints' : 'Show inlay hints'),
      group: 'View',
      keywords: 'editor types parameter names hints inline annotations language server',
      run: () => a.toggleEditorPart('inlayHints'),
    },
    {
      id: 'view.semanticHighlighting',
      title: 'Toggle semantic colours',
      label: () => (a.editorLayout().semanticHighlighting ? 'Turn semantic colours off' : 'Turn semantic colours on'),
      group: 'View',
      keywords: 'editor semantic highlighting tokens colors types deprecated language server',
      run: () => a.toggleEditorPart('semanticHighlighting'),
    },
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
    { id: 'agent.effort', title: 'Choose effort…', group: 'Session', keys: ['Ctrl+Shift+M'], keywords: 'reasoning thinking effort low medium high max', run: () => a.chooseEffort() },
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
    {
      id: 'agent.askReviewer',
      title: 'Ask the Reviewer',
      group: 'Session',
      keywords: 'review code bugs check findings second opinion changes diff',
      enabled: () => a.hasWorkspace(),
      run: () => a.askReviewer(),
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
