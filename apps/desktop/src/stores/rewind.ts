import { create } from '../store'
import type { RewindOutcome, RewindPlan } from '@shared/types'
import { api } from '../api'
import { mergeDraft } from '../components/Chat/queue'
import { defaultChoice, outcomeNote, requestFor, type RewindChoice } from '../panels/rewind'
import { useChat } from './chat'
import { useSessions } from './sessions'
import { useUi } from './ui'

/** Where the dialog is pointed: a request of the person's in a session, or (to undo) just the session. */
export interface RewindTarget {
  sessionId: string
  /** The request's id; empty when the dialog is for undoing the latest rewind. */
  turn: string
  /** What the person wrote, to show which request this is. */
  text: string
}

export type RewindMode = 'rewind' | 'undo'

interface RewindStore {
  target: RewindTarget | null
  mode: RewindMode
  loading: boolean
  /** What putting the files back to before the request would do; null where nothing is recorded. */
  plan: RewindPlan | null
  /** What undoing the latest rewind would do; null when there is nothing to undo. */
  redo: RewindPlan | null
  /** Why no plan could be made, in words. */
  problem: string | null
  /** The plan was out of date when it was applied: the list shows how things stand now. */
  refreshed: boolean
  choice: RewindChoice
  /** Also put back files that changed since the agent last wrote them. */
  overwrite: boolean
  busy: boolean
  show(sessionId: string, turn: string, text: string): Promise<void>
  /** Opens the dialog on the undoing of the latest rewind. */
  showUndo(sessionId: string): Promise<void>
  close(): void
  setChoice(choice: RewindChoice): void
  setOverwrite(overwrite: boolean): void
  setMode(mode: RewindMode): void
  apply(): Promise<void>
}

function described(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useRewind = create<RewindStore>((set, get) => {
  /** Reads the plans again for the dialog's target. A plan that cannot be made leaves its reason. */
  const load = async (target: RewindTarget): Promise<void> => {
    const [plan, redo] = await Promise.all([
      target.turn ? api.agent.rewindPlan(target.sessionId, target.turn).then((value) => ({ value, problem: null }), (error: unknown) => ({ value: null, problem: described(error) })) : { value: null, problem: null },
      api.agent.redoPlan(target.sessionId).catch(() => null),
    ])
    // The dialog may have moved on, or closed, while the answers were on their way.
    const now = get().target
    if (!now || now.sessionId !== target.sessionId || now.turn !== target.turn) return
    set({
      plan: plan.value,
      redo,
      problem: plan.problem,
      loading: false,
      choice: get().mode === 'rewind' ? defaultChoice(plan.value) : 'code',
      overwrite: false,
    })
  }

  /** The conversation was cut: show it as it is now, and give the request back for editing. */
  const afterCut = async (sessionId: string, text: string): Promise<void> => {
    await useChat.getState().load(sessionId)
    useChat.getState().setDraft(mergeDraft(useChat.getState().draft, text))
    void useSessions.getState().refresh()
  }

  const finish = async (outcome: RewindOutcome, kind: RewindPlan['kind'], sessionId: string): Promise<void> => {
    const note = outcomeNote(outcome, kind)
    if (outcome.ok && outcome.text !== undefined) await afterCut(sessionId, outcome.text)
    const changed = outcome.ok && outcome.restored + outcome.deleted > 0
    const action = kind === 'rewind' && changed ? { label: 'Undo', run: () => void get().showUndo(sessionId) } : undefined
    useUi.getState().notify(note.tone, note.text, action)
  }

  return {
    target: null,
    mode: 'rewind',
    loading: false,
    plan: null,
    redo: null,
    problem: null,
    refreshed: false,
    choice: 'conversation',
    overwrite: false,
    busy: false,

    show: async (sessionId, turn, text) => {
      const target = { sessionId, turn, text }
      set({ target, mode: 'rewind', loading: true, plan: null, redo: null, problem: null, refreshed: false, choice: 'conversation', overwrite: false, busy: false })
      await load(target)
    },

    showUndo: async (sessionId) => {
      const target = { sessionId, turn: '', text: '' }
      set({ target, mode: 'undo', loading: true, plan: null, redo: null, problem: null, refreshed: false, choice: 'code', overwrite: false, busy: false })
      await load(target)
      if (!get().redo && get().target === target) {
        set({ target: null })
        useUi.getState().notify('info', 'There is no rewind to undo.')
      }
    },

    close: () => set({ target: null, plan: null, redo: null, problem: null, busy: false }),

    setChoice: (choice) => set({ choice }),
    setOverwrite: (overwrite) => set({ overwrite }),
    setMode: (mode) => set({ mode, choice: mode === 'rewind' ? defaultChoice(get().plan) : 'code', overwrite: false }),

    apply: async () => {
      const { target, mode, plan, redo, choice, overwrite, busy } = get()
      if (!target || busy) return
      if (useChat.getState().running) {
        useUi.getState().notify('error', 'eNCode is working on this session. Stop it first.')
        return
      }
      set({ busy: true })
      try {
        if (mode === 'undo' || (mode === 'rewind' && choice !== 'conversation')) {
          const stored = mode === 'undo' ? redo : plan
          const request = stored ? requestFor(stored, mode === 'undo' ? 'code' : choice, overwrite) : null
          if (!stored || !request) return
          const outcome = await api.agent.rewindApply(target.sessionId, request)
          if (!outcome.ok && outcome.reason === 'stale') {
            // The files moved while the dialog was open: show how they stand now, and let the person decide again.
            set({ loading: true, refreshed: true })
            await load(target)
            return
          }
          if (!outcome.ok) {
            useUi.getState().notify('error', outcome.message)
            return
          }
          get().close()
          await finish(outcome, stored.kind, target.sessionId)
          return
        }
        const { text } = await api.agent.rewindConversation(target.sessionId, target.turn)
        get().close()
        await afterCut(target.sessionId, text)
        useUi.getState().notify('success', 'Went back in the conversation.')
      } catch (error) {
        useUi.getState().notify('error', described(error))
      } finally {
        set({ busy: false })
      }
    },
  }
})
