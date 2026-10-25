/**
 * What the agent shows a client: conversation entries, approval requests,
 * todos, goals, plans and the events that carry them.
 *
 * These mirror the desktop app's renderer API (apps/desktop/shared/types.ts)
 * shape for shape; the desktop's agent host checks at compile time that each
 * is assignable to the renderer's, so the renderer keeps its API unchanged.
 */
import type { PauseReason } from '@encode/providers'
import type { AgentMode, DiffHunk, JobStatus, ToolOffer } from '@encode/tools'

export type { AgentMode, DiffHunk, DiffLine } from '@encode/tools'

export type AgentStatus = 'idle' | 'thinking' | 'running-tool' | 'awaiting-approval' | 'awaiting-user' | 'done' | 'error'

export type ApprovalPolicy = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

/** `steer`: a message the user sent while the agent worked, which the running request took in between two steps. */
export type EntryKind = 'user' | 'steer' | 'assistant' | 'tool' | 'notice' | 'error'

/** `reviewing`: under Auto review, the call waits for the Reviewer. */
export type ToolState = 'running' | 'waiting' | 'reviewing' | 'done' | 'rejected' | 'error'

/** What Auto review made of a call. */
export interface ToolReview {
  /** Who looked: the Reviewer model, the fixed checks that come before it, or the agent's model asked again (ADR 0097). */
  by: 'reviewer' | 'floor' | 'second-look'
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
    /** Something the app offers to do about the call: `search-key` after a free search failed (ADR 0123). */
    offer?: ToolOffer
  }
  /** The model that wrote an assistant entry. */
  model?: string
  /** On an error: what kind it is and what can be done about it. */
  problem?: EntryProblem
  /** The longer account behind an error or a notice (what a provider said, keys removed), shown folded. */
  details?: string
  /** On your message: what its request has cost so far. */
  usage?: RequestUsage
  /** On your message: the pictures and files that came with it. */
  attached?: EntryAttachment[]
  /** On a notice: lines eNCode suggests keeping in the project's instructions file (ADR 0097). */
  suggestion?: EntrySuggestion
  /** On a notice: the attempts of a best-of-N request, and which to keep (ADR 0098). */
  best?: EntryBest
  /** On a notice: the request stopped at the step limit, this many steps since the person's last message (ADR 0124). */
  stepLimit?: number
  createdAt: number
}

/**
 * A request made several times side by side, each attempt in a git worktree of its own (ADR 0098). `running` while
 * the attempts work, `judging` while the Reviewer reads them, `ready` until the person keeps one or discards them all;
 * `failed` when the run could not start or finish, with what is left to remove.
 */
export interface EntryBest {
  state: 'running' | 'judging' | 'ready' | 'kept' | 'discarded' | 'failed'
  attempts: BestAttempt[]
  /** The attempt the Reviewer, or eNCode by the checks, says to keep, counted from 1; and why. */
  pick?: number
  reason?: string
  pickedBy?: 'reviewer' | 'checks'
  /** The attempt the person kept. */
  kept?: number
  /** Why the run could not start or finish, for the person. */
  error?: string
}

export interface BestAttempt {
  /** Counted from 1. */
  n: number
  state: 'running' | 'done' | 'failed' | 'stopped'
  /** Its last step, as one line. */
  activity?: string
  steps: number
  reply?: string
  /** What it changed, relative to the workspace with `/`. */
  files: BestFile[]
  /** What the project's checks said after its last change: `none` when there are none, or they did not run since. */
  checks: 'passed' | 'failed' | 'none'
  checksText?: string
  /** The Reviewer's line on it. */
  note?: string
  error?: string
  /** Where it worked, until the person decides; the commit it started from and the folders linked into it. */
  worktree?: { name: string; path: string; branch: string; base: string; from?: string }
  seed?: { base: string; linked: string[] }
}

export interface BestFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
}

/** What answering a best-of-N card did: the files the kept attempt changed, or why it could not. */
export type BestOutcome = { ok: true; files?: string[] } | { ok: false; error: string; conflicts?: string[] }

/** What the person asks of a session's worktree from the chat (ADR 0105). */
export type WorktreeRequest =
  /** Work in a new worktree of the project, named or not. */
  | { action: 'enter'; name?: string }
  /** Work in the project folder again; the worktree stays. */
  | { action: 'leave' }
  /** Work in the project folder again and remove the worktree; one with work in it only when `discard`. */
  | { action: 'remove'; discard?: boolean }
  /** Copy what the worktree changed into the project folder; files the project changed meanwhile only when `force`. */
  | { action: 'bring'; force?: boolean }

export type WorktreeOutcome =
  | { ok: true; worktree: { name: string; branch: string; path: string } | null; files?: string[] }
  | { ok: false; error: string; conflicts?: string[]; work?: { changed: string[]; commits: number } }

/** What a request taught, offered for the instructions file the agent reads at the start of every session (ADR 0097). */
export interface EntrySuggestion {
  /** The file, relative to the workspace: the instructions file the agent reads, or ENCODE.md when there is none. */
  file: string
  lines: string[]
  /** `open` until the person adds the lines or dismisses them. */
  state: 'open' | 'saved' | 'dismissed'
}

/** What answering an offered suggestion did: where Add wrote the lines, or why it could not. */
export type SuggestionOutcome = { ok: true; file?: string } | { ok: false; error: string }

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
  /** The same, by the model that answered (the Usage page); absent in requests stored before it was kept. */
  models?: Record<string, ModelUsage>
}

/** One model's calls in a request, or on a day. */
export interface ModelUsage {
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  /** US dollars, when every one of these calls reported what it cost. */
  cost?: number
}

/** A sum of model calls on the Usage page: what reported a cost is summed, what did not is counted. */
export interface UsageTally {
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  /** US dollars, of the calls that reported what they cost. */
  cost: number
  /** Calls whose cost was not reported. */
  unpriced: number
}

/** One day of a session's requests, by the day each began on this computer's clock. */
export interface DayUsage extends UsageTally {
  requests: number
  /** By the model that answered; "" for calls of requests stored before the model was kept. */
  models: Record<string, UsageTally>
}

/** What one session's requests used, by day ("2026-10-24"). */
export interface SessionUsage {
  id: string
  title: string
  projectRoot: string | null
  days: Record<string, DayUsage>
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
  review?: { by: 'floor' | 'reviewer' | 'second-look'; reason: string }
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
  /** The session this one is a side chat of (ADR 0104); lists leave side chats out. */
  sideOf?: string
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
  /** Make this many attempts at the request side by side and keep the best (ADR 0098): 2 to 4, Code mode only. */
  best?: number
  /** File context the user attached to the prompt. */
  attachments?: { path: string; content: string }[]
  /** Pictures and PDFs the person attached (ADR 0113). */
  media?: AttachedMedia[]
}

/** A picture or a PDF attached to a message: a pasted screenshot, a file dropped or picked from the computer. */
export interface AttachedMedia {
  /** Its file name, or a name eNCode gave a pasted picture. */
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf'
  /** Base64, without a data: prefix. */
  data: string
  /** A picture's thumbnail, a small JPEG as a data: URL, shown on the person's message. */
  preview?: string
}

/** What came with the person's message, shown on it. */
export interface EntryAttachment {
  name: string
  kind: 'picture' | 'pdf' | 'file'
  /** A picture's thumbnail, as a data: URL. */
  preview?: string
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
