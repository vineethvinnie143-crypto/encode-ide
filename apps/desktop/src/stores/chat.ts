import { create } from '../store'
import type {
  AgentEvent,
  AgentStatus,
  EntryProblem,
  ApprovalAnswer,
  ApprovalRequest,
  ConversationEntry,
  PlanRequest,
  SessionGoal,
  ThinkingProgress,
  TodoItem,
} from '@shared/types'
import { api } from '../api'
import { enqueue, dequeue, moveQueued, removeQueued, takeQueued, mergeDraft, type Queued } from '../components/Chat/queue'
import { startInput, type ComposerAttachment } from '../components/Chat/attachments'
import { getActiveSessionId } from './active'
import { appendTexts, createDeltaBuffer } from './deltas'
import { useSettings } from './settings'
import { isBusy } from './sidebar-model'
import { useStatus } from './status'
import { useUi } from './ui'
import { errorText } from '../ipc-error'
import { HOST_STOPPED_MESSAGE, localProblemEntry } from '@shared/problems'

export interface AskState {
  id: string
  entryId: string
  question: string
  options?: string[]
  /** Asked by a subagent in the background: it stays when the turn ends. */
  background?: boolean
}

/** What a subagent in the background still waits on once the turn is over; the turn's own cards leave with it. */
const outlives = (state: { approvals: ApprovalRequest[]; ask: AskState | null }) => ({
  approvals: state.approvals.filter((item) => item.background),
  ask: state.ask?.background ? state.ask : null,
})

interface ChatStore {
  entries: ConversationEntry[]
  status: AgentStatus
  running: boolean
  /** Every approval waiting for you in this session, oldest first. */
  approvals: ApprovalRequest[]
  ask: AskState | null
  goal: SessionGoal | null
  todos: TodoItem[]
  /** What the model has thought so far in the call under way, for the live line (ADR 0125). */
  thinking: ThinkingProgress | null
  plan: PlanRequest | null
  usageTotals: { total: number; cached: number; prompt: number; completion: number }
  initialized: boolean
  /** The session whose entries are shown; the thread starts at its end, and fades in, when this changes. */
  loadedFor: string
  draft: string
  /** What the chat box will send with the draft (ADR 0113): files, pictures, PDFs. */
  attachments: ComposerAttachment[]
  /** Messages sent while the agent worked, by session, waiting to go out one by one. */
  queues: Record<string, Queued[]>
  /** Messages handed to a session's running request that no step has taken yet, by session. */
  steering: Record<string, Queued[]>
  tokensPerSecond: number
  streamStartedAt: number
  streamChars: number
  setDraft(text: string): void
  attach(items: readonly ComposerAttachment[]): void
  detach(id: string): void
  init(): Promise<void>
  load(sessionId: string): Promise<void>
  /** Starts a turn. `keepDraft`: the message comes from elsewhere (the Review tab), so what the composer holds stays. */
  /** `best`: make that many attempts side by side, in Code mode (ADR 0098). */
  /** What the chat box held is cleared with the draft; `attachments` go with the message. */
  send(text: string, attachments?: readonly ComposerAttachment[], options?: { keepDraft?: boolean; best?: number }): void
  /** Runs the last request again from where a problem stopped it. */
  retry(): void
  stop(): Promise<void>
  clear(): Promise<void>
  /** Answers one approval (the first, unless an id is given); the card leaves the list at once. */
  answerApproval(answer: boolean | ApprovalAnswer, id?: string): Promise<void>
  answer(text: string): Promise<void>
  /** Holds a message until the agent is done. */
  enqueue(text: string, options?: { keepDraft?: boolean; attachments?: readonly ComposerAttachment[] }): void
  /**
   * Hands a message to the running request, which reads it after the step it is on. A message no step takes (the
   * request was ending, or a tool ended it) goes to the front of the queue, so it is the next request.
   */
  steer(text: string, options?: { keepDraft?: boolean }): void
  /** Takes a queued message out of the queue: the running request reads it after its step, or, with none running, it is sent. */
  sendQueued(id: string): void
  /** Follows a session's messages handed to its request: one taken leaves the list; what an ended request left goes back to the queue. */
  followSteers(event: AgentEvent): void
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

/** A problem only the app knows of (the agent process stopped), shown once: a second report of it adds nothing. */
function withLocalProblem(entries: ConversationEntry[], text: string, problem: EntryProblem): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.kind === 'error' && last.text === text && !last.problem?.resolved) return entries
  return [...entries, localProblemEntry(text, problem)]
}

