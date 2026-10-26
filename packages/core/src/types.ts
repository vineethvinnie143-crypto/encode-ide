/**
 * The loop's seams: what it is told (settings, a conversation to extend), what
 * it reports and asks (a surface), and how a turn ends. A session wires them
 * to the UI and the log; a subagent wires them to its parent.
 */
import type { PauseReason, ReasoningEffort, SystemPart, ToolDefinition, Usage, UserBlock } from '@encode/providers'
import type { AgentMode, DiffHunk, PlanConsent, PlanVerdict, Question, TodoInput } from '@encode/tools'
import type { Message } from '@encode/providers'
import type { CheckGate } from './checks'
import type { ContextSignal } from './context-signals'
import type { ErrorGate } from './edit-diagnostics'
import type { GuideSetting } from './guide'
import type { ReviewSetting } from './review'
import type { ModelNotesSetting } from './model-notes'
import type { SmallerHelp, StrongerOffer } from './smaller'
import type { AgentStatus, ApprovalPolicy, ConversationEntry, ProblemCode, ThinkingProgress } from './ui'

export interface AgentSettings {
  policy: ApprovalPolicy
  /** Steps per turn (a step is one model call and its tool calls). Clamped to 1..100. */
  maxSteps: number
  /** How many times an active goal restarts the agent on its own. */
  maxGoalRounds: number
  reasoning?: ReasoningEffort
  /**
   * A step that only reads the results of reads, searches and commands that worked thinks at low effort, on models
   * whose cache a changed effort keeps; the first step, one after a failure and the answer keep the effort set (ADR 0135).
   */
  lightSteps?: boolean
  temperature?: number
  /** Offer attempt_completion, for models that do not end a turn by themselves. */
  completionTool?: boolean
  /** Offer the Computer tool (mouse, keyboard and screen), where the host has a desktop to give. Applies from the next turn. */
  computer?: boolean
  /** Compact before the prompt passes this many tokens, whatever the window. 200,000 when absent. */
  contextCap?: number
  /**
   * When the agent wants to end a turn while the language servers report errors its changes introduced: `auto` sends
   * it back once, `on` up to three times, `off` lets it end. Default `auto`.
   */
  errorGate?: ErrorGate
  /**
   * When the agent wants to end a turn that changed code: `auto` runs the project's typecheck and tests and sends it
   * back up to twice for what its changes broke, `on` up to four times, `off` neither runs them nor checks its reply.
   * Default `auto` (ADR 0095).
   */
  checkGate?: CheckGate
  /** Whether the Reviewer reads a request's changes and a plan before they reach the person (ADR 0096); `auto` when absent. */
  review?: ReviewSetting
  /**
   * Before a command that is hard to undo runs without the person seeing it: `on` asks the agent's model about it once
   * more and leaves it to the person when the answers differ, `off` runs it as allowed. Default `on` (ADR 0097).
   */
  askAgain?: 'on' | 'off'
  /**
   * After a request that set a standing rule or got past a failed command: `on` offers lines for the project's
   * instructions file below the answer, added only on the person's click; `off` never does. Default `on` (ADR 0097).
   */
  learnConventions?: 'on' | 'off'
  /** `auto` (the default): a model that needs no guide gets the short instructions and tool descriptions (ADR 0094). `full`: every model gets the full guide. */
  guide?: GuideSetting
  /**
   * `auto` (the default): a model that is not one of the strong ones gets the help for smaller models, a part after
   * the instructions and its first change held until it says what will change (ADR 0100). `off`: no model does.
   */
  smallerHelp?: SmallerHelp
  /**
   * `ask` (the default): after two setbacks in a request of a smaller model, the person is asked whether the strong
   * model of the Plan or Review role may do the rest of it (ADR 0100). `off`: never.
   */
  offerStronger?: StrongerOffer
  /**
   * `auto` (the default): a model of a family with notes gets them after a role's instructions, such as DeepSeek's
   * Reviewer, told to keep its reasoning short (ADR 0142). `off`: no model does; the benchmark compares the two.
   */
  modelNotes?: ModelNotesSetting
}

/**
 * Steps one request may take before the agent stops and asks to go on. High enough that real work (a weaker model, a
 * server reached over ssh) finishes in one request, as in Claude Code; the person can lower it.
 */
export const DEFAULT_MAX_STEPS = 200
export const MAX_STEPS_LIMIT = 1000

export const DEFAULT_SETTINGS: AgentSettings = { policy: 'workspace-write', maxSteps: DEFAULT_MAX_STEPS, maxGoalRounds: 8 }

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
  review?: { by: 'floor' | 'reviewer' | 'second-look'; reason: string }
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
  /** A model call's measure; `model` names the model that answered, for the Usage page by model. */
  usage(usage: Usage, model?: string): void
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
  /** While the model thinks before it writes: how much so far and its latest words; null once the call ends (ADR 0125). */
  thinking?(progress: ThinkingProgress | null): void
  /** One more of a sign of what compaction did in the request, counted with its usage (ADR 0132). */
  signal?(kind: ContextSignal): void
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
  /** The request took all the steps it may; `reply` is what the agent wrote then, with tools held back (ADR 0124). */
  | { kind: 'max-steps'; steps: number; reply?: string }
  /** No model could run now. `message` is plain; `detail` the longer account (see CompletionOutcome). */
  | { kind: 'paused'; reason: PauseReason; message: string; detail?: string; retryAt?: number }
  /** The request cannot go on. `message` is plain, for the person; `code` what kind of trouble it is. */
  | { kind: 'failed'; message: string; code?: ProblemCode; detail?: string }
  /** The turn did not run to its end: the user stopped it, or a hook refused the request. */
  | { kind: 'cancelled' }

/** How the loop itself can end a turn; it signals a stop by throwing. */
export type LoopEnd = Exclude<TurnEnd, { kind: 'cancelled' }>
