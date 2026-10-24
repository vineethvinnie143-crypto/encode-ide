/**
 * Types shared by the Electron main process, the preload bridge and the
 * renderer. Keep this module free of runtime dependencies and DOM APIs so it
 * can be consumed from both tsconfig projects.
 */

import type { Keybindings } from './keybindings'
import type { Appearance } from './appearance'
import type { CustomTheme } from './themes'
import type { SearchCheckResult, SearchProviderId } from './search'
import type { EditorIssueDraft } from './editor-issue'
import type { TurnReportDraft, TurnReportSaved } from './turn-report'
import type { ModelTestPlan, ModelTestProgress, ModelTestResult } from './model-tests'

export type AgentMode = 'code' | 'ask' | 'plan'

/**
 * What Enter does with a message while the agent works: `queue` holds it until the request is done, `steer` hands it
 * to the running request, which reads it after the step it is on. Ctrl+Enter does the other one.
 */
export type FollowUp = 'queue' | 'steer'

/**
 * The key that sends a message: `enter` (Shift+Enter starts a new line) or `ctrl-enter` (Enter starts a new line, as in
 * an editor). While the agent works, the other follow-up takes Ctrl+Enter with `enter` and Ctrl+Shift+Enter with
 * `ctrl-enter`.
 */
export type SendKey = 'enter' | 'ctrl-enter'

/** When Windows is asked to show a notice: never, only while eNCode is not the window in front, or every time. */
export type NotifyWhen = 'never' | 'background' | 'always'
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
export type ModelRole = 'main' | 'explore' | 'planner' | 'reviewer' | 'summarizer' | 'utility' | 'inline'

/** How hard a model thinks before it answers. The providers map it to their own dial; a model without one ignores it. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
 * Whether the agent may finish a request while the language servers report errors in the files it changed: `auto`
 * sends it back once to fix them, `on` up to three times, `off` lets it finish and only tells it.
 */
export type ErrorGate = 'auto' | 'on' | 'off'

/** `auto`: models that need no guide get the short instructions (ADR 0094); `full`: every model gets the full guide. */
export type Guide = 'auto' | 'full'

/**
 * When the agent ends a request that changed code: `auto` runs the project's typecheck and tests and sends it back up to
 * twice for what its changes broke, `on` up to four times, `off` runs nothing and leaves its reply unchecked (ADR 0095).
 */
export type CheckGate = 'auto' | 'on' | 'off'

/**
 * Whether the Reviewer reads the agent's finished changes and its plans before you do (ADR 0096): `auto` for models
 * that need the full guide or when the Review role has a model of its own, `on` always, `off` never.
 */
export type ReviewWork = 'auto' | 'on' | 'off'

/** Before a command that is hard to undo runs without you seeing it: `on` asks the agent's model about it once more, and leaves it to you when the answers differ (ADR 0097). */
export type AskAgain = 'on' | 'off'

/** After a request where you set a rule or a command failed and another worked: `on` offers lines for the project's instructions file, added only when you click Add (ADR 0097). */
export type LearnConventions = 'on' | 'off'

/**
 * `auto`: a model that is not one of the strong ones gets a few lines of help after the instructions, and its first
 * change in a request waits until it has said what will change (ADR 0100). `off`: no model does.
 */
export type HelpSmaller = 'auto' | 'off'

/**
 * `ask`: when a smaller model runs into trouble twice in a request and the Plan or Review role has a strong model of
 * its own, you are asked whether that model may do the rest of the request (ADR 0100). `off`: never.
 */
export type OfferStronger = 'ask' | 'off'

/**
 * Suggestions as you type, drawn faded at the cursor (ADR 0087). `auto`: on, except while the Inline suggestions role
 * would use the free models, whose requests a day are few and kept for the agent. `on`: on whatever the role uses.
 * `off`: never. See shared/inline.ts.
 */
export type InlineSuggest = 'auto' | 'on' | 'off'

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
  /** Tokens a conversation may reach before older parts are summarized, whatever the model's window; one of CONTEXT_CAPS. Default 200,000. */
  contextCap: number
  /**
   * Lets the agent see and operate other applications on this computer (the Computer tool). Off until the person turns it
   * on; each application still asks the first time it is used. Windows only.
   */
  computer: boolean
  recentWorkspaces: string[]
  lastWorkspace: string | null
  agentMode: AgentMode
  /** What Enter does with a message while the agent works; see FollowUp. Default `queue`. */
  followUp: FollowUp
  /** The key that sends a message; see SendKey. Default `enter`. */
  sendKey: SendKey
  /** Keeps the computer from sleeping while an agent works (not while it waits for you). Default on. */
  keepAwake: boolean
  /**
   * Starts the language servers installed on this computer for the files of a trusted folder: the editor marks errors,
   * and the agent finds definitions and sees what its edits broke. Default on.
   */
  languageServers: boolean
  /** The editor formats a file through its language server before it saves it. Default off. */
  formatOnSave: boolean
  /** The editor formats a line through its language server as it is typed, after `;`, `}` and the like. Default off. */
  formatOnType: boolean
  /** See InlineSuggest. Default `auto`. */
  inlineSuggest: InlineSuggest
  /** See ErrorGate. Default `auto`. */
  errorGate: ErrorGate
  /** See Guide. Default `auto`. */
  guide: Guide
  /** See CheckGate. Default `auto`. */
  checkGate: CheckGate
  /** See ReviewWork. Default `auto`. */
  reviewWork: ReviewWork
  /** See AskAgain. Default `on`. */
  askAgain: AskAgain
  /** See LearnConventions. Default `on`. */
  learnConventions: LearnConventions
  /** See HelpSmaller. Default `auto`. */
  helpSmaller: HelpSmaller
  /** See OfferStronger. Default `ask`. */
  offerStronger: OfferStronger
  /** A notice when a request finishes. Default `background`. */
  notifyDone: NotifyWhen
  /** A notice when the agent needs you: an approval, a question or a plan to look at. Default `background`. */
  notifyNeeds: NotifyWhen
  /** The taskbar button flashes while the agent needs you and eNCode is not in front. Default on. */
  flashTaskbar: boolean
  /**
   * Read only: the folder chats (sessions that belong to no project) work in, with the default filled in. Changed with
   * settings.chooseChatsFolder, which asks with the system's folder dialog, and settings.resetChatsFolder.
   */
  chatsFolder: string
  /** Read only: the folder chats work in when the person has not chosen one. */
  chatsFolderDefault: string
  /** Theme, accent, contrast, density and motion; see shared/appearance.ts. */
  appearance: Appearance
  /**
   * The models each role uses, best first; a later one takes over when the ones before it cannot answer.
   * An entry is "<profile id>:<model id>", or "@free" for the free models. A role without a list follows another
   * (see shared/models.ts), and main without one uses the active profile's model.
   */
  roles: Partial<Record<ModelRole, string[]>>
  /** How hard each role's models think; a role left out leaves it to the model. See shared/models.ts EFFORTS. */
  efforts: Partial<Record<ModelRole, ReasoningEffort>>
  /** The shortcuts the person chose, by command id; see shared/keybindings.ts. */
  keybindings: Keybindings
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
  /** In plain words. */
  message: string
  /** What the provider said, for the log and a report. */
  detail?: string
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
  /** The folder's path; on another machine, its path there. */
  root: string
  name: string
  /** A folder on another machine over SSH (ADR 0111): the machine, and the folder's full name in eNCode. */
  remote?: { label: string; uri: string }
}

