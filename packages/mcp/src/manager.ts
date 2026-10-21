import fs from 'node:fs/promises'
import type { TrustRecord } from '@encode/config'
import { mcpTool, resourceTools, type ExternalTool, type ResourceSource, type ToolCaller } from './adapter'
import { McpClient, type CallOptions, type ChangeKind } from './client'
import { expandSetup, type McpScope, type McpServerEntry, type ServerSetup } from './config'
import { LegacySseTransport, StreamableHttpTransport } from './http'
import type { Transport } from './jsonrpc'
import { modelToolName, ruleToolName } from './names'
import { resolveProgram, serverEnvironment, spawnTarget, type ProgramHost } from './program'
import type { McpContent, McpPrompt, McpPromptResult, McpResource, McpResourceTemplate, McpToolResult } from './protocol'
import { StdioTransport } from './stdio'

/**
 * Runs the configured servers and keeps their tools registered.
 *
 * Which servers run is decided here and nowhere else. The user's own
 * servers run unless settings turn them off. A project's servers run only
 * when the folder is trusted and the user approved that exact entry (its
 * digest), or settings enable it by name (settings the user wrote, or a
 * folder configuration the user approved). When an entry changes (a pull, or
 * the agent editing .mcp.json), the old one stops at once and the new one
 * waits for approval.
 *
 * A server that dies stays in the tool list, so the list the model sees does
 * not change under it; the next call starts the server again, with a pause
 * that grows after each failure so a crashing program is not started once
 * per call.
 */

export interface ToolSink {
  /** Adds a tool and returns the function that removes it. */
  register(tool: ExternalTool): () => void
}

export interface McpTrust {
  get(rootReal: string): Promise<TrustRecord>
  approveServer(rootReal: string, name: string, digest: string): Promise<void>
}

export interface McpPolicy {
  /** Every server of the project's files runs. */
  enableAll: boolean
  /** Project servers that run by name. */
  enabled: readonly string[]
  /** Servers that never run. */
  disabled: readonly string[]
}

export type ServerState = 'disabled' | 'needs-approval' | 'connecting' | 'connected' | 'failed' | 'stopped'

export interface ServerStatus {
  name: string
  scope: McpScope
  state: ServerState
  /** In words for the user: why approval is needed, what failed. */
  detail?: string
  digest: string
  /** What approving would run: the command line or the address. */
  summary: string
  /** Names only; the values of variables and headers are never shown. */
  envNames: string[]
  headerNames: string[]
  /** Environment variables of the user's that the entry reads. */
  variables: string[]
  /** Tool names as the model sees them. */
  tools: string[]
  resources: number
  prompts: number
  hasInstructions: boolean
  problems: string[]
}

export interface McpManagerOptions {
  /** The workspace root, as a real path. */
  root: string
  home: string
  entries: McpServerEntry[]
  policy: McpPolicy
  trust: McpTrust
  tools: ToolSink
  /** The user's environment: ${VAR} is filled from it, and stdio servers get a filtered copy. */
  env: Record<string, string | undefined>
  platform?: NodeJS.Platform
  clientInfo?: { name: string; version: string }
  /** For tests: the transport to use instead of starting a program or opening a connection; a string says why not. */
  createTransport?: (entry: McpServerEntry, setup: ServerSetup) => Transport | string | Promise<Transport | string>
  isFile?: (file: string) => Promise<boolean>
  onStatus?: (status: ServerStatus) => void
  onLog?: (server: string, level: string, text: string) => void
  /** How long a server may take to start, ms. Default 60 s: the first start of an npx server downloads it. */
  connectTimeoutMs?: number
  /** The pause after a failed start grows from this, ms. Default 2 s, up to 60 s. */
  retryBaseMs?: number
  now?: () => number
  /** How many servers start at once. Default 4. */
  concurrency?: number
}

interface Runtime {
  entry: McpServerEntry
  state: ServerState
  detail?: string
  client?: McpClient
  tools: Map<string, { name: string; unregister: () => void }>
  resources: McpResource[]
  templates: McpResourceTemplate[]
  prompts: McpPrompt[]
  problems: string[]
  instructions?: string
  connecting?: Promise<void>
  refreshing: Promise<void>
  refreshTimer?: ReturnType<typeof setTimeout>
  failures: number
  retryAt: number
  /** Bumped whenever the runtime is replaced or stopped, so a late connect does not revive it. */
  generation: number
}

export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpUnavailableError'
  }
}

const own = (map: object | undefined, key: string) => map !== undefined && Object.hasOwn(map, key)

