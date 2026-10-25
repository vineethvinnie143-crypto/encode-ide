/**
 * The contract between the agent and its tools.
 *
 * A tool declares what it is (its definition, kind and whether it only
 * reads), what a call would touch (`access`, which the approval policy
 * judges), and how to run it. Everything a tool needs from the outside world
 * comes through `ToolContext`, so the same tool runs in the desktop app's
 * agent host, in the CLI, and in tests against a temporary directory.
 *
 * Seams other milestones build on, kept stable:
 *   - `ToolContext.beforeWrite`: awaited before every file write (checkpoints).
 *   - `SpawnWrapper`: rewrites how a shell command is spawned (sandboxing).
 *   - `ShellCommandAssessor`: judges a shell line (eNCode's own command rules).
 *   - `ToolRegistry.register`: tools from outside (MCP), with their own schema.
 */
import type { IndexedFile } from './codemap/rank'
import type { LanguageServers, NativeDoc } from '@encode/lsp'
import type { ToolDefinition, ToolResultContent } from '@encode/providers'
import type { BrowserHandle } from './browser/tool'
import type { DesktopHandle } from './computer/state'
import type { OffLimits } from './paths'

export type AgentMode = 'code' | 'ask' | 'plan'

export type ToolKind = 'read' | 'write' | 'command' | 'web' | 'interaction' | 'agent' | 'other'

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

/** What a call would touch. The approval policy decides from this, never from the tool's name. */
export type ToolAccess =
  /** Touches nothing outside the session: todos, questions, plans. */
  | { type: 'none' }
  /** Reads these absolute paths. */
  | { type: 'read'; paths: string[] }
  /** Creates, changes or deletes these absolute paths. */
  | { type: 'write'; paths: string[] }
  /** Runs a shell line in `cwd`. `unsandboxed`: it asks to run outside the sandbox, which only the person may allow. */
  | { type: 'command'; command: string; cwd: string; background: boolean; unsandboxed?: boolean }
  /** Fetches from the network. */
  | { type: 'web'; url: string }
  /** Starts a subagent, which asks for its own calls. */
  | { type: 'agent' }
  /**
   * A tool from outside eNCode (MCP); every call asks unless a rule allows it. `tool` is the tool's name as
   * permission rules spell it (the `ruleTool` of its identity), so a rule can name one tool of a server.
   */
  | { type: 'external'; server: string; tool?: string }
  /**
   * Sees or operates an application on the desktop. `app` is its program (notepad.exe), `label` its name
   * for people, `title` the window's. `blocked` says why it can never be used, when it cannot.
   */
  | { type: 'desktop'; app: string; label: string; title: string; blocked?: string }

/** How a call reads in an approval card and in the transcript. */
export interface ToolSummary {
  /** One line: "Edit src/app.ts", "Run npm test". */
  title: string
  /** More context: the command, the URL, the question. */
  detail?: string
  /** A diff preview for writes. */
  preview?: DiffHunk[]
}

/** Something the app can do about a step, offered beside it. `search-key`: add a free search key (ADR 0123). */
export type ToolOffer = 'search-key'

export interface ToolOutcome {
  /** False when the call failed; the model sees an error result. */
  ok: boolean
  /** What the model reads. */
  content: string | ToolResultContent[]
  /** What the UI shows, when it differs from what the model reads. */
  display?: {
    output?: string
    diff?: DiffHunk[]
    offer?: ToolOffer
  }
  /** Paths the call created, changed or deleted. */
  changed?: string[]
  /** Ends the turn after this step, with a summary for the user. */
  stop?: { summary: string }
  /** The session continues in this mode (EnterPlanMode, and ExitPlanMode once the plan is approved). */
  mode?: AgentMode
  /**
   * What the model reads in place of `content` when the loop can keep `content` whole in a file: a command's output made
   * smaller by what the command is (ADR 0133). `note` says what it left out; the loop adds where the whole is.
   */
  digest?: { content: string; note: string }
}

/** A call read in a tool's shape (Tool.reshape): the input, what was changed, and the tool that runs it if another one. */
export interface Reshaped {
  input: Record<string, unknown>
  fixes: string[]
  tool?: string
}

