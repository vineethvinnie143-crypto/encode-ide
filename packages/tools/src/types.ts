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
import type { ImageBlock, TextBlock, ToolDefinition } from '@encode/providers'

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
  /** Runs a shell line in `cwd`. */
  | { type: 'command'; command: string; cwd: string; background: boolean }
  /** Fetches from the network. */
  | { type: 'web'; url: string }
  /** Starts a subagent, which asks for its own calls. */
  | { type: 'agent' }
  /** A tool from outside eNCode (MCP); every call asks unless a rule allows it. */
  | { type: 'external'; server: string }

/** How a call reads in an approval card and in the transcript. */
export interface ToolSummary {
  /** One line: "Edit src/app.ts", "Run npm test". */
  title: string
  /** More context: the command, the URL, the question. */
  detail?: string
  /** A diff preview for writes. */
  preview?: DiffHunk[]
}

export interface ToolOutcome {
  /** False when the call failed; the model sees an error result. */
  ok: boolean
  /** What the model reads. */
  content: string | (TextBlock | ImageBlock)[]
  /** What the UI shows, when it differs from what the model reads. */
  display?: {
    output?: string
    diff?: DiffHunk[]
  }
  /** Paths the call created, changed or deleted. */
  changed?: string[]
  /** Ends the turn after this step, with a summary for the user. */
  stop?: { summary: string }
  /** The session continues in this mode (ExitPlanMode, once the plan is approved). */
  mode?: AgentMode
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
  /** Rules the schema cannot express, checked after it passes. Returns what is wrong. */
  check?(input: Input): string | undefined
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
}

export interface FileStateTracker {
  get(path: string): FileState | undefined
  set(path: string, state: FileState): void
  delete(path: string): void
  /** Every path and state, for a subagent that inherits what its parent read. */
  entries(): [string, FileState][]
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

export interface ShellState {
  /** Where the next command starts. */
  cwd: string
  /** The environment the next command starts with, exports included. */
  env: Record<string, string>
  dialect: ShellDialect
}

export interface ShellAssessment {
  decision: 'allow' | 'ask' | 'deny'
  /** Short and user-facing. */
  reason: string
  /** Absolute paths the line may touch, when known. */
  paths?: string[]
  /** External programs the line starts, as typed. */
  programs?: string[]
}

/** Judges a shell line before it runs. eNCode's own command rules plug in here. */
export type ShellCommandAssessor = (
  line: string,
  context: { root: string; cwd: string; home: string; env: Record<string, string>; dialect: ShellDialect },
) => Promise<ShellAssessment>

export interface ShellRunOptions {
  /** ms; clamped to the shell's maximum. */
  timeoutMs?: number
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
}

export interface JobManager {
  start(command: string, options: { cwd?: string }): Promise<JobInfo>
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
}

export interface SkillSummary {
  name: string
  description: string
}

export interface Interaction {
  /** AskUserQuestion: one answer per question, as the user's text (labels joined for multi-select). */
  ask(questions: Question[], signal: AbortSignal): Promise<string[]>
  /** ExitPlanMode: the user's verdict on a plan. */
  proposePlan(plan: string, signal: AbortSignal): Promise<PlanVerdict>
  setTodos(todos: TodoInput[]): void
}

export interface Subagents {
  types(): SubagentType[]
  /** Runs a subagent to completion; resolves to its final report. */
  run(request: SubagentRequest, signal: AbortSignal): Promise<{ ok: boolean; report: string }>
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
  readonly home: string
  readonly platform: NodeJS.Platform
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
  readonly interaction: Interaction
  readonly subagents?: Subagents
  readonly skills?: Skills
  readonly goals?: Goals
  /**
   * Awaited before every write, with the file's previous bytes (null when it
   * did not exist). Checkpoints hook in here; a rejection fails the write.
   */
  beforeWrite?(path: string, previous: Buffer | null, info: WriteInfo): Promise<void>
  /** Streams live output of a long call to the UI. */
  progress?(text: string): void
  /**
   * Answers `prompt` about `content` with a small, fast model (WebFetch).
   * Without it, WebFetch returns the page text itself.
   */
  summarize?(request: { source: string; content: string; prompt: string }, signal: AbortSignal): Promise<string>
}
