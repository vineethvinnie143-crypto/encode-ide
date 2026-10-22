/**
 * Types shared by the Electron main process, the preload bridge and the
 * renderer. Keep this module free of runtime dependencies and DOM APIs so it
 * can be consumed from both tsconfig projects.
 */

import type { Appearance } from './appearance'
import type { SearchCheckResult, SearchProviderId } from './search'

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

/** The jobs a model can be given; the names core and the model router use. */
export type ModelRole = 'main' | 'explore' | 'planner' | 'reviewer' | 'summarizer' | 'utility'

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

/**
 * Where API keys live: encrypted by the OS keychain on disk, or, when no
 * keychain is usable, only in memory until eNCode quits.
 */
export type KeyStorage = { mode: 'keychain' } | { mode: 'session'; reason: string }

export interface Settings {
  profiles: ModelProfile[]
  activeProfileId: string | null
  /** What the agent may do without asking; see electron/agent/approval.ts. */
  policy: ApprovalPolicy
  maxSteps: number
  maxGoalRounds: number
  /**
   * Lets the agent see and operate other applications on this computer (the Computer tool). Off until the person turns it
   * on; each application still asks the first time it is used. Windows only.
   */
  computer: boolean
  recentWorkspaces: string[]
  lastWorkspace: string | null
  agentMode: AgentMode
  /** Theme, accent, contrast, density and motion; see shared/appearance.ts. */
  appearance: Appearance
  /**
   * The models each role uses, best first; a later one takes over when the ones before it cannot answer.
   * An entry is "<profile id>:<model id>", or "@free" for the free models. A role without a list follows another
   * (see shared/models.ts), and main without one uses the active profile's model.
   */
  roles: Partial<Record<ModelRole, string[]>>
  /** Never send a request to a model that costs money, whatever the roles list. */
  freeOnly: boolean
  /** The OpenRouter profile whose key serves "@free"; null picks the first one that has a key. */
  freeProfileId: string | null
  /** The first-run dialog has been answered: a model connected, the demo chosen, or "not now". */
  setupDone: boolean
  /** Who answers the agent's web searches; see shared/search.ts. Default DuckDuckGo, which needs no key. */
  searchProvider: SearchProviderId
  /** Read only: the search providers that have an API key stored. A key is set with settings.setSearchKey and never comes back. */
  searchKeys: SearchProviderId[]
  /** Read only; reported by the main process and ignored on save. */
  keyStorage: KeyStorage
  /** Read only: this computer has a way for the agent to see and operate other applications (Windows). */
  computerSupported: boolean
}

/** Something about a model connection the person should hear, from the model router. */
export interface ModelAlert {
  kind: 'key-refused' | 'sign-in' | 'payment' | 'quota' | 'catalog' | 'billed' | 'model-refused'
  /** The profile it is about, when it is one of theirs. */
  profileId: string | null
  message: string
  /** When the block ends, ms since the epoch. */
  until?: number
}

/** How the model connections are doing, for the Models page. */
export interface ModelStatus {
  /** The router found nothing wrong with the settings it was given, or these problems. */
  problems: string[]
  providers: Array<{
    profileId: string
    name: string
    /** Models the provider lists, and how many of them are free; undefined until the list has been read. */
    models?: number
    free?: number
    /** Why the list could not be read. */
    catalogError?: string
    /** Why requests to this provider are held back, and until when (ms since the epoch). */
    blocked?: { message: string; until: number }
    /** Free requests left today, when the provider says. */
    freeLeft?: number
  }>
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
  /** The provider lists tool calls among what the model supports; the agent needs them. Unset when the listing does not say. */
  tools?: boolean
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
  /**
   * Set by a core that supports session grants: whether this request may be allowed for the
   * rest of the session. When it is set (true or false), the card also offers a note on a refusal.
   */
  grantable?: boolean
  /** The rules "Always allow" would save, shown as they will be written. Absent when no rule could vouch for the call. */
  always?: { label: string; rules: string[] }
  /** Under Auto review: why the Reviewer passed the question to the person. */
  review?: { by: 'floor' | 'reviewer'; reason: string }
  /** Hidden or look-alike characters in what the call adds, one line each. */
  warnings?: string[]
}

/** Which settings file a saved rule goes to: every project of the user, the project's shared file, or the project's private one. */
export type RuleScope = 'user' | 'project' | 'local'

/**
 * What you answer to an approval: yes or no, with a note to the agent on a refusal, "for this session", or "always"
 * (saves the rules the request offered in the settings file `scope` names; the private file of the project by default).
 */
export interface ApprovalAnswer {
  approved: boolean
  note?: string
  remember?: 'session' | 'always'
  scope?: RuleScope
}