export interface Tool<Input extends Record<string, unknown> = Record<string, unknown>> {
  readonly definition: ToolDefinition
  readonly kind: ToolKind
  /**
   * Changes nothing outside the session. Read-only tools run in plan and ask
   * modes, and run concurrently with each other.
   */
  readonly readOnly: boolean
  /** Modes that offer the tool. Default: every mode when read-only, `code` otherwise. */
  readonly modes?: readonly AgentMode[]
  /**
   * For tools there can be many of (those of MCP servers): once their definitions together are long, only their names
   * are listed, and a definition is sent when the model asks for it with ToolSearch (tool-search.ts). `always`: a
   * built-in tool that is seldom needed waits for ToolSearch however few tools there are, as in Claude Code.
   */
  readonly defer?: boolean | 'always'
  /**
   * Seldom needed, and paid for in full on every step by a model without a prompt cache: such a model is sent its name
   * in ToolSearch and its definition once ToolSearch loads it (ADR 0136). Models with a cache keep it in their list.
   */
  readonly seldom?: boolean
  /** Its results keep within a size of their own, which says how to read on (Read): never kept in a file for being long (ADR 0093). */
  readonly bounded?: boolean
  /**
   * The description sent to a model that needs no guide (ADR 0094): what the tool does and the rules a call must keep,
   * without the advice such a model follows unasked. Absent: the description is sent to every model.
   */
  readonly brief?: string
  /** Rules the schema cannot express, checked after it passes. Returns what is wrong. */
  check?(input: Input): string | undefined
  /**
   * The call in this tool's own shape, when a model sent it in a shape that can mean one thing only (MultiEdit's list
   * of edits to Edit, SEARCH/REPLACE blocks): tried before the schema's own repairs, on input that fails the schema.
   */
  reshape?(input: Record<string, unknown>): Reshaped | undefined
  /** What the call would touch, with paths resolved against the context. */
  access(input: Input, context: ToolContext): ToolAccess | Promise<ToolAccess>
  /** How the call reads in an approval card; may read the disk for a diff preview. */
  describe(input: Input, context: ToolContext): ToolSummary | Promise<ToolSummary>
  run(input: Input, context: ToolContext): Promise<ToolOutcome>
}

// ---------------------------------------------------------------------------
// Files

/** What the agent last saw of a file. Writes check it, so the agent never overwrites what it has not read. */
export interface FileState {
  /** sha256 of the bytes it saw, hex. */
  hash: string
  mtimeMs: number
  size: number
  /** True when it saw only a range of lines. */
  partial: boolean
  readAt: number
  /**
   * The lines Read put in the conversation last, while that output is still in it. Only Read sets it; a write, a
   * rewind and every rewrite of the history (a shortened output, a summary) clear it, because from then on the
   * conversation no longer holds those lines as they are.
   */
  seen?: { from: number; to: number; chars: number }
}

export interface FileStateTracker {
  get(path: string): FileState | undefined
  set(path: string, state: FileState): void
  delete(path: string): void
  /** Every path and state, for a subagent that inherits what its parent read. */
  entries(): [string, FileState][]
  /** The conversation was rewritten and no longer holds what Read showed: the next Read shows the lines again. */
  forgetSeen(): void
}

/** Who is writing, for checkpoints keyed by turn. */
export interface WriteInfo {
  /** The record id of the user message that started the turn. */
  turnId: string
  toolUseId: string
}

// ---------------------------------------------------------------------------
// The shell

export type ShellDialect = 'bash' | 'pwsh'

