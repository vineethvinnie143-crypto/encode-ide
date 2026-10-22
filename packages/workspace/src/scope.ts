import path from 'node:path'
import { workspaceKey } from '@encode/config'
import type { SessionScope } from '@encode/core'
import { realPathOf } from '@encode/tools'
import { actOn, type PermissionsAction, type PermissionsOutcome } from './actions'
import { WorkspaceConfig } from './config'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { rememberRules } from './remember'
import { reportOn, type WorkspaceReport } from './report'

export interface WorkspacesOptions {
  home: string
  platform?: NodeJS.Platform
  fs?: WorkspaceFs
  /** Default `<home>/.encode/trust.json`. */
  trustFile?: string
  /** Trouble a session should not have to hear about, such as a settings file that cannot be read. */
  warn?(message: string): void
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

  constructor(options: WorkspacesOptions) {
    this.home = options.home
    this.platform = options.platform ?? process.platform
    this.fs = options.fs ?? nodeWorkspaceFs
    this.trustFile = options.trustFile
    this.warn = options.warn
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

  /** What the host's `scope` option is given. The folder's settings are read before the session opens. */
  readonly scope = async (request: { sessionId: string; root: string }): Promise<SessionScope> => {
    const config = this.config(request.root)
    await config.refresh()
    return {
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
    }
  }
}
