/**
 * What the agent shows a client: conversation entries, approval requests,
 * todos, goals, plans and the events that carry them.
 *
 * These mirror the desktop app's renderer API (apps/desktop/shared/types.ts)
 * shape for shape; the desktop's agent host checks at compile time that each
 * is assignable to the renderer's, so the renderer keeps its API unchanged.
 */
import type { PauseReason } from '@encode/providers'
import type { AgentMode, DiffHunk, JobStatus } from '@encode/tools'

export type { AgentMode, DiffHunk, DiffLine } from '@encode/tools'

export type AgentStatus = 'idle' | 'thinking' | 'running-tool' | 'awaiting-approval' | 'awaiting-user' | 'done' | 'error'

export type ApprovalPolicy = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

/** `steer`: a message the user sent while the agent worked, which the running request took in between two steps. */
export type EntryKind = 'user' | 'steer' | 'assistant' | 'tool' | 'notice' | 'error'

/** `reviewing`: under Auto review, the call waits for the Reviewer. */
export type ToolState = 'running' | 'waiting' | 'reviewing' | 'done' | 'rejected' | 'error'

/** What Auto review made of a call. */
export interface ToolReview {
  /** Who looked: the Reviewer model, or the fixed checks that come before it. */
  by: 'reviewer' | 'floor'
  /** `approved`: it ran on this review. `declined`: it did not run. `asked`: the person was asked. */
  verdict: 'approved' | 'declined' | 'asked'
  risk?: 'low' | 'medium' | 'high'
  reason: string
}

/** What the person can do about a problem the chat shows, offered as buttons under it. */
export type ProblemAction = 'retry' | 'switch-model' | 'settings' | 'diagnostics'

/**
 * The kind of trouble behind an error in the chat: why no model could run (the router's reasons), or the loop's and
 * eNCode's own (`context`: the conversation does not fit; `empty`: the model said nothing; `host`: the agent process
 * stopped; `internal`: a fault in eNCode).
 */
export type ProblemCode = PauseReason | 'context' | 'empty' | 'host' | 'internal'

export interface EntryProblem {
  code: ProblemCode
  actions: ProblemAction[]
  /** Epoch ms after which trying again can work. */
  retryAt?: number
  /** The request was tried again from here: the problem offers nothing more. */
  resolved?: boolean
}

export interface ConversationEntry {
  id: string
  kind: EntryKind
  text?: string
  /** True while assistant text is still streaming in. */
  streaming?: boolean
  tool?: {
    name: string
    input: Record<string, unknown>
    output?: string
    ok?: boolean
    diff?: DiffHunk[]
    state?: ToolState
    review?: ToolReview
    /** Hidden or look-alike characters found in what the call wrote, one line each. */
    warnings?: string[]
    /** `encode`: a call eNCode made itself, such as a check before the agent finishes (ADR 0095), not the model. */
    by?: 'encode'
  }
  /** The model that wrote an assistant entry. */
  model?: string
  /** On an error: what kind it is and what can be done about it. */
  problem?: EntryProblem
  /** The longer account behind an error or a notice (what a provider said, keys removed), shown folded. */
  details?: string
  /** On your message: what its request has cost so far. */
  usage?: RequestUsage
  createdAt: number
}

/** The model calls of one request together: the agent's, its subagents' and the reviewer's (ADR 0093). */
export interface RequestUsage {
  calls: number
  /** Every prompt token read, cached or not. */
  inputTokens: number
  /** Of inputTokens, read from the provider's prompt cache. */
  cachedTokens: number
  outputTokens: number
  /** US dollars, when every call reported what it cost. */
  cost?: number
}

export interface ApprovalRequest {
  id: string
  entryId: string
  tool: string
  title: string
  detail: string
  /** Why the policy asks, when it is not obvious from the policy. */
  reason?: string
  input: Record<string, unknown>
  /** A diff preview shown before approving a write. */
  preview?: DiffHunk[]
  /** True when the user may approve this and its like for the rest of the session. */
  grantable?: boolean
  /** The rules "Always allow" would save, shown as they will be written. Absent when no rule could vouch for the call. */
  always?: { label: string; rules: string[] }
  /** Under Auto review: why the Reviewer passed the question to the person. */
  review?: { by: 'floor' | 'reviewer'; reason: string }
  /** Hidden or look-alike characters in what the call adds, one line each. */
  warnings?: string[]
  /** Asked by a subagent in the background: it still waits when the turn ends, or when no turn runs. */
  background?: boolean
}

