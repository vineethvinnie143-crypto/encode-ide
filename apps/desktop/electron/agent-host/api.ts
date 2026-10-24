/**
 * The wire between the main process and the agent host (a utility process).
 * The host serves the session API of @encode/core and requests of its own;
 * the main process answers the host's requests for keys and for the browser. Everything crosses as
 * structured-clonable data, and secrets cross only when asked for.
 */
import type { CheckGate, ErrorGate, GuideSetting, HostEvents, HostRequests, ReviewSetting, SmallerHelp, StrongerOffer } from '@encode/core'
import type { BrowserAnswer, BrowserRequest, CodeDiagnostic } from '@encode/tools'
import type { InstallPlan } from '@encode/lsp'
import type { EditorAnswer, EditorAsk, EditorChangeRequest, EditorChangeResult, EditorDocumentChange, InstallResult, LanguageServersReport } from '@encode/workspace'
import type { ModelMode } from '../../shared/models'
import type { ModelTestPlan, ModelTestProgress, ModelTestResult } from '../../shared/model-tests'
import type { KeyedSearchProviderId, SearchCheckResult, SearchProviderId } from '../../shared/search'
import type { ApprovalPolicy, InlineSuggestAnswer, InlineSuggestRequest, McpAction, McpOutcome, McpReport, ModelAlert, ModelRole, ModelStatus, PermissionsAction, PermissionsOutcome, PermissionsReport, ReasoningEffort, SandboxAction, SandboxOutcome, SandboxReport } from '../../shared/types'
import type { CodeReviewInput, CodeReviewResult } from '@encode/core'
import type { CommitDraftInput } from './commit-message'
import type { RouterSettings } from './router-settings'

/** What the host needs to know about the user's settings, and nothing else of them. */
export interface HostConfig {
  policy: ApprovalPolicy
  maxSteps: number
  maxGoalRounds: number
  /** Tokens a conversation may reach before older parts are summarized; see Settings.contextCap. */
  contextCap: number
  /** The Computer tool is offered to the agent; see Settings.computer. */
  computer: boolean
  /** What answers the model calls: the scripted demo, nothing yet, or real models through the router. */
  model: ModelMode
  /** The model router's settings; no keys. */
  router: RouterSettings
  /** How hard each role's models think; a role left out (or all, when absent) is left to the model. */
  efforts?: Partial<Record<ModelRole, ReasoningEffort>>
  /**
   * The router's providers by id: the profile each is, its name for messages, and a number that changes with its
   * key (null: no key is stored). The key itself stays in the main process until a request needs it.
   */
  providers: Record<string, { profile: string; name: string; keyRevision: number | null }>
  /** Who answers the agent's web searches. Its key, if it needs one, is asked for at every search. */
  searchProvider: SearchProviderId
  /** Language servers start for trusted folders; see Settings.languageServers. */
  languageServers: boolean
  errorGate: ErrorGate
  guide: GuideSetting
  checkGate: CheckGate
  reviewWork: ReviewSetting
  askAgain: 'on' | 'off'
  learnConventions: 'on' | 'off'
  helpSmaller: SmallerHelp
  offerStronger: StrongerOffer
}

export interface HostInit {
  /** Where the session logs live. */
  dir: string
  /** The user's home, for ~/.encode (instructions, skills, agents). */
  home: string
  /** The folder open now. */
  workspace: string | null
  config: HostConfig
  /** A sessions file of an earlier build, imported once if it is there. */
  legacySessionsFile?: string
  /** Where the router keeps what it has learned (model lists, health, free-tier counts) between runs. */
  routerStateFile?: string
  /** Where what the agent's file tools change is kept so that a rewind can put it back; without it nothing is kept. */
  checkpointsDir?: string
  /** The sandbox's own folder (its temp folder, and on Windows its helper); without it commands run unconfined. */
  sandboxDir?: string
  /** eNCode's profile folder, off limits to the agent (its keys, the browser's sign-ins, every chat). */
  profileDir?: string
  /** Where eNCode installs language servers when asked, and where they keep their caches; without it none is installed. */
  toolsDir?: string
  serverCacheDir?: string
  /** The benchmark's tasks, for Test this model (ADR 0101); without it no model can be tested. */
  benchTasksDir?: string
}

/** The result of a test call to one model. */
export interface ModelCheckResult {
  ok: boolean
  /** In plain words. */
  message: string
  /** What the provider said, keys removed, for a Details fold. */
  detail?: string
  /** What the model took to start answering, ms. */
  ms?: number
}

