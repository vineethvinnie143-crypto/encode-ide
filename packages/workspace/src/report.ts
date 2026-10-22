import path from 'node:path'
import {
  folderConfigDigest,
  grantingPart,
  isFolderSource,
  removeRule,
  saveRule,
  settingsFiles,
  trustWarning,
  type RuleScope,
  type SettingsScope,
} from '@encode/config'
import type { RuleBehavior } from '@encode/permissions'
import type { WorkspaceConfig } from './config'
import { keepLocalSettingsOutOfGit } from './remember'

/** One rule as the Settings screen lists it. */
export interface RuleView {
  behavior: RuleBehavior
  text: string
  scope: SettingsScope
  /** False for a rule of the folder's that waits for the user to trust the folder and approve its settings. */
  active: boolean
}

/** A folder's permissions as the Settings screen shows them. */
export interface WorkspaceReport {
  root: string
  trusted: boolean
  /** Why trusting this folder deserves a second look (the home folder, a drive root), or null. */
  trustWarning: string | null
  /** Whether what the folder's own settings grant applies. */
  configApproved: boolean
  /** What the folder's settings would grant, one line per file, while it waits. */
  heldBack: string[]
  /** The text of what waits, to read before approving it. */
  waiting: Array<{ file: string; text: string }>
  problems: string[]
  /** Why the agent may run nothing here until the settings are fixed, or null. */
  broken: string | null
  rules: RuleView[]
  additionalDirectories: string[]
  /** Names only. */
  envNames: string[]
  /** The mode settings ask sessions to start in, if any. */
  defaultMode?: string
  files: Record<'user' | 'project' | 'local', string>
}

const MAX_WAITING_CHARS = 6_000

/** The folder's picture, read over first. */
export async function reportOn(config: WorkspaceConfig, platform: NodeJS.Platform = process.platform): Promise<WorkspaceReport> {
  const snapshot = await config.refresh()
  const { folder, effective, sources } = snapshot
  const rules: RuleView[] = []
  for (const source of sources) {
    const applies = !isFolderSource(source.scope) || folder.configApproved
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      for (const text of source.settings.permissions?.[behavior] ?? []) {
        // What a folder only restricts with applies at once; what it grants waits.
        rules.push({ behavior, text, scope: source.scope, active: behavior !== 'allow' || applies })
      }
    }
  }
  const waiting: WorkspaceReport['waiting'] = []
  if (!folder.configApproved) {
    for (const source of sources) {
      if (!isFolderSource(source.scope)) continue
      const granting = grantingPart(source.settings)
      if (!Object.keys(granting).length) continue
      const text = JSON.stringify(granting, null, 2)
      waiting.push({ file: source.file ?? source.scope, text: text.length > MAX_WAITING_CHARS ? `${text.slice(0, MAX_WAITING_CHARS)}\n[cut: the file says more]` : text })
    }
  }
  return {
    root: config.root,
    trusted: folder.trusted,
    trustWarning: trustWarning(config.root, config.home, platform === 'win32'),
    configApproved: folder.configApproved,
    heldBack: effective.heldBack,
    waiting,
    problems: snapshot.problems,
    broken: snapshot.broken,
    rules,
    additionalDirectories: snapshot.extraRoots,
    envNames: Object.keys(effective.env).sort(),
    ...(effective.defaultMode ? { defaultMode: effective.defaultMode } : {}),
    files: settingsFiles(config.home, config.root, platform === 'win32' ? path.win32 : path.posix),
  }
}

export type TrustOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Trusts the folder and approves its settings as they are now. A folder that trusts far more than a project (the
 * home folder, a drive root) is trusted only when the caller says the person saw the warning.
 */
export async function trustFolder(config: WorkspaceConfig, options: { acknowledged?: boolean; platform?: NodeJS.Platform } = {}): Promise<TrustOutcome> {
  const platform = options.platform ?? process.platform
  const warning = trustWarning(config.root, config.home, platform === 'win32')
  if (warning && !options.acknowledged) return { ok: false, reason: warning }
  const snapshot = await config.refresh()
  await config.trustStore.trust(config.root, folderConfigDigest(snapshot.sources))
  config.invalidate()
  return { ok: true }
}

/** Approves the folder's settings as they are now; the folder must already be trusted. */
export async function approveFolder(config: WorkspaceConfig): Promise<TrustOutcome> {
  const snapshot = await config.refresh()
  if (!snapshot.folder.trusted) return { ok: false, reason: 'Trust the folder first.' }
  const digest = folderConfigDigest(snapshot.sources)
  if (digest !== null) await config.trustStore.approveConfig(config.root, digest)
  config.invalidate()
  return { ok: true }
}

/** Forgets the folder: untrusted, and nothing of its settings approved. */
export async function revokeFolder(config: WorkspaceConfig): Promise<void> {
  await config.trustStore.revoke(config.root)
  config.invalidate()
}

export interface RuleChange {
  scope: RuleScope
  behavior: RuleBehavior
  text: string
}

/** Adds a rule to a settings file from the Settings screen. */
export async function addRuleTo(config: WorkspaceConfig, change: RuleChange, fs = config.fileSystem, platform: NodeJS.Platform = process.platform) {
  const result = await saveRule({ ...change, home: config.home, root: config.root, fs, trust: config.trustStore, platform })
  config.invalidate()
  if (result.ok && change.scope === 'local' && result.changed) {
    await keepLocalSettingsOutOfGit(config.root, fs, platform === 'win32' ? path.win32 : path.posix).catch(() => undefined)
  }
  return result
}

/** Removes a rule from a settings file from the Settings screen. */
export async function removeRuleFrom(config: WorkspaceConfig, change: RuleChange, fs = config.fileSystem, platform: NodeJS.Platform = process.platform) {
  const result = await removeRule({ ...change, home: config.home, root: config.root, fs, trust: config.trustStore, platform })
  config.invalidate()
  return result
}