/** Which settings file a saved rule goes to: every project of the user, the project's shared file, or the project's private one. */
export type RuleScope = 'user' | 'project' | 'local'

/**
 * The user's answer to an approval request. A bare boolean is approve or refuse. `remember` approves for the rest
 * of the session, or saves the rules the request offered (`always`) in the settings file `scope` names, which is
 * the project's private one by default.
 */
export type ApprovalAnswer = boolean | { approved: boolean; note?: string; remember?: 'session' | 'always'; scope?: RuleScope }

/** A question waiting for the user's answer. */
export interface AskRequest {
  id: string
  entryId: string
  question: string
  options?: string[]
  /** Asked by a subagent in the background: it still waits when the turn ends, or when no turn runs. */
  background?: boolean
}

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked'

export interface SessionGoal {
  text: string
  status: GoalStatus
  rounds: number
  createdAt: number
  updatedAt: number
}

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface PlanRequest {
  id: string
  plan: string
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** The project folder the session belongs to; null for a standalone session. */
  projectRoot: string | null
  pinned: boolean
  /** Archived sessions leave the sidebar until restored. */
  archived: boolean
  /** Finished while another session was open. */
  unread: boolean
  /** The start of the last reply on one line, for the Activity view. */
  preview: string
  /** How many entries the conversation has; 0 for a session nobody has used. */
  entryCount: number
  /** When the agent asked to be woken (ScheduleWakeup), epoch ms. */
  wakeAt?: number
  /** The worktree the agent works in (EnterWorktree), by name. */
  worktree?: string
}

/** What a client may change about a session. */
export type SessionPatch = Partial<Pick<SessionSummary, 'title' | 'projectRoot' | 'pinned' | 'archived' | 'unread'>>

/** The start of the last reply on one line. */
export function previewOf(entries: readonly ConversationEntry[], max = 140): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind !== 'assistant' || !entry.text?.trim()) continue
    const flat = entry.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
  }
  return ''
}

export interface AgentStartInput {
  text: string
  mode: AgentMode
  /** File context the user attached to the prompt. */
  attachments?: { path: string; content: string }[]
}

export interface AgentHistory {
  entries: ConversationEntry[]
  status: AgentStatus
  /** The approval card still waiting for an answer, so reopening the session shows it again. */
  approval?: ApprovalRequest | null
  /** Every approval still waiting, oldest first; `approval` is the first. */
  approvals?: ApprovalRequest[]
  /** The question still waiting for an answer. */
  ask?: AskRequest | null
}

/**
 * Something going on in the background of a session: a command, a monitor (a command whose lines reach the agent),
 * a subagent, or the wake-up the agent asked for. For a subagent `command` is its task, `title` its type and `output`
 * what it did last; for a wake-up `command` is its reason, `startedAt` when it fires and `output` its prompt.
 */
export interface BackgroundJob {
  id: string
  command: string
  cwd: string
  sessionId: string
  startedAt: number
  status: JobStatus
  exitCode?: number
  output: string
  /** Default `command`. */
  kind?: 'command' | 'monitor' | 'agent' | 'wakeup'
  /** What the agent said it is for; a subagent's type. */
  title?: string
}

// ------------------------------------------------------------ checkpoints and rewind

/** A request of the user's after which the agent's file tools changed files, for the rewind picker. */
export interface RewindTurn {
  /** The request's id: the id of its entry in the conversation. */
  turn: string
  at: number
  /** Files in the workspace the agent's tools changed in this turn. */
  files: number
  /** Files changed elsewhere, which a rewind does not restore. */
  outside: number
}

export interface CheckpointInfo {
  /** False where nothing is recorded: no folder is open, or the store could not be opened (`problem` says why). */
  available: boolean
  problem?: string
  /** Oldest first. */
  turns: RewindTurn[]
  /** The latest rewind can still be undone. */
  canUndo: boolean
}

export type RewindAction = 'restore' | 'delete' | 'unchanged' | 'skip'

export interface RewindFile {
  /** Relative to the workspace root where the file is inside it. */
  path: string
  action: RewindAction
  /** Why the file is skipped. */
  reason?: string
  /** Not what the agent last left there: putting it back would overwrite someone else's change. */
  conflict: boolean
}