/** How the connection to another machine stands (ADR 0111). */
export interface RemoteState {
  status: 'connecting' | 'uploading' | 'starting' | 'connected' | 'lost' | 'closed'
  /** `user@host:port`, as the person wrote it. */
  label: string
  /** Why it was lost, in words. */
  message?: string
}

/** Why a folder on another machine did not open, for the Open dialog. */
export interface RemoteOpenFailure {
  ok: false
  kind: 'input' | 'ssh-missing' | 'auth' | 'host-key' | 'host-key-changed' | 'unreachable' | 'node-missing' | 'node-old' | 'failed'
  message: string
  /** What ssh said, for a Details fold. */
  detail?: string
  /** For node-missing and node-old: whether eNCode can put its own Node.js there, and what it is. */
  install?: { platform: string; version: string }
}

export type RemoteOpenResult = { ok: true; workspace: OpenWorkspace } | RemoteOpenFailure

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
  /** Relative to the repository, with `/`. */
  path: string
  status: string
  /** The index holds a change to it. */
  staged: boolean
  /** The working tree holds a change to it that is not staged, or it is new to git. */
  unstaged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  changes: GitChange[]
}

// ---------------------------------------------------------------------------
// The Review tab (the same shapes as @encode/git's, which the main process fills)

/**
 * Unstaged: the working tree against the index. Staged: the index against HEAD. Branch: against the base. Commit: one
 * commit. Turn: what one request of a session changed, from the agent's record (the latest such request when `turn` is
 * not given); it needs no git.
 */
export type ReviewScope = { kind: 'unstaged' } | { kind: 'staged' } | { kind: 'branch'; base?: string } | { kind: 'commit'; commit: string } | { kind: 'turn'; session: string; turn?: string }

export interface ReviewOptions {
  /** Unchanged lines around each change; Infinity shows whole files. */
  context: number
  ignoreWhitespace: boolean
}

export interface ReviewLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  old?: number
  new?: number
  noEol?: true
  words?: Array<[number, number]>
}

export interface ReviewHunk {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ReviewLine[]
  added: number
  removed: number
}

export type ReviewFileChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'

export interface ReviewFile {
  path: string
  oldPath?: string
  change: ReviewFileChange
  kind: 'text' | 'binary' | 'large' | 'submodule' | 'symlink' | 'folder'
  oldMode?: string
  newMode?: string
  added: number
  removed: number
  hunks: ReviewHunk[]
  approximate?: boolean
  hunkActions: boolean
  hunkActionsOff?: string
  note?: string
  size?: { old?: number; new?: number }
  fingerprint: string
  /** Turn view: why the file cannot be changed from here (a later request changed it again, it lies outside the folder). */
  fixed?: string
}

export interface ReviewCommit {
  oid: string
  short: string
  subject: string
  author: string
  /** Seconds since 1970. */
  time: number
}

export interface ReviewRepo {
  /** The repository's top folder. */
  root: string
  /** Where the open folder sits in the repository: `/`-separated and ending in `/`, or empty at the top. */
  folder: string
  branch: string | null
  head: string | null
  upstream?: string
  ahead?: number
  behind?: number
}

/** The request a Turn view shows. */
export interface ReviewTurn {
  /** Null when no request of the session has changed a file yet. */
  id: string | null
  /** When it began. */
  at?: number
  /** A turn is running, so nothing can be reverted until it ends. */
  busy: boolean
}

export interface ReviewSnapshot {
  scope: ReviewScope
  /** In the Turn view: the open folder, with no branch. */
  repo: ReviewRepo
  files: ReviewFile[]
  added: number
  removed: number
  /** Files with unstaged and staged changes, for the scope menu; null in the Turn view, which does not read git. */
  counts: { unstaged: number; staged: number } | null
  turn?: ReviewTurn
  base?: { ref: string; oid: string | null }
  commit?: ReviewCommit
  skipped: number
  readOnly: boolean
  options: ReviewOptions
}

export type ReviewAction =
  | { type: 'stage-hunk' | 'unstage-hunk' | 'revert-hunk'; path: string; hunk: string; fingerprint: string }
  | { type: 'stage-file' | 'unstage-file' | 'revert-file'; path: string; fingerprint?: string }
  | { type: 'stage-all' | 'unstage-all' | 'revert-all' }

/** A review, or why there is none: no folder, not a repository, no git. */
export type ReviewLoad = { ok: true; snapshot: ReviewSnapshot; undo: string | null } | { ok: false; message: string }

/**
 * What an action did and the scope as it stands afterwards. `stale`: the file changed since it was shown, so nothing
 * was done and the review is read again.
 */
export type ReviewActOutcome =
  | { ok: true; message: string; undoable: boolean; load: ReviewLoad }
  | { ok: false; message: string; stale: boolean; load: ReviewLoad }

