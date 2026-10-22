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
import type { ModelAlert, ModelStatus } from '../../shared/types'
import type { DesktopHostApi, HostConfig, HostInit, MainApi, ModelCheckResult } from './api'

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
  onEvent(event: AgentEvent): void
  onJobs(jobs: BackgroundJob[]): void
  /** The model router has something the person should hear: a key was refused, a quota is spent, a model is closed to the account. */
  onAlert?(alert: ModelAlert): void
  log?(message: string): void
  /** The pause before the first restart, ms; it doubles with every failure. Default 400. */
  restartDelayMs?: number
  maxRestartDelayMs?: number
  /** Failures in a row before the host stays down until it is asked for again. Default 5. */
  maxFailures?: number
  /** A host that ran this long counts as healthy again, ms. Default 60 000. */
  healthyAfterMs?: number
}

export const HOST_STOPPED_MESSAGE = 'The agent process stopped unexpectedly. Your conversation is saved; send your message again.'

const REQUEST_TIMEOUT_MS = 60_000
const LONG_REQUEST_TIMEOUT_MS = 10 * 60_000
const INIT_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 4_000

/** What the host may ask for: the host is a separate process, so its requests are checked like any other input. */
const KEY_REQUEST = {
  type: 'object',
  required: ['profileId', 'baseUrl'],
  additionalProperties: false,
  properties: { profileId: { type: 'string', minLength: 1, maxLength: 200 }, baseUrl: { type: 'string', maxLength: 2_000 } },
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
    peer.on('event', (event) => {
      this.track(event)
      this.o.onEvent(event)
    })
    peer.on('jobs', (jobs) => this.o.onJobs(jobs))
    peer.on('alert', (alert) => this.o.onAlert?.(alert))
    peer.on('warn', (message) => this.log(message))
    child.onExit(() => this.exited(child, peer))

    const starting = peer
      .request('init', { ...this.o.init(), config: this.config ?? NO_CONFIG }, { timeoutMs: INIT_TIMEOUT_MS })
      .then(() => {
        if (this.child !== child) throw new Error('The agent process stopped while it was starting.')
        this.peer = peer
        this.startedAt = Date.now()
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
      this.o.onEvent({ type: 'error', message: HOST_STOPPED_MESSAGE, sessionId })
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
  model: 'none',
  router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } },
  providers: {},
}
