/**
 * What the agent's commands do, shared by the message box (its + menu and its slash commands), the command palette
 * and the menus, so each works the same way from everywhere.
 */
import { modelMode } from '@shared/models'
import { api } from '../api'
import { buildTurns, latestEditTurn, latestRequest } from '../components/Chat/turns'
import { errorText } from '../ipc-error'
import { getActiveSessionId } from '../stores/active'
import { useChat } from '../stores/chat'
import { usePanels } from '../stores/panels'
import { useReview, type ScopeKind } from '../stores/review'
import { useRewind } from '../stores/rewind'
import { useSettings } from '../stores/settings'
import { useUi, type ComposerMenu } from '../stores/ui'
import { useWorkspace } from '../stores/workspace'

const ui = () => useUi.getState()
const chat = () => useChat.getState()

/**
 * /init: the agent writes the instructions file it reads at the start of every session. The first of ENCODE.md,
 * .encode/ENCODE.md, AGENTS.md and CLAUDE.md in a folder is the one read, so an existing one is improved in place.
 */
export const INIT_PROMPT = [
  'Write the project instructions file for this project: the file you read at the start of every session.',
  'If ENCODE.md, .encode/ENCODE.md, AGENTS.md or CLAUDE.md already exists at the project root, improve that file instead of creating another; otherwise create AGENTS.md.',
  'Look through the project first. Keep it short and specific to this project: what it is, the exact commands to install, build, test and run it, how the code is laid out, the conventions to follow, and anything surprising.',
  'Leave out generic advice and anything a reader sees at once from the files.',
].join(' ')

/** The thread under a full-width side panel is shown again, so a control in the message box can open. */
function revealThread(): void {
  if (usePanels.getState().side.layout === 'full') usePanels.getState().setLayout('split')
}

function turns() {
  return buildTurns(chat().entries, chat().running)
}

export const agentActions = {
  inPlanMode: (): boolean => useSettings.getState().settings?.agentMode === 'plan',

  async setPlanMode(on: boolean): Promise<void> {
    await useSettings.getState().save({ agentMode: on ? 'plan' : 'code' })
  },

  togglePlan(): void {
    void agentActions.setPlanMode(!agentActions.inPlanMode())
  },

  /** Sets the goal to `text`, or asks for it (showing the current one). */
  async setGoal(text?: string): Promise<void> {
    const sessionId = getActiveSessionId()
    if (!sessionId) return
    const current = chat().goal
    const goal = text?.trim() || (await ui().askText(current ? 'Goal' : 'Set a goal', 'Goal', current?.text ?? ''))?.trim()
    if (!goal) return
    try {
      await api.agent.setGoal(sessionId, { text: goal, status: 'active', rounds: 0, createdAt: Date.now(), updatedAt: Date.now() })
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },

  async clearGoal(): Promise<void> {
    const sessionId = getActiveSessionId()
    if (!sessionId) return
    if (!chat().goal) {
      ui().notify('info', 'This session has no goal.')
      return
    }
    try {
      await api.agent.setGoal(sessionId, null)
      ui().notify('info', 'Cleared the goal.')
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },

  async compact(): Promise<void> {
    try {
      const result = await api.agent.compact(getActiveSessionId())
      ui().notify('success', result.removed ? `Compacted ${result.removed} messages` : 'Nothing to compact yet')
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },

  isRunning: (): boolean => chat().running,

  stop(): void {
    void chat().stop()
  },

  /** Opens the model list, the effort menu or the permissions menu of the message box. */
  openMenu(menu: ComposerMenu): void {
    revealThread()
    ui().requestMenu(menu)
  },

  /** The effort menu, which is there while a real model answers: the offline demo has nothing to set. */
  chooseEffort(): void {
    const settings = useSettings.getState().settings
    if (settings && modelMode(settings) === 'router') agentActions.openMenu('effort')
    else ui().notify('info', 'Connect a model first. Effort is how hard a model thinks, and the offline demo has no such dial.')
  },

  /**
   * Sends a request as the person's message, or queues it while the agent works. False when there is no folder.
   * `best`: as that many attempts side by side (ADR 0098), which waits for nothing: the queue keeps plain messages.
   */
  send(text: string, options?: { best?: number }): boolean {
    if (!useWorkspace.getState().workspace) {
      ui().notify('info', 'Open a folder first so the agent has a project to work on.')
      return false
    }
    if (options?.best && chat().running) {
      ui().notify('info', 'Wait until eNCode is done, then send /best again.')
      return false
    }
    if (chat().running) chat().enqueue(text, { keepDraft: true })
    else chat().send(text, undefined, { keepDraft: true, ...(options?.best ? { best: options.best } : {}) })
    return true
  },

  writeInstructions(): void {
    agentActions.send(INIT_PROMPT)
  },

  canRewind: (): boolean => !chat().running && latestRequest(turns()) !== null,

  /** The Rewind dialog on the latest request, with its default choice. */
  rewind(): void {
    const user = latestRequest(turns())?.user
    if (!user || chat().running) return
    useRewind.getState().show(getActiveSessionId(), user.id, user.text ?? '')
  },

  canUndo: (): boolean => !chat().running && latestEditTurn(turns()) !== null,

  /** The Rewind dialog on putting back the files of the latest request that changed some, as its change card's Undo. */
  undo(): void {
    const user = latestEditTurn(turns())?.user
    if (!user || chat().running) return
    useRewind.getState().show(getActiveSessionId(), user.id, user.text ?? '', 'code')
  },

  reviewLastTurn(): void {
    useReview.getState().showTurn(null)
  },

  /** The Reviewer's findings on the changes the Review tab shows (with `kind`, on that view's), as comments there. */
  askReviewer(kind?: ScopeKind): Promise<void> {
    return useReview.getState().askReviewer(kind)
  },

  async feedback(text?: string): Promise<void> {
    const note = text?.trim() || (await ui().askText('Feedback', 'What went well or badly?'))?.trim()
    if (!note) return
    try {
      await api.app.feedback(note)
      ui().notify('success', 'Feedback recorded')
    } catch (error) {
      ui().notify('error', errorText(error))
    }
  },
}