export type DesktopHostRequests = HostRequests & {
  init: { params: HostInit; result: void }
  configure: { params: HostConfig; result: void }
  /** Closes the sessions and their commands, and flushes the logs; the process exits afterwards. */
  shutdown: { params: undefined; result: void }
  /** How the model connections are doing. */
  modelStatus: { params: undefined; result: ModelStatus }
  /** A small tool call to one model, the way the agent will make it. */
  modelCheck: { params: { profileId: string; model: string }; result: ModelCheckResult }
  /** Lifts what a refused key or a payment problem set, reads the model lists again. */
  modelRecheck: { params: undefined; result: void }
  /** What testing one model will run and may cost (ADR 0101), or why it cannot be tested now. */
  modelTestPlan: { params: { profileId: string; model: string }; result: ModelTestPlan }
  /** Tests one model on the benchmark's short run; answers when it ends. One test runs at a time. */
  modelTest: { params: { profileId: string; model: string }; result: ModelTestResult }
  /** Stops the test that runs; it answers with what it scored so far. */
  modelTestStop: { params: undefined; result: void }
  /** One search through the provider in use, the way the agent makes it, for the Settings screen's test. */
  searchCheck: { params: undefined; result: SearchCheckResult }
  /** A folder's settings, trust and permission rules, for the Permissions screen. */
  permissionsReport: { params: { root: string }; result: PermissionsReport }
  /** Does something to a folder's settings; answers with the folder as it stands afterwards. */
  permissionsAct: { params: { root: string; action: PermissionsAction }; result: PermissionsOutcome }
  /** A folder's MCP servers, for the MCP screen. */
  mcpReport: { params: { root: string; start?: boolean }; result: McpReport }
  /** Does something to one of a folder's MCP servers; answers with the servers as they stand afterwards. */
  mcpAct: { params: { root: string; action: McpAction }; result: McpOutcome }
  /** The sandbox around the agent's commands in a folder, for the Sandbox screen. */
  sandboxReport: { params: { root: string }; result: SandboxReport }
  /** Changes a switch of the sandbox or checks the machine again; answers with the sandbox as it stands afterwards. */
  sandboxAct: { params: { root: string; action: SandboxAction }; result: SandboxOutcome }
  /** A commit message for the changes given, from the model of the Small tasks role. */
  draftCommit: { params: CommitDraftInput; result: { message: string } }
  /** What the model of the Review role finds wrong with a change. */
  codeReview: { params: CodeReviewInput; result: CodeReviewResult }
  /** A folder's language servers, for the Settings screen; with `logs`, the last lines of those that stopped or failed. */
  codeReport: { params: { root: string; logs?: number }; result: LanguageServersReport & { logs?: Record<string, string[]> } }
  /** What installing a language server would do, for the person to read first. */
  codeInstallPlan: { params: { root: string; id: string }; result: InstallPlan | { unavailable: string } }
  /** Installs a language server the person said yes to; answers once it is installed or failed. */
  codeInstall: { params: { root: string; id: string }; result: InstallResult }
  /** Stops an install that runs; it ends as failed, with nothing left behind. */
  codeInstallCancel: { params: { id: string }; result: void }
  /** Removes a language server eNCode installed. */
  codeUninstall: { params: { id: string }; result: InstallResult }
  /** A question of the editor's to the servers of a file it shows; answered for the text it sent before it. */
  codeAsk: { params: { root: string; ask: EditorAsk }; result: EditorAnswer }
  /** A rename or a code action of the editor's, its preview, or taking one back; after the editor's earlier changes. */
  codeChange: { params: { root: string; request: EditorChangeRequest }; result: EditorChangeResult }
  /** A suggestion at the editor's cursor from the model of the Inline suggestions role (ADR 0087); the caller cancels one it no longer wants. */
  inlineSuggest: { params: { root: string; request: InlineSuggestRequest }; result: InlineSuggestAnswer }
}

/** A file the editor shows, opened, changed or closed, in a folder named as the main process knows it. */
export type EditorDocumentEvent = EditorDocumentChange & { root: string }

/**
 * What the host serves. `mcp`: a folder's MCP servers changed what the screen shows (the folder is named as the host knows it).
 * `sandbox`: the sandbox was checked or is preparing a folder, so the Sandbox screen should ask again.
 * `code`: a folder's language server started, stopped or failed. `diagnostics`: what a server says of a file now, by
 * real paths; an empty list takes the file's marks away.
 */
export type DesktopHostApi = {
  requests: DesktopHostRequests
  events: HostEvents & {
    alert: ModelAlert
    mcp: { root: string }
    sandbox: { working: string | null }
    code: { root: string }
    diagnostics: { root: string; file: string; diagnostics: CodeDiagnostic[] }
    /** How the model test that runs is going. */
    modelTest: ModelTestProgress
  }
}

/** What the main process serves to the host. */
export type MainApi = {
  requests: {
    /**
     * The key stored for a model profile, for a call to `baseUrl`; empty when there is none, or when the
     * profile's key was entered for another server (a key is bound to its server).
     */
    key: { params: { profileId: string; baseUrl: string }; result: string }
    /**
     * The API key of a search provider, for a search about to be sent to that provider's own address (fixed in the
     * code, never a setting); empty when there is none.
     */
    searchKey: { params: { provider: KeyedSearchProviderId }; result: string }
    /** A step of the Browser tool in the agent tab of a chat (ADR 0103); the window shows the tab. */
    browser: { params: { session: string; request: BrowserRequest }; result: BrowserAnswer }
  }
  events: {
    /** What the editor shows, for the language servers: its text goes before it is saved. */
    document: EditorDocumentEvent
  }
}
