import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionSummary } from '@shared/types'
import { GROUPS, buildCommands, type AppActions } from './commands'
import { parseChord } from './keys'
import type { MenuAction, MenuEntry } from '../ui/Menu'
import { MENUS, menuEntries } from './menus'
import { CommandRegistry } from './registry'

const none = () => undefined
const LAYOUT = {
  breadcrumbs: true,
  outline: false,
  folding: true,
  stickyScroll: true,
  bracketColors: true,
  minimap: true,
  inlayHints: true,
  semanticHighlighting: true,
  wordWrap: false,
  wrapIndent: true,
  showWhitespace: false,
  tabMovesFocus: false,
}
/** Actions that do nothing, and answer the questions about state with "no". */
function actions(patch: Partial<AppActions> = {}): AppActions {
  const base = { hasWorkspace: () => false, canGoBack: () => false, canGoForward: () => false, activeSession: () => undefined, editorLayout: () => LAYOUT, ...patch }
  return new Proxy(base as AppActions, { get: (target, name) => (name in target ? target[name as keyof AppActions] : none) })
}
function registryWith(patch: Partial<AppActions> = {}): CommandRegistry {
  const registry = new CommandRegistry()
  registry.register(...buildCommands(actions(patch)))
  return registry
}
function itemOf(entries: MenuEntry[], id: string): MenuAction {
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry || entry.kind === 'separator' || entry.kind === 'group') throw new Error(`no menu item ${id}`)
  return entry
}
const session = (patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's',
  title: 'Session',
  createdAt: 0,
  updatedAt: 0,
  projectRoot: null,
  pinned: false,
  archived: false,
  unread: false,
  preview: '',
  entryCount: 2,
  ...patch,
})