/** One permission rule as the Permissions screen lists it. */
export interface PermissionRuleView {
  behavior: 'allow' | 'ask' | 'deny'
  text: string
  /** Where it is written. */
  scope: 'user' | 'project' | 'local' | 'cli'
  /** False for a rule of the folder's that waits for the person to trust the folder and approve its settings. */
  active: boolean
}

/** One hook command that runs, as the Permissions screen lists it. */
export interface PermissionHookView {
  event: string
  /** The tool names it is for, as a regular expression; empty for everything. */
  matcher: string
  command: string
  /** Seconds it may run. */
  timeout: number
  scope: 'user' | 'project' | 'local' | 'cli'
}

/** A folder's settings, trust and rules as the Permissions screen shows them. */
export interface PermissionsReport {
  root: string
  trusted: boolean
  /** Why trusting this folder deserves a second look (the home folder, a drive root), or null. */
  trustWarning: string | null
  /** Whether what the folder's own settings grant applies. */
  configApproved: boolean
  /** What the folder's settings would grant, one line per file, while it waits. */
  heldBack: string[]
  /** The text of what waits, to read before approving it. */
  waiting: Array<{ file: string; text: string }>
  problems: string[]
  /** Why the agent may run nothing here until the settings are fixed, or null. */
  broken: string | null
  rules: PermissionRuleView[]
  additionalDirectories: string[]
  /** Names only. */
  envNames: string[]
  /** The hooks that run: the person's own, and the folder's once it is trusted and its settings approved. */
  hooks: PermissionHookView[]
  /** The mode settings ask sessions to start in, if any. */
  defaultMode?: string
  files: Record<'user' | 'project' | 'local', string>
}

/** What the Permissions screen can do to a folder's settings. */
export type PermissionsAction =
  | { type: 'trust'; acknowledged?: boolean }
  | { type: 'approve' }
  | { type: 'revoke' }
  | { type: 'add-rule'; scope: RuleScope; behavior: 'allow' | 'ask' | 'deny'; text: string }
  | { type: 'remove-rule'; scope: RuleScope; behavior: 'allow' | 'ask' | 'deny'; text: string }

/** The folder as it is after an action, with what happened in words. */
export type PermissionsOutcome = { ok: true; report: PermissionsReport; note?: string } | { ok: false; reason: string; report: PermissionsReport }

/** One tool of an MCP server, as the MCP screen lists it. The words are the server's. */
export interface McpToolView {
  /** The name the model calls it by. */
  name: string
  description: string
}

export type McpServerState = 'disabled' | 'needs-approval' | 'connecting' | 'connected' | 'failed' | 'stopped'

/** One MCP server of the open folder as the MCP screen shows it. */
export interface McpServerView {
  name: string
  /** Yours (your own file) or the project's. */
  scope: 'user' | 'project'
  /** The file the entry was read from. */
  file: string
  state: McpServerState
  /** In words: why approval is needed, what failed. */
  detail?: string
  /** What approving is for: the exact setup the card showed. */
  digest: string
  /** What approving would run: the command line or the address. */
  summary: string
  /** Names only; the values never leave the files. */
  envNames: string[]
  headerNames: string[]
  /** Variables of your own environment that the entry reads. */
  variables: string[]
  tools: McpToolView[]
  resources: number
  prompts: number
  hasInstructions: boolean
  problems: string[]
  /** The last lines the server printed, for finding out why it failed. */
  log: string[]
}

/** The open folder's MCP servers as the MCP screen shows them. */
export interface McpReport {
  root: string
  /** A project's server cannot be approved before the folder is trusted. */
  trusted: boolean
  /** Why no server runs under these settings, or null. */
  broken: string | null
  /** Servers are still being started. */
  starting: boolean
  servers: McpServerView[]
  /** What was wrong in the files, in words. */
  problems: string[]
  files: { user: string; project: string; encode: string }
}

/** What the MCP screen can do to a folder's servers. */
export type McpAction =
  | { type: 'approve'; name: string; /** The digest of the setup the person was shown. */ digest: string }
  | { type: 'forget'; name: string }
  | { type: 'restart'; name: string }
  | { type: 'turn-off'; name: string }
  | { type: 'turn-on'; name: string }

/** The servers as they are after an action, with what happened in words. */
export type McpOutcome = { ok: true; report: McpReport; note?: string } | { ok: false; reason: string; report: McpReport }