export interface ReviewBranches {
  current: string | null
  /** The base the Branch view uses unless another is chosen. */
  base: string | null
  refs: string[]
}

export interface ReviewCommitRequest {
  message: string
  /** Stage every change first. */
  all: boolean
  amend: boolean
  /** Push after committing. */
  push: boolean
}

export type ReviewCommitOutcome =
  | { ok: true; commit: ReviewCommit; pushed?: string; pushError?: string }
  | { ok: false; message: string }

/** How much a Reviewer's finding matters: P0 stops everything (broken build, lost data, a hole), P3 is minor. */
export type FindingPriority = 'P0' | 'P1' | 'P2' | 'P3'

/** A problem the Reviewer found, tied to one line of the change as the review names its file. */
export interface ReviewFinding {
  path: string
  side: 'old' | 'new'
  line: number
  priority: FindingPriority
  title: string
  body: string
}

/**
 * What the Reviewer said about a review's changes: a short verdict and its findings. `files`: how many files it read;
 * `left`: how many changed files were left out to keep the request small.
 */
export type ReviewAskOutcome = { ok: true; summary: string; findings: ReviewFinding[]; files: number; left: number } | { ok: false; message: string }

export interface ModelInfo {
  id: string
  name: string
  contextLength?: number
  free?: boolean
  pricing?: string
  /** US dollars per million tokens read and written, where the listing says (OpenRouter's does). */
  price?: { input: number; output: number }
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
  review?: { by: 'floor' | 'reviewer' | 'second-look'; reason: string }
  /** Hidden or look-alike characters in what the call adds, one line each. */
  warnings?: string[]
  /** Asked by a subagent in the background: the card stays when the turn ends, or shows when no turn runs. */
  background?: boolean
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

/** A server as the Add form describes it, in the files' own format. */
export type McpNewServer =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> }

/** What the MCP screen can do to a folder's servers. */
export type McpAction =
  | { type: 'approve'; name: string; /** The digest of the setup the person was shown. */ digest: string }
  | { type: 'forget'; name: string }
  | { type: 'restart'; name: string }
  | { type: 'turn-off'; name: string }
  | { type: 'turn-on'; name: string }
  /** Writes the server into ~/.encode/mcp.json (`user`) or the project's .mcp.json (`project`). */
  | { type: 'add'; name: string; scope: 'user' | 'project'; setup: McpNewServer }
  /** Takes the server out of every file of its scope that lists it. */
  | { type: 'remove'; name: string }

/** The servers as they are after an action, with what happened in words. */
export type McpOutcome = { ok: true; report: McpReport; note?: string } | { ok: false; reason: string; report: McpReport }

