import path from 'node:path'
import { settingsFiles } from './settings'
import { isObject, readSettingsDocument, writeSettingsDocument } from './settings-document'
import type { TrustFs } from './trust'

/**
 * Changing the sandbox's switches from Settings.
 *
 * They are written into the `sandbox` key of the user's own settings file, the one place the sandbox takes a loosening
 * from (a folder's files can only tighten it). Nothing else in the file is touched, and a file that is not valid JSON,
 * or whose `sandbox` is not an object, is not overwritten.
 */

export type SandboxChange =
  | { key: 'enabled' | 'required' | 'allowUnsandboxed' | 'caches' | 'powershell'; value: boolean }
  | { key: 'network'; value: 'allow' | 'block' }

export interface SandboxChangeOptions {
  change: SandboxChange
  home: string
  fs: TrustFs
  platform?: NodeJS.Platform
}

export type SandboxChangeResult =
  | {
      ok: true
      file: string
      /** False when the file already said so. */
      changed: boolean
    }
  | { ok: false; reason: string }

const FLAGS: readonly string[] = ['enabled', 'required', 'allowUnsandboxed', 'caches', 'powershell']

/** Checks a change that came from a screen; the types are not trusted. Returns the reason it is refused, or null. */
export function sandboxChangeProblem(change: unknown): string | null {
  if (!isObject(change)) return 'That is not a setting.'
  if (typeof change.key !== 'string') return 'Name the setting.'
  if (FLAGS.includes(change.key)) return typeof change.value === 'boolean' ? null : `${change.key} is on or off.`
  if (change.key === 'network') return change.value === 'allow' || change.value === 'block' ? null : 'network is allow or block.'
  return `${change.key.slice(0, 48)} is not a sandbox setting that can be changed here.`
}

export async function setSandboxSetting(options: SandboxChangeOptions): Promise<SandboxChangeResult> {
  const problem = sandboxChangeProblem(options.change)
  if (problem) return { ok: false, reason: problem }
  const platform = options.platform ?? process.platform
  const file = settingsFiles(options.home, '', platform === 'win32' ? path.win32 : path.posix).user
  const loaded = await readSettingsDocument(options.fs, file, 'changing the sandbox')
  if (!loaded.ok) return loaded
  const existing = loaded.document.sandbox
  if (existing !== undefined && !isObject(existing)) return { ok: false, reason: `"sandbox" in ${file} is not an object; fix it before changing the sandbox there.` }
  const { key, value } = options.change
  if (existing?.[key] === value) return { ok: true, file, changed: false }
  const next: Record<string, unknown> = { ...loaded.document, sandbox: { ...existing, [key]: value } }
  const unwritten = await writeSettingsDocument(options.fs, file, next)
  if (unwritten) return { ok: false, reason: unwritten }
  return { ok: true, file, changed: true }
}