describe('the command map', () => {
  const registry = registryWith()

  it('binds no shortcut twice', () => {
    assert.deepEqual(registry.conflicts(), [])
  })

  it('writes every shortcut so that it can be read back', () => {
    for (const command of registry.all()) {
      for (const text of [...(command.keys ?? []), ...(command.hint ? [command.hint] : [])]) {
        assert.notEqual(parseChord(text), null, `${command.id}: ${text}`)
      }
    }
  })

  it('has unique ids and puts each command in a known menu', () => {
    const ids = registry.all().map((command) => command.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const command of registry.all()) assert.ok(GROUPS.includes(command.group as (typeof GROUPS)[number]), `${command.id} → ${command.group}`)
  })

  it('has Alt+1 to Alt+9 for the first nine sessions, out of the menus', () => {
    for (let n = 1; n <= 9; n++) {
      const command = registry.get(`session.go${n}`)
      assert.deepEqual(command?.keys, [`Alt+${n}`])
      assert.equal(command?.hidden, true)
    }
  })

  it('keeps the spec shortcuts where Codex has them, and search in files on Ctrl+Shift+F', () => {
    const keys = (id: string) => registry.get(id)?.keys?.[0]
    assert.equal(keys('file.newSession'), 'Ctrl+N')
    assert.equal(keys('view.sidebar'), 'Ctrl+B')
    assert.equal(keys('view.sidePanel'), 'Ctrl+Alt+B')
    assert.equal(keys('view.activity'), 'Ctrl+Alt+U')
    assert.equal(keys('session.back'), 'Ctrl+[')
    assert.equal(keys('session.forward'), 'Ctrl+]')
    assert.equal(keys('session.attention'), 'Ctrl+Alt+A')
    assert.equal(keys('edit.searchInFiles'), 'Ctrl+Shift+F')
    assert.equal(keys('help.shortcuts'), 'Ctrl+/')
    assert.equal(keys('app.settings'), 'Ctrl+,')
    assert.deepEqual(registry.get('app.palette')?.keys, ['Ctrl+K', 'Ctrl+Shift+P'])
    assert.equal(keys('agent.model'), 'Alt+M')
    assert.equal(registry.get('agent.plan')?.hint, 'Shift+Tab')
  })

  it('leaves out of the palette what only makes sense in a field, and the palette itself', () => {
    const left = registry
      .all()
      .filter((command) => command.palette === false)
      .map((command) => command.id)
    assert.ok(left.includes('app.palette'))
    assert.ok(left.every((id) => id === 'app.palette' || id.startsWith('edit.')), left.join(', '))
  })

  it('runs Ctrl+K while typing, so the palette opens from the message box', () => {
    assert.equal(registry.forEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, true)?.id, 'app.palette')
  })

  it('finds in the session on Ctrl+F from the message box, and steps with F3 only while the find bar is open', () => {
    const key = (key: string, code: string, shiftKey = false, ctrlKey = false) => ({ key, code, ctrlKey, altKey: false, shiftKey, metaKey: false })
    const open = registryWith({ canFind: () => true, isFinding: () => true })
    assert.equal(open.forEvent(key('f', 'KeyF', false, true), true)?.id, 'edit.find')
    assert.equal(open.forEvent(key('F3', 'F3'), true)?.id, 'edit.findNext')
    assert.equal(open.forEvent(key('F3', 'F3', true), false)?.id, 'edit.findPrevious')
    const closed = registryWith({ canFind: () => true, isFinding: () => false })
    assert.equal(closed.forEvent(key('F3', 'F3'), false), undefined, 'F3 is left to the editor')
    const covered = registryWith({ canFind: () => false })
    assert.equal(covered.forEvent(key('f', 'KeyF', false, true), false), undefined, 'a full-width panel covers the thread')
  })

  it('puts the side panel on browser-style tab shortcuts, and the first nine tabs on Ctrl+1 to Ctrl+9', () => {
    const keys = (id: string) => registry.get(id)?.keys?.[0]
    assert.equal(keys('panel.newTab'), 'Ctrl+T')
    assert.equal(keys('panel.closeTab'), 'Ctrl+W')
    assert.equal(keys('panel.reopenTab'), 'Ctrl+Shift+T')
    assert.equal(keys('panel.nextTab'), 'Ctrl+Shift+]')
    assert.equal(keys('panel.prevTab'), 'Ctrl+Shift+[')
    assert.equal(keys('panel.cycle'), 'Ctrl+Shift+B')
    assert.equal(keys('panel.full'), 'Ctrl+Alt+F')
    assert.equal(keys('view.bottomPanel'), 'Ctrl+J')
    assert.equal(keys('view.terminal'), 'Ctrl+`')
    for (let n = 1; n <= 9; n++) {
      assert.deepEqual(registry.get(`panel.tab${n}`)?.keys, [`Ctrl+${n}`])
      assert.equal(registry.get(`panel.tab${n}`)?.hidden, true)
    }
  })

  it('lets quit, zoom and full screen work while a dialog is open, and nothing else', () => {
    const global = registry
      .all()
      .filter((command) => command.global)
      .map((command) => command.id)
      .sort()
    assert.deepEqual(global, ['app.quit', 'view.fullScreen', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset'])
  })
})

describe('menus', () => {
  const registry = registryWith()

  it('list only commands that exist, once each', () => {
    const seen = new Set<string>()
    for (const menu of MENUS) {
      for (const item of menu.items) {
        if (item === '-') continue
        assert.ok(registry.get(item), `${menu.label}: ${item} is not a command`)
        assert.equal(registry.get(item)?.group, menu.label, `${item} is listed under ${menu.label}`)
        assert.equal(seen.has(item), false, `${item} is listed twice`)
        seen.add(item)
      }
    }
  })

  it('list every command that is not hidden', () => {
    const listed = new Set(MENUS.flatMap((menu) => menu.items))
    for (const command of registry.all()) {
      if (!command.hidden && command.menu !== false) assert.ok(listed.has(command.id), `${command.id} is in no menu`)
    }
  })

  it('draw no leading, trailing or doubled separators', () => {
    for (const menu of MENUS) {
      const entries = menuEntries(registry, menu)
      assert.notEqual(entries[0]?.kind, 'separator', menu.label)
      assert.notEqual(entries[entries.length - 1]?.kind, 'separator', menu.label)
      entries.forEach((entry, index) => {
        if (entry.kind === 'separator') assert.notEqual(entries[index - 1]?.kind, 'separator', menu.label)
      })
    }
  })

  it('show a command as disabled when it cannot run, with its shortcut', () => {
    const quickOpen = itemOf(menuEntries(registry, MENUS[0]), 'file.quickOpen')
    assert.equal(quickOpen.disabled, true, 'no folder is open')
    assert.equal(quickOpen.shortcut, 'Ctrl+P')
  })

  it('say Pin or Unpin by the open session', () => {
    assert.equal(registryWith({ activeSession: () => session() }).titleOf('session.pin'), 'Pin session')
    assert.equal(registryWith({ activeSession: () => session({ pinned: true }) }).titleOf('session.pin'), 'Unpin session')
  })

  it('say Show or Hide for the breadcrumbs and the outline, and open Go to file on symbols', () => {
    const shown = registryWith({ editorLayout: () => LAYOUT })
    assert.equal(shown.titleOf('view.breadcrumbs'), 'Hide breadcrumbs')
    assert.equal(shown.titleOf('view.outline'), 'Show outline')
    const hidden = registryWith({ editorLayout: () => ({ ...LAYOUT, breadcrumbs: false, outline: true }) })
    assert.equal(hidden.titleOf('view.breadcrumbs'), 'Show breadcrumbs')
    assert.equal(hidden.titleOf('view.outline'), 'Hide outline')
    const asked: (string | undefined)[] = []
    const live = registryWith({ hasEditor: () => true, hasWorkspace: () => true, quickOpen: (query) => void asked.push(query) })
    void live.run('editor.goToSymbol')
    void live.run('editor.goToFolderSymbol')
    void live.run('file.quickOpen')
    assert.deepEqual(asked, ['@', '#', undefined])
    assert.equal(live.shortcut('editor.goToSymbol'), 'Ctrl+Shift+O')
    assert.equal(live.shortcut('editor.goToFolderSymbol'), 'Ctrl+Alt+T')
    assert.equal(live.shortcut('editor.focusBreadcrumbs'), 'Ctrl+Shift+.')
    assert.equal(live.shortcut('editor.callHierarchy'), 'Shift+Alt+H')
  })

  it('turn inlay hints and semantic colours on and off', () => {
    const on = registryWith({ hasEditor: () => true })
    assert.equal(on.titleOf('view.inlayHints'), 'Hide inlay hints')
    assert.equal(on.titleOf('view.semanticHighlighting'), 'Turn semantic colours off')
    const off = registryWith({ hasEditor: () => true, editorLayout: () => ({ ...LAYOUT, inlayHints: false, semanticHighlighting: false }) })
    assert.equal(off.titleOf('view.inlayHints'), 'Show inlay hints')
    assert.equal(off.titleOf('view.semanticHighlighting'), 'Turn semantic colours on')
    const toggled: string[] = []
    const live = registryWith({ hasEditor: () => true, toggleEditorPart: (part) => void toggled.push(part) })
    for (const id of ['view.inlayHints', 'view.semanticHighlighting']) void live.run(id)
    assert.deepEqual(toggled, ['inlayHints', 'semanticHighlighting'])
  })

  it('turn suggestions as you type on and off, and ask for one on Alt+\\', () => {
    assert.equal(registryWith({}).titleOf('view.inlineSuggest'), 'Turn suggestions as you type on')
    let flips = 0
    const on = registryWith({ hasEditor: () => true, inlineSuggestOn: () => true, toggleInlineSuggest: () => void flips++ })
    assert.equal(on.titleOf('view.inlineSuggest'), 'Turn suggestions as you type off')
    void on.run('view.inlineSuggest')
    assert.equal(flips, 1)
    const ran: string[] = []
    void registryWith({ hasEditor: () => true, editorCommand: (name) => void ran.push(name) }).run('editor.inlineSuggest')
    assert.deepEqual(ran, ['triggerInlineSuggest'])
  })

  it('turn word wrap on and off with Alt+Z, and show every space and tab', () => {
    const off = registryWith({})
    assert.equal(off.titleOf('view.wordWrap'), 'Turn word wrap on')
    assert.equal(off.titleOf('view.whitespace'), 'Show whitespace')
    assert.equal(off.shortcut('view.wordWrap'), 'Alt+Z')
    const on = registryWith({ editorLayout: () => ({ ...LAYOUT, wordWrap: true, showWhitespace: true }) })
    assert.equal(on.titleOf('view.wordWrap'), 'Turn word wrap off')
    assert.equal(on.titleOf('view.whitespace'), 'Hide whitespace')
    const toggled: string[] = []
    const live = registryWith({ toggleEditorPart: (part) => void toggled.push(part) })
    for (const id of ['view.wordWrap', 'view.whitespace']) void live.run(id)
    assert.deepEqual(toggled, ['wordWrap', 'showWhitespace'])
  })

  it('make Tab move the focus with Ctrl+M, and indent again', () => {
    const off = registryWith({})
    assert.equal(off.titleOf('view.tabMovesFocus'), 'Make Tab move the focus')
    assert.equal(off.shortcut('view.tabMovesFocus'), 'Ctrl+M')
    assert.equal(registryWith({ editorLayout: () => ({ ...LAYOUT, tabMovesFocus: true }) }).titleOf('view.tabMovesFocus'), 'Make Tab indent again')
    const toggled: string[] = []
    void registryWith({ toggleEditorPart: (part) => void toggled.push(part) }).run('view.tabMovesFocus')
    assert.deepEqual(toggled, ['tabMovesFocus'])
  })

  it('turn folding, sticky scroll, bracket colours and the minimap on and off, and fold only while folding is on', () => {
    const on = registryWith({ hasEditor: () => true })
    assert.equal(on.titleOf('view.folding'), 'Turn folding off')
    assert.equal(on.titleOf('view.stickyScroll'), 'Hide sticky scroll')
    assert.equal(on.titleOf('view.bracketColors'), 'Turn bracket colours off')
    assert.equal(on.titleOf('view.minimap'), 'Hide minimap')
    const off = registryWith({ hasEditor: () => true, editorLayout: () => ({ ...LAYOUT, folding: false, stickyScroll: false, bracketColors: false, minimap: false }) })
    assert.equal(off.titleOf('view.folding'), 'Turn folding on')
    assert.equal(off.titleOf('view.stickyScroll'), 'Show sticky scroll')
    assert.equal(off.titleOf('view.bracketColors'), 'Turn bracket colours on')
    assert.equal(off.titleOf('view.minimap'), 'Show minimap')
    const toggled: string[] = []
    const ran: string[] = []
    const live = registryWith({ hasEditor: () => true, toggleEditorPart: (part) => void toggled.push(part), editorCommand: (name) => void ran.push(name) })
    for (const id of ['view.folding', 'view.stickyScroll', 'view.bracketColors', 'view.minimap']) void live.run(id)
    assert.deepEqual(toggled, ['folding', 'stickyScroll', 'bracketColors', 'minimap'])
    for (const id of ['editor.fold', 'editor.foldLevel2', 'editor.foldImports']) void live.run(id)
    assert.deepEqual(ran, ['fold', 'foldLevel2', 'foldImports'])
    // The editor's own keys: shown, and left to the editor, which takes them only while folding is on.
    assert.equal(live.shortcut('editor.fold'), 'Ctrl+Shift+[')
    assert.equal(live.shortcut('editor.unfoldAll'), 'Ctrl+Alt+]')
    assert.equal(live.isEnabled('editor.fold'), true)
    assert.equal(off.isEnabled('editor.fold'), false)
    assert.equal(off.isEnabled('editor.foldLevel3'), false)
    const listed = new Set(MENUS.flatMap((menu) => menu.items))
    assert.equal(listed.has('editor.foldLevel3'), false, 'the levels are in the palette, not the menu bar')
    assert.equal(live.get('editor.foldLevel3')?.hidden, undefined)
  })

  it('run the command when chosen', () => {
    let ran = 0
    const live = registryWith({ newSession: () => void ran++ })
    itemOf(menuEntries(live, MENUS[0]), 'file.newSession').onSelect()
    assert.equal(ran, 1)
  })

  it('disable Close tab with no tab open and Reopen with none closed', () => {
    const none = registryWith({ canClosePanelTab: () => false, canReopenPanelTab: () => false })
    assert.equal(none.isEnabled('panel.closeTab'), false)
    assert.equal(none.isEnabled('panel.reopenTab'), false)
    const some = registryWith({ canClosePanelTab: () => true, canReopenPanelTab: () => true })
    assert.equal(some.isEnabled('panel.closeTab'), true)
    assert.equal(some.isEnabled('panel.reopenTab'), true)
  })

  it('disable session commands when there is no session', () => {
    const empty = registryWith({ activeSession: () => undefined })
    assert.equal(empty.isEnabled('session.rename'), false)
    assert.equal(registryWith({ activeSession: () => session() }).isEnabled('session.rename'), true)
    assert.equal(empty.isEnabled('session.back'), false)
    assert.equal(registryWith({ canGoBack: () => true }).isEnabled('session.back'), true)
  })
})