/** How the sandbox around the agent's commands stands in the open folder, for the Sandbox screen. */
export interface SandboxReport {
  /** `active`: commands are confined. `off`: the settings turn it off. `unavailable`: this machine cannot run it. */
  state: 'active' | 'off' | 'unavailable'
  engine?: 'bubblewrap' | 'seatbelt' | 'integrity-level'
  /** Why it is off or unavailable, in words. */
  reason?: string
  /** What this system's sandbox can hold back. */
  limits?: { reads: boolean; network: boolean; protectedPaths: 'exact' | 'best-effort'; processes: boolean }
  /** The shell commands run in on this computer, and why the sandbox cannot confine it when it cannot. */
  shell?: { name: string; unsupported?: string }
  /** What applies in this folder: your own settings, tightened by the folder's. */
  settings: {
    enabled: boolean
    required: boolean
    allowUnsandboxed: boolean
    caches: boolean
    powershell: boolean
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
  /** Folders the sandbox changed so that it can confine commands there (Windows: the integrity marks). */
  marked: string[]
  /** Folders Windows does not let your account prepare (change their security settings): commands there run only outside the sandbox. */
  blocked: string[]
}

/** What the Sandbox screen can do: change a switch in your own settings, or check the machine again. */
export type SandboxAction =
  | { type: 'set'; key: 'enabled' | 'required' | 'allowUnsandboxed' | 'caches' | 'powershell'; value: boolean }
  | { type: 'set'; key: 'network'; value: 'allow' | 'block' }
  | { type: 'recheck' }
  /** Takes the marks off every folder, or only these. */
  | { type: 'unmark'; folders?: string[] }

/** The sandbox as it is after an action, with what happened in words. */
export type SandboxOutcome = { ok: true; report: SandboxReport; note?: string } | { ok: false; reason: string; report: SandboxReport }

/** A language server as Settings lists it. */
export interface LanguageServerInfo {
  id: string
  label: string
  state: 'missing' | 'stopped' | 'starting' | 'running' | 'failed' | 'off'
  /** Where it was found, or why it is missing, off or failed. */
  detail?: string
  command?: string
  /** It is busy (indexing, checking the project). */
  working?: boolean
  documents: number
  /** How to install it. */
  install: string
  /** What it covers: ".ts", ".tsx", "CMakeLists.txt". */
  files: string[]
  /** How many of the folder's files it covers, and the files that mark a project of its kind. */
  used?: { files: number; markers: string[] }
  /** eNCode can install it with one click, this way. */
  installer?: 'npm' | 'download' | 'toolchain'
  /** eNCode installed it, at this version. */
  installed?: string
  /** The toolchain eNCode fetched for it, which it runs on: ".NET SDK 10.0.402" (ADR 0114). */
  runtime?: string
  /** An install is running: bytes so far, of about this many. */
  installing?: { done: number; total: number }
  /** The last install failed, and why. */
  installError?: string
  /** What eNCode installs for it that this folder wants, or that is installed (FiveM's natives for Lua, ADR 0084). */
  libraries?: LanguageLibraryInfo[]
  /** It runs beside the server a file has, for the files of its languages, in a folder that uses it (ADR 0086). */
  companion?: true
}

/** A library eNCode installs for a server to read, listed under the server. */
export interface LanguageLibraryInfo {
  id: string
  /** "FiveM natives". */
  label: string
  /** "FiveM's natives for Lua". */
  what: string
  installed?: string
  installing?: { done: number; total: number }
  installError?: string
}

export interface LanguageServersReport {
  /** `on`: a server starts when a file needs it. `off`: turned off in Settings. `untrusted`: the folder is not trusted. */
  state: 'on' | 'off' | 'untrusted'
  reason?: string
  servers: LanguageServerInfo[]
  /** The folder was not read to the end for the languages it uses. */
  partial?: boolean
}

/** What installing a language server would do (ADR 0083), for the person to read before saying yes. */
export interface ServerInstallPlan {
  id: string
  label: string
  /** What is installed, for a title: "YAML's language server", "FiveM's natives for Lua". */
  what: string
  version: string
  steps: string[]
  /** About how much is downloaded, when known. */
  bytes?: number
  /** Where it is kept. */
  dir: string
}

export type ServerInstallResult = { ok: true; dir: string } | { ok: false; reason: string }

/** A problem a language server found, zero-based, in UTF-16 units as the editor counts. */
export interface CodeDiagnostic {
  line: number
  character: number
  endLine: number
  endCharacter: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
  code?: string
}

/** What a language server says of one file of the open folder now; an empty list takes its marks away. */
export interface FileMarks {
  /** As the file tree names it: "src/a.ts". */
  path: string
  diagnostics: CodeDiagnostic[]
}

/** A place in a file as a language server counts it: zero-based lines, and columns in UTF-16 units. */
export interface CodePosition {
  line: number
  character: number
}

export interface CodeRange {
  start: CodePosition
  end: CodePosition
}

/** Text a server wrote for people: markdown, or plain text. */
export interface CodeMarkup {
  kind: 'plaintext' | 'markdown'
  value: string
}

export interface CodeTextEdit {
  range: CodeRange
  newText: string
}

/** One suggestion of a language server, as the editor shows and inserts it. */
export interface CompletionEntry {
  /** Its place in its list; with the list's number it names the item to fill in. */
  id: number
  label: string
  /** "function", "property", "keyword"... */
  kind?: string
  detail?: string
  /** Shown right after the label, such as a signature: `(a: number)`. */
  labelDetail?: string
  /** Shown at the end of the row, such as the module an import comes from. */
  description?: string
  documentation?: CodeMarkup
  deprecated?: boolean
  preselect?: boolean
  sortText: string
  filterText: string
  /** The text to put in, or a snippet when `snippet` is true. */
  insertText: string
  snippet: boolean
  /** Where the text goes: `replace` covers the whole word under the cursor, `insert` only up to the cursor. */
  replace?: CodeRange
  insert?: CodeRange
  /** Edits elsewhere in the file, such as the import an item needs. */
  additionalEdits?: CodeTextEdit[]
  commitCharacters?: string[]
  /** What the editor does once the item is in: suggest again, or show the parameters of the call. */
  then?: 'suggest' | 'parameterHints'
  /** False while the server can still fill in documentation or edits. */
  resolved: boolean
}

export interface CompletionResult {
  /** The list's number. */
  list: number
  /** The server did not send everything: typing more asks again. */
  incomplete: boolean
  items: CompletionEntry[]
}

export interface SignatureParameter {
  /** The parameter's text, or where it is in the signature's label (UTF-16 offsets, end exclusive). */
  label: string | [number, number]
  documentation?: string | CodeMarkup
}

export interface SignatureInfo {
  label: string
  documentation?: string | CodeMarkup
  parameters?: SignatureParameter[]
  activeParameter?: number
}

/** The calls a function can take, and which parameter the cursor is on. */
export interface SignatureHelp {
  signatures: SignatureInfo[]
  activeSignature?: number
  activeParameter?: number
}

/** Another place of the symbol at the cursor; `write` where it is assigned. */
export interface EditorHighlight {
  range: CodeRange
  kind: 'text' | 'read' | 'write'
}

/** The characters that make the editor ask a file's server: for suggestions, to accept one, for a call's parameters. */
export interface EditorTriggers {
  completion: string[]
  commit: string[]
  signature: string[]
  signatureRetrigger: string[]
  /** The characters after which the server formats what was typed (`;`, `}`). */
  format: string[]
}

/** An action a server offers for a range: a quick fix, a refactoring, a source action such as organizing the imports. */
export interface EditorAction {
  /** Its place in its list; with the list's number it names the action to take. */
  id: number
  title: string
  /** "quickfix", "refactor.extract", "source.organizeImports"... */
  kind?: string
  /** The fix the server thinks best. */
  preferred?: boolean
  /** Why it cannot be taken now. */
  disabled?: string
  /** It runs a command of the server's, whose changes are known only once it runs. */
  command?: boolean
}

/** A place a server pointed to: in the folder by its path, or outside it (a library) by its whole path only. */
export interface EditorLocation {
  /** The path in the folder, or null for a file outside it. */
  path: string | null
  file: string
  line: number
  character: number
  endLine: number
  endCharacter: number
  /** The text of its first line (its end trimmed, at most 300 characters), for a list of places; only for a file in the folder. */
  preview?: string
}

/** A symbol of a file as the outline and the breadcrumbs show it: its whole range, its name's, and what it holds. */
export interface EditorSymbol {
  name: string
  /** As people read it: "function", "class", "enum member". */
  kind: string
  detail?: string
  range: CodeRange
  /** The range of its name: where going to it puts the cursor. */
  selection: CodeRange
  children?: EditorSymbol[]
}

/** A block a server says can fold: 0-based lines, `endCharacter` where on its last line it ends. */
export interface EditorFoldRange {
  startLine: number
  endLine: number
  endCharacter?: number
  kind?: 'comment' | 'imports' | 'region'
}

/** A hint a server draws among the text: a type it worked out, or the name of the parameter an argument goes to. 0-based. */
export interface EditorInlayHint {
  line: number
  character: number
  label: string
  kind?: 'type' | 'parameter'
  paddingLeft?: boolean
  paddingRight?: boolean
}

/**
 * A file's semantic tokens, five numbers each: line, character, length (0-based, UTF-16), kind (an index into the
 * host's list of the editor's token kind names, `SEMANTIC_KINDS` in the renderer) and flags (1: deprecated).
 */
export interface EditorSemanticTokens {
  data: number[]
}

/** A symbol found by name across the folder; only the folder's own files are listed. */
export interface EditorSymbolMatch {
  name: string
  kind: string
  container?: string
  path: string
  range: CodeRange
}

/** A function of a call hierarchy, numbered in the newest one so that its calls can be asked for. */
export interface EditorCallFunction {
  id: number
  name: string
  kind: string
  detail?: string
  /** Its name. */
  at: EditorLocation
}

/** The other end of a function's calls (who calls it, or what it calls) and where those calls are. */
export interface EditorCallEntry {
  item: EditorCallFunction
  sites: EditorLocation[]
}

interface EditorAt {
  /** As the file tree names it: "src/a.ts". */
  path: string
  /** Zero-based. */
  line: number
  /** Zero-based, in UTF-16 units: a JavaScript string index. */
  character: number
}

/** What the editor asks the servers of the file it shows, by kind, with what each answers. */
export interface EditorAsks {
  complete: { params: EditorAt & { triggerKind: 1 | 2 | 3; triggerCharacter?: string }; result: CompletionResult | null }
  resolve: { params: { path: string; list: number; id: number }; result: CompletionEntry | null }
  signature: { params: EditorAt & { triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; active?: SignatureHelp }; result: SignatureHelp | null }
  hover: { params: EditorAt; result: { markdown: string; range?: CodeRange } | null }
  highlights: { params: EditorAt; result: EditorHighlight[] }
  definition: { params: EditorAt; result: EditorLocation[] | null }
  typeDefinition: { params: EditorAt; result: EditorLocation[] | null }
  implementation: { params: EditorAt; result: EditorLocation[] | null }
  references: { params: EditorAt; result: EditorLocation[] | null }
  triggers: { params: { path: string }; result: EditorTriggers | null }
  /** Whether the symbol can be renamed: its range and the name to start from (none: the word there), or why not. */
  prepareRename: { params: EditorAt; result: { ok: true; range?: CodeRange; placeholder?: string } | { ok: false; reason: string } | null }
  /** The actions for a range; `automatic` when the editor asks by itself (the lightbulb), `only` to keep some kinds. */
  codeActions: { params: { path: string; range: CodeRange; only?: string[]; automatic: boolean }; result: { list: number; actions: EditorAction[] } | null }
  /** The edits that format the file, or a range of it. */
  format: { params: { path: string; range?: CodeRange; tabSize: number; insertSpaces: boolean }; result: CodeTextEdit[] | null }
  /** The edits that format what was just typed: `ch`, which ends at the position. */
  formatOnType: { params: EditorAt & { ch: string; tabSize: number; insertSpaces: boolean }; result: CodeTextEdit[] | null }
  /** The file's outline, as a tree. */
  symbols: { params: { path: string }; result: EditorSymbol[] | null }
  /** The blocks the file folds by, as its server sees them (0-based lines); null when no server folds it. */
  folding: { params: { path: string }; result: EditorFoldRange[] | null }
  /** The hints drawn among lines `startLine` to `endLine` (0-based, both included); null when no server draws any. */
  inlayHints: { params: { path: string; startLine: number; endLine: number }; result: EditorInlayHint[] | null }
  /** The file's semantic tokens; null when no server gives them. */
  semanticTokens: { params: { path: string }; result: EditorSemanticTokens | null }
  /** Symbols by name across the folder; `path` is the file shown ('' for none), whose server starts if it is not running. */
  workspaceSymbols: { params: { path: string; query: string }; result: EditorSymbolMatch[] | null }
  /** The functions at a position a call hierarchy starts from, numbered in a new hierarchy. */
  callHierarchy: { params: EditorAt; result: { list: number; items: EditorCallFunction[] } | null }
  /** Who calls a function of the newest hierarchy (`incoming`), or what it calls (`outgoing`). */
  calls: { params: { path: string; list: number; id: number; direction: 'incoming' | 'outgoing' }; result: { calls: EditorCallEntry[] } | { reason: string } | null }
}

/**
 * What the editor sends for a suggestion at the cursor (ADR 0087). The main process checks every field and cuts what is
 * too long (shared/inline.ts); the agent host leaves out what the folder's rules keep from the agent and what looks like
 * a secret, and asks the model of the Inline suggestions role.
 */
export interface InlineSuggestRequest {
  /** Names the request, so that `cancelInline` can stop it. */
  id: number
  /** As the file tree names it. */
  path: string
  /** The editor's language id for the file. */
  language: string
  /** The text before the cursor, from the start of a line. */
  prefix: string
  /** The text after the cursor, to the end of a line. */
  suffix: string
  /** Only spaces follow the cursor in its line, so the suggestion may run over several lines. */
  multiline: boolean
  /** Parts of other files open in the editor that look like the code at the cursor, by their paths in the tree. */
  snippets: { path: string; text: string }[]
}

/**
 * What came back: text to show; nothing to suggest; or no suggestion for now, `message` saying why for the editor's
 * status line, with `until` when trying again later may help and `stop` when only a change of settings will.
 */
export type InlineSuggestAnswer =
  | { kind: 'text'; text: string }
  | { kind: 'none' }
  | { kind: 'paused'; message: string; until?: number; stop?: boolean }

/**
 * A change the editor asks for through the servers. `open` names every file the editor has open, so that none of them
 * is written behind its back. Applied at once, or shown first (`preview`) and applied by its id; `undo` takes an
 * applied one back while nothing it touched has changed; `discard` lets a preview go.
 */
export type EditorChangeRequest =
  | { kind: 'rename'; path: string; line: number; character: number; newName: string; preview: boolean; open: string[] }
  | { kind: 'action'; path: string; list: number; id: number; preview: boolean; open: string[] }
  | { kind: 'apply'; id: number; open: string[] }
  | { kind: 'undo'; id: number; open: string[] }
  | { kind: 'discard'; id: number }

/** The edits a change makes to a file the editor has open; `written`: the file on disk was written too, so it is saved once they are in. */
export interface EditorFileEdit {
  path: string
  edits: CodeTextEdit[]
  written: boolean
}

/** A file a change would make, edit, move or delete, for its preview. */
export interface EditorChangeFile {
  path: string
  kind: 'edit' | 'create' | 'move' | 'delete'
  to?: string
  places: number
  lines?: { line: number; before: string; after: string }[]
  /** Changed in the editor, where it has unsaved changes, rather than on disk. */
  inEditor?: boolean
  /** Some of its lines are left out: a preview shows at most so many. */
  cut?: boolean
}

export type EditorChangeResult =
  | { ok: true; done: 'preview'; id: number; title: string; files: EditorChangeFile[] }
  | {
      ok: true
      done: 'applied'
      id: number
      title: string
      editor: EditorFileEdit[]
      written: string[]
      created: string[]
      moved: { from: string; to: string }[]
      deleted: string[]
      places: number
      files: number
      undo: boolean
      notes: string[]
    }
  | { ok: true; done: 'undone'; id: number; editor: { path: string; written: boolean }[]; written: string[]; created: string[]; deleted: string[] }
  | { ok: true; done: 'discarded' }
  | { ok: false; reason: string }

export type EditorAsk = { [K in keyof EditorAsks]: { kind: K } & EditorAsks[K]['params'] }[keyof EditorAsks]
export type EditorAnswer<K extends keyof EditorAsks = keyof EditorAsks> = EditorAsks[K]['result']

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

/** `steer`: a message the person sent while the agent worked, which the running request took in between two steps. */
export type EntryKind = 'user' | 'steer' | 'assistant' | 'tool' | 'notice' | 'error'

/** What the person can do about a problem the chat shows, offered as buttons under it. */
export type ProblemAction = 'retry' | 'switch-model' | 'settings' | 'diagnostics'

/**
 * The kind of trouble behind an error in the chat: why no model could run, or the loop's and eNCode's own
 * (`context`: the conversation does not fit; `empty`: the model said nothing; `host`: the agent process stopped;
 * `internal`: a fault in eNCode).
 */
export type ProblemCode = 'rate-limit' | 'quota' | 'payment' | 'auth' | 'network' | 'unavailable' | 'no-model' | 'refused' | 'context' | 'empty' | 'host' | 'internal'

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
    /** `encode`: a call eNCode made itself, such as a check before the agent finishes (ADR 0095). */
    by?: 'encode'
  }
  /** On an error: what kind it is and what can be done about it. */
  problem?: EntryProblem
  /** The longer account behind an error or a notice (what a provider said, keys removed), shown folded. */
  details?: string
  /** On your message: what its request has cost so far. */
  usage?: RequestUsage
  /** On your message: the pictures and files that came with it (ADR 0113). */
  attached?: EntryAttachment[]
  /** On a notice: lines eNCode suggests keeping in the project's instructions file (ADR 0097). */
  suggestion?: EntrySuggestion
  /** On a notice: the attempts of a best-of-N request, and which to keep (ADR 0098). */
  best?: EntryBest
  createdAt: number
}

