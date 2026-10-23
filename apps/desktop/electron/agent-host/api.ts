/**
 * The wire between the main process and the agent host (a utility process).
 * The host serves the session API of @encode/core and three requests of its
 * own; the main process answers one, for keys. Everything crosses as
 * structured-clonable data, and secrets cross only when asked for.
 */
import type { ErrorGate, HostEvents, HostRequests } from '@encode/core'
import type { CodeDiagnostic } from '@encode/tools'
import type { EditorDocumentChange, LanguageServersReport } from '@encode/workspace'
import type { ModelMode } from '../../shared/models'
import type { KeyedSearchProviderId, SearchCheckResult, SearchProviderId } from '../../shared/search'
import type { ApprovalPolicy, McpAction, McpOutcome, McpReport, ModelAlert, ModelRole, ModelStatus, PermissionsAction, PermissionsOutcome, PermissionsReport, ReasoningEffort, SandboxAction, SandboxOutcome, SandboxReport } from '../../shared/types'
import type { CodeReviewInput, CodeReviewResult } from './code-review'
import type { CommitDraftInput } from './commit-message'
import type { RouterSettings } from './router-settings'

/** What the host needs to know about the user's settings, and nothing else of them. */
export interface HostConfig {
  policy: ApprovalPolicy
  maxSteps: number
  maxGoalRounds: number
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
  }
  events: {
    /** What the editor shows, for the language servers: its text goes before it is saved. */
    document: EditorDocumentEvent
  }
}
