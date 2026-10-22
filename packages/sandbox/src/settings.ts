/**
 * The `sandbox` key of the settings files, checked here (config only carries it, 0041). The user's own files decide;
 * a folder's files (project, local) may only make the sandbox stricter, whatever the person has trusted, because
 * what they grant is what the sandbox exists to bound.
 */
import path from 'node:path'

export type SandboxScope = 'user' | 'project' | 'local' | 'cli'

export interface SandboxSettings {
  /** Use the operating system's sandbox when this machine has one. Default true. */
  enabled: boolean
  /** Refuse to run commands where there is none. Default false: they run as before and the settings say so. */
  required: boolean
  /** Let a command ask to run outside the sandbox (the person is asked each time). Default true. */
  allowUnsandboxed: boolean
  /** Whether commands may use the network. Where the system cannot block it this has no effect. Default true. */
  network: boolean
  /** Folders besides the project's that commands may write (user settings only). */
  allowWrite: string[]
  /** Paths that commands may not write, though they are inside a writable folder. */
  denyWrite: string[]
  /** Paths that commands may not read, where the system can hide them. */
  denyRead: string[]
  /** Paths from the default list of hidden ones that commands may read (user settings only). */
  allowRead: string[]
  /** Let commands write the usual package caches in the person's home (npm, pnpm, pip, cargo...). Default true. */
  caches: boolean
  /** Windows: run commands in PowerShell, which the sandbox can confine and Git Bash it cannot. Default false. */
  powershell: boolean
}

export const DEFAULT_SETTINGS: Readonly<SandboxSettings> = {
  enabled: true,
  required: false,
  allowUnsandboxed: true,
  network: true,
  allowWrite: [],
  denyWrite: [],
  denyRead: [],
  allowRead: [],
  caches: true,
  powershell: false,
}

export interface SandboxSource {
  scope: SandboxScope
  config: unknown
}

export interface ResolvedSandboxSettings extends SandboxSettings {
  /** What was wrong in the files, each entry skipped. */
  problems: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const KEYS = new Set(['enabled', 'required', 'allowUnsandboxed', 'network', 'allowWrite', 'denyWrite', 'denyRead', 'allowRead', 'caches', 'powershell'])

/** `network` is written `"allow"`/`"block"` (or a boolean). */
function networkOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'allow') return true
  if (value === 'block') return false
  return undefined
}

function paths(value: unknown, where: string, problems: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list of paths`)
    return []
  }
  const out: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string' && entry.trim() && !entry.includes('\0') && entry.length < 4096) out.push(entry.trim())
    else problems.push(`${where}[${index}] must be a non-empty path`)
  }
  return out
}

/**
 * Settings in precedence order (user first, the command line last). A key a folder's file may not loosen is ignored
 * there, and said to be.
 */
export function resolveSandboxSettings(sources: readonly SandboxSource[]): ResolvedSandboxSettings {
  const out: ResolvedSandboxSettings = { ...DEFAULT_SETTINGS, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [], problems: [] }
  for (const source of sources) {
    const label = `${source.scope} settings`
    if (!isObject(source.config)) {
      out.problems.push(`${label}: "sandbox" must be an object`)
      continue
    }
    const own = source.scope === 'user' || source.scope === 'cli'
    const config = source.config
    for (const key of Object.keys(config)) if (!KEYS.has(key)) out.problems.push(`${label}: sandbox.${key} is not a setting`)

    const flag = (key: 'enabled' | 'required' | 'allowUnsandboxed' | 'caches' | 'powershell', tighter: boolean) => {
      const value = config[key]
      if (value === undefined) return
      if (typeof value !== 'boolean') {
        out.problems.push(`${label}: sandbox.${key} must be true or false`)
        return
      }
      if (!own && value !== tighter) {
        out.problems.push(`${label}: sandbox.${key} can only be ${tighter} in a folder's settings; ignored`)
        return
      }
      out[key] = value
    }
    flag('enabled', true)
    flag('required', true)
    flag('allowUnsandboxed', false)
    flag('caches', false)
    flag('powershell', true)

    if (config.network !== undefined) {
      const network = networkOf(config.network)
      if (network === undefined) out.problems.push(`${label}: sandbox.network must be "allow" or "block"`)
      else if (!own && network) out.problems.push(`${label}: sandbox.network can only be "block" in a folder's settings; ignored`)
      else out.network = network
    }

    out.denyWrite.push(...paths(config.denyWrite, `${label}: sandbox.denyWrite`, out.problems))
    out.denyRead.push(...paths(config.denyRead, `${label}: sandbox.denyRead`, out.problems))
    for (const key of ['allowWrite', 'allowRead'] as const) {
      const listed = paths(config[key], `${label}: sandbox.${key}`, out.problems)
      if (!listed.length) continue
      if (own) out[key].push(...listed)
      else out.problems.push(`${label}: sandbox.${key} is only read from the user's settings; ignored`)
    }
  }
  return out
}

/** `~` and `~/x` as the home folder; a relative path as under `base`. Always absolute and normalized. */
export function expandPath(entry: string, base: string, home: string, pathApi: typeof path.posix | typeof path.win32 = path): string {
  let text = entry
  if (text === '~') text = home
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = pathApi.join(home, text.slice(2))
  return pathApi.resolve(base, text)
}