export interface SpawnSpec {
  /** Absolute path of the program. */
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** Rewrites how a command is spawned, to run it inside a sandbox. Must return an absolute `file`. */
export type SpawnWrapper = (spec: SpawnSpec) => SpawnSpec | Promise<SpawnSpec>

/** What the shell knows of the sandbox around its commands (absent where it has none). */
export interface SandboxView {
  /** Commands are confined right now. False when the sandbox is off or unavailable. */
  active: boolean
  /** A command may ask to run outside it; the person is asked each time. */
  allowUnsandboxed: boolean
}

export interface ShellState {
  /** Where the next command starts. */
  cwd: string
  /** The environment the next command starts with, exports included. */
  env: Record<string, string>
  dialect: ShellDialect
  sandbox?: SandboxView
}

export interface ShellAssessment {
  decision: 'allow' | 'ask' | 'deny'
  /** Short and user-facing. */
  reason: string
  /** Absolute paths the line may touch, when known. */
  paths?: string[]
  /** External programs the line starts, as typed. */
  programs?: string[]
  /**
   * What decided: a permission rule (the user's word, which says nothing about what the line does), the
   * read-only check, or neither. Without it an allow is a read-only proof, as the built-in assessor's is.
   */
  source?: 'rule' | 'read-only' | 'default'
  /** For an allow by a rule: whether the line is also proven read-only, which is all a Read Only policy runs. */
  readOnly?: boolean
}

/** Judges a shell line before it runs. eNCode's own command rules plug in here. */
export type ShellCommandAssessor = (
  line: string,
  context: { root: string; cwd: string; home: string; env: Record<string, string>; dialect: ShellDialect },
) => Promise<ShellAssessment>

export interface ShellRunOptions {
  /** ms; clamped to the shell's maximum. */
  timeoutMs?: number
  /** Run outside the sandbox. The caller has been allowed by the person; the shell does not ask. */
  unsandboxed?: boolean
  signal: AbortSignal
  /** Live output, for the UI. */
  onOutput?(text: string): void
}

export interface ShellResult {
  /** Combined stdout and stderr, in arrival order, truncated in the middle when long. */
  output: string
  exitCode: number | null
  /** The signal that ended it, when one did. */
  signal?: string
  timedOut: boolean
  interrupted: boolean
  /** The directory the command ended in; the next command starts there. */
  cwd: string
  /** Something the model should know, such as the directory being reset to the workspace root. */
  notice?: string
}

export interface AgentShell {
  readonly dialect: ShellDialect
  /** Absolute path of the shell program. */
  readonly program: string
  state(): ShellState
  run(command: string, options: ShellRunOptions): Promise<ShellResult>
}

// ---------------------------------------------------------------------------
// Background jobs

export type JobStatus = 'running' | 'done' | 'error' | 'killed'

export interface JobInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  status: JobStatus
  exitCode?: number
  /** `monitor`: its lines reach the agent as they come (Monitor). Default `command`. */
  kind?: 'command' | 'monitor'
  /** What the agent said the job is for. */
  description?: string
  /** The agent that started it: 'main', or a subagent's id. */
  agentId?: string
}

export interface JobStartOptions {
  cwd?: string
  unsandboxed?: boolean
  kind?: 'command' | 'monitor'
  description?: string
  agentId?: string
  /** Output as it comes, after ANSI codes are taken out. */
  onOutput?(text: string): void
}

export interface JobManager {
  start(command: string, options: JobStartOptions): Promise<JobInfo>
  /** Output since the last read, optionally only lines matching `filter`. */
  read(id: string, options?: { filter?: RegExp }): { job: JobInfo; output: string } | undefined
  kill(id: string): Promise<boolean>
  list(): JobInfo[]
}

// ---------------------------------------------------------------------------
// The web

