import path from 'node:path'
import { parseRule, type RuleBehavior } from '@encode/permissions'
import { isFolderSource, loadSettingsSources, settingsFiles, type SettingsScope } from './settings'
import { folderConfigDigest, type TrustFs, type TrustStore } from './trust'

/**
 * Saving and removing permission rules in the settings files, for the
 * "Always allow this" button and the rule list in Settings.
 *
 * Only the rule list is touched: everything else in the file stays as it
 * was, and a file that is not valid JSON is never overwritten (the user
 * fixes it, or the rule is not saved). The write is atomic.
 *
 * A folder's allow rules count only while the folder's configuration is the
 * one the user approved (see trust.ts), and saving a rule changes that
 * configuration. When the configuration was approved just before the save,
 * the new one is approved with it: the user's click is the approval of
 * exactly the rule they saw. When something else in the folder's settings
 * changed since (a pull, an edit by the agent), the rule is saved but stays
 * held back, and `approved` says so, so the caller can show the settings
 * for review instead of quietly approving them.
 */

export type RuleScope = Exclude<SettingsScope, 'cli'>

export interface RuleEditOptions {
  scope: RuleScope
  behavior: RuleBehavior
  text: string
  home: string
  /** The workspace root, as a real path. */
  root: string
  fs: TrustFs
  /** Given, a folder scope keeps its approval when it can (see above). */
  trust?: TrustStore
  platform?: NodeJS.Platform
}

export type RuleEditResult =
  | {
      ok: true
      file: string
      /** False when the rule was already there (saving) or was not there (removing). */
      changed: boolean
      /** Whether the rule applies now: always for the user's file and for a rule that deny or asks, and for a folder's allow rule while its configuration is approved. */
      approved: boolean
    }
  | { ok: false; reason: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `change` gets the rule list and the rule's text as it is stored, and returns the new list, or null when there is nothing to change. */
async function edit(options: RuleEditOptions, change: (list: string[], text: string) => string[] | null): Promise<RuleEditResult> {
  const parsed = parseRule(options.text, options.behavior, options.scope)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const text = parsed.rule.text
  const platform = options.platform ?? process.platform
  const file = settingsFiles(options.home, options.root, platform === 'win32' ? path.win32 : path.posix)[options.scope]

  let current: string | null
  try {
    current = await options.fs.read(file)
  } catch (error) {
    return { ok: false, reason: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  let document: Record<string, unknown> = {}
  if (current !== null && current.trim() !== '') {
    let raw: unknown
    try {
      raw = JSON.parse(current.replace(/^\uFEFF/, ''))
    } catch (error) {
      return { ok: false, reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it before saving a rule there.` }
    }
    if (!isObject(raw)) return { ok: false, reason: `${file} does not hold a settings object; fix it before saving a rule there.` }
    document = raw
  }
  const permissions = document.permissions
  if (permissions !== undefined && !isObject(permissions)) return { ok: false, reason: `"permissions" in ${file} is not an object.` }
  const existing = permissions?.[options.behavior]
  if (existing !== undefined && (!Array.isArray(existing) || !existing.every((item) => typeof item === 'string'))) {
    return { ok: false, reason: `"permissions.${options.behavior}" in ${file} is not a list of rules.` }
  }
  const after = change((existing as string[] | undefined) ?? [], text)
  if (after === null) return { ok: true, file, changed: false, approved: true }

  // The configuration as the user approved it, before this change.
  const folder = isFolderSource(options.scope)
  const read = options.fs.read
  const loadDigest = async () => folderConfigDigest(await loadSettingsSources({ home: options.home, root: options.root, read, platform }))
  const wasApproved = folder && options.trust ? (await options.trust.state(options.root, await loadDigest())).configApproved : false

  const next = { ...document, permissions: { ...(permissions as Record<string, unknown> | undefined), [options.behavior]: after } }
  if (after.length === 0 && permissions !== undefined) delete (next.permissions as Record<string, unknown>)[options.behavior]
  try {
    await options.fs.writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `${file} could not be written: ${error instanceof Error ? error.message : String(error)}` }
  }

  // A rule that takes something away applies at once, wherever it is written: only a folder's allow rules wait for its approval.
  if (!folder || options.behavior !== 'allow') return { ok: true, file, changed: true, approved: true }
  if (!options.trust || !wasApproved) return { ok: true, file, changed: true, approved: false }
  const digest = await loadDigest()
  if (digest !== null) await options.trust.approveConfig(options.root, digest)
  return { ok: true, file, changed: true, approved: true }
}

/** Adds a rule to a settings file. Saving a rule that is already there changes nothing. */
export function saveRule(options: RuleEditOptions): Promise<RuleEditResult> {
  return edit(options, (list, text) => (list.some((item) => item.trim() === text) ? null : [...list, text]))
}

/** Removes a rule from a settings file. */
export function removeRule(options: RuleEditOptions): Promise<RuleEditResult> {
  return edit(options, (list, text) => (list.some((item) => item.trim() === text) ? list.filter((item) => item.trim() !== text) : null))
}
