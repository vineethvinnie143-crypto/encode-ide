import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ExternalToolSource } from '@encode/core'
import { decideServer, describeSetup, mcpConfigFiles, McpManager, type ExternalTool, type McpManagerOptions, type McpPolicy, type McpServerEntry, type ServerDecision, type ServerState, type ServerStatus, type ToolSink } from '@encode/mcp'
import type { Tool } from '@encode/tools'
import type { ConfigSnapshot, WorkspaceConfig } from './config'

/**
 * A folder's MCP servers: which of them run, their tools as the agent's, and what the Settings screen shows of them.
 *
 * One hub for a folder, shared by every session in it, so that a server is started once and not once per chat. It
 * follows the folder's picture (`WorkspaceConfig`): whatever the files and the settings say now is what runs, and a
 * project's server runs only after the person approved that exact entry (ADR 0057). Starting a server can take a
 * while, so nothing here waits for one except `ready`, which a session calls when a turn begins and which gives up
 * after a few seconds: the tools of a late server join from the next turn.
 */

const START_WAIT_MS = 5_000
/** How long an action waits for the server it started before it answers; the screen hears the rest from `onChange`. */
const SETTLE_MS = 1_500
/** How long closing waits for the servers to go: the program is on its way out. */
const CLOSE_WAIT_MS = 2_500
/** A folder nobody works in any more is let go of after this long. */
const IDLE_CLOSE_MS = 5 * 60_000
const NOTIFY_DELAY_MS = 50
const LOG_LINES = 30
const LOG_LINE_CHARS = 300
const TOOL_DESCRIPTION_CHARS = 300

const NOTHING: McpPolicy = { enableAll: false, enabled: [], disabled: [] }

/** One tool of a server, as the Settings screen lists it. The words are the server's. */
export interface McpToolView {
  /** The name the model calls it by. */
  name: string
  description: string
}

/** One server as the Settings screen shows it. */
export interface McpServerView {
  name: string
  /** Yours (the user's own file) or the project's. */
  scope: 'user' | 'project'
  /** The file the entry was read from. */
  file: string
  state: ServerState
  /** In words for the person: why approval is needed, what failed. */
  detail?: string
  /** What approving is for: the exact setup the card showed. */
  digest: string
  /** What approving would run: the command line or the address. */
  summary: string
  /** Names only; the values never leave the files. */
  envNames: string[]
  headerNames: string[]
  /** Variables of the person's own environment that the entry reads. */
  variables: string[]
  tools: McpToolView[]
  resources: number
  prompts: number
  hasInstructions: boolean
  problems: string[]
  /** The last lines the server printed, for finding out why it failed. */
  log: string[]
}

export interface McpReport {
  root: string
  /** Whether the folder is trusted: a project's server cannot be approved before. */
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

export interface McpHubOptions {
  config: WorkspaceConfig
  platform: NodeJS.Platform
  /** What ${VAR} in the files is filled from, and what servers start from before anything that looks like a secret is taken out. */
  env: Record<string, string | undefined>
  /** Something changed that the screen shows: a server's state or its tools. Called after a short pause, never in a burst. */
  onChange?(): void
  /** Nobody has worked in the folder for a while: let the hub go. */
  onIdle?(): void
  warn?(message: string): void
  /** How long a turn waits for servers that are starting, ms. */
  startWaitMs?: number
  idleMs?: number
  /** For tests: how servers are reached, and how patient the manager is. */
  manager?: Partial<Pick<McpManagerOptions, 'createTransport' | 'connectTimeoutMs' | 'retryBaseMs' | 'clientInfo' | 'isFile' | 'concurrency' | 'now'>>
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal?.addEventListener('abort', done, { once: true })
  })
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0)

