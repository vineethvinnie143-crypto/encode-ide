/**
 * A folder's language servers, as eNCode starts them: one hub for the folder (@encode/lsp), shared by every session
 * in it and by the editor, so a server runs once and not once per chat.
 *
 * A language server reads the project and can run code it names (TypeScript plugins in tsconfig.json, Rust build
 * scripts and macros, the project's own copy of a server in node_modules/.bin), so servers run only in a folder the
 * person trusts, and only while language servers are on in Settings. They start with the agent's environment, without
 * anything that looks like a secret, in the folder itself. Like MCP servers they run outside the sandbox of the
 * agent's commands: they write their caches and logs where they please, and nothing the agent types reaches them.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { discover, fromChildProcess, LanguageServers, type CodeDiagnostic, type LaunchPlan, type ServerProcess, type ServerSpec } from '@encode/lsp'
import { agentEnvironment, decodeText, searchPath } from '@encode/tools'
import type { WorkspaceConfig } from './config'

/** The largest document a server is given. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export interface LanguageServerOptions {
  /** Language servers are on (the setting). Read at each start. */
  enabled(): boolean
  /** What servers start from, before secrets are taken out. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** Every publish, for the editor's marks: the folder, the file and what the server said. */
  onDiagnostics?(root: string, file: string, diagnostics: CodeDiagnostic[]): void
  /** A server of the folder started, stopped or failed. */
  onChange?(root: string): void
  /** For tests: how servers are found and started, and how soon an unused one stops. */
  discover?(spec: ServerSpec, root: string): LaunchPlan | { missing: string }
  spawn?(plan: LaunchPlan, cwd: string, env: Record<string, string>): Promise<ServerProcess>
  idleMs?: number
  catalog?: readonly ServerSpec[]
}

export const SERVERS_OFF = 'Language servers are turned off in Settings.'
export const FOLDER_NOT_TRUSTED = 'Language servers run only in folders you trust, since a server can run code the project names (its plugins, its build scripts). Trust the folder to use them.'

/** A file's text as the tools read it (UTF-8, its byte order mark, UTF-16, older Windows text), or null. */
async function readText(file: string): Promise<string | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) return null
    return decodeText(await fs.readFile(file))?.text ?? null
  } catch {
    return null
  }
}

async function start(plan: LaunchPlan, cwd: string, env: Record<string, string>): Promise<ServerProcess> {
  const child = spawn(plan.file, plan.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  // A program that cannot be started says so through `error`; wait for it to start or fail.
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => reject(new Error(`${plan.command} could not be started: ${error.message}`)))
  })
  return fromChildProcess(child)
}

export function folderLanguageServers(config: WorkspaceConfig, platform: NodeJS.Platform, options: LanguageServerOptions): LanguageServers {
  const base = options.env ?? process.env
  const environment = () => agentEnvironment(base, { platform }).env
  return new LanguageServers({
    root: config.root,
    platform,
    ...(options.catalog ? { catalog: options.catalog } : {}),
    allowed: () => {
      if (!options.enabled()) return { ok: false, reason: SERVERS_OFF }
      if (!config.current().folder.trusted) return { ok: false, reason: FOLDER_NOT_TRUSTED }
      return { ok: true }
    },
    // Only reached once the folder is trusted: its own node_modules/.bin is looked in first.
    discover: (spec) => options.discover?.(spec, config.root) ?? discover(spec, config.root, { platform, projectBins: true, which: (name) => searchPath(name, environment(), platform) }),
    spawn: (plan, cwd) => (options.spawn ?? start)(plan, cwd, environment()),
    readText,
    exists: (file) => existsSync(file),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    ...(options.onDiagnostics ? { onDiagnostics: (file: string, items: CodeDiagnostic[]) => options.onDiagnostics?.(config.root, file, items) } : {}),
    ...(options.onChange ? { onChange: () => options.onChange?.(config.root) } : {}),
  })
}