/** Trying again puts the problems the app showed out of action; the session does the same for its own. */
function resolveLocalProblems(entries: ConversationEntry[]): ConversationEntry[] {
  if (!entries.some((entry) => entry.id.startsWith('problem-') && entry.problem && !entry.problem.resolved)) return entries
  return entries.map((entry) => (entry.id.startsWith('problem-') && entry.problem && !entry.problem.resolved ? { ...entry, problem: { ...entry.problem, resolved: true } } : entry))
}

const HOST_PROBLEM: EntryProblem = { code: 'host', actions: ['retry'] }

/** What a session's request was handed and did not take goes to the front of its queue, in the order it was sent. */
function giveBack(sessionId: string): void {
  useChat.setState((state) => {
    const left = state.steering[sessionId]
    if (!left?.length) return {}
    return { steering: { ...state.steering, [sessionId]: [] }, queues: { ...state.queues, [sessionId]: [...left, ...(state.queues[sessionId] ?? [])] } }
  })
}

/** A task list whose every item is done: its card folds away (TodoCard), and a session opened with one shows none (ADR 0115). */
export function finishedList(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed')
}

/** The tokens of a conversation that has used none: a new, loaded or reset one counts from here. */
const NO_USAGE = { total: 0, cached: 0, prompt: 0, completion: 0 } as const

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
  thinking: null,
  plan: null,
  usageTotals: NO_USAGE,
  initialized: false,
  loadedFor: '',
  draft: '',
  attachments: [],
  queues: {},
  steering: {},
  tokensPerSecond: 0,
  streamStartedAt: 0,
  streamChars: 0,

  setDraft: (text) => set({ draft: text }),
  attach: (items) => set((state) => ({ attachments: [...state.attachments, ...items] })),
  detach: (id) => set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) })),

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
        todos: finishedList(todos) ? [] : todos,
        thinking: null,
        plan,
        usageTotals: NO_USAGE,
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

  send: (text, attachments, options) => {
    const trimmed = text.trim()
    if (!trimmed || get().running) return
    set({ running: true, status: 'thinking', approvals: [], ask: null, streamStartedAt: 0, streamChars: 0, ...(options?.keepDraft ? {} : { draft: '', attachments: [] }) })
    const sessionId = getActiveSessionId()
    void api.agent
      .start(sessionId, {
        text: trimmed,
        mode: options?.best ? 'code' : (useSettings.getState().settings?.agentMode ?? 'code'),
        ...startInput(attachments ?? []),
        ...(options?.best ? { best: options.best } : {}),
      })
      .catch((error: Error) => {
        const text = errorText(error)
        // The agent process stopping is a problem in the chat, with Retry; anything else (no folder open) is a notice.
        if (text === HOST_STOPPED_MESSAGE) set((state) => ({ running: false, status: 'error', entries: withLocalProblem(state.entries, text, HOST_PROBLEM) }))
        else {
          set({ running: false, status: 'error' })
          useUi.getState().notify('error', text)
        }
      })
  },

  retry: () => {
    if (get().running) return
    const sessionId = getActiveSessionId()
    set((state) => ({ running: true, status: 'thinking', approvals: [], ask: null, streamStartedAt: 0, streamChars: 0, entries: resolveLocalProblems(state.entries) }))
    void api.agent.retry(sessionId, useSettings.getState().settings?.agentMode ?? 'code').catch((error: Error) => {
      const text = errorText(error)
      if (text === HOST_STOPPED_MESSAGE) set((state) => ({ running: false, status: 'error', entries: withLocalProblem(state.entries, text, HOST_PROBLEM) }))
      else {
        set({ running: false, status: 'error' })
        useUi.getState().notify('error', text)
      }
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
    set({ entries: [], status: 'idle', running: false, approvals: [], ask: null, usageTotals: NO_USAGE })
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
      useUi.getState().notify('error', errorText(error))
    }
  },

  answer: async (text) => {
    const ask = get().ask
    if (!ask) return
    set({ ask: null, status: 'running-tool' })
    try {
      await api.agent.answer(ask.id, text)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  enqueue: (text, options) => {
    const sessionId = getActiveSessionId()
    const queue = enqueue(get().queues[sessionId] ?? [], text, crypto.randomUUID(), options?.attachments)
    set({ queues: { ...get().queues, [sessionId]: queue }, ...(options?.keepDraft ? {} : { draft: '', attachments: [] }) })
  },

  steer: (text, options) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const sessionId = getActiveSessionId()
    // The id is ours, so the entry the request shows for the message is known even if it comes before the answer.
    const id = crypto.randomUUID()
    set((state) => ({
      steering: { ...state.steering, [sessionId]: [...(state.steering[sessionId] ?? []), { id, text: trimmed }] },
      ...(options?.keepDraft ? {} : { draft: '' }),
    }))
    // Not taken: a request that still runs gives it back when it ends; one that is over gives it back now.
    const refused = () => {
      if (!isBusy(useStatus.getState().statusById[sessionId])) giveBack(sessionId)
    }
    void api.agent.steer(sessionId, trimmed, id).then((taken) => {
      if (!taken) refused()
    }, refused)
  },

  sendQueued: (id) => {
    const sessionId = getActiveSessionId()
    const { taken, rest } = takeQueued(get().queues[sessionId] ?? [], id)
    if (!taken) return
    // A running request reads words only: pictures and files wait for a request of their own.
    if (get().running && taken.attachments?.length) {
      useUi.getState().notify('info', 'Pictures and files go with a new request, so this message waits until eNCode is done.')
      return
    }
    set({ queues: { ...get().queues, [sessionId]: rest } })
    if (get().running) get().steer(taken.text, { keepDraft: true })
    else get().send(taken.text, taken.attachments, { keepDraft: true })
  },

  followSteers: (event) => {
    const sessionId = event.sessionId
    if (!sessionId) return
    if (event.type === 'entry') {
      const list = get().steering[sessionId]
      if (event.entry.kind === 'steer' && list?.some((item) => item.id === event.entry.id)) {
        set((state) => ({ steering: { ...state.steering, [sessionId]: removeQueued(state.steering[sessionId] ?? [], event.entry.id) } }))
      }
      return
    }
    const ended = event.type === 'done' || event.type === 'error' || event.type === 'session-reset' || (event.type === 'status' && !isBusy(event.status))
    if (ended) giveBack(sessionId)
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
    set({ queues: { ...get().queues, [sessionId]: rest }, draft: mergeDraft(get().draft, taken.text), attachments: [...get().attachments, ...(taken.attachments ?? [])] })
  },

  drainQueue: (sessionId) => {
    const { next, rest } = dequeue(get().queues[sessionId] ?? [])
    if (!next) return
    set({ queues: { ...get().queues, [sessionId]: rest } })
    if (sessionId === getActiveSessionId()) {
      get().send(next.text, next.attachments, { keepDraft: true })
      return
    }
    // A session in the background: start it directly; its events reach the sidebar through the sessions store.
    void api.agent
      .start(sessionId, { text: next.text, mode: useSettings.getState().settings?.agentMode ?? 'code', ...startInput(next.attachments ?? []) })
      .catch((error: Error) => useUi.getState().notify('error', errorText(error)))
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
          // A thought belongs to the model call under way: whatever comes next is not it.
          ...(event.status === 'thinking' ? {} : { thinking: null }),
          // Cards leave when you answer them, or when the run ends (stopping, for one, ends the wait); a background
          // subagent's stay until it has its answer.
          ...(event.status === 'idle' || event.status === 'done' || event.status === 'error' ? outlives(state) : { approvals: state.approvals }),
          ...(event.status === 'awaiting-user' ? {} : { ask: state.ask?.background ? state.ask : null }),
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
          ask: { id: event.id, entryId: event.entryId, question: event.question, options: event.options, ...(event.background ? { background: true } : {}) },
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
            thinking: null,
            ...outlives(state),
            tokensPerSecond: measured || state.tokensPerSecond,
            streamStartedAt: 0,
            streamChars: 0,
          }
        })
        break
      case 'error':
        // The problem is in the chat: the session's own entry, or, when the session could not make one, the app's.
        set((state) => ({
          running: false,
          status: 'error',
          thinking: null,
          ...outlives(state),
          entries: event.entryId ? state.entries : withLocalProblem(state.entries, event.message, event.problem ?? HOST_PROBLEM),
        }))
        // A model notice that said the same thing a moment ago (a refused key) is now said by the card, with its buttons.
        if (useUi.getState().toast?.kind === 'error' && event.message.startsWith(useUi.getState().toast!.text)) useUi.getState().dismissToast()
        break
      case 'session-reset':
        set({
          entries: [],
          status: 'idle',
          running: false,
          approvals: [],
          ask: null,
          thinking: null,
          usageTotals: NO_USAGE,
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
      case 'thinking':
        set({ thinking: event.thinking })
        break
      case 'plan':
        set({ plan: event.plan })
        break
      case 'mode':
        // The agent went into plan mode itself: what you send next stays in plan mode until you approve its plan.
        if (useSettings.getState().settings?.agentMode !== event.mode) void useSettings.getState().save({ agentMode: event.mode })
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
