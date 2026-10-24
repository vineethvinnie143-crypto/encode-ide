/**
 * The main process's side of the agent host: starts the utility process,
 * hands it its configuration, answers its requests for keys, passes its
 * events on, and starts it again if it dies. It never touches Electron
 * itself; `spawn` does.
 *
 * A turn the host was running when it died is over: the user is told, and the
 * conversation stays as the session log left it.
 */
import { createHostClient, type AgentEvent, type AgentStatus, type BackgroundJob, type HostCaller, type HostClient } from '@encode/core'
import { Peer, type Port, type RequestOptions } from '@encode/protocol'
import { DEFAULT_SEARCH_PROVIDER, KEYED_SEARCH_PROVIDER_IDS, type KeyedSearchProviderId, type SearchCheckResult } from '../../shared/search'
import type { CodeDiagnostic, EditorAnswer, EditorAsk, EditorChangeRequest, EditorChangeResult, InlineSuggestAnswer, InlineSuggestRequest, LanguageServersReport, ServerInstallPlan, ServerInstallResult, McpAction, McpOutcome, McpReport, ModelAlert, ModelStatus, PermissionsAction, PermissionsOutcome, PermissionsReport, SandboxAction, SandboxOutcome, SandboxReport } from '../../shared/types'
import type { DesktopHostApi, EditorDocumentEvent, HostConfig, HostInit, MainApi, ModelCheckResult } from './api'
import type { CodeReviewInput, CodeReviewResult } from '@encode/core'
import type { CommitDraftInput } from './commit-message'
import { HOST_STOPPED_MESSAGE } from '../../shared/problems'

export interface HostProcess {
  port: Port
  /** Ends the process. */
  kill(): void
  /** Calls `handler` once, when the process has ended. */
  onExit(handler: () => void): void
}

export interface AgentHostServiceOptions {
  spawn(): HostProcess
  /** Where things are now; the configuration is added by the service. */
  init(): Omit<HostInit, 'config'>
  /** The key stored for a profile when it is about to be sent to `baseUrl`, or an empty string. */
  apiKey(profileId: string, baseUrl: string): string | Promise<string>
  /** The key of a search provider that needs one, or an empty string. */
  searchKey(provider: KeyedSearchProviderId): string | Promise<string>
  onEvent(event: AgentEvent): void
  onJobs(jobs: BackgroundJob[]): void
  /** The model router has something the person should hear: a key was refused, a quota is spent, a model is closed to the account. */
  onAlert?(alert: ModelAlert): void
  /** A folder's MCP servers changed what the MCP screen shows. */
  onMcp?(root: string): void
  /** The sandbox was checked, or is preparing a folder: the Sandbox screen should ask again. */
  onSandbox?(): void
  /** A folder's language server started, stopped or failed. */
  onCode?(root: string): void
  /** What a language server says of a file now, by real paths. */
  onDiagnostics?(root: string, file: string, diagnostics: CodeDiagnostic[]): void
  log?(message: string): void
  /** The pause before the first restart, ms; it doubles with every failure. Default 400. */
  restartDelayMs?: number
  maxRestartDelayMs?: number
  /** Failures in a row before the host stays down until it is asked for again. Default 5. */
  maxFailures?: number
  /** A host that ran this long counts as healthy again, ms. Default 60 000. */
  healthyAfterMs?: number
}

export { HOST_STOPPED_MESSAGE }

const REQUEST_TIMEOUT_MS = 60_000
const LONG_REQUEST_TIMEOUT_MS = 10 * 60_000
/** A language server's download or its toolchain's install, on a slow line. */
const INSTALL_TIMEOUT_MS = 30 * 60_000
/** A server that starts for the question (the first one in a big project) can take this long to answer. */
const CODE_ASK_TIMEOUT_MS = 30_000
const CODE_CHANGE_TIMEOUT_MS = 120_000
/** The host gives a suggestion 10 seconds; this is its backstop. */
const INLINE_TIMEOUT_MS = 12_000
const INIT_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 4_000

/** What the host may ask for: the host is a separate process, so its requests are checked like any other input. */
const KEY_REQUEST = {
  type: 'object',
  required: ['profileId', 'baseUrl'],
  additionalProperties: false,
  properties: { profileId: { type: 'string', minLength: 1, maxLength: 200 }, baseUrl: { type: 'string', maxLength: 2_000 } },
}

const SEARCH_KEY_REQUEST = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: { provider: { type: 'string', enum: [...KEYED_SEARCH_PROVIDER_IDS] } },
}

