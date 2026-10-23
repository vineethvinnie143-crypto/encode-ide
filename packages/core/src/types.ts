/**
 * The loop's seams: what it is told (settings, a conversation to extend), what
 * it reports and asks (a surface), and how a turn ends. A session wires them
 * to the UI and the log; a subagent wires them to its parent.
 */
import type { PauseReason, ReasoningEffort, SystemPart, ToolDefinition, Usage, UserBlock } from '@encode/providers'
import type { AgentMode, DiffHunk, PlanConsent, PlanVerdict, Question, TodoInput } from '@encode/tools'
import type { Message } from '@encode/providers'
import type { AgentStatus, ApprovalPolicy, ConversationEntry, ProblemCode } from './ui'

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
  /** Offer the Computer tool (mouse, keyboard and screen), where the host has a desktop to give. Applies from the next turn. */
  computer?: boolean
  /** Compact before the prompt passes this many tokens, whatever the window. 200,000 when absent. */
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
  /** The rules "Always allow" would save for this call; absent when no rule could vouch for it. */
  always?: AlwaysAllow
  /** Under Auto review, why the Reviewer did not answer: the fixed checks' reason, or the Reviewer's own. */
  review?: { by: 'floor' | 'reviewer'; reason: string }
  /** Hidden or look-alike characters in what the call adds, one line each. */
  warnings?: string[]
  /** Asked by a subagent working in the background: it stays when the main agent's turn ends. */
  background?: boolean
}

/** What "Always allow" would save: the rules, and what they say in a phrase. */
export interface AlwaysAllow {
  /** "npm run build, and anything after it". */
  label: string
  /** In permission-rule syntax, as they will be written to the settings file. */
  rules: string[]
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
  /** Whether the user already allowed this grant for the rest of the session, so nothing needs to judge it again. */
  granted?(grant: string): boolean
  /** One answer to one question. `background`: a subagent in the background asks, and the question outlives the turn. */
  ask(entryId: string, question: Question, signal: AbortSignal, options?: { background?: boolean }): Promise<string>
  /** Whether the user wants a plan agreed first (EnterPlanMode); `reason` is the agent's, for the user. */
  enterPlan(entryId: string, reason: string, signal: AbortSignal): Promise<PlanConsent>
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

/**
 * Messages the user sent to steer the running turn. The loop takes them in between two steps, with the results
 * of the step that ran (or after a reply that would have ended the turn), so they belong to the turn they steer.
 */
export interface Steers {
  /**
   * A message is waiting. `end`: the model has just given its final answer, and only a message that should keep the
   * turn going counts (the person's, not background news, which waits for a turn of its own).
   */
  waiting(at?: 'end'): boolean
  /** The waiting messages as the model reads them, shown in the transcript as they are taken; empty when none is left to read. Never rejects. */
  take(signal: AbortSignal): Promise<UserBlock[]>
  /** The turn is ending: it takes no more, and a message sent from now on waits for the next turn. */
  close(): void
}

export type TurnEnd =
  /** The model answered without calling a tool. */
  | { kind: 'done'; reply: string }
  /** A tool ended the turn (a completion report, a finished goal, a plan left for the user). */
  | { kind: 'stopped'; summary: string }
  | { kind: 'max-steps'; steps: number }
  /** No model could run now. */
  /** No model could run now. `message` is plain; `detail` the longer account (see CompletionOutcome). */
  | { kind: 'paused'; reason: PauseReason; message: string; detail?: string; retryAt?: number }
  /** The request cannot go on. `message` is plain, for the person; `code` what kind of trouble it is. */
  | { kind: 'failed'; message: string; code?: ProblemCode; detail?: string }
  /** The turn did not run to its end: the user stopped it, or a hook refused the request. */
  | { kind: 'cancelled' }

/** How the loop itself can end a turn; it signals a stop by throwing. */
export type LoopEnd = Exclude<TurnEnd, { kind: 'cancelled' }>