/** What came with the person's message, shown on it. */
export interface EntryAttachment {
  name: string
  kind: 'picture' | 'pdf' | 'file'
  /** A picture's thumbnail, as a data: URL. */
  preview?: string
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
  error?: string
}

export interface BestAttempt {
  n: number
  state: 'running' | 'done' | 'failed' | 'stopped'
  /** Its last step, as one line. */
  activity?: string
  steps: number
  reply?: string
  files: BestFile[]
  checks: 'passed' | 'failed' | 'none'
  checksText?: string
  /** The Reviewer's line on it. */
  note?: string
  error?: string
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

/** The model calls of one request together: the agent's, its subagents' and the reviewer's. */
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

/** One model's calls in a request. */
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

/** Who looked at a call before it ran (the Reviewer model, the fixed checks before it, or the agent's model asked again before a hard-to-undo command), and the verdict. */
export interface ToolReview {
  by: 'reviewer' | 'floor' | 'second-look'
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
  status: 'running' | 'done' | 'error' | 'killed'
  exitCode?: number
  output: string
  /** Default `command`. */
  kind?: 'command' | 'monitor' | 'agent' | 'wakeup'
  /** What the agent said it is for; a subagent's type. */
  title?: string
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

/** An agent the main agent can start with the Task tool: built in, the person's own (~/.encode/agents) or the project's (.encode/agents). */
export interface AgentDefinitionInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'workspace'
  /** The role whose model it works on; the main agent's when absent. */
  role?: string
  /** The only tools it gets; every tool a subagent may have when absent. */
  tools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
  color?: string
  /** Its file; built-in agents have none. */
  path?: string
}

/** A new agent in the person's folder, from Settings > Skills and agents. */
export interface AgentCreateInput {
  name: string
  /** When the main agent should use it. */
  description: string
  /** Only reads and searches, as Explore does. */
  readOnly: boolean
  /** The role whose model it works on; the main agent's when absent. */
  role?: 'main' | 'explore' | 'planner' | 'reviewer' | 'utility'
}

/** The person's own instructions, ~/.encode/ENCODE.md (Settings > Personalization). */
export interface InstructionsInfo {
  path: string
  text: string
  exists: boolean
  /** Past this many characters the middle of the file is cut when it is sent. */
  sentChars: number
}

/** A save of the instructions; `changed` when the file was changed elsewhere since it was read, with what it holds now. */
export type InstructionsSaveOutcome = { ok: true; info: InstructionsInfo } | { ok: false; changed: InstructionsInfo }

/** The open folder's own instructions file, by its path in the folder; `file` null when it has none. */
export interface ProjectInstructions {
  root: string
  file: string | null
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
  | { type: 'ask'; id: string; entryId: string; question: string; options?: string[]; background?: boolean }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }
  | { type: 'goal'; goal: SessionGoal | null }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'plan'; plan: PlanRequest | null }
  /** The agent changed the session's mode itself (EnterPlanMode): the message box follows. */
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