const STILL_WORKING: ReadonlySet<AgentStatus> = new Set(['thinking', 'running-tool', 'awaiting-approval', 'awaiting-user'])

export class AgentHostService {
  readonly client: HostClient
  private child: HostProcess | undefined
  private peer: Peer<MainApi, DesktopHostApi> | undefined
  private starting: Promise<Peer<MainApi, DesktopHostApi>> | undefined
  private config: HostConfig | undefined
  private failures = 0
  private startedAt = 0
  private disposed = false
  private restartTimer: NodeJS.Timeout | undefined
  /** The sessions the host last reported as working, by id. */
  private readonly working = new Set<string>()
  /**
   * The files the editor shows, with their text: a host that starts again is shown them, and a change of a file that
   * was not opened in this folder (one sent before the folder changed) is dropped.
   */
  private documents = new Map<string, { text: string; dirty: boolean }>()
  private documentsRoot: string | null = null

  constructor(private readonly o: AgentHostServiceOptions) {
    const caller: HostCaller = {
      request: (async (method: string, ...args: unknown[]) => {
        const peer = await this.ready()
        const [params] = args as [unknown]
        // A turn lasts as long as it lasts; every other request should answer promptly.
        const timeoutMs = method === 'start' ? 0 : method === 'compact' ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        const options: RequestOptions = { timeoutMs }
        return (peer as unknown as { request(method: string, params: unknown, options: RequestOptions): Promise<unknown> }).request(method, params, options)
      }) as HostCaller['request'],
    }
    this.client = createHostClient(caller)
  }

  private log(message: string): void {
    ;(this.o.log ?? ((text: string) => console.error(`[agent-host] ${text}`)))(message)
  }

  /** Starts the host if it is not running. Resolves when it is ready to answer. */
  async start(): Promise<void> {
    await this.ready()
  }

