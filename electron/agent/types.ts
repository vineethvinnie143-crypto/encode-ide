import type { AgentMode, DiffHunk, SessionGoal, TodoItem } from '../../shared/types'
import type { JobService } from '../services/jobs'
import type { SettingsService } from '../services/settings'
import type { ShellService } from '../services/shell'
import type { SkillService } from '../services/skills'
import type { WorkspaceService } from '../services/workspace'

export interface GoalAccess {
  get(): SessionGoal | null
  set(goal: SessionGoal | null): void
}

export interface TodoAccess {
  get(): TodoItem[]
  set(todos: TodoItem[]): void
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallPayload[]
  tool_call_id?: string
}

export interface ToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolContext {
  workspace: WorkspaceService
  settings: SettingsService
  shell: ShellService
  goals: GoalAccess
  todos: TodoAccess
  jobs: JobService
  skills: SkillService
  proposePlan: (plan: string) => void
  mode: AgentMode
  signal: AbortSignal
  ask: (question: string, options?: string[]) => Promise<string>
}

export interface ToolResult {
  ok: boolean
  output: string
  diff?: DiffHunk[]
  changedPath?: string
  done?: boolean
  summary?: string
}

export interface ParsedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
