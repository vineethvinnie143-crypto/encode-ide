/**
 * Types shared by the Electron main process, the preload bridge and the
 * renderer. Keep this module free of runtime dependencies and DOM APIs so it
 * can be consumed from both tsconfig projects.
 */

export type AgentMode = 'code' | 'ask' | 'plan'
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'running-tool'
  | 'awaiting-approval'
  | 'awaiting-user'
  | 'done'
  | 'error'

export type ProfileKind = 'custom' | 'openrouter' | 'demo'

export interface ModelProfile {
  id: string
  name: string
  kind: ProfileKind
  baseUrl: string
  model: string
  models?: string[]
  /** Never carries the secret to the renderer — only whether one is stored. */
  hasApiKey?: boolean
}

export type ApprovalPolicy = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

export interface Settings {
  profiles: ModelProfile[]
  activeProfileId: string | null
  /** What the agent may do without asking; see electron/agent/approval.ts. */
  policy: ApprovalPolicy
  maxSteps: number
  maxGoalRounds: number
  recentWorkspaces: string[]
  lastWorkspace: string | null
  agentMode: AgentMode
}

export interface FileEntry {
  name: string
  /** Workspace-relative path with forward slashes. */
  path: string
  isDir: boolean
  size?: number
}

export interface OpenWorkspace {
  root: string
  name: string
}

export interface ReadFileResult {
  path: string
  content: string
  size: number
  mtimeMs: number
  binary?: boolean
}

export interface SearchOptions {
  query: string
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
  /** Comma separated glob patterns, e.g. "src/**\/*.ts,*.json" */
  include?: string
  maxResults?: number
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  lineText: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
  filesSearched: number
}

export interface GitChange {
  path: string
  status: string
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  changes: GitChange[]
}

export interface ModelInfo {
  id: string
  name: string
  contextLength?: number
  free?: boolean
  pricing?: string
}

export interface ShellCreateOptions {
  cwd?: string
}

export interface ShellInfo {
  id: string
  cwd: string
  prompt: string
}

export interface ShellPromptInfo {
  id: string
  cwd: string
  prompt: string
}

export interface ApprovalRequest {
  id: string
  entryId: string
  tool: string
  title: string
  detail: string
  /** Why the approval policy asks, when it is not obvious from the policy. */
  reason?: string
  input: Record<string, unknown>
  /** Optional diff preview shown before approving a write. */
  preview?: DiffHunk[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

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

export type EntryKind = 'user' | 'assistant' | 'tool' | 'notice' | 'error'

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
    state?: 'running' | 'waiting' | 'done' | 'rejected' | 'error'
  }
  createdAt: number
}

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked'

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface BackgroundJob {
  id: string
  command: string
  cwd: string
  sessionId: string
  startedAt: number
  status: 'running' | 'done' | 'error' | 'killed'
  exitCode?: number
  output: string
}

export interface Schedule {
  id: string
  prompt: string
  sessionId: string
  everySeconds?: number
  nextAt: number
  enabled: boolean
  createdAt: number
  lastFiredAt?: number
  attempts: number
  lastResult?: string
  lastError?: string
}

export interface SkillInfo {
  name: string
  description: string
  source: 'workspace' | 'user'
  path: string
}

export interface PlanRequest {
  id: string
  plan: string
}

export interface SessionGoal {
  text: string
  status: GoalStatus
  rounds: number
  createdAt: number
  updatedAt: number
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

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AgentStartInput {
  text: string
  mode: AgentMode
  /** Explicit file context the user attached to the prompt. */
  attachments?: { path: string; content: string }[]
}

export interface AgentHistory {
  entries: ConversationEntry[]
  status: AgentStatus
}

export interface EncodeApi {
  app: {
    version(): Promise<string>
    platform(): Promise<string>
    user(): Promise<string>
    feedback(text: string): Promise<void>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    onStateChange(cb: (state: { maximized: boolean }) => void): () => void
  }
  workspace: {
    openDialog(): Promise<OpenWorkspace | null>
    openPath(path: string): Promise<OpenWorkspace>
    get(): Promise<OpenWorkspace | null>
    close(): Promise<void>
    recent(): Promise<string[]>
    list(path: string): Promise<FileEntry[]>
    listAllFiles(): Promise<{ files: string[]; truncated: boolean }>
    read(path: string): Promise<ReadFileResult>
    write(path: string, content: string): Promise<{ size: number }>
    createFile(parent: string, name: string): Promise<FileEntry>
    createDir(parent: string, name: string): Promise<FileEntry>
    rename(path: string, newName: string): Promise<FileEntry>
    delete(path: string): Promise<void>
    reveal(path: string): Promise<void>
    search(options: SearchOptions): Promise<SearchResult>
    onFileChanged(cb: (paths: string[]) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    save(patch: Partial<Settings>): Promise<Settings>
    setProfileKey(id: string, key: string): Promise<void>
  }
  models: {
    openRouter(freeOnly?: boolean): Promise<ModelInfo[]>
    provider(id: string): Promise<ModelInfo[]>
    test(id: string): Promise<{ ok: boolean; message: string }>
  }
  git: {
    status(): Promise<GitStatus>
  }
  shell: {
    create(opts: ShellCreateOptions): Promise<ShellInfo>
    run(id: string, line: string): Promise<void>
    cancel(id: string): Promise<void>
    close(id: string): Promise<void>
    complete(id: string, line: string): Promise<string[]>
    onData(cb: (id: string, text: string) => void): () => void
    onPrompt(cb: (prompt: ShellPromptInfo) => void): () => void
    onExit(cb: (id: string, code: number) => void): () => void
  }
  agent: {
    sessions(): Promise<SessionSummary[]>
    createSession(): Promise<SessionSummary>
    history(sessionId?: string): Promise<AgentHistory>
    start(sessionId: string, input: AgentStartInput): Promise<void>
    cancel(sessionId: string): Promise<void>
    reset(sessionId?: string): Promise<void>
    remove(sessionId: string): Promise<void>
    fork(sessionId: string): Promise<SessionSummary>
    rename(sessionId: string, title: string): Promise<void>
    goal(sessionId: string): Promise<SessionGoal | null>
    setGoal(sessionId: string, goal: SessionGoal | null): Promise<void>
    todos(sessionId: string): Promise<TodoItem[]>
    setTodos(sessionId: string, todos: TodoItem[]): Promise<void>
    compact(sessionId: string): Promise<{ removed: number }>
    export(sessionId: string, targetPath?: string): Promise<string | null>
    plan(sessionId: string): Promise<PlanRequest | null>
    setPlan(sessionId: string, plan: PlanRequest | null): Promise<void>
    approve(requestId: string, approved: boolean): Promise<void>
    answer(requestId: string, answer: string): Promise<void>
    onEvent(cb: (e: AgentEvent) => void): () => void
  }
  jobs: {
    list(): Promise<BackgroundJob[]>
    output(id: string): Promise<string>
    kill(id: string): Promise<void>
    onChange(cb: (jobs: BackgroundJob[]) => void): () => void
  }
  schedules: {
    list(): Promise<Schedule[]>
    create(input: { prompt: string; sessionId: string; afterSeconds?: number; everySeconds?: number }): Promise<Schedule>
    remove(id: string): Promise<void>
    toggle(id: string, enabled: boolean): Promise<void>
  }
  skills: {
    list(): Promise<SkillInfo[]>
    read(name: string): Promise<string>
    create(name: string, description?: string): Promise<SkillInfo>
    openFolder(): Promise<void>
  }
}