  /** Tells the host which model and limits to use; takes effect on its next call. */
  configure(config: HostConfig): void {
    this.config = config
    const peer = this.peer
    if (peer && !peer.closed) {
      peer.request('configure', config, { timeoutMs: REQUEST_TIMEOUT_MS }).catch((error) => this.log(`could not send the settings: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  /** How the model connections are doing. */
  async modelStatus(): Promise<ModelStatus> {
    return (await this.ready()).request('modelStatus', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** A small tool call to one model, the way the agent will make it. */
  async modelCheck(profileId: string, model: string): Promise<ModelCheckResult> {
    return (await this.ready()).request('modelCheck', { profileId, model }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS })
  }

  /** Lifts what a refused key or a payment problem set, and reads the model lists again. */
  async modelRecheck(): Promise<void> {
    await (await this.ready()).request('modelRecheck', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** One search through the provider in use, the way the agent makes it. */
  async searchCheck(): Promise<SearchCheckResult> {
    return (await this.ready()).request('searchCheck', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** A folder's settings, trust and permission rules. */
  async permissionsReport(root: string): Promise<PermissionsReport> {
    return (await this.ready()).request('permissionsReport', { root }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** Does something to a folder's settings; the folder as it stands afterwards comes back. */
  async permissionsAct(root: string, action: PermissionsAction): Promise<PermissionsOutcome> {
    return (await this.ready()).request('permissionsAct', { root, action }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** A folder's MCP servers and how they stand. */
  async mcpReport(root: string, options: { start?: boolean } = {}): Promise<McpReport> {
    return (await this.ready()).request('mcpReport', { root, ...(options.start === false ? { start: false } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** Does something to one of a folder's MCP servers; the servers as they stand afterwards come back. */
  async mcpAct(root: string, action: McpAction): Promise<McpOutcome> {
    return (await this.ready()).request('mcpAct', { root, action }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** The sandbox around the agent's commands in a folder. */
  async sandboxReport(root: string): Promise<SandboxReport> {
    return (await this.ready()).request('sandboxReport', { root }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** Changes a switch of the sandbox or checks the machine again; the sandbox as it stands afterwards comes back. */
  async sandboxAct(root: string, action: SandboxAction): Promise<SandboxOutcome> {
    return (await this.ready()).request('sandboxAct', { root, action }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS })
  }

  /** What installing a language server would do. */
  async codeInstallPlan(root: string, id: string): Promise<ServerInstallPlan | { unavailable: string }> {
    return (await this.ready()).request('codeInstallPlan', { root, id }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** Installs a language server the person said yes to. */
  async codeInstall(root: string, id: string): Promise<ServerInstallResult> {
    return (await this.ready()).request('codeInstall', { root, id }, { timeoutMs: INSTALL_TIMEOUT_MS })
  }

  /** Stops an install that runs. */
  async codeInstallCancel(id: string): Promise<void> {
    return (await this.ready()).request('codeInstallCancel', { id }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** Removes a language server eNCode installed. */
  async codeUninstall(id: string): Promise<ServerInstallResult> {
    return (await this.ready()).request('codeUninstall', { id }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /** A folder's language servers, and with `logs` the last lines of those that stopped or failed. */
  async codeReport(root: string, options: { logs?: number } = {}): Promise<LanguageServersReport & { logs?: Record<string, string[]> }> {
    return (await this.ready()).request('codeReport', { root, ...(options.logs ? { logs: options.logs } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS })
  }

  /**
   * A question of the editor's to the servers of a file it shows. It goes after the changes the editor sent before
   * it, on the same channel, so it is answered for that text. A server that is still starting may take a while.
   */
  async codeAsk<K extends EditorAsk['kind']>(root: string, ask: Extract<EditorAsk, { kind: K }>): Promise<EditorAnswer<K>> {
    return (await (await this.ready()).request('codeAsk', { root, ask }, { timeoutMs: CODE_ASK_TIMEOUT_MS })) as EditorAnswer<K>
  }

  /** A suggestion at the editor's cursor; `signal` stops it when the editor no longer wants it. */
  async inlineSuggest(root: string, request: InlineSuggestRequest, signal: AbortSignal): Promise<InlineSuggestAnswer> {
    return (await this.ready()).request('inlineSuggest', { root, request }, { timeoutMs: INLINE_TIMEOUT_MS, signal })
  }

  /**
   * A rename or a code action of the editor's across the folder `root`, after the editor's earlier changes. A server's
   * command can take a while (it is given a minute), and so can a large rename.
   */
  async codeChange(root: string, request: EditorChangeRequest): Promise<EditorChangeResult> {
    return (await this.ready()).request('codeChange', { root, request }, { timeoutMs: CODE_CHANGE_TIMEOUT_MS })
  }

  /** The editor opened, changed or closed a file of the folder `root`. */
  document(event: EditorDocumentEvent): void {
    if (event.root !== this.documentsRoot) {
      this.closeDocuments()
      this.documentsRoot = event.root
    }
    if (event.kind === 'close') {
      if (!this.documents.delete(event.path)) return
    } else {
      if (event.kind === 'change' && !this.documents.has(event.path)) return
      this.documents.set(event.path, { text: event.text, dirty: event.dirty })
    }
    this.sendDocument(event)
  }

  /** The folder closed or changed: its servers are told the editor shows none of its files any more. */
  closeDocuments(): void {
    const root = this.documentsRoot
    const paths = [...this.documents.keys()]
    this.documents = new Map()
    this.documentsRoot = null
    if (root) for (const path of paths) this.sendDocument({ kind: 'close', root, path })
  }

  private sendDocument(event: EditorDocumentEvent): void {
    const peer = this.peer
    // A host that is starting is shown every open file once it is up.
    if (!peer || peer.closed || this.starting) return
    try {
      peer.notify('document', event)
    } catch (error) {
      this.log(`could not pass a file of the editor on: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** A commit message for the changes given, from the model of the Small tasks role. */
  async draftCommit(input: CommitDraftInput): Promise<string> {
    return (await (await this.ready()).request('draftCommit', input, { timeoutMs: 2 * 60_000 })).message
  }

  /** What the model of the Review role finds wrong with a change. */
  async codeReview(input: CodeReviewInput): Promise<CodeReviewResult> {
    return (await this.ready()).request('codeReview', input, { timeoutMs: 6 * 60_000 })
  }

  private ready(): Promise<Peer<MainApi, DesktopHostApi>> {
    if (this.disposed) return Promise.reject(new Error('eNCode is closing.'))
    if (this.starting) return this.starting
    if (this.peer && !this.peer.closed) return Promise.resolve(this.peer)
    // Asked for after giving up: try afresh.
    this.failures = Math.min(this.failures, (this.o.maxFailures ?? 5) - 1)
    return this.spawn()
  }

  private spawn(): Promise<Peer<MainApi, DesktopHostApi>> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.o.spawn()
    const peer = new Peer<MainApi, DesktopHostApi>(child.port, { onProtocolError: (error) => this.log(error.message) })
    this.child = child
    peer.handle(
      'key',
      async ({ profileId, baseUrl }) => {
        try {
          return (await this.o.apiKey(profileId, baseUrl)) || ''
        } catch {
          return ''
        }
      },
      { schema: KEY_REQUEST },
    )
    peer.handle(
      'searchKey',
      async ({ provider }) => {
        try {
          return (await this.o.searchKey(provider)) || ''
        } catch {
          return ''
        }
      },
      { schema: SEARCH_KEY_REQUEST },
    )
    peer.on('event', (event) => {
      this.track(event)
      this.o.onEvent(event)
    })
    peer.on('jobs', (jobs) => this.o.onJobs(jobs))
    peer.on('alert', (alert) => this.o.onAlert?.(alert))
    peer.on('mcp', ({ root }) => this.o.onMcp?.(root))
    peer.on('sandbox', () => this.o.onSandbox?.())
    peer.on('code', ({ root }) => this.o.onCode?.(root))
    peer.on('diagnostics', ({ root, file, diagnostics }) => this.o.onDiagnostics?.(root, file, diagnostics))
    peer.on('warn', (message) => this.log(message))
    child.onExit(() => this.exited(child, peer))

    const starting = peer
      .request('init', { ...this.o.init(), config: this.config ?? NO_CONFIG }, { timeoutMs: INIT_TIMEOUT_MS })
      .then(() => {
        if (this.child !== child) throw new Error('The agent process stopped while it was starting.')
        this.peer = peer
        this.startedAt = Date.now()
        const root = this.documentsRoot
        if (root) for (const [path, doc] of this.documents) peer.notify('document', { kind: 'open', root, path, text: doc.text, dirty: doc.dirty })
        return peer
      })
      .catch((error) => {
        // Not usable: end it, and let the exit handler count the failure.
        child.kill()
        throw error
      })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined
      })
    this.starting = starting
    // A failure is reported to whoever asked; this keeps it from being reported twice as unhandled.
    starting.catch(() => undefined)
    return starting
  }

  private track(event: AgentEvent): void {
    if (event.type === 'status') {
      if (STILL_WORKING.has(event.status)) this.working.add(event.sessionId)
      else this.working.delete(event.sessionId)
    } else if (event.type === 'done' || event.type === 'error' || event.type === 'session-reset') {
      this.working.delete(event.sessionId)
    }
  }

  private exited(child: HostProcess, peer: Peer<MainApi, DesktopHostApi>): void {
    if (this.child !== child) return
    this.child = undefined
    this.peer = undefined
    peer.close('The agent process stopped.')
    if (this.disposed) return

    const ranFor = Date.now() - this.startedAt
    this.failures = this.startedAt && ranFor >= (this.o.healthyAfterMs ?? 60_000) ? 1 : this.failures + 1
    this.startedAt = 0
    this.log(`the agent process stopped (failure ${this.failures})`)

    for (const sessionId of [...this.working]) {
      this.o.onEvent({ type: 'error', message: HOST_STOPPED_MESSAGE, problem: { code: 'host', actions: ['retry'] }, sessionId })
      this.o.onEvent({ type: 'status', status: 'error', sessionId })
    }
    this.working.clear()

    // Start it again at once, so schedules and background work carry on; later requests also start it if it is down.
    const maxFailures = this.o.maxFailures ?? 5
    if (this.failures >= maxFailures) {
      this.log('the agent process keeps stopping; it will be started again when it is next needed')
      return
    }
    const delay = Math.min(this.o.maxRestartDelayMs ?? 15_000, (this.o.restartDelayMs ?? 400) * 2 ** (this.failures - 1))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.disposed && !this.child) this.spawn().catch((error) => this.log(`could not restart: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
  }

  /** For a diagnostics report: whether the process is up, how many times in a row it stopped, how many sessions are working. */
  health(): { running: boolean; failures: number; working: number } {
    return { running: Boolean(this.peer && !this.peer.closed), failures: this.failures, working: this.working.size }
  }

  /** Closes the sessions, then the process. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const { peer, child } = this
    if (peer && !peer.closed) await peer.request('shutdown', undefined, { timeoutMs: SHUTDOWN_TIMEOUT_MS }).catch(() => undefined)
    peer?.close('eNCode is closing.')
    child?.kill()
  }
}

const NO_CONFIG: HostConfig = {
  policy: 'workspace-write',
  maxSteps: 30,
  maxGoalRounds: 8,
  computer: false,
  // Nothing starts before the settings arrive.
  languageServers: false,
  errorGate: 'auto',
  guide: 'auto',
  checkGate: 'auto',
  reviewWork: 'auto',
  model: 'none',
  router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } },
  providers: {},
  searchProvider: DEFAULT_SEARCH_PROVIDER,
}