function describeSetup(setup: ServerSetup): Pick<ServerStatus, 'summary' | 'envNames' | 'headerNames'> {
  if (setup.type === 'stdio') {
    const words = [setup.command, ...setup.args].map((word) => (/^[A-Za-z0-9_@+=:,./\\~${}-]+$/.test(word) ? word : JSON.stringify(word)))
    return { summary: words.join(' '), envNames: Object.keys(setup.env).sort(), headerNames: [] }
  }
  return { summary: `${setup.type === 'sse' ? 'SSE ' : ''}${setup.url}`, envNames: [], headerNames: Object.keys(setup.headers).sort() }
}

const nodeIsFile = async (file: string) => {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

export class McpManager implements ToolCaller, ResourceSource {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly platform: NodeJS.Platform
  private readonly host: ProgramHost
  private policy: McpPolicy
  private closing = false
  private resourceUnregister: Array<() => void> = []

  constructor(private readonly options: McpManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.policy = options.policy
    this.host = { env: options.env, cwd: options.root, platform: this.platform, isFile: options.isFile ?? nodeIsFile }
    for (const entry of options.entries) this.runtimes.set(entry.name, this.fresh(entry))
  }

  // ---- what the UI and the agent use ----------------------------------------------------------

  /** Decides what runs and starts it. Resolves when every start has finished, one way or the other. */
  async start(): Promise<void> {
    await this.settle([...this.runtimes.values()])
  }

  status(): ServerStatus[] {
    return [...this.runtimes.values()].map((runtime) => this.statusOf(runtime))
  }

  /** Text servers ask to have shown to the model; untrusted, so a caller labels it as such. */
  instructions(): Array<{ server: string; text: string }> {
    return [...this.runtimes.values()].filter((r) => r.state === 'connected' && r.instructions).map((r) => ({ server: r.entry.name, text: r.instructions! }))
  }

  /** The user approves a project server in exactly the setup the card showed. */
  async approve(name: string, digest: string): Promise<void> {
    const runtime = this.runtimes.get(name)
    if (!runtime) throw new McpUnavailableError(`There is no MCP server called ${name}.`)
    if (runtime.entry.scope !== 'project') throw new McpUnavailableError(`${name} is your own server and needs no approval.`)
    if (runtime.entry.digest !== digest) throw new McpUnavailableError(`${name} changed after the approval card was shown; check it again.`)
    const record = await this.options.trust.get(this.options.root)
    if (!record.trusted) throw new McpUnavailableError('Trust this folder first, then approve its MCP servers.')
    await this.options.trust.approveServer(this.options.root, name, digest)
    await this.settle([runtime])
  }

  /** The files or the settings changed: stop what is no longer allowed, start what is. */
  async update(entries: McpServerEntry[], policy: McpPolicy): Promise<void> {
    this.policy = policy
    const names = new Set(entries.map((entry) => entry.name))
    for (const [name, runtime] of this.runtimes) {
      if (!names.has(name)) {
        await this.stop(runtime, 'stopped', 'It is no longer in the configuration.')
        this.dropTools(runtime)
        this.runtimes.delete(name)
      }
    }
    const changed: Runtime[] = []
    for (const entry of entries) {
      const runtime = this.runtimes.get(entry.name)
      if (!runtime) {
        const added = this.fresh(entry)
        this.runtimes.set(entry.name, added)
        changed.push(added)
      } else if (runtime.entry.digest !== entry.digest || runtime.entry.scope !== entry.scope) {
        await this.stop(runtime, 'stopped', 'Its setup changed.')
        runtime.entry = entry
        runtime.failures = 0
        runtime.retryAt = 0
        changed.push(runtime)
      } else {
        runtime.entry = entry
        changed.push(runtime)
      }
    }
    await this.settle(changed)
  }

  /** Starts a server again by hand, ignoring the pause after failures. */
  async restart(name: string): Promise<void> {
    const runtime = this.runtimes.get(name)
    if (!runtime) throw new McpUnavailableError(`There is no MCP server called ${name}.`)
    await this.stop(runtime, 'stopped')
    runtime.failures = 0
    runtime.retryAt = 0
    await this.settle([runtime])
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.runtimes.values()].map((runtime) => this.stop(runtime, 'stopped')))
    for (const runtime of this.runtimes.values()) this.dropTools(runtime)
    for (const unregister of this.resourceUnregister) unregister()
    this.resourceUnregister = []
  }

  // ---- ToolCaller, ResourceSource ---------------------------------------------------------------

  async callTool(server: string, tool: string, input: Record<string, unknown>, options: CallOptions): Promise<McpToolResult> {
    const client = await this.clientFor(server)
    return client.callTool(tool, input, options)
  }

  async listResources(server: string | undefined, signal?: AbortSignal): Promise<Array<{ server: string; resources: McpResource[]; templates: McpResourceTemplate[] }>> {
    const names = server === undefined ? [...this.runtimes.values()].filter((r) => r.state === 'connected').map((r) => r.entry.name) : [server]
    const out: Array<{ server: string; resources: McpResource[]; templates: McpResourceTemplate[] }> = []
    for (const name of names) {
      const client = await this.clientFor(name)
      const [resources, templates] = await Promise.all([client.listResources(signal), client.listResourceTemplates(signal).catch(() => ({ items: [], problems: [] }))])
      out.push({ server: name, resources: resources.items, templates: templates.items })
    }
    return out
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<McpContent[]> {
    return (await this.clientFor(server)).readResource(uri, signal)
  }

  async listPrompts(server: string, signal?: AbortSignal): Promise<McpPrompt[]> {
    return (await (await this.clientFor(server)).listPrompts(signal)).items
  }

  async getPrompt(server: string, name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    return (await this.clientFor(server)).getPrompt(name, args, signal)
  }

  // ---- deciding and connecting -----------------------------------------------------------------

  private fresh(entry: McpServerEntry): Runtime {
    return { entry, state: 'stopped', tools: new Map(), resources: [], templates: [], prompts: [], problems: [], refreshing: Promise.resolve(), failures: 0, retryAt: 0, generation: 0 }
  }

  private statusOf(runtime: Runtime): ServerStatus {
    const { entry } = runtime
    return {
      name: entry.name,
      scope: entry.scope,
      state: runtime.state,
      ...(runtime.detail ? { detail: runtime.detail } : {}),
      digest: entry.digest,
      ...describeSetup(entry.setup),
      variables: entry.variables,
      tools: [...runtime.tools.values()].map((tool) => tool.name),
      resources: runtime.resources.length + runtime.templates.length,
      prompts: runtime.prompts.length,
      hasInstructions: Boolean(runtime.instructions),
      problems: runtime.problems,
    }
  }

  private emit(runtime: Runtime, state: ServerState, detail?: string): void {
    runtime.state = state
    runtime.detail = detail
    this.options.onStatus?.(this.statusOf(runtime))
  }

  /** Whether the server may run now, or why not. */
  private async decide(entry: McpServerEntry): Promise<{ run: true } | { run: false; state: 'disabled' | 'needs-approval'; detail: string }> {
    if (this.policy.disabled.includes(entry.name)) return { run: false, state: 'disabled', detail: 'Turned off in the settings (disabledMcpjsonServers).' }
    if (entry.scope === 'user') return { run: true }
    let record: TrustRecord
    try {
      record = await this.options.trust.get(this.options.root)
    } catch {
      record = { trusted: false }
    }
    if (!record.trusted) return { run: false, state: 'needs-approval', detail: 'This folder is not trusted yet. Trust it to let its MCP servers run.' }
    if (this.policy.enableAll || this.policy.enabled.includes(entry.name)) return { run: true }
    const approved = own(record.mcpServers, entry.name) ? record.mcpServers![entry.name] : undefined
    if (approved === entry.digest) return { run: true }
    return {
      run: false,
      state: 'needs-approval',
      detail: approved ? 'Its setup changed since you approved it. Check the new setup before you approve it again.' : 'This project asks to run an MCP server. Read what it starts before you approve it.',
    }
  }

  private async settle(runtimes: Runtime[]): Promise<void> {
    const limit = Math.max(1, this.options.concurrency ?? 4)
    let next = 0
    const worker = async () => {
      while (next < runtimes.length) {
        const runtime = runtimes[next++]
        const decision = await this.decide(runtime.entry)
        if (!decision.run) {
          await this.stop(runtime, decision.state, decision.detail)
          continue
        }
        if (runtime.state === 'connected' || runtime.state === 'connecting') continue
        await this.connect(runtime).catch(() => {})
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, runtimes.length) }, worker))
  }

  /** Starts the server and registers its tools. Never rejects with anything but the reason a start failed. */
  private connect(runtime: Runtime): Promise<void> {
    if (runtime.connecting) return runtime.connecting
    const generation = ++runtime.generation
    const attempt = this.attempt(runtime, generation).finally(() => {
      if (runtime.connecting === attempt) runtime.connecting = undefined
    })
    runtime.connecting = attempt
    return attempt
  }

  private async attempt(runtime: Runtime, generation: number): Promise<void> {
    const { entry } = runtime
    this.emit(runtime, 'connecting')
    const fail = (message: string): never => {
      runtime.failures++
      const pause = Math.min(60_000, (this.options.retryBaseMs ?? 2000) * 2 ** Math.min(runtime.failures - 1, 6))
      runtime.retryAt = (this.options.now ?? Date.now)() + pause
      this.emit(runtime, 'failed', message)
      throw new McpUnavailableError(message)
    }
    const setup = expandSetup(entry.setup, this.options.env, this.platform === 'win32')
    if (typeof setup === 'string') return fail(`Cannot start ${entry.name}: ${setup}.`)
    const transport = await this.transportFor(entry, setup)
    if (typeof transport === 'string') return fail(transport)
    let up = false
    const client = new McpClient({
      transport,
      clientInfo: this.options.clientInfo ?? { name: 'encode', version: '0.0.0' },
      roots: () => [{ path: this.options.root }],
      connectTimeoutMs: this.options.connectTimeoutMs ?? 60_000,
      onChanged: (what) => this.changed(runtime, generation, what),
      onLog: (level, line) => this.options.onLog?.(entry.name, level, line),
      onNotice: () => {},
      onClose: (reason) => {
        // A start that fails reports itself; this is for a server that goes away once it is up.
        if (!up || runtime.generation !== generation || this.closing || runtime.client !== client) return
        runtime.client = undefined
        runtime.failures++
        runtime.retryAt = (this.options.now ?? Date.now)() + Math.min(60_000, (this.options.retryBaseMs ?? 2000) * 2 ** Math.min(runtime.failures - 1, 6))
        this.emit(runtime, 'failed', reason ? reason.message : 'The connection closed.')
      },
    })
    runtime.client = client
    try {
      const info = await client.connect()
      up = true
      if (runtime.generation !== generation || this.closing) {
        await client.close().catch(() => {})
        return
      }
      runtime.instructions = info.instructions
      runtime.failures = 0
      runtime.retryAt = 0
      await this.refresh(runtime, generation)
      if (runtime.generation === generation) this.emit(runtime, 'connected', runtime.problems[0])
    } catch (error) {
      runtime.client = undefined
      const tail = transport instanceof StdioTransport ? transport.stderrTail() : ''
      await client.close().catch(() => {})
      if (runtime.generation !== generation || this.closing) return
      const reason = error instanceof Error ? error.message : String(error)
      return fail(`Could not start ${entry.name}: ${reason}${tail && !reason.includes(tail.slice(-60)) ? ` It printed: ${tail.slice(-300)}` : ''}`)
    }
  }

  private async transportFor(entry: McpServerEntry, setup: ServerSetup): Promise<Transport | string> {
    if (this.options.createTransport) return this.options.createTransport(entry, setup)
    const info = this.options.clientInfo ?? { name: 'encode', version: '0.0.0' }
    if (setup.type === 'stdio') {
      const program = await resolveProgram(setup.command, this.host)
      if (!program) return `Cannot start ${entry.name}: the program "${setup.command}" was not found. Check that it is installed and on your PATH (eNCode does not look in the project folder).`
      const target = spawnTarget(program, setup.args, this.host)
      if (typeof target === 'string') return `Cannot start ${entry.name}: ${target}`
      return new StdioTransport({
        target,
        env: serverEnvironment(this.options.env, setup.env, this.platform),
        cwd: this.options.root,
        platform: this.platform,
        onStderr: (line) => this.options.onLog?.(entry.name, 'stderr', line.slice(0, 500)),
      })
    }
    try {
      const options = { url: setup.url, headers: setup.headers, userAgent: `${info.name}/${info.version} (MCP)` }
      return setup.type === 'sse' ? new LegacySseTransport(options) : new StreamableHttpTransport(options)
    } catch (error) {
      return `Cannot start ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- tools --------------------------------------------------------------------------------

  private changed(runtime: Runtime, generation: number, what: ChangeKind): void {
    if (what === 'resource' || runtime.generation !== generation || this.closing) return
    clearTimeout(runtime.refreshTimer)
    runtime.refreshTimer = setTimeout(() => {
      void this.refresh(runtime, generation)
        .then(() => runtime.generation === generation && this.options.onStatus?.(this.statusOf(runtime)))
        .catch(() => {})
    }, 200)
  }

  private refresh(runtime: Runtime, generation: number): Promise<void> {
    runtime.refreshing = runtime.refreshing.then(() => this.load(runtime, generation)).catch(() => {})
    return runtime.refreshing
  }

  /** Lists what the server offers and replaces its registered tools with it. */
  private async load(runtime: Runtime, generation: number): Promise<void> {
    const client = runtime.client
    if (!client || runtime.generation !== generation) return
    const problems: string[] = []
    let tools
    try {
      tools = await client.listTools()
    } catch (error) {
      runtime.problems = [`Could not list the tools: ${error instanceof Error ? error.message : String(error)}`]
      return
    }
    problems.push(...tools.problems)
    const [resources, templates, prompts] = await Promise.all([
      client.listResources().catch((error: unknown) => (problems.push(`Could not list resources: ${error instanceof Error ? error.message : String(error)}`), { items: [] as McpResource[], problems: [] as string[] })),
      client.listResourceTemplates().catch(() => ({ items: [] as McpResourceTemplate[], problems: [] as string[] })),
      client.listPrompts().catch(() => ({ items: [] as McpPrompt[], problems: [] as string[] })),
    ])
    if (runtime.generation !== generation) return
    runtime.resources = resources.items
    runtime.templates = templates.items
    runtime.prompts = prompts.items
    for (const { unregister } of runtime.tools.values()) unregister()
    runtime.tools.clear()
    const taken = new Set<string>()
    for (const other of this.runtimes.values()) for (const { name } of other.tools.values()) taken.add(name)
    for (const tool of tools.items) {
      const name = modelToolName(runtime.entry.name, tool.name, taken)
      taken.add(name)
      try {
        const unregister = this.options.tools.register(mcpTool({ caller: this, server: runtime.entry.name, tool, name, ruleTool: ruleToolName(tool.name) }))
        runtime.tools.set(tool.name, { name, unregister })
      } catch (error) {
        problems.push(`${tool.name} could not be added: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    runtime.problems = problems
    this.syncResourceTools()
  }

  /** ListMcpResources and ReadMcpResource exist while some server offers resources. */
  private syncResourceTools(): void {
    const offered = [...this.runtimes.values()].some((r) => r.state !== 'stopped' && (r.resources.length > 0 || r.templates.length > 0))
    if (offered && !this.resourceUnregister.length) {
      for (const tool of resourceTools(this)) {
        try {
          this.resourceUnregister.push(this.options.tools.register(tool))
        } catch {
          // Another source already provides a tool of that name.
        }
      }
    } else if (!offered && this.resourceUnregister.length) {
      for (const unregister of this.resourceUnregister) unregister()
      this.resourceUnregister = []
    }
  }

  private dropTools(runtime: Runtime): void {
    clearTimeout(runtime.refreshTimer)
    for (const { unregister } of runtime.tools.values()) unregister()
    runtime.tools.clear()
  }

  // ---- calls ---------------------------------------------------------------------------------

  /** A live client for the server, starting it again first if it went away and is allowed to run. */
  private async clientFor(name: string): Promise<McpClient> {
    const runtime = this.runtimes.get(name)
    if (!runtime) throw new McpUnavailableError(`There is no MCP server called ${name}.`)
    if (runtime.state === 'connecting' && runtime.connecting) await runtime.connecting.catch(() => {})
    if (runtime.state === 'connected' && runtime.client) return runtime.client
    if (runtime.state === 'disabled' || runtime.state === 'needs-approval') throw new McpUnavailableError(`${name} is not running: ${runtime.detail ?? runtime.state}`)

    const decision = await this.decide(runtime.entry)
    if (!decision.run) {
      this.emit(runtime, decision.state, decision.detail)
      throw new McpUnavailableError(`${name} is not running: ${decision.detail}`)
    }
    const now = (this.options.now ?? Date.now)()
    if (runtime.state === 'failed' && now < runtime.retryAt) {
      throw new McpUnavailableError(`${name} is not running: ${runtime.detail ?? 'it failed to start'} It will be tried again in ${Math.ceil((runtime.retryAt - now) / 1000)} s.`)
    }
    await this.connect(runtime)
    if (runtime.state === 'connected' && runtime.client) return runtime.client
    throw new McpUnavailableError(`${name} is not running: ${runtime.detail ?? 'it failed to start'}`)
  }

  private async stop(runtime: Runtime, state: ServerState, detail?: string): Promise<void> {
    runtime.generation++
    clearTimeout(runtime.refreshTimer)
    const client = runtime.client
    runtime.client = undefined
    runtime.connecting = undefined
    // The tools stay registered while a server is merely down; they go when it is not allowed or not there.
    if (state === 'disabled' || state === 'needs-approval') this.dropTools(runtime)
    if (state === 'stopped' && this.closing) this.dropTools(runtime)
    runtime.resources = []
    runtime.templates = []
    runtime.prompts = []
    runtime.instructions = undefined
    this.emit(runtime, state, detail)
    this.syncResourceTools()
    await client?.close().catch(() => {})
  }
}
