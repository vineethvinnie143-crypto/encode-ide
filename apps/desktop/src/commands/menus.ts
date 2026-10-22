/**
 * The menu bar's structure: which commands each menu lists, in order, with
 * '-' for a separator. Titles, shortcuts and enabled state come from the
 * registry, so a menu can never disagree with the keymap.
 */
import type { MenuEntry } from '../ui/Menu'
import type { CommandRegistry } from './registry'

export interface MenuSpec {
  label: string
  items: readonly string[]
}

export const MENUS: readonly MenuSpec[] = [
  { label: 'File', items: ['file.newSession', 'file.openFolder', 'file.quickOpen', 'file.save', '-', 'app.settings', '-', 'app.quit'] },
  {
    label: 'Edit',
    items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', '-', 'edit.searchInFiles'],
  },
  {
    label: 'View',
    items: [
      'app.palette',
      '-',
      'view.sidebar',
      'view.sidePanel',
      'view.bottomPanel',
      'view.activity',
      '-',
      'view.chat',
      'view.files',
      'view.review',
      'view.terminal',
      'view.plugins',
      'view.automations',
      '-',
      'panel.newTab',
      'panel.closeTab',
      'panel.reopenTab',
      'panel.nextTab',
      'panel.prevTab',
      'panel.cycle',
      'panel.full',
      '-',
      'view.theme',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset',
      '-',
      'view.fullScreen',
    ],
  },
  {
    label: 'Session',
    items: [
      'session.rename',
      'session.pin',
      'session.archive',
      'session.unread',
      '-',
      'session.fork',
      'session.export',
      'session.delete',
      '-',
      'agent.plan',
      'agent.goal',
      'agent.model',
      'agent.effort',
      'agent.permissions',
      'agent.compact',
      'agent.stop',
      '-',
      'agent.reviewTurn',
      'agent.askReviewer',
      'agent.undo',
      'agent.rewind',
      'agent.status',
      'agent.init',
      '-',
      'session.back',
      'session.forward',
      'session.nextRecent',
      'session.prevRecent',
      'session.attention',
    ],
  },
  { label: 'Help', items: ['help.shortcuts', '-', 'help.feedback', 'help.diagnostics', 'help.logs', '-', 'help.about'] },
]

/** The entries of one menu as the Menu component draws them. */
export function menuEntries(registry: CommandRegistry, spec: MenuSpec): MenuEntry[] {
  const entries: MenuEntry[] = []
  for (const item of spec.items) {
    if (item === '-') {
      if (entries.length && entries[entries.length - 1].kind !== 'separator') entries.push({ kind: 'separator', id: `sep-${entries.length}` })
      continue
    }
    if (!registry.get(item)) continue
    entries.push({
      id: item,
      label: registry.titleOf(item),
      shortcut: registry.shortcut(item),
      disabled: !registry.isEnabled(item),
      onSelect: () => void registry.run(item),
    })
  }
  while (entries.length && entries[entries.length - 1].kind === 'separator') entries.pop()
  return entries
}