function clipped(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export class McpHub implements ExternalToolSource {
  private readonly tools = new Map<string, ExternalTool>()
  private readonly logs = new Map<string, string[]>()
  /** What ${VAR} is filled from. Handed to the manager once and changed in place, so that it always holds the settings' variables of the moment. */
  private readonly env: Record<string, string | undefined> = {}
  private version = 0
  private keyed: { version: number; key: string } | undefined
  private manager: McpManager | undefined
  /** The picture the servers were last brought in line with, and the one being brought in line. */
  private applied: ConfigSnapshot | undefined
  private wanted: ConfigSnapshot | undefined
  private applies: Promise<void> = Promise.resolve()
  /** Everything that is starting servers; `ready` waits on it, and a new wave of work replaces it. */
  private starting: Promise<void> = Promise.resolve()
  private waited: Promise<void> | undefined
  private pending = 0
  private users = 0
  private idleTimer: NodeJS.Timeout | undefined
  private notifyTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: McpHubOptions) {}

  // ---- the agent's side ----------------------------------------------------------------------

  private readonly sink: ToolSink = {
    register: (tool) => {
      const { name } = tool.definition
      if (this.tools.has(name)) throw new Error(`A tool called ${name} is already registered.`)
      this.tools.set(name, tool)
      this.touched()
      return () => {
        if (this.tools.get(name) !== tool) return
        this.tools.delete(name)
        this.touched()
      }
    },
  }

  /** Changes when a tool's name, description or schema does, and not when a server only reconnects with the same tools. */
  key(): string {
    if (this.keyed?.version !== this.version) {
      const hash = createHash('sha256')
      for (const [name, tool] of [...this.tools.entries()].sort(byName)) {
        hash.update(`${name}\u0000${tool.definition.description}\u0000${JSON.stringify(tool.definition.inputSchema)}\n`)
      }
      this.keyed = { version: this.version, key: hash.digest('hex').slice(0, 16) }
    }
    return this.keyed.key
  }

  /** In name order, so that the start of every request stays the same while the tools do. */
  list(): readonly Tool[] {
    return [...this.tools.entries()].sort(byName).map(([, tool]) => tool)
  }

  instructions(): ReadonlyArray<{ server: string; text: string }> {
    return this.manager?.instructions() ?? []
  }

  /**
   * Brings the servers in line with the folder's files as they are now, and gives those that are starting a few seconds.
   * A wave of starting is waited for once: the next turn does not wait again for a server that is slow.
   */
  async ready(signal: AbortSignal): Promise<void> {
    await this.follow(this.options.config)
    const starting = this.starting
    if (starting === this.waited) return
    this.waited = starting
    await Promise.race([starting, pause(this.options.startWaitMs ?? START_WAIT_MS, signal)])
  }

  // ---- following the folder -----------------------------------------------------------------------

  /** Which servers may run under a picture, and under which rules. While the settings cannot be trusted, none. */
  private plan(snapshot: ConfigSnapshot): { entries: McpServerEntry[]; policy: McpPolicy } {
    return snapshot.broken ? { entries: [], policy: NOTHING } : { entries: snapshot.mcp.servers, policy: snapshot.mcp.policy }
  }

  private fillEnv(snapshot: ConfigSnapshot): void {
    for (const key of Object.keys(this.env)) delete this.env[key]
    Object.assign(this.env, this.options.env, snapshot.effective.env)
  }

  /** Notes that servers are starting, for `ready` and for the screen. */
  private watch(work: Promise<unknown>): void {
    this.pending++
    const settled = work.then(
      () => undefined,
      () => undefined,
    )
    this.starting = Promise.all([this.starting, settled]).then(() => undefined)
    void settled.then(() => {
      this.pending--
      this.notify()
    })
  }

  /**
   * Follows the folder's picture. Does not wait for any server: starting is slow, and the files are read again before
   * every turn and every tool call, so this is called all the time.
   */
  sync(snapshot: ConfigSnapshot): void {
    if (this.closed) return
    this.arm()
    if (snapshot === this.wanted) return
    this.wanted = snapshot
    this.fillEnv(snapshot)
    const { entries, policy } = this.plan(snapshot)
    if (!this.manager) {
      const manager = new McpManager({
        root: this.options.config.root,
        home: this.options.config.home,
        entries,
        policy,
        trust: this.options.config.trustStore,
        tools: this.sink,
        env: this.env,
        platform: this.options.platform,
        onStatus: () => this.notify(),
        onLog: (server, level, text) => this.log(server, level, text),
        ...this.options.manager,
      })
      this.manager = manager
      this.applied = snapshot
      this.watch(manager.start())
      return
    }
    // One update at a time; a later one finds the newest picture waiting.
    this.applies = this.applies.then(async () => {
      const next = this.wanted
      if (this.closed || !this.manager || !next || next === this.applied) return
      this.applied = next
      const plan = this.plan(next)
      await this.manager.update(plan.entries, plan.policy)
    })
    this.watch(this.applies)
    this.applies = this.applies.catch((error: unknown) => {
      this.options.warn?.(`Could not update the MCP servers of ${this.options.config.root}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Reads the folder's files over and follows them. The folder's own refusal says why when they cannot be read. */
  async follow(config: WorkspaceConfig): Promise<void> {
    try {
      this.sync(await config.refresh())
    } catch {
      // Whatever runs keeps running.
    }
  }

  private log(server: string, level: string, text: string): void {
    const lines = this.logs.get(server) ?? []
    lines.push(clipped(level === 'stderr' ? text : `${level}: ${text}`, LOG_LINE_CHARS))
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
    this.logs.set(server, lines)
  }

  private touched(): void {
    this.version++
    this.notify()
  }

  private notify(): void {
    if (this.closed || this.notifyTimer || !this.options.onChange) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (!this.closed) this.options.onChange?.()
    }, NOTIFY_DELAY_MS)
    this.notifyTimer.unref?.()
  }

  // ---- what the screen asks for ----------------------------------------------------------------------

  /**
   * The servers as they stand, with the first moments of a start given time to show. With `start: false` nothing is
   * started for the sake of looking: servers that are not running are reported by what the settings and the person's
   * approvals say of them.
   */
  async report(snapshot: ConfigSnapshot, options: { start?: boolean } = {}): Promise<McpReport> {
    this.arm()
    const looking = options.start === false
    if (!looking) this.sync(snapshot)
    // Who may run is worked out in a few milliseconds; how long a server takes is its own business.
    if (!looking) await Promise.race([this.starting, pause(200)])
    const decisions = looking || !this.manager ? await this.decisions(snapshot) : undefined
    const { config, platform } = this.options
    const api = platform === 'win32' ? path.win32 : path.posix
    const [user, project, encode] = mcpConfigFiles(config.home, config.root, api).map((entry) => entry.file)
    const statuses = new Map((this.manager?.status() ?? []).map((status) => [status.name, status]))
    const servers: McpServerView[] = snapshot.mcp.servers.map((entry) => {
      // A look that starts nothing does not bring the servers in line with the files, so it trusts a status only for the setup it is about.
      const known = statuses.get(entry.name)
      const status: ServerStatus | undefined = known && (!looking || known.digest === entry.digest) ? known : undefined
      const decision = decisions?.get(entry.name)
      const waiting = decision && !decision.run ? decision : undefined
      const detail = status?.detail ?? waiting?.detail ?? snapshot.broken ?? undefined
      return {
        name: entry.name,
        scope: entry.scope,
        file: entry.file,
        state: status?.state ?? waiting?.state ?? 'stopped',
        ...(detail ? { detail } : decision?.run ? { detail: 'It starts with your next chat in this folder.' } : {}),
        digest: entry.digest,
        ...describeSetup(entry.setup),
        variables: entry.variables,
        tools: [...this.tools.values()]
          .filter((tool) => tool.mcp?.server === entry.name)
          .map((tool) => ({ name: tool.definition.name, description: clipped(tool.definition.description, TOOL_DESCRIPTION_CHARS) })),
        resources: status?.resources ?? 0,
        prompts: status?.prompts ?? 0,
        hasInstructions: status?.hasInstructions ?? false,
        problems: status?.problems ?? [],
        log: this.logs.get(entry.name) ?? [],
      }
    })
    return {
      root: config.root,
      trusted: snapshot.folder.trusted,
      broken: snapshot.broken,
      starting: this.pending > 0,
      servers,
      problems: snapshot.mcp.problems,
      files: { user, project, encode },
    }
  }

  /** Where each server stands by the settings and the person's approvals alone, for a look that starts nothing. */
  private async decisions(snapshot: ConfigSnapshot): Promise<Map<string, ServerDecision>> {
    const record = await this.options.config.trustStore.get(this.options.config.root).catch(() => ({ trusted: false }))
    const { entries, policy } = this.plan(snapshot)
    return new Map(entries.map((entry) => [entry.name, decideServer(entry, policy, record)]))
  }

  /** Records the person's approval of a project's server in exactly the setup they saw, and starts it. */
  async approve(name: string, digest: string): Promise<void> {
    const manager = this.manager
    if (!manager) throw new Error('The MCP servers of this folder have not been read yet.')
    await this.within(manager.approve(name, digest))
  }

  /** Starts a server again by hand. */
  async restart(name: string): Promise<void> {
    const manager = this.manager
    if (!manager) throw new Error('The MCP servers of this folder have not been read yet.')
    await this.within(manager.restart(name))
  }

  /** Waits for work on a server for a moment: a refusal comes back at once, a slow start is told by `onChange`. */
  private async within(work: Promise<void>): Promise<void> {
    this.watch(work)
    let failure: unknown
    let failed = false
    const caught = work.catch((error: unknown) => {
      failed = true
      failure = error
    })
    await Promise.race([caught, pause(SETTLE_MS)])
    if (failed) throw failure
  }

  // ---- how long the hub lives ------------------------------------------------------------------------

  /** A session works in the folder; the returned function says it is done. */
  acquire(): () => void {
    this.users++
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    let released = false
    return () => {
      if (released) return
      released = true
      this.users--
      this.arm()
    }
  }

  /** Counts the time nobody works in the folder, from the last session that left or the last look at the servers. */
  private arm(): void {
    if (this.closed || this.users > 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.options.onIdle?.(), this.options.idleMs ?? IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  /** Stops every server and lets go of their tools. Quick enough for a program that is closing. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer)
    clearTimeout(this.notifyTimer)
    const manager = this.manager
    this.manager = undefined
    await Promise.race([manager?.close().catch(() => undefined), pause(CLOSE_WAIT_MS)])
    this.tools.clear()
    this.version++
  }
}
