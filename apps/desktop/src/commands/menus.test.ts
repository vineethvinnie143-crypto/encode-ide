import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionSummary } from '@shared/types'
import { GROUPS, buildCommands, type AppActions } from './commands'
import { parseChord } from './keys'
import type { MenuAction, MenuEntry } from '../ui/Menu'
import { MENUS, menuEntries } from './menus'
import { CommandRegistry } from './registry'

const none = () => undefined
/** Actions that do nothing, and answer the questions about state with "no". */
function actions(patch: Partial<AppActions> = {}): AppActions {
  const base = { hasWorkspace: () => false, canGoBack: () => false, canGoForward: () => false, activeSession: () => undefined, ...patch }
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
      if (!command.hidden) assert.ok(listed.has(command.id), `${command.id} is in no menu`)
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
