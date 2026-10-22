import path from 'node:path'
import { settingsFiles, type SettingsSource } from './settings'
import { readSettingsDocument, writeSettingsDocument } from './settings-document'
import type { TrustFs } from './trust'

/**
 * Turning an MCP server off and on from Settings.
 *
 * The server's name goes into, or comes out of, "disabledMcpjsonServers" in the user's own settings (for a server the
 * user set up) or in the folder's local settings (for a project's server, so that the person's choice does not change
 * the file the project shares). The list only takes permissions away, so it applies at once, and changing it never
 * touches the approval of the folder's settings (see `grantingPart`). Nothing else in the file is touched, and a file
 * that is not valid JSON is not overwritten.
 */

export interface McpOffOptions {
  name: string
  off: boolean
  /** Whose file: the user's, or this folder's local settings. */
  scope: 'user' | 'local'
  home: string
  /** The workspace root, as a real path. */
  root: string
  fs: TrustFs
  platform?: NodeJS.Platform
}

export type McpOffResult =
  | {
      ok: true
      file: string
      /** False when the server was already off (or already not listed). */
      changed: boolean
    }
  | { ok: false; reason: string }

export async function setMcpServerOff(options: McpOffOptions): Promise<McpOffResult> {
  const platform = options.platform ?? process.platform
  const file = settingsFiles(options.home, options.root, platform === 'win32' ? path.win32 : path.posix)[options.scope]
  const loaded = await readSettingsDocument(options.fs, file, 'changing an MCP server')
  if (!loaded.ok) return loaded
  const existing = loaded.document.disabledMcpjsonServers
  if (existing !== undefined && (!Array.isArray(existing) || !existing.every((item) => typeof item === 'string'))) {
    return { ok: false, reason: `"disabledMcpjsonServers" in ${file} is not a list of names.` }
  }
  const list = (existing as string[] | undefined) ?? []
  if (options.off === list.includes(options.name)) return { ok: true, file, changed: false }

  const after = options.off ? [...list, options.name] : list.filter((item) => item !== options.name)
  const next: Record<string, unknown> = { ...loaded.document }
  if (after.length) next.disabledMcpjsonServers = after
  else delete next.disabledMcpjsonServers
  const unwritten = await writeSettingsDocument(options.fs, file, next)
  if (unwritten) return { ok: false, reason: unwritten }
  return { ok: true, file, changed: true }
}

/** The settings files whose list turns a server off, for telling the person why it is still off after they turned it on. */
export function disabledIn(sources: readonly SettingsSource[], name: string): string[] {
  const files: string[] = []
  for (const source of sources) if (source.file && source.settings.disabledMcpjsonServers?.includes(name)) files.push(source.file)
  return files
}
