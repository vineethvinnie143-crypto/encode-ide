import { create } from '../store'
import type {
  AgentEvent,
  AgentStatus,
  ApprovalAnswer,
  ApprovalRequest,
  ConversationEntry,
  PlanRequest,
  SessionGoal,
  TodoItem,
} from '@shared/types'
import { api } from '../api'
import { enqueue, dequeue, moveQueued, removeQueued, takeQueued, mergeDraft, type Queued } from '../components/Chat/queue'
import { getActiveSessionId } from './active'
import { appendTexts, createDeltaBuffer } from './deltas'
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
  /** Every approval waiting for you in this session, oldest first. */
  approvals: ApprovalRequest[]
  ask: AskState | null
  goal: SessionGoal | null
  todos: TodoItem[]
  plan: PlanRequest | null
  usageTotals: { total: number; cached: number; prompt: number; completion: number }
  initialized: boolean
  /** The session whose entries are shown; the thread starts at its end, and fades in, when this changes. */
  loadedFor: string
  draft: string
  /** Messages sent while the agent worked, by session, waiting to go out one by one. */
  queues: Record<string, Queued[]>
  tokensPerSecond: number
  streamStartedAt: number
  streamChars: number
  setDraft(text: string): void
  init(): Promise<void>
  load(sessionId: string): Promise<void>
  send(text: string, attachments?: { path: string; content: string }[]): void
  stop(): Promise<void>
  clear(): Promise<void>
  /** Answers one approval (the first, unless an id is given); the card leaves the list at once. */
  answerApproval(answer: boolean | ApprovalAnswer, id?: string): Promise<void>
  answer(text: string): Promise<void>
  /** Holds a message until the agent is done. */
  enqueue(text: string): void
  removeQueued(id: string): void
  moveQueued(id: string, direction: -1 | 1): void
  /** Takes a queued message back into the composer to edit it. */
  editQueued(id: string): void
  /** Sends the next queued message of a session, if there is one. */
  drainQueue(sessionId: string): void
  applyEvent(event: AgentEvent): void
}

function upsertEntry(entries: ConversationEntry[], entry: ConversationEntry): ConversationEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

/** Streamed text is applied once per frame (see deltas.ts), not once per piece. */
const deltas = createDeltaBuffer(({ texts, firstAt, chars }) => {
  useChat.setState((state) => ({
    entries: appendTexts(state.entries, texts),
    streamStartedAt: state.streamStartedAt || firstAt,
    streamChars: state.streamChars + chars,
  }))
})

