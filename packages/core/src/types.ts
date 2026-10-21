/**
 * The loop's seams: what it is told (settings, a conversation to extend), what
 * it reports and asks (a surface), and how a turn ends. A session wires them
 * to the UI and the log; a subagent wires them to its parent.
 */
import type { PauseReason, ReasoningEffort, SystemPart, ToolDefinition, Usage } from '@encode/providers'
import type { AgentMode, DiffHunk, PlanVerdict, Question, TodoInput } from '@encode/tools'
import type { Message } from '@encode/providers'
import type { AgentStatus, ApprovalPolicy, ConversationEntry } from './ui'

export interface AgentSettings {
  policy: ApprovalPolicy
  /** Steps per turn (a step is one model call and its tool calls). Clamped to 1..100. */
  maxSteps: number
  /** How many times an active goal restarts the agent on its own. */
  maxGoalRounds: number
  reasoning?: ReasoningEffort
  temperature?: number
  /** Offer attempt_completion, for models that do not end a turn by themselves. */
  completionTool?: boolean
  /** Compact before the prompt passes this many tokens, whatever the window. */
  contextCap?: number
}

export const DEFAULT_SETTINGS: AgentSettings = { policy: 'workspace-write', maxSteps: 30, maxGoalRounds: 8 }

export class AgentAbortedError extends Error {
  constructor() {
    super('Stopped.')
    this.name = 'AgentAbortedError'
  }
}

export interface ApprovalPrompt {
  entryId: string
  tool: string
  title: string
  detail: string
  reason?: string
  input: Record<string, unknown>
  preview?: DiffHunk[]
  /** Names what the user would approve for the rest of the session; absent when each call must be asked. */
  grant?: string
}

export interface ApprovalResult {
  approved: boolean
  /** What the user said when refusing, for the model to read. */
  note?: string
}

export type NewEntry = Omit<ConversationEntry, 'id' | 'createdAt'> & { id?: string }

/**
 * What the loop shows and asks. The session's surface talks to the UI and
 * stores the transcript; a subagent's passes approvals and questions to its
 * parent and shows nothing of its own.
 */
export interface Surface {
  status(status: AgentStatus): void
  /** Adds a transcript entry and shows it. Entries are stored once they settle. */
  entry(entry: NewEntry): ConversationEntry
  /** The entry changed while it is still in flight: show it. */
  update(entry: ConversationEntry): void
  /** The entry is final: show it and store it. */
  settle(entry: ConversationEntry): void
  delta(entry: ConversationEntry, text: string): void
  usage(usage: Usage): void
  fileChanged(path: string): void
  /** Resolves approved when the user approves; not approved when they refuse or the signal aborts. */
  approve(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalResult>
  /** One answer to one question. */
  ask(entryId: string, question: Question, signal: AbortSignal): Promise<string>
  proposePlan(entryId: string, plan: string, signal: AbortSignal): Promise<PlanVerdict>
  setTodos(todos: TodoInput[]): void
}

/** The messages the model reads. The loop only ever appends, except through `replace`. */
export interface Conversation {
  messages(): readonly Message[]
  /** Appends a message and stores it. */
  add(message: Message, meta: { turnId: string; usage?: Usage }): Promise<void>
  /** Swaps the whole conversation after a rewrite: compaction, elision or repair. */
  replace(messages: Message[], rewrite: { trigger: 'auto' | 'manual'; summary: string; removed: number; turnId: string }): Promise<void>
  /** Notes the system prompt and tools in force. Resolves true when they differ from the ones stored before. */
  context(system: SystemPart[], tools: ToolDefinition[]): Promise<boolean>
}

export interface Turn {
  /** The id of the user message that started the turn. */
  turnId: string
  mode: AgentMode
  signal: AbortSignal
}

export type TurnEnd =
  /** The model answered without calling a tool. */
  | { kind: 'done'; reply: string }
  /** A tool ended the turn (a completion report, a finished goal, a plan left for the user). */
  | { kind: 'stopped'; summary: string }
  | { kind: 'max-steps'; steps: number }
  /** No model could run now. */
  | { kind: 'paused'; reason: PauseReason; message: string; retryAt?: number }
  | { kind: 'failed'; message: string }
