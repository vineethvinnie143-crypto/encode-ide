/**
 * The agent the command line drives: the desktop app's agent host, with the same Workspaces (a folder's settings,
 * trust, rules, hooks, MCP servers, checkpoints and code index), the same shells and the same operating-system
 * sandbox. Only the window is missing; the terminal answers what the window would.
 *
 * The command line keeps its sessions apart from the app's, in `~/.encode/cli`. That folder and the app's profile are
 * off limits to the agent, as the app's own profile is in the app (ADR 0106): they hold every chat, and the app's
 * holds its keys. Each session's long results, kept there, stay readable to that session.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentHost, type AgentEvent, type AgentSettings } from '@encode/core'
import { createWorktreeGit } from '@encode/git'
import type { ModelClient } from '@encode/providers'
import { Sandbox, type SandboxStatus } from '@encode/sandbox'
import { createWebAccess, searchPath } from '@encode/tools'
import { Workspaces, type ServerTools } from '@encode/workspace'

/** The command line's own folder: its sessions, checkpoints and sandbox. */
export function cliProfile(home: string): string {
  return path.join(home, '.encode', 'cli')
}

/** Where the desktop app keeps its profile (Electron's userData for "eNCode") on each system. */
export function desktopProfile(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return path.win32.join(env.APPDATA?.trim() || path.win32.join(home, 'AppData', 'Roaming'), 'eNCode')
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'eNCode')
  const config = env.XDG_CONFIG_HOME?.trim()
  return path.posix.join(config && path.posix.isAbsolute(config) ? config : path.posix.join(home, '.config'), 'eNCode')
}

export interface RuntimeOptions {
  root: string
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  client: ModelClient
  settings: () => AgentSettings
  emit(event: AgentEvent): void
  /** The operating-system sandbox around the agent's commands. */
  sandbox: boolean
  /** Name each session after its first request, with one small call. */
  nameSessions: boolean
  warn(text: string): void
  /** For tests: where the command line keeps its sessions. */
  profile?: string
  /** The language servers the app installed, and eNCode's own (ADR 0085); without them, only those on the PATH. */
  tools?: ServerTools
}

export interface Runtime {
  host: AgentHost
  workspaces: Workspaces
  /** The folder the agent works in, as its real path. */
  root: string
  profile: string
  /** How the sandbox stands, or undefined when it was turned off. */
  sandbox?: SandboxStatus
  close(): Promise<void>
}

export async function openRuntime(options: RuntimeOptions): Promise<Runtime> {
  const home = options.home ?? os.homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const profile = options.profile ?? cliProfile(home)
  const sessions = path.join(profile, 'sessions')
  await fs.mkdir(sessions, { recursive: true })
  const root = await fs.realpath(options.root)
  const offLimits = [profile, desktopProfile(home, platform, env)]

  let sandbox: Sandbox | undefined
  let status: SandboxStatus | undefined
  if (options.sandbox) {
    sandbox = new Sandbox({ dir: path.join(profile, 'sandbox'), home, platform, hidden: offLimits, warn: options.warn })
    status = await sandbox.start()
  }
  const workspaces = new Workspaces({
    home,
    platform,
    warn: options.warn,
    checkpoints: { dir: path.join(profile, 'checkpoints') },
    transcriptPath: (sessionId) => path.join(sessions, `${sessionId}.jsonl`),
    ...(sandbox ? { sandbox } : {}),
    // Servers already on this computer, and those the app installed: installing them is the app's (Settings >
    // Language servers).
    languageServers: { enabled: () => true, ...(options.tools ? { tools: options.tools } : {}) },
  })
  const host = new AgentHost({
    dir: sessions,
    home,
    platform,
    workspace: root,
    client: options.client,
    settings: options.settings,
    emit: options.emit,
    warn: options.warn,
    scope: workspaces.scope,
    offLimits: { folders: offLimits, except: sandbox?.ownFolders() ?? [] },
    ...(sandbox ? { scratch: sandbox.scratchFolder() } : {}),
    // git by absolute path, looked up at each use: a bare `git` could be a git.exe in the project on Windows.
    worktrees: createWorktreeGit({ git: () => searchPath('git', env) }),
    web: createWebAccess(),
    nameSessions: options.nameSessions,
  })
  // Side chats are the app's; none is ever left for the command line to show.
  await host.removeSideChats().catch(() => undefined)
  return {
    host,
    workspaces,
    root,
    profile,
    ...(status ? { sandbox: status } : {}),
    async close() {
      await host.dispose().catch(() => undefined)
      await workspaces.close().catch(() => undefined)
    },
  }
}