export interface FetchedPage {
  url: string
  /** After redirects. */
  finalUrl: string
  status: number
  contentType: string
  /** Markdown-ish text of the page, or the raw text for non-HTML. */
  text: string
  truncated: boolean
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebAccess {
  fetch(url: string, signal: AbortSignal): Promise<FetchedPage>
  search(query: string, options: { allowedDomains?: string[]; blockedDomains?: string[]; signal: AbortSignal }): Promise<SearchHit[]>
  /** The address a search is sent to now, which is what the approval of a search names. */
  searchTarget?(): string
}

// ---------------------------------------------------------------------------
// Interaction with the user and the session

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  /** A short label for the question, 12 characters at most. */
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface TodoInput {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The present-continuous form shown while it runs: "Running tests". */
  activeForm: string
}

/** The user's answer to the agent asking to plan first. */
export interface PlanConsent {
  approved: boolean
  /** What the user said with a refusal. */
  note?: string
}

export interface PlanVerdict {
  approved: boolean
  /** What the user said instead, when they did not approve. */
  feedback?: string
  /** The user will answer later, in a new turn: end this one. */
  deferred?: boolean
}

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked'

export interface GoalState {
  text: string
  status: GoalStatus
  rounds: number
  createdAt: number
  updatedAt: number
}

export interface Goals {
  get(): GoalState | null
  set(goal: GoalState | null): void
}

export interface SubagentType {
  name: string
  description: string
  /** Tools it may use; undefined for every tool its mode offers. */
  tools?: string[]
}

export interface SubagentRequest {
  description: string
  prompt: string
  type: string
  toolUseId: string
  /** The mode of the call that started it; a subagent never has more freedom than its parent. */
  mode: AgentMode
  /** The transcript entry of the call, so the subagent's questions and approvals show under it. */
  entryId?: string
  /** Shows what the subagent is doing on the call's card while it works. */
  progress?: (text: string) => void
  /** The main agent's request it works for: what its file changes are recorded under, for Rewind and Review. */
  turnId?: string
}

/** What a subagent came back with. `agentId` names it for SendMessage. */
export interface SubagentResult {
  ok: boolean
  report: string
  agentId?: string
}

/** SendMessage: a message for a subagent that is running, or one that ended and goes on from where it stopped. */
export interface SubagentMessage {
  to: string
  text: string
  /** Go on in the background and report through a notice, instead of waiting for the reply. */
  background: boolean
  toolUseId: string
  mode: AgentMode
  entryId?: string
  progress?: (text: string) => void
  turnId?: string
}

export interface SkillSummary {
  name: string
  description: string
}

export interface Interaction {
  /** AskUserQuestion: one answer per question, as the user's text (labels joined for multi-select). */
  ask(questions: Question[], signal: AbortSignal): Promise<string[]>
  /** EnterPlanMode: whether the user wants a plan agreed first. */
  enterPlan(reason: string, signal: AbortSignal): Promise<PlanConsent>
  /** ExitPlanMode: the user's verdict on a plan. */
  proposePlan(plan: string, signal: AbortSignal): Promise<PlanVerdict>
  setTodos(todos: TodoInput[]): void
}

export interface Subagents {
  types(): SubagentType[]
  /** Runs a subagent to completion; resolves to its final report. */
  run(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult>
  /** Starts a subagent in the background and returns at once; its report reaches the main agent as a notice. */
  start?(request: SubagentRequest): Promise<{ ok: true; agentId: string } | { ok: false; report: string }>
  /**
   * A message for a subagent. One that runs reads it between two of its steps (`delivered`); one that ended goes on
   * from where it stopped, with its whole conversation, also after eNCode was restarted.
   */
  message?(request: SubagentMessage, signal: AbortSignal): Promise<SubagentResult & { delivered?: boolean }>
  /** Stops a subagent running in the background. Undefined when no subagent has that id. */
  stop?(agentId: string): Promise<{ stopped: boolean; description: string } | undefined>
}

/**
 * Work that goes on while the agent does something else, and comes back to it as a notice: a command whose lines it
 * watches (Monitor), and a wake-up it asked for (ScheduleWakeup). The main agent's only.
 */
export interface BackgroundWork {
  /** Starts a command whose output lines reach the agent as notices, in batches. `timeoutMs` null: until it ends. */
  monitor(request: { command: string; description: string; cwd: string; timeoutMs: number | null }): Promise<{ ok: true; id: string } | { ok: false; reason: string }>
  /** Sets the session's one wake-up, replacing the one before. */
  wake(request: { delayMs: number; reason: string; prompt: string }): { at: number; replaced: boolean }
  /** Cancels the wake-up; false when none was set. */
  cancelWake(): boolean
}

/** A git worktree the agent works in, inside the project at `.encode-worktrees/<name>`, on a branch of its own. */
export interface WorktreeInfo {
  name: string
  /** The worktree's folder, absolute. */
  path: string
  branch: string
  /** The commit it started from. */
  base: string
  /** The branch the project was on when it started, when it was on one. */
  from?: string
}

/** What keeps a worktree from being removed: changes not committed, and commits on its branch only. */
export interface WorktreeWork {
  changed: string[]
  commits: number
}

/** EnterWorktree and ExitWorktree. The main agent's only: a subagent works where the main agent works. */
export interface Worktrees {
  current(): WorktreeInfo | null
  enter(request: { name?: string }, signal: AbortSignal): Promise<{ ok: true; worktree: WorktreeInfo } | { ok: false; reason: string }>
  /** `remove` refuses when there is work in it, unless `discard`. */
  exit(
    request: { action: 'keep' | 'remove'; discard: boolean },
    signal: AbortSignal,
  ): Promise<{ ok: true; left: WorktreeInfo; removed: boolean } | { ok: false; reason: string; work?: WorktreeWork }>
}

/**
 * The project's language servers (@encode/lsp), shared with the editor: lookups and diagnostics for LSP, edit plans
 * for LSPEdit, and what the loop tells them of the files the tools change.
 */
export type CodeIntelligence = Pick<
  LanguageServers,
  | 'covers'
  | 'known'
  | 'prefetch'
  | 'changed'
  | 'diagnostics'
  | 'definition'
  | 'typeDefinition'
  | 'implementation'
  | 'references'
  | 'hover'
  | 'documentSymbols'
  | 'workspaceSymbols'
  | 'calls'
  | 'rename'
  | 'codeActions'
  | 'actionEdit'
  | 'runActionCommand'
  | 'status'
>

/** The code map of a folder (ADR 0090): its files' definitions and the names they use, only the files the agent may read. */
export interface CodeMapSource {
  files(dir: string, signal?: AbortSignal): Promise<{ files: IndexedFile[]; truncated: boolean }>
  /** A tool changed a file: the index reads it again before its next use. */
  changed?(file: string): void
  /** FiveM's natives, when eNCode installed them (ADR 0091). */
  natives?(): readonly NativeDoc[] | undefined
  /** False for a file the person's rules forbid reading, wherever it is; a package lookup leaves it out. */
  readable?(file: string): boolean
}

export interface Skills {
  list(): SkillSummary[]
  /** The skill's instructions, with its base directory, or undefined. */
  load(name: string): Promise<{ name: string; directory: string; body: string } | undefined>
}

// ---------------------------------------------------------------------------
// The context

export interface ToolContext {
  /** The workspace root, as a real path. */
  readonly root: string
  /**
   * Where the agent works: the root, or the worktree it entered (inside the root). Relative paths and searches start
   * here. Absent means the root.
   */
  readonly cwd?: string
  readonly home: string
  readonly platform: NodeJS.Platform
  /** eNCode's own folders, which searches never enter (approvals refuse a call that names them). */
  readonly offLimits?: OffLimits
  readonly sessionId: string
  /** 'main', or the subagent's id. */
  readonly agentId: string
  readonly mode: AgentMode
  /** The record id of the user message that started the turn. */
  readonly turnId: string
  /** The call being run. */
  readonly toolUseId: string
  readonly signal: AbortSignal
  readonly files: FileStateTracker
  readonly shell: AgentShell
  readonly jobs: JobManager
  readonly web: WebAccess
  /** The way to the desktop for the Computer tool; absent where there is none. */
  readonly desktop?: DesktopHandle
  /** The agent's Browser tab, for the Browser tool; absent outside the desktop app. */
  readonly browser?: BrowserHandle
  readonly interaction: Interaction
  readonly subagents?: Subagents
  readonly skills?: Skills
  readonly goals?: Goals
  /** Monitor and ScheduleWakeup; absent for subagents. */
  readonly background?: BackgroundWork
  /** EnterWorktree and ExitWorktree; absent for subagents and outside a git repository. */
  readonly worktrees?: Worktrees
  /** LSP and LSPEdit; absent where no language servers may run (a folder not trusted, servers turned off). */
  readonly code?: CodeIntelligence
  /** CodeMap; absent where no index is kept. */
  readonly codeMap?: CodeMapSource
  /**
   * Awaited before every write, with the file's previous bytes (null when it
   * did not exist). Checkpoints hook in here; a rejection fails the write.
   */
  beforeWrite?(path: string, previous: Buffer | null, info: WriteInfo): Promise<void>
  /** Whether the model that answered last reads PDFs as documents (Read then attaches pages with figures). */
  readsDocuments?(): boolean
  /** Streams live output of a long call to the UI. */
  progress?(text: string): void
  /**
   * Answers `prompt` about `content` with a small, fast model (WebFetch).
   * Without it, WebFetch returns the page text itself.
   */
  summarize?(request: { source: string; content: string; prompt: string }, signal: AbortSignal): Promise<string>
}
