/**
 * What each slash command does when it runs from the message box. The list, the names and the parsing are in
 * picker.ts; each command reuses the action the menus and the palette run.
 */
import { EFFORT_INFO, isEffort } from '@shared/models'
import type { ReasoningEffort } from '@shared/types'
import { agentActions } from '../../commands/agent'
import { commandRegistry } from '../../commands/app'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import type { SlashCommand } from './picker'

const ui = () => useUi.getState()
const run = (id: string) => void commandRegistry.run(id)

/** The effort `/effort` names: a level, as written or by its label ("extra high"); null for the model's default; undefined for words it does not know. */
export function effortOf(words: string): ReasoningEffort | null | undefined {
  const wanted = words.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (['default', 'auto', 'model default', 'reset'].includes(wanted)) return null
  if (wanted === 'extra high' || wanted === 'x high') return 'xhigh'
  return isEffort(wanted) ? wanted : undefined
}

export const SLASH_RUNNERS: Readonly<Record<string, (args: string) => void | Promise<void>>> = {
  plan: async (args) => {
    if (!args) return agentActions.togglePlan()
    await agentActions.setPlanMode(true)
    agentActions.send(args)
  },
  goal: (args) => (args.toLowerCase() === 'clear' ? agentActions.clearGoal() : agentActions.setGoal(args || undefined)),
  compact: () => agentActions.compact(),
  model: () => agentActions.openMenu('model'),
  effort: async (args) => {
    if (!args) return agentActions.chooseEffort()
    const effort = effortOf(args)
    if (effort === undefined) return ui().notify('info', `/effort takes low, medium, high, xhigh, max or default, not “${args}”.`)
    await useSettings.getState().setEffort('main', effort)
    ui().notify('success', effort ? `The model thinks at ${EFFORT_INFO[effort].label} effort.` : 'The model decides how hard to think.')
  },
  policy: () => agentActions.openMenu('policy'),
  status: () => ui().setStatusOpen(true),
  diff: () => {
    if (!commandRegistry.run('view.review')) ui().notify('info', 'Open a folder to review its changes.')
  },
  undo: () => {
    if (agentActions.canUndo()) agentActions.undo()
    else ui().notify('info', agentActions.isRunning() ? 'Wait until eNCode is done, then undo.' : 'No request in this session has changed files yet.')
  },
  rewind: () => {
    if (agentActions.canRewind()) agentActions.rewind()
    else ui().notify('info', agentActions.isRunning() ? 'Wait until eNCode is done, then rewind.' : 'There is nothing to rewind yet.')
  },
  init: () => agentActions.writeInstructions(),
  new: () => run('file.newSession'),
  fork: () => run('session.fork'),
  rename: async (args) => {
    const { activeId, rename } = useSessions.getState()
    if (args && activeId) await rename(activeId, args)
    else run('session.rename')
  },
  pin: () => run('session.pin'),
  archive: () => run('session.archive'),
  export: () => run('session.export'),
  mcp: () => ui().openSettings('mcp'),
  skills: () => ui().setPluginsOpen(true),
  settings: () => ui().setSettingsOpen(true),
  shortcuts: () => ui().setShortcutsOpen(true),
  feedback: (args) => agentActions.feedback(args || undefined),
  stop: () => agentActions.stop(),
}

export async function runSlash(command: SlashCommand, args: string): Promise<void> {
  await SLASH_RUNNERS[command.name]?.(args)
}
