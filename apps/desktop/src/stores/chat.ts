import { create } from '../store'
import type {
  AgentEvent,
  AgentStatus,
  ApprovalRequest,
  ConversationEntry,
  PlanRequest,
  SessionGoal,
  TodoItem,
} from '@shared/types'
import { api } from '../api'
import { getActiveSessionId } from './active'
import { useSettings } from './settings'
import { useUi } from './ui'

export interface AskState {
  id: string
  entryId: string
  question: string
  options?: string[]
}

interface ChatStore {
  entries: ConversationEntry[]
  status: AgentStatus
  running: boolean
  approval: ApprovalRequest | null
  ask: AskState | null
  goal: SessionGoal | null
  todos: TodoItem[]
  plan: PlanRequest | null
  usageTotals: { total: number; cached: number; prompt: number; completion: number }
  initialized: boolean
  draft: string
  tokensPerSecond: number
  streamStartedAt: number
  streamChars: number
  setDraft(text: string): void
  init(): Promise<void>
  load(sessionId: string): Promise<void>
  send(text: string, attachments?: { path: string; content: string }[]): void
  stop(): Promise<void>
  clear(): Promise<void>
  approve(approved: boolean): Promise<void>
  answer(text: string): Promise<void>
  applyEvent(event: AgentEvent): void
}

function upsertEntry(entries: ConversationEntry[], entry: ConversationEntry): ConversationEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

export const useChat = create<ChatStore>((set, get) => ({
  entries: [],
  status: 'idle',
  running: false,
  approval: null,
  ask: null,
  goal: null,
  todos: [],
  plan: null,
  usageTotals: { total: 0, cached: 0, prompt: 0, completion: 0 },
  initialized: false,
  draft: '',
  tokensPerSecond: 0,
  streamStartedAt: 0,
  streamChars: 0,

  setDraft: (text) => set({ draft: text }),

  init: async () => {
    try {
      const history = await api.agent.history()
      set({
        entries: history.entries,
        status: history.status,
        running: history.status === 'thinking' || history.status === 'running-tool',
        initialized: true,
      })
    } catch {
      set({ initialized: true })
    }
  },

  load: async (sessionId) => {
    try {
      const history = await api.agent.history(sessionId)
      let goal: SessionGoal | null = null
      let todos: TodoItem[] = []
      let plan: PlanRequest | null = null
      try {
        goal = await api.agent.goal(sessionId)
      } catch {
        goal = null
      }
      try {
        todos = await api.agent.todos(sessionId)
      } catch {
        todos = []
      }
      try {
        plan = await api.agent.plan(sessionId)
      } catch {
        plan = null
      }
      set({
        entries: history.entries,
        status: history.status,
        running: history.status === 'thinking' || history.status === 'running-tool',
        approval: null,
        ask: null,
        goal,
        todos,
        plan,
        usageTotals: { total: 0, cached: 0, prompt: 0, completion: 0 },
        tokensPerSecond: 0,
        streamStartedAt: 0,
        streamChars: 0,
        initialized: true,
      })
    } catch {
      set({ entries: [], status: 'idle', running: false })
    }
  },

  send: (text, attachments) => {
    const trimmed = text.trim()
    if (!trimmed || get().running) return
    set({ running: true, status: 'thinking', approval: null, ask: null, draft: '', streamStartedAt: 0, streamChars: 0 })
    const sessionId = getActiveSessionId()
    void api.agent
      .start(sessionId, {
        text: trimmed,
        mode: useSettings.getState().settings?.agentMode ?? 'code',
        attachments,
      })
      .catch((error: Error) => {
        set({ running: false, status: 'error' })
        useUi.getState().notify('error', error.message)
      })
  },

  stop: async () => {
    try {
      await api.agent.cancel(getActiveSessionId())
    } catch {
      /* ignore */
    }
  },

  clear: async () => {
    try {
      await api.agent.reset(getActiveSessionId())
    } catch {
      /* ignore */
    }
    set({ entries: [], status: 'idle', running: false, approval: null, ask: null })
  },

  approve: async (approved) => {
    const approval = get().approval
    if (!approval) return
    set({ approval: null, status: approved ? 'running-tool' : 'thinking' })
    try {
      await api.agent.approve(approval.id, approved)
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  answer: async (text) => {
    const ask = get().ask
    if (!ask) return
    set({ ask: null, status: 'running-tool' })
    try {
      await api.agent.answer(ask.id, text)
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  applyEvent: (event) => {
    if (event.sessionId && event.sessionId !== getActiveSessionId()) return
    switch (event.type) {
      case 'status':
        set({
          status: event.status,
          running: event.status === 'thinking' || event.status === 'running-tool' || event.status === 'awaiting-approval' || event.status === 'awaiting-user',
        })
        break
      case 'entry':
        set((state) => ({ entries: upsertEntry(state.entries, event.entry) }))
        break
      case 'delta':
        set((state) => ({
          entries: state.entries.map((entry) =>
            entry.id === event.entryId ? { ...entry, text: (entry.text ?? '') + event.text } : entry,
          ),
          streamStartedAt: state.streamStartedAt || Date.now(),
          streamChars: state.streamChars + event.text.length,
        }))
        break
      case 'approval-request':
        set({ approval: event.request, status: 'awaiting-approval', running: true })
        break
      case 'ask':
        set({
          ask: { id: event.id, entryId: event.entryId, question: event.question, options: event.options },
          status: 'awaiting-user',
          running: true,
        })
        break
      case 'done':
        set((state) => {
          const seconds = state.streamStartedAt ? (Date.now() - state.streamStartedAt) / 1000 : 0
          const measured = seconds > 0.2 ? Math.round(state.streamChars / 4 / seconds) : 0
          return {
            running: false,
            status: 'done',
            approval: null,
            ask: null,
            tokensPerSecond: measured || state.tokensPerSecond,
            streamStartedAt: 0,
            streamChars: 0,
          }
        })
        break
      case 'error':
        set({ running: false, status: 'error', approval: null, ask: null })
        useUi.getState().notify('error', event.message)
        break
      case 'session-reset':
        set({
          entries: [],
          status: 'idle',
          running: false,
          approval: null,
          ask: null,
          tokensPerSecond: 0,
          streamStartedAt: 0,
          streamChars: 0,
        })
        break
      case 'goal':
        set({ goal: event.goal })
        break
      case 'todos':
        set({ todos: event.todos })
        break
      case 'plan':
        set({ plan: event.plan })
        break
      case 'usage':
        set((state) => ({
          usageTotals: {
            total: state.usageTotals.total + event.totalTokens,
            cached: state.usageTotals.cached + (event.cachedTokens ?? 0),
            prompt: state.usageTotals.prompt + event.promptTokens,
            completion: state.usageTotals.completion + event.completionTokens,
          },
        }))
        break
      default:
        break
    }
  },
}))