/** What the renderer may change about a session. */
export type SessionPatch = Partial<Pick<SessionSummary, 'title' | 'projectRoot' | 'pinned' | 'archived' | 'unread'>>

export interface AgentStartInput {
  text: string
  mode: AgentMode
  /** Make this many attempts at the request side by side and keep the best (ADR 0098): 2 to 4, Code mode only. */
  best?: number
  /** Explicit file context the user attached to the prompt. */
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

/** How saving a report of an editor issue ended. */
export type EditorIssueSaved = { saved: string } | { canceled: true } | { refused: string }

/** What a key pressed in a Browser tab's page asks of the tab (browser/guard.ts in the main process). */
export type BrowserKeyAction = 'address' | 'reload' | 'back' | 'forward' | 'close' | 'new-tab' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

/** The main process asks for a chat's agent tab (ADR 0103): show it (opening it when it is not open) or close it. */
export type AgentTabRequest = { type: 'show' | 'close'; key: string }

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
    /** Asks where to save a report of an editor issue (ADR 0088) and writes it; the reason when it may not go as it is. */
    saveEditorIssue(draft: EditorIssueDraft): Promise<EditorIssueSaved>
    /** Asks where to save a report of one request (ADR 0092) and writes it; the reason when it may not go as it is. */
    saveTurnReport(draft: TurnReportDraft): Promise<TurnReportSaved>
    /** Shows the folder the log files are in. */
    openLogs(): Promise<void>
    /** Shows a notice the way a finished request would, so the person sees whether Windows lets eNCode show them. */
    testNotification(): Promise<void>
    /** A notice was clicked: open that session. */
    onOpenSession(cb: (sessionId: string) => void): () => void
    /** Whether a screen reader (or another assistive program) is using eNCode now: Chromium turns its accessibility on for one. */
    screenReader(): Promise<boolean>
    /** A screen reader started or stopped. */
    onScreenReader(cb: (active: boolean) => void): () => void
  }
  browser: {
    /** A page in one of the person's tabs opened a window: it becomes a new Browser tab. */
    onOpenTab(cb: (url: string) => void): () => void
    /** The agent of a chat wants its tab shown, or closed. */
    onAgentTab(cb: (request: AgentTabRequest) => void): () => void
    /** A key the app answers to was pressed in the page of a tab, named by its web contents. */
    onKey(cb: (event: { contentsId: number; action: BrowserKeyAction }) => void): () => void
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
    /** A file up to 12 MB, for anything but the editor. */
    read(path: string): Promise<ReadFileResult>
    /** A file for the editor, up to 256 MB. */
    readForEditor(path: string): Promise<ReadFileResult>
    write(path: string, content: string): Promise<{ size: number }>
    createFile(parent: string, name: string): Promise<FileEntry>
    createDir(parent: string, name: string): Promise<FileEntry>
    rename(path: string, newName: string): Promise<FileEntry>
    delete(path: string): Promise<void>
    reveal(path: string): Promise<void>
    search(options: SearchOptions): Promise<SearchResult>
    onFileChanged(cb: (paths: string[]) => void): () => void
  }
  /** Folders on other machines over SSH (ADR 0111). */
  remote: {
    /** The host names of ~/.ssh/config, for the Host box. */
    hosts(): Promise<string[]>
    /** Connects (unless that machine's folder is open already) and opens the folder there. */
    open(host: string, folder: string): Promise<RemoteOpenResult>
    /** Puts eNCode's own Node.js on a machine that has none, after the person said yes. */
    installNode(host: string, platform: string): Promise<{ ok: true } | { ok: false; message: string; detail?: string }>
    /** The connection of the folder that is open, or null. */
    state(): Promise<RemoteState | null>
    onState(cb: (state: RemoteState) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    save(patch: Partial<Settings>): Promise<Settings>
    setProfileKey(id: string, key: string): Promise<Settings>
    /** Stores, replaces or (with an empty key) removes the API key of a search provider that needs one. */
    setSearchKey(provider: SearchProviderId, key: string): Promise<Settings>
    /** Asks for the chats folder with the system's folder dialog; null when the dialog was cancelled. */
    chooseChatsFolder(): Promise<Settings | null>
    /** Puts the chats folder back to the eNCode folder in Documents. */
    resetChatsFolder(): Promise<Settings>
    /** Saves one of the person's themes to a file they choose; resolves to the file, or null when cancelled. */
    exportTheme(theme: CustomTheme): Promise<string | null>
    /** Reads a theme from a file they choose, under the id given; null when cancelled. */
    importTheme(id: string): Promise<CustomTheme | null>
  }
  search: {
    /** One search through the provider in use, the way the agent makes it: the answer says whether it works. */
    test(): Promise<SearchCheckResult>
  }
  models: {
    openRouter(freeOnly?: boolean): Promise<ModelInfo[]>
    provider(id: string): Promise<ModelInfo[]>
    /** Lists the models, then asks the chosen one for a tool call, the way the agent will. */
    /** `message` is plain; `detail` is what the provider said, when the call failed on its answer. */
    test(id: string): Promise<{ ok: boolean; message: string; detail?: string }>
    status(): Promise<ModelStatus>
    /** Lifts what a refused key or a payment problem set, and asks again: after changing a key or adding credit. */
    recheck(): Promise<void>
    onAlert(cb: (alert: ModelAlert) => void): () => void
    /** What testing a model will run and may cost (ADR 0101), or why it cannot be tested now. */
    testPlan(profileId: string, model: string): Promise<ModelTestPlan>
    /** Tests a model on the benchmark's short run; answers when it ends, with every model's latest scores. */
    runTest(profileId: string, model: string): Promise<{ result: ModelTestResult; results: Record<string, ModelTestResult> }>
    stopTest(): Promise<void>
    /** Each tested model's latest result, by "<profile id>:<model id>". */
    testResults(): Promise<Record<string, ModelTestResult>>
    onTestProgress(cb: (progress: ModelTestProgress) => void): () => void
  }
  git: {
    status(): Promise<GitStatus>
  }
  /** The Review tab: the open folder's repository by scope, and what can be done to it. */
  review: {
    load(scope: ReviewScope, options: ReviewOptions): Promise<ReviewLoad>
    act(scope: ReviewScope, action: ReviewAction, options: ReviewOptions): Promise<ReviewActOutcome>
    /** Takes back the latest revert, then answers with the scope as it stands. */
    undo(scope: ReviewScope, options: ReviewOptions): Promise<ReviewActOutcome>
    commits(): Promise<ReviewCommit[]>
    branches(): Promise<ReviewBranches>
    commit(request: ReviewCommitRequest): Promise<ReviewCommitOutcome>
    /** A commit message for what is staged (with `all`, every change), drafted by the model of the Small tasks role. */
    draft(options?: { all?: boolean }): Promise<{ ok: true; message: string } | { ok: false; message: string }>
    /** The Reviewer's findings on the scope's changes, from the model of the Review role. */
    ask(scope: ReviewScope, options: ReviewOptions): Promise<ReviewAskOutcome>
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
    /** What each session's requests used, by day and by model (Settings > Usage). */
    usage(): Promise<SessionUsage[]>
    /** In the open project by default; `projectRoot: null` makes a standalone session. */
    createSession(options?: { projectRoot?: string | null }): Promise<SessionSummary>
    /** A chat: a session in the chats folder (see Settings.chatsFolder), which is made if it is missing. */
    createChat(): Promise<SessionSummary>
    /** Makes the chats folder if it is missing, so a chat can open it; resolves to the folder. */
    chatsFolder(): Promise<string>
    update(sessionId: string, patch: SessionPatch): Promise<SessionSummary | null>
    /** The sessions that are running or waiting right now, by id. */
    statuses(): Promise<Record<string, AgentStatus>>
    history(sessionId?: string): Promise<AgentHistory>
    start(sessionId: string, input: AgentStartInput): Promise<void>
    /** Runs the last request again from where a problem stopped it; resolves when it ends. */
    retry(sessionId: string, mode?: AgentMode): Promise<void>
    cancel(sessionId: string): Promise<void>
    /**
     * Hands a message to the running request, which reads it after its current step and shows it as an entry with the
     * id given (a fresh `crypto.randomUUID()`). Null when nothing is running that can take it: the turn is ending, or a
     * tool stopped it; then it is the next request's.
     */
    steer(sessionId: string, text: string, id: string): Promise<{ id: string } | null>
    reset(sessionId?: string): Promise<void>
    remove(sessionId: string): Promise<void>
    fork(sessionId: string): Promise<SessionSummary>
    /** A side chat of the session (ADR 0104): a copy of it to ask about it on the side; lists leave it out. */
    side(sessionId: string): Promise<SessionSummary>
    /** Enters, leaves or removes the session's worktree, or brings its changes into the project folder (ADR 0105). */
    worktree(sessionId: string, request: WorktreeRequest): Promise<WorktreeOutcome>
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
    /** Adds the lines a request taught to the project's instructions file (`accept`), or dismisses them (ADR 0097). */
    answerSuggestion(sessionId: string, entryId: string, accept: boolean): Promise<SuggestionOutcome>
    /** Keeps attempt `keep` (from 1) of a best-of-N request, or discards them all (0); `force` writes over the person's changes. */
    answerBest(sessionId: string, entryId: string, keep: number, force?: boolean): Promise<BestOutcome>
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
    /** Moves one of the person's own skills to the bin. */
    remove(name: string): Promise<void>
    /** Shows a skill's file in the file manager. */
    reveal(name: string): Promise<void>
  }
  agents: {
    list(): Promise<AgentDefinitionInfo[]>
    read(name: string): Promise<string>
    create(input: AgentCreateInput): Promise<AgentDefinitionInfo>
    /** Moves one of the person's own agents to the bin. */
    remove(name: string): Promise<void>
    reveal(name: string): Promise<void>
    openFolder(): Promise<void>
  }
  instructions: {
    read(): Promise<InstructionsInfo>
    /** Saves when the file still holds `base`, the text read. */
    write(text: string, base: string): Promise<InstructionsSaveOutcome>
    /** The open folder's instructions file; null when no folder is open. */
    project(): Promise<ProjectInstructions | null>
    /** Makes ENCODE.md in the open folder when it has no instructions file; resolves to the file it has. */
    createProject(): Promise<string>
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
  code: {
    /** The open folder's language servers and how they stand; null when no folder is open. */
    report(): Promise<LanguageServersReport | null>
    /** What installing a server would do, for the person to read before saying yes. */
    installPlan(id: string): Promise<ServerInstallPlan | { unavailable: string }>
    /** Installs a server the person said yes to; resolves once it is installed or failed. Progress comes in reports. */
    install(id: string): Promise<ServerInstallResult>
    /** Stops an install that runs; it ends as failed, with nothing left behind. */
    cancelInstall(id: string): Promise<void>
    /** Removes a server eNCode installed. */
    uninstall(id: string): Promise<ServerInstallResult>
    /**
     * The editor shows a file of the open folder, by its path in the tree, with the text it holds (`dirty`: not saved).
     * Its server starts if it may, and its problems arrive through `onMarks`.
     */
    open(path: string, text: string, dirty: boolean): void
    change(path: string, text: string, dirty: boolean): void
    close(path: string): void
    /**
     * A question to the servers of a file the editor shows, for its text as last given (send pending changes first).
     * Null (an empty list for highlights) when no server answers: none runs for the file, or it cannot say.
     */
    ask<K extends keyof EditorAsks>(ask: { kind: K } & EditorAsks[K]['params']): Promise<EditorAnswer<K>>
    /** A rename or a code action across the folder, its preview, or taking one back. Send pending changes first. */
    edit(request: EditorChangeRequest): Promise<EditorChangeResult>
    /** A server's problems in a file, as they change. */
    onMarks(cb: (marks: FileMarks) => void): () => void
    /** A server started, stopped or failed: ask for the report again. */
    onChanged(cb: () => void): () => void
    /** A suggestion at the cursor from the model of the Inline suggestions role; a newer request stops an older one. */
    inline(request: InlineSuggestRequest): Promise<InlineSuggestAnswer>
    /** Stops the request `id` if it still runs; it answers `none`. */
    cancelInline(id: number): void
  }
}
