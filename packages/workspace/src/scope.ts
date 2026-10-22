import path from 'node:path'
import { checkpointDir, CheckpointService, nodeCheckpointFs, pruneStore, type CheckpointFs } from '@encode/checkpoints'
import { workspaceKey } from '@encode/config'
import { combineHooks, type SessionScope } from '@encode/core'
import type { HookRunner } from '@encode/hooks'
import { realPathOf } from '@encode/tools'
import { actOn, type PermissionsAction, type PermissionsOutcome } from './actions'
import { WorkspaceConfig } from './config'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { workspaceHooks } from './hooks'
import { rememberRules } from './remember'
import { reportOn, type WorkspaceReport } from './report'
import { recordingHooks, sessionCheckpoints } from './rewind'

const DAY_MS = 24 * 60 * 60 * 1000

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

  /** The folder's permissions as the Permissions screen shows them. The folder may be given as any path to it. */
  async report(root: string): Promise<WorkspaceReport> {
    return reportOn(this.config(await realPathOf(root)), this.platform)
  }

  /** Does what the Permissions screen asked in a folder, and returns how the folder stands afterwards. */
  async act(root: string, action: PermissionsAction): Promise<PermissionsOutcome> {
    return actOn(this.config(await realPathOf(root)), action, { fs: this.fs, platform: this.platform })
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
    await config.refresh()
    const recording = this.recorder(request, config)
    const { env, hookRunner, transcriptPath } = this.options
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
      refresh: async () => {
        try {
          await config.refresh()
        } catch (error) {
          this.warn?.(`Could not reload the settings of ${request.root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      remember: rememberRules(config, this.fs, this.platform),
      shell: () => ({ extraEnv: config.current().effective.env }),
      ...(recording ? { beforeWrite: recording.beforeWrite, checkpoints: recording.checkpoints } : {}),
    }
  }
}
