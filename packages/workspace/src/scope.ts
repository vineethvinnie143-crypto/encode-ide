import path from 'node:path'
import { checkpointDir, CheckpointService, nodeCheckpointFs, pruneStore, type CheckpointFs } from '@encode/checkpoints'
import { workspaceKey } from '@encode/config'
import { combineHooks, type SessionScope } from '@encode/core'
import type { HookRunner } from '@encode/hooks'
import { resolveSandboxSettings, type Sandbox } from '@encode/sandbox'
import { detectShell, realPathOf, type ShellProgram } from '@encode/tools'
import { actOn, type PermissionsAction, type PermissionsOutcome } from './actions'
import { WorkspaceConfig, type ConfigSnapshot } from './config'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { workspaceHooks } from './hooks'
import { McpHub, type McpHubOptions, type McpReport } from './mcp'
import { actOnMcp, type McpAction, type McpOutcome } from './mcp-actions'
import { rememberRules } from './remember'
import { reportOn, type WorkspaceReport } from './report'
import { recordingHooks, sessionCheckpoints } from './rewind'
import { actOnSandbox, type SandboxAction, type SandboxOutcome } from './sandbox-actions'
import { sandboxReport, type SandboxReport } from './sandbox-report'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long opening a session waits for the sandbox to find out whether this machine has one (the first run on Windows builds its helper). */
const SANDBOX_WAIT_MS = 15_000

export interface CheckpointStoreOptions {
  /** The store's base folder; a folder for each workspace is made under it. */
  dir: string
  fs?: CheckpointFs
  /** Sessions nobody has touched for this long are forgotten when the store is tidied. Default 30 days. */
  maxAgeMs?: number
  /** The largest file a rewind can bring back. Default 20 MB. */
  maxFileBytes?: number
}

export interface WorkspacesOptions {
  home: string
  platform?: NodeJS.Platform
  fs?: WorkspaceFs
  /** Default `<home>/.encode/trust.json`. */
  trustFile?: string
  /** Trouble a session should not have to hear about, such as a settings file that cannot be read. */
  warn?(message: string): void
  /** Keeps what the agent's file tools change, so that it can be put back. Without it nothing is kept and rewinding is not offered. */
  checkpoints?: CheckpointStoreOptions
  /** Runs hook command lines. Default: the shell the agent's own commands use. */
  hookRunner?: HookRunner
  /** What hooks start from, before secrets are taken out. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** The conversation's file for a session, for the `transcript_path` that hooks are given. */
  transcriptPath?(sessionId: string): string | undefined
  /** What a folder's MCP servers do that a screen shows (their state, their tools, their setup), as the folder's real path. Called after a short pause, never in a burst. */
  onMcpChange?(root: string): void
  /** For tests: how MCP servers are reached, and how long things are waited for. */
  mcp?: Pick<McpHubOptions, 'manager' | 'startWaitMs' | 'idleMs'>
  /** The operating-system sandbox for the agent's commands; one for the whole program. Without it commands run as the user does. */
  sandbox?: Sandbox
}

/**
 * The folders sessions work in, each with its settings picture, and the scope the agent core asks for when it opens
 * a session. One object for a whole program: the desktop's agent host and the command line each make one.
 */
export class Workspaces {
  readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly fs: WorkspaceFs
  private readonly trustFile: string | undefined
  private readonly warn: ((message: string) => void) | undefined
  private readonly configs = new Map<string, WorkspaceConfig>()
  /** A folder's MCP servers, shared by every session in it. Made on first use, let go of when nobody works in the folder. */
  private readonly hubs = new Map<string, McpHub>()
  private readonly stores: CheckpointStoreOptions | undefined
  /** The stores already tidied by this program, so that opening a second session in a folder does not do it again. */
  private readonly tidied = new Set<string>()

  private readonly options: WorkspacesOptions

  constructor(options: WorkspacesOptions) {
    this.home = options.home
    this.platform = options.platform ?? process.platform
    this.fs = options.fs ?? nodeWorkspaceFs
    this.trustFile = options.trustFile
    this.warn = options.warn
    this.stores = options.checkpoints
    this.options = options
  }

  /** The picture of a folder, given as a real path; the same object for every session in it. */
  config(root: string): WorkspaceConfig {
    const key = workspaceKey(root, this.platform === 'win32')
    let config = this.configs.get(key)
    if (!config) {
      config = new WorkspaceConfig({
        root: (this.platform === 'win32' ? path.win32 : path.posix).normalize(root),
        home: this.home,
        platform: this.platform,
        fs: this.fs,
        ...(this.trustFile ? { trustFile: this.trustFile } : {}),
      })
      this.configs.set(key, config)
    }
    return config
  }

