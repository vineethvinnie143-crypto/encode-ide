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
  | { type: 'ask'; id: string; entryId: string; question: string; options?: string[] }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }
  | { type: 'goal'; goal: SessionGoal | null }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'plan'; plan: PlanRequest | null }
  | { type: 'file-changed'; path: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'session-reset' }

export type AgentEvent = AgentEventBody & { sessionId: string }
