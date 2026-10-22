/**
 * What the agent shows a client: conversation entries, approval requests,
 * todos, goals, plans and the events that carry them.
 *
 * These mirror the desktop app's renderer API (apps/desktop/shared/types.ts)
 * shape for shape; the desktop's agent host checks at compile time that each
 * is assignable to the renderer's, so the renderer keeps its API unchanged.
 */
import type { AgentMode, DiffHunk, JobStatus } from '@encode/tools'

export type { AgentMode, DiffHunk, DiffLine } from '@encode/tools'

export type AgentStatus = 'idle' | 'thinking' | 'running-tool' | 'awaiting-approval' | 'awaiting-user' | 'done' | 'error'

export type ApprovalPolicy = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

export type EntryKind = 'user' | 'assistant' | 'tool' | 'notice' | 'error'

export type ToolState = 'running' | 'waiting' | 'done' | 'rejected' | 'error'

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
  }
  /** The model that wrote an assistant entry. */
  model?: string
  createdAt: number
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

export interface BackgroundJob {
  id: string
  command: string
  cwd: string
  sessionId: string
  startedAt: number
  status: JobStatus
  exitCode?: number
  output: string
}

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
  | { type: 'file-changed'; path: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'session-reset' }
  | { type: 'title'; title: string }

export type AgentEvent = AgentEventBody & { sessionId: string }