  private hub(config: WorkspaceConfig): McpHub {
    const key = workspaceKey(config.root, this.platform === 'win32')
    let hub = this.hubs.get(key)
    if (!hub) {
      const made: McpHub = new McpHub({
        config,
        platform: this.platform,
        env: this.options.env ?? process.env,
        ...(this.warn ? { warn: this.warn } : {}),
        ...(this.options.onMcpChange ? { onChange: () => this.options.onMcpChange?.(config.root) } : {}),
        onIdle: () => {
          if (this.hubs.get(key) === made) this.hubs.delete(key)
          void made.close()
        },
        ...this.options.mcp,
      })
      this.hubs.set(key, made)
      hub = made
    }
    return hub
  }

  /**
   * The folder's MCP servers as the Settings screen shows them. The folder may be given as any path to it. With
   * `start: false` no server is started for the sake of looking (the banner above the composer does that).
   */
  async mcpReport(root: string, options: { start?: boolean } = {}): Promise<McpReport> {
    const config = this.config(await realPathOf(root))
    return this.hub(config).report(await config.refresh(), options)
  }

  /** Does what the MCP screen asked in a folder, and returns how its servers stand afterwards. */
  async mcpAct(root: string, action: McpAction): Promise<McpOutcome> {
    const config = this.config(await realPathOf(root))
    return actOnMcp(config, this.hub(config), action, { fs: this.fs, platform: this.platform })
  }

  /** The sandbox around the agent's commands as it stands in a folder, for the Sandbox screen. The folder may be given as any path to it. */
  async sandboxReport(root: string): Promise<SandboxReport> {
    const config = this.config(await realPathOf(root))
    const snapshot = await config.refresh()
    return sandboxReport(this.options.sandbox, snapshot, this.home, this.platform, this.shellFor(snapshot))
  }

  /** The shell the agent's commands run in for a folder's settings (PowerShell when they ask for it on Windows). */
  private shellFor(snapshot: ConfigSnapshot): ShellProgram | undefined {
    return detectShell(this.options.env ?? process.env, this.platform, this.prefersPowerShell(snapshot.effective.sandbox) ? 'pwsh' : undefined)
  }

  /** Asked for by the settings. Only Windows has a choice to make; elsewhere shell detection ignores it. */
  private prefersPowerShell(sources: ConfigSnapshot['effective']['sandbox']): boolean {
    const settings = resolveSandboxSettings(sources)
    return settings.enabled && settings.powershell
  }

  /** Does what the Sandbox screen asked, and returns how the sandbox stands afterwards. */
  async sandboxAct(root: string, action: SandboxAction): Promise<SandboxOutcome> {
    const config = this.config(await realPathOf(root))
    return actOnSandbox(config, this.options.sandbox, action, { fs: this.fs, platform: this.platform, shell: (snapshot) => this.shellFor(snapshot) })
  }

  /** Calls back when the sandbox's state changes (it was checked, or a folder is being prepared). Returns the way to stop. */
  onSandboxChange(listener: () => void): () => void {
    return this.options.sandbox?.onChange(listener) ?? (() => undefined)
  }

  /** Stops every folder's MCP servers. Quick enough for a program that is closing. */
  async close(): Promise<void> {
    const hubs = [...this.hubs.values()]
    this.hubs.clear()
    await Promise.all(hubs.map((hub) => hub.close().catch(() => undefined)))
  }

  /** The folder's permissions as the Permissions screen shows them. The folder may be given as any path to it. */
  async report(root: string): Promise<WorkspaceReport> {
    return reportOn(this.config(await realPathOf(root)), this.platform)
  }

  /** Does what the Permissions screen asked in a folder, and returns how the folder stands afterwards. */
  async act(root: string, action: PermissionsAction): Promise<PermissionsOutcome> {
    const config = this.config(await realPathOf(root))
    const outcome = await actOn(config, action, { fs: this.fs, platform: this.platform })
    // Trusting a folder, or approving its settings, decides which of its MCP servers may run.
    await this.hubs.get(workspaceKey(config.root, this.platform === 'win32'))?.follow(config)
    return outcome
  }