export const useChat = create<ChatStore>((set, get) => ({
  entries: [],
  status: 'idle',
  running: false,
  approvals: [],
  ask: null,
  goal: null,
  todos: [],
  plan: null,
  usageTotals: { total: 0, cached: 0, prompt: 0, completion: 0 },
  initialized: false,
  loadedFor: '',
  draft: '',
  queues: {},
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
    deltas.discard()
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
      const waiting = history.status === 'awaiting-approval' || history.status === 'awaiting-user'
      set({
        entries: history.entries,
        status: history.status,
        running: history.status === 'thinking' || history.status === 'running-tool' || waiting,
        // A session that is still waiting for an answer shows its card again.
        approvals: history.status === 'awaiting-approval' ? (history.approvals ?? (history.approval ? [history.approval] : [])) : [],
        ask: history.status === 'awaiting-user' ? (history.ask ?? null) : null,
        goal,
        todos,
        plan,
        usageTotals: { total: 0, cached: 0, prompt: 0, completion: 0 },
        tokensPerSecond: 0,
        streamStartedAt: 0,
        streamChars: 0,
        initialized: true,
        loadedFor: sessionId,
      })
    } catch {
      set({ entries: [], status: 'idle', running: false, loadedFor: sessionId })
    }
  },

  send: (text, attachments) => {
    const trimmed = text.trim()
    if (!trimmed || get().running) return
    set({ running: true, status: 'thinking', approvals: [], ask: null, draft: '', streamStartedAt: 0, streamChars: 0 })
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
    deltas.discard()
    set({ entries: [], status: 'idle', running: false, approvals: [], ask: null })
  },

  answerApproval: async (answer, id) => {
    const approval = get().approvals.find((item) => item.id === (id ?? get().approvals[0]?.id))
    if (!approval) return
    const approved = typeof answer === 'boolean' ? answer : answer.approved
    const approvals = get().approvals.filter((item) => item.id !== approval.id)
    // Another card may still be waiting; otherwise the agent carries on.
    set({ approvals, status: approvals.length ? 'awaiting-approval' : approved ? 'running-tool' : 'thinking' })
    try {
      await api.agent.approve(approval.id, answer)
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

  enqueue: (text) => {
    const sessionId = getActiveSessionId()
    const queue = enqueue(get().queues[sessionId] ?? [], text, crypto.randomUUID())
    set({ queues: { ...get().queues, [sessionId]: queue }, draft: '' })
  },

  removeQueued: (id) => {
    const sessionId = getActiveSessionId()
    set({ queues: { ...get().queues, [sessionId]: removeQueued(get().queues[sessionId] ?? [], id) } })
  },

  moveQueued: (id, direction) => {
    const sessionId = getActiveSessionId()
    set({ queues: { ...get().queues, [sessionId]: moveQueued(get().queues[sessionId] ?? [], id, direction) } })
  },

  editQueued: (id) => {
    const sessionId = getActiveSessionId()
    const { taken, rest } = takeQueued(get().queues[sessionId] ?? [], id)
    if (!taken) return
    set({ queues: { ...get().queues, [sessionId]: rest }, draft: mergeDraft(get().draft, taken.text) })
  },

  drainQueue: (sessionId) => {
    const { next, rest } = dequeue(get().queues[sessionId] ?? [])
    if (!next) return
    set({ queues: { ...get().queues, [sessionId]: rest } })
    if (sessionId === getActiveSessionId()) {
      get().send(next.text)
      return
    }
    // A session in the background: start it directly; its events reach the sidebar through the sessions store.
    void api.agent
      .start(sessionId, { text: next.text, mode: useSettings.getState().settings?.agentMode ?? 'code' })
      .catch((error: Error) => useUi.getState().notify('error', error.message))
  },

  applyEvent: (event) => {
    if (event.sessionId && event.sessionId !== getActiveSessionId()) return
    if (event.type === 'delta') {
      deltas.push(event.entryId, event.text)
      return
    }
    // Whatever was streaming comes first, so an event never lands on text that has not caught up with it.
    deltas.flush()
    switch (event.type) {
      case 'status':
        set((state) => ({
          status: event.status,
          running: event.status === 'thinking' || event.status === 'running-tool' || event.status === 'awaiting-approval' || event.status === 'awaiting-user',
          // Cards leave when you answer them, or when the run ends (stopping, for one, ends the wait).
          approvals: event.status === 'idle' || event.status === 'done' || event.status === 'error' ? [] : state.approvals,
          ask: event.status === 'awaiting-user' ? state.ask : null,
        }))
        break
      case 'entry':
        set((state) => ({ entries: upsertEntry(state.entries, event.entry) }))
        break
      case 'approval-request':
        set((state) => ({
          approvals: [...state.approvals.filter((item) => item.id !== event.request.id), event.request],
          status: 'awaiting-approval',
          running: true,
        }))
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
            approvals: [],
            ask: null,
            tokensPerSecond: measured || state.tokensPerSecond,
            streamStartedAt: 0,
            streamChars: 0,
          }
        })
        break
      case 'error':
        set({ running: false, status: 'error', approvals: [], ask: null })
        useUi.getState().notify('error', event.message)
        break
      case 'session-reset':
        set({
          entries: [],
          status: 'idle',
          running: false,
          approvals: [],
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