/** How the sandbox around the agent's commands stands in the open folder, for the Sandbox screen. */
export interface SandboxReport {
  /** `active`: commands are confined. `off`: the settings turn it off. `unavailable`: this machine cannot run it. */
  state: 'active' | 'off' | 'unavailable'
  engine?: 'bubblewrap' | 'seatbelt' | 'restricted-token'
  /** Why it is off or unavailable, in words. */
  reason?: string
  /** What this system's sandbox can hold back. */
  limits?: { reads: boolean; network: boolean; protectedPaths: 'exact' | 'best-effort' }
  /** What applies in this folder: your own settings, tightened by the folder's. */
  settings: {
    enabled: boolean
    required: boolean
    allowUnsandboxed: boolean
    caches: boolean
    network: 'allow' | 'block'
    allowWrite: string[]
    denyWrite: string[]
    denyRead: string[]
    allowRead: string[]
  }
  /** What the folder's own files made stricter than your settings, in words. */
  tightened: string[]
  /** What was wrong in the settings files, in words. */
  problems: string[]
  /** What is being prepared right now, when something is. */
  working?: string
  /** Your settings file, where the switches are saved. */
  file: string
}

/** What the Sandbox screen can do: change a switch in your own settings, or check the machine again. */
export type SandboxAction =
  | { type: 'set'; key: 'enabled' | 'required' | 'allowUnsandboxed' | 'caches'; value: boolean }
  | { type: 'set'; key: 'network'; value: 'allow' | 'block' }
  | { type: 'recheck' }

/** The sandbox as it is after an action, with what happened in words. */
export type SandboxOutcome = { ok: true; report: SandboxReport; note?: string } | { ok: false; reason: string; report: SandboxReport }

/** A request of the person's after which the agent's file tools changed files, for the rewind menu. */
export interface RewindTurn {
  /** The request's id: the id of its entry in the conversation. */
  turn: string
  at: number
  /** Files in the folder the agent's tools changed in this request. */
  files: number
  /** Files changed elsewhere, which a rewind does not restore. */
  outside: number
}

export interface CheckpointInfo {
  /** False where nothing is recorded: no folder is open, or the record could not be opened (`problem` says why). */
  available: boolean
  problem?: string
  /** Oldest first. */
  turns: RewindTurn[]
  /** The latest rewind can still be undone. */
  canUndo: boolean
}

export type RewindAction = 'restore' | 'delete' | 'unchanged' | 'skip'

export interface RewindFile {
  /** Relative to the folder where the file is inside it. */
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
  /** False when nothing was recorded for the request. */
  known: boolean
  files: RewindFile[]
  /** Names what the plan was made from; a plan the files have moved past is refused. */
  fingerprint: string
}

export interface RewindRequest {
  kind: 'rewind' | 'redo'
  turn: string
  fingerprint: string
  /** Also put back files that changed since the agent last wrote them. */
  force?: boolean
  /** Also go back in the conversation to just before the request (the request comes back as text). */
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
  /** The model that wrote an assistant reply. */
  model?: string
  tool?: {
    name: string
    input: Record<string, unknown>
    output?: string
    ok?: boolean
    diff?: DiffHunk[]
    /** `reviewing`: under Auto review, the call waits for the Reviewer. */
    state?: 'running' | 'waiting' | 'reviewing' | 'done' | 'rejected' | 'error'
    /** What Auto review made of the call. */
    review?: ToolReview
    /** Hidden or look-alike characters found in what the call wrote, one line each. */
    warnings?: string[]
  }
  createdAt: number
}