  /** The record of what a session's file tools change: the hooks that keep it, the seam the tools call, and the means to put it back. */
  private recorder(request: { sessionId: string; root: string; notice(text: string): void }, config: WorkspaceConfig) {
    const stores = this.stores
    if (!stores) return undefined
    const fs = stores.fs ?? nodeCheckpointFs()
    const dir = checkpointDir(stores.dir, request.root, this.platform)
    if (!this.tidied.has(dir)) {
      this.tidied.add(dir)
      pruneStore(fs, dir, { maxAgeMs: stores.maxAgeMs ?? 30 * DAY_MS, platform: this.platform }).catch((error: unknown) => {
        this.warn?.(`Could not tidy the record of file changes of ${request.root}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const service = new CheckpointService({
      fs,
      dir,
      // The folder, and the extra folders the settings name as it stands when a file is written.
      roots: () => [request.root, ...config.current().extraRoots],
      sessionId: request.sessionId,
      platform: this.platform,
      ...(stores.maxFileBytes ? { maxFileBytes: stores.maxFileBytes } : {}),
      notice: request.notice,
    })
    return {
      hooks: recordingHooks(service, request.notice),
      checkpoints: sessionCheckpoints(service, { root: request.root, platform: this.platform }),
      // A write is stopped when its earlier version cannot be kept: a change that cannot be taken back is not made.
      beforeWrite: async (file: string, previous: Buffer | null, info: { turnId: string; toolUseId: string }) => {
        try {
          await service.beforeWrite(file, previous, info)
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          throw new Error(`eNCode could not keep the earlier version of ${path.basename(file)} so that it can be put back (${why}), so the file was not changed.`)
        }
      },
    }
  }

  /** What the host's `scope` option is given. The folder's settings are read before the session opens. */
  readonly scope = async (request: { sessionId: string; root: string; notice(text: string): void }): Promise<SessionScope> => {
    const config = this.config(request.root)
    const hub = this.hub(config)
    // Taken before anything is awaited, so that the hub cannot be let go of between getting it and holding it.
    const release = hub.acquire()
    try {
      hub.sync(await config.refresh())
      await this.sandboxChecked()
      return this.scopeOf(request, config, hub, release)
    } catch (error) {
      release()
      throw error
    }
  }

  /** A session's tools are built once the sandbox has said whether it works here, so that Bash is told what its commands run in. Never fails a session. */
  private async sandboxChecked(): Promise<void> {
    const sandbox = this.options.sandbox
    if (!sandbox) return
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        sandbox.start().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SANDBOX_WAIT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private scopeOf(request: { sessionId: string; root: string; notice(text: string): void }, config: WorkspaceConfig, hub: McpHub, release: () => void): SessionScope {
    const recording = this.recorder(request, config)
    const { env, hookRunner, transcriptPath } = this.options
    // The folder and the extra folders its settings name are where commands may write; its settings may tighten the rest.
    const sandbox = this.options.sandbox?.session({
      roots: () => [request.root, ...config.current().extraRoots],
      settings: () => resolveSandboxSettings(config.current().effective.sandbox),
    })
    sandbox?.warm()
    return {
      // What keeps the record comes first: a hook that stops a result must not leave the record out of date.
      hooks: combineHooks(
        recording?.hooks,
        workspaceHooks(config, {
          platform: this.platform,
          notice: request.notice,
          ...(hookRunner ? { runner: hookRunner } : {}),
          ...(env ? { baseEnv: env } : {}),
          ...(transcriptPath ? { transcriptPath } : {}),
        }),
      ),
      assessor: config.assessor,
      rules: config.rules,
      extraRoots: () => config.current().extraRoots,
      // A picture that cannot be rebuilt refuses everything until it can (see WorkspaceConfig.refresh); this only reports why.
      // The folder's MCP servers follow the same picture.
      refresh: async () => {
        try {
          hub.sync(await config.refresh())
        } catch (error) {
          this.warn?.(`Could not reload the settings of ${request.root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      remember: rememberRules(config, this.fs, this.platform),
      shell: () => ({
        extraEnv: config.current().effective.env,
        ...(this.prefersPowerShell(config.current().effective.sandbox) ? { prefer: 'pwsh' as const } : {}),
        ...(sandbox
          ? {
              wrapSpawn: sandbox.wrapSpawn,
              scratchRoot: sandbox.scratchRoot,
              sandbox: (program: string) => {
                const { active, allowUnsandboxed } = sandbox.state(program)
                return { active, allowUnsandboxed }
              },
            }
          : {}),
      }),
      external: hub,
      release: async () => release(),
      ...(recording ? { beforeWrite: recording.beforeWrite, checkpoints: recording.checkpoints } : {}),
    }
  }
}
