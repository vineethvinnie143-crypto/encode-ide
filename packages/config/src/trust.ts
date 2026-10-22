import { createHash } from 'node:crypto'
import path from 'node:path'
import { grantingPart, isFolderSource, type SettingsSource } from './settings'

/**
 * Workspace trust, kept per workspace in ~/.encode/trust.json.
 *
 * Trusting a folder says the user accepts what its files can make tools do:
 * a folder's git config can start programs, so git runs unasked only in
 * trusted folders. Trust alone does not turn on what the folder's eNCode
 * settings grant (hooks, allow rules, environment variables, MCP servers):
 * the user approves that configuration as it is, by its digest, and any
 * later change to it, from a pull or from the agent itself, turns it off
 * again until they approve the new one. A project's MCP servers are approved
 * one by one the same way.
 *
 * Trust is per folder, not inherited: trusting ~/code does not trust a
 * repository cloned into it tomorrow.
 */

export interface TrustRecord {
  trusted: boolean
  /** When the user trusted the folder, ms since the epoch. */
  trustedAt?: number
  /** The digest of the folder configuration the user approved. */
  configDigest?: string
  /** Approved project MCP servers: name to the digest of the configuration approved. */
  mcpServers?: Record<string, string>
}

interface TrustFile {
  version: 1
  workspaces: Record<string, TrustRecord>
}

/** File access for the store; writes must replace the file atomically (write a temporary file, then rename). */
export interface TrustFs {
  read(file: string): Promise<string | null>
  writeAtomic(file: string, text: string): Promise<void>
}

/** JSON with sorted keys, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * The digest of what a folder's settings grant: the project and local files'
 * granting parts. Restrictions are left out, so adding a deny rule does not
 * ask for approval again. Null when the folder grants nothing.
 */
export function folderConfigDigest(sources: readonly SettingsSource[]): string | null {
  const parts = sources
    .filter((source) => isFolderSource(source.scope))
    .map((source) => ({ scope: source.scope, grants: grantingPart(source.settings) }))
    .filter((part) => Object.keys(part.grants).length)
  return parts.length ? digestOf(parts) : null
}

/** The key a workspace is stored under: its real path, compared without case on Windows. */
export function workspaceKey(rootReal: string, windows: boolean): string {
  const normalized = (windows ? path.win32 : path.posix).normalize(rootReal)
  return windows ? normalized.toLowerCase() : normalized
}

export interface FolderState {
  trusted: boolean
  /** Whether what the folder's settings grant applies: trusted, and the configuration is the one approved (or grants nothing). */
  configApproved: boolean
  /** The current configuration's digest, to approve. */
  configDigest: string | null
}

export class TrustStore {
  constructor(
    private readonly file: string,
    private readonly fs: TrustFs,
    private readonly windows: boolean,
  ) {}

  /**
   * The file as it is. One that cannot be read counts as one that trusts nothing, unless it is about to be written
   * over (`strict`): a read that failed for a moment must not wipe the trust of every other folder.
   */
  private async load(strict = false): Promise<TrustFile> {
    let text: string | null
    try {
      text = await this.fs.read(this.file)
    } catch (error) {
      if (strict) throw error
      text = null
    }
    if (text === null) return { version: 1, workspaces: {} }
    try {
      const parsed = JSON.parse(text) as Partial<TrustFile>
      if (parsed && parsed.version === 1 && parsed.workspaces && typeof parsed.workspaces === 'object') {
        // A null prototype, so a workspace path can never reach Object.prototype.
        return { version: 1, workspaces: Object.assign(Object.create(null), parsed.workspaces) }
      }
    } catch {
      // Fall through: an unreadable store trusts nothing.
    }
    return { version: 1, workspaces: {} }
  }

  private async update(rootReal: string, change: (record: TrustRecord) => TrustRecord | null): Promise<void> {
    const data = await this.load(true)
    const key = workspaceKey(rootReal, this.windows)
    const next = change(data.workspaces[key] ?? { trusted: false })
    if (next) data.workspaces[key] = next
    else delete data.workspaces[key]
    await this.fs.writeAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`)
  }

  async get(rootReal: string): Promise<TrustRecord> {
    const data = await this.load()
    const record = data.workspaces[workspaceKey(rootReal, this.windows)]
    return record && typeof record === 'object' ? record : { trusted: false }
  }

  /** What applies in a folder, given the digest of its current configuration. */
  async state(rootReal: string, configDigest: string | null): Promise<FolderState> {
    const record = await this.get(rootReal)
    const trusted = record.trusted === true
    return { trusted, configApproved: trusted && (configDigest === null || record.configDigest === configDigest), configDigest }
  }

  /** Trusts the folder and approves its current configuration. */
  async trust(rootReal: string, configDigest: string | null, now = Date.now()): Promise<void> {
    await this.update(rootReal, (record) => ({ ...record, trusted: true, trustedAt: now, configDigest: configDigest ?? undefined }))
  }

  /** Approves a changed configuration of a folder that is already trusted. */
  async approveConfig(rootReal: string, configDigest: string): Promise<void> {
    await this.update(rootReal, (record) => (record.trusted ? { ...record, configDigest } : record))
  }

  /** Forgets the folder: untrusted, nothing approved. */
  async revoke(rootReal: string): Promise<void> {
    await this.update(rootReal, () => null)
  }

  async approveServer(rootReal: string, name: string, digest: string): Promise<void> {
    await this.update(rootReal, (record) => ({ ...record, mcpServers: { ...record.mcpServers, [name]: digest } }))
  }

  async revokeServer(rootReal: string, name: string): Promise<void> {
    await this.update(rootReal, (record) => {
      const servers = { ...record.mcpServers }
      delete servers[name]
      return { ...record, mcpServers: servers }
    })
  }

  /** Whether a project MCP server is approved in exactly this configuration. */
  async serverApproved(rootReal: string, name: string, digest: string): Promise<boolean> {
    const record = await this.get(rootReal)
    return Boolean(record.trusted && record.mcpServers && Object.hasOwn(record.mcpServers, name) && record.mcpServers[name] === digest)
  }
}

/** Why trusting this folder deserves a second look, or null: the home folder or a drive root trusts far more than a project. */
export function trustWarning(rootReal: string, home: string, windows: boolean): string | null {
  const api = windows ? path.win32 : path.posix
  const root = workspaceKey(rootReal, windows)
  if (root === workspaceKey(home, windows)) return 'This is your home folder: trusting it trusts every file in it.'
  if (api.dirname(root) === root) return 'This is the root of a drive: trusting it trusts every file on it.'
  return null
}