/** What a rewind (or the undoing of one) would do, shown before it is done. */
export interface RewindPlan {
  kind: 'rewind' | 'redo'
  turn: string
  /** False when nothing was recorded for the turn. */
  known: boolean
  files: RewindFile[]
  /** Names the state of the disk and the history the plan was made from; applying a plan whose fingerprint no longer matches is refused. */
  fingerprint: string
}

export interface RewindRequest {
  kind: 'rewind' | 'redo'
  turn: string
  fingerprint: string
  /** Also put back files that changed since the agent last wrote them. */
  force?: boolean
  /** Also go back in the conversation to just before the request (for a rewind; the request comes back as text). */
  conversation?: boolean
}

export type RewindOutcome =
  | {
      ok: true
      restored: number
      deleted: number
      skipped: Array<{ path: string; reason: string }>
      failed: Array<{ path: string; error: string }>
      /** The request, to be edited and sent again, when the conversation went back too. */
      text?: string
    }
  | { ok: false; reason: 'stale' | 'unavailable' | 'busy' | 'failed'; message: string }

// ------------------------------------------------------------ one request's changes, for the Review tab

/** One version of a file as a review reads it. Known only by its hash (`unread`) when it was too large, not kept or lost. */
export type ChangeVersion =
  | { state: 'missing' }
  | { state: 'bytes'; hash: string; bytes: Uint8Array }
  | { state: 'unread'; hash: string | null; size: number; why: 'large' | 'budget' | 'unkept' | 'lost' | 'outside' }

/** One file a request's file tools changed: as the request found it, and as it left it. */
export interface TurnFileChange {
  /** Relative to the workspace root with `/`, or absolute where the file lies outside it. */
  path: string
  /** Absolute, as the tools wrote it: what a write names. */
  file: string
  before: ChangeVersion
  /** The copy a later request kept just before it changed the file again (`later`), or the file now (`now`). */
  after: ChangeVersion
  afterFrom: 'later' | 'now'
  /** Something other than the agent changed the file after the request's last write; `after` holds that too. */
  changedSince: boolean
  /** Why the file cannot be written from the review. */
  fixed?: string
}

export interface TurnChangeSet {
  /** The request shown: the one asked for, or the latest that changed files; null when there is none. */
  turn: string | null
  /** When the request began. */
  at?: number
  /** The workspace root the paths are relative to. */
  root: string
  files: TurnFileChange[]
  /** A turn is running in the session, so nothing can be written until it ends. */
  busy: boolean
  /** Why nothing can be shown, in words. */
  problem?: string
}

/** What the review writes in a file: these bytes, a copy the record keeps (by hash), or nothing (the file goes). */
export interface TurnFileWrite {
  /** As `TurnFileChange.file`. */
  file: string
  /** What the file must hold now (its SHA-256); null: there must be no file. */
  expected: string | null
  next: { bytes: ArrayBuffer } | { kept: string } | null
}

export type TurnWriteOutcome =
  | { ok: true; previous: string | null; written: string | null }
  | { ok: false; reason: 'stale' | 'refused' | 'busy' | 'unavailable'; message: string }

export type AgentEventBody =
  | { type: 'status'; status: AgentStatus }
  | { type: 'entry'; entry: ConversationEntry }
  | { type: 'delta'; entryId: string; text: string }
  | { type: 'approval-request'; request: ApprovalRequest }
  | ({ type: 'ask' } & AskRequest)
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }
  | { type: 'goal'; goal: SessionGoal | null }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'plan'; plan: PlanRequest | null }
  /** The agent changed the session's mode itself (EnterPlanMode): the message box should follow. */
  | { type: 'mode'; mode: AgentMode }
  | { type: 'file-changed'; path: string }
  | { type: 'done'; summary: string }
  /** The request ended on a problem. `entryId`: the entry that shows it, when the session made one. */
  | { type: 'error'; message: string; problem?: EntryProblem; entryId?: string }
  | { type: 'session-reset' }
  | { type: 'title'; title: string }
  /** The agent works in this worktree of the project now, or in the project folder again (null). */
  | { type: 'worktree'; worktree: { name: string; branch: string; path: string } | null }

export type AgentEvent = AgentEventBody & { sessionId: string }