/** What Auto review made of a call: who looked (the Reviewer model, or the fixed checks before it), and the verdict. */
export interface ToolReview {
  by: 'reviewer' | 'floor'
  /** `approved`: it ran on this review. `declined`: it did not run. `asked`: the person was asked. */
  verdict: 'approved' | 'declined' | 'asked'
  risk?: 'low' | 'medium' | 'high'
  reason: string
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
  | { type: 'title'; title: string }

export type AgentEvent = AgentEventBody & { sessionId: string }

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

/** What the renderer may change about a session. */
export type SessionPatch = Partial<Pick<SessionSummary, 'title' | 'projectRoot' | 'pinned' | 'archived' | 'unread'>>

export interface AgentStartInput {
  text: string
  mode: AgentMode
  /** Explicit file context the user attached to the prompt. */
  attachments?: { path: string; content: string }[]
}

export interface AgentHistory {
  entries: ConversationEntry[]
  status: AgentStatus
  /** The approval card still waiting for an answer, so reopening the session shows it again. */
  approval?: ApprovalRequest | null
  /** Every approval still waiting, oldest first, when the agent can have several at once. */
  approvals?: ApprovalRequest[]
  /** The question still waiting for an answer. */
  ask?: { id: string; entryId: string; question: string; options?: string[] } | null
}

export type ZoomAction = 'in' | 'out' | 'reset'

/** Which build this is and what it runs on; shown in About and at the top of a diagnostics report. */
export interface AboutInfo {
  name: string
  version: string
  /** The commit the build was made from: 40 hex characters, or empty for a build made outside a checkout. */
  commit: string
  /** The build was made from a working tree with changes in it. */
  dirty: boolean
  builtAt: string
  /** "tester" for a build that is handed out, "dev" otherwise. */
  channel: string
  /** Installed and run as a program, not started from the sources. */
  packaged: boolean
  platform: string
  arch: string
  /** Operating system and release, for example "Windows 11 (10.0.26100)". */
  os: string
  electron: string
  chrome: string
  node: string
}

export interface EncodeApi {
  app: {
    about(): Promise<AboutInfo>
    user(): Promise<string>
    feedback(text: string): Promise<void>
    /**
     * Asks where to save a report for the person who looks after eNCode (build, system, settings without keys,
     * recent log lines, counts) and writes it. Resolves to the file, or null when the dialog was cancelled.
     */
    exportDiagnostics(): Promise<string | null>
    /** Shows the folder the log files are in. */
    openLogs(): Promise<void>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    /** Enters or leaves full screen; resolves to whether the window is now full screen. */
    toggleFullScreen(): Promise<boolean>
    /** Zooms the whole interface a half step; resolves to the new zoom level (0 is 100%). */
    zoom(action: ZoomAction): Promise<number>
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
    setProfileKey(id: string, key: string): Promise<Settings>
    /** Stores, replaces or (with an empty key) removes the API key of a search provider that needs one. */
    setSearchKey(provider: SearchProviderId, key: string): Promise<Settings>
  }
  search: {
    /** One search through the provider in use, the way the agent makes it: the answer says whether it works. */
    test(): Promise<SearchCheckResult>
  }
  models: {
    openRouter(freeOnly?: boolean): Promise<ModelInfo[]>
    provider(id: string): Promise<ModelInfo[]>
    /** Lists the models, then asks the chosen one for a tool call, the way the agent will. */
    test(id: string): Promise<{ ok: boolean; message: string }>
    status(): Promise<ModelStatus>
    /** Lifts what a refused key or a payment problem set, and asks again: after changing a key or adding credit. */
    recheck(): Promise<void>
    onAlert(cb: (alert: ModelAlert) => void): () => void
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
    /** In the open project by default; `projectRoot: null` makes a standalone session. */
    createSession(options?: { projectRoot?: string | null }): Promise<SessionSummary>
    update(sessionId: string, patch: SessionPatch): Promise<SessionSummary | null>
    /** The sessions that are running or waiting right now, by id. */
    statuses(): Promise<Record<string, AgentStatus>>
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
    /** The requests after which files changed, and whether the latest rewind can be undone. */
    checkpoints(sessionId: string): Promise<CheckpointInfo>
    /** What putting the files back to just before a request would do; nothing changes. */
    rewindPlan(sessionId: string, turn: string): Promise<RewindPlan>
    /** What undoing the latest rewind would do, or null. */
    redoPlan(sessionId: string): Promise<RewindPlan | null>
    /** Puts files back as a plan said, and the conversation with them if asked. Only while the agent is idle. */
    rewindApply(sessionId: string, request: RewindRequest): Promise<RewindOutcome>
    /** Goes back in the conversation to just before a request, which comes back as text to edit; the files stay as they are. */
    rewindConversation(sessionId: string, entryId: string): Promise<{ text: string }>
    approve(requestId: string, answer: boolean | ApprovalAnswer): Promise<void>
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
  permissions: {
    /** The open folder's settings, trust and rules; null when no folder is open. */
    report(): Promise<PermissionsReport | null>
    /** Does something to the open folder's settings and answers with the folder as it stands. */
    act(action: PermissionsAction): Promise<PermissionsOutcome>
  }
  mcp: {
    /**
     * The open folder's MCP servers and how they stand; null when no folder is open. `start: false` looks without
     * starting any server (what the banner above the composer does); the MCP screen starts them, as a chat would.
     */
    report(options?: { start?: boolean }): Promise<McpReport | null>
    /** Does something to one of the open folder's servers and answers with the servers as they stand. */
    act(action: McpAction): Promise<McpOutcome>
    /** A server changed (it started, stopped or failed, or its tools or setup changed): ask for the report again. */
    onChanged(cb: () => void): () => void
  }
  sandbox: {
    /** The sandbox around the agent's commands in the open folder; null when no folder is open. */
    report(): Promise<SandboxReport | null>
    /** Changes a switch or checks the machine again; answers with the sandbox as it stands. */
    act(action: SandboxAction): Promise<SandboxOutcome>
    /** The sandbox was checked, or a folder is being prepared: ask for the report again. */
    onChanged(cb: () => void): () => void
  }
}
