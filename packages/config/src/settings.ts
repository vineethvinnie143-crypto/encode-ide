import path from 'node:path'
import type { RuleBehavior, RuleSource } from '@encode/permissions'

/**
 * eNCode's settings files, in Claude Code's format so existing settings
 * carry over:
 *
 *   ~/.encode/settings.json             user: every workspace
 *   <root>/.encode/settings.json        project: shared through the repository
 *   <root>/.encode/settings.local.json  local: this machine only, usually ignored by git
 *
 * plus settings passed on the command line. A file that cannot be read or
 * parsed is skipped with a problem the settings screen shows; a bad entry is
 * dropped the same way, so one typo never disables the rest of a file.
 *
 * Project and local files come with the folder, so whoever wrote the folder
 * wrote them. What they restrict (deny and ask rules, disabled MCP servers)
 * always applies. What they grant (allow rules, a default mode, extra
 * directories, hooks, environment variables, MCP servers, sandbox
 * settings) applies only once the user trusts the workspace and has
 * approved that exact configuration; see trust.ts.
 */

export type SettingsScope = 'user' | 'project' | 'local' | 'cli'

export interface PermissionSettings {
  allow?: string[]
  ask?: string[]
  deny?: string[]
  /** The approval mode a session starts in. */
  defaultMode?: string
  /** Folders outside the workspace the agent may read and edit as if inside it. */
  additionalDirectories?: string[]
}

export interface EncodeSettings {
  permissions?: PermissionSettings
  /** Hook configuration, checked by @encode/hooks. */
  hooks?: unknown
  /** Variables set for every command the agent runs. */
  env?: Record<string, string>
  model?: string
  /** Approves every server in the project's .mcp.json. */
  enableAllProjectMcpServers?: boolean
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  /** Sandbox configuration, checked by @encode/sandbox. */
  sandbox?: unknown
  /** Every other key, kept for the features that read them. */
  [key: string]: unknown
}

export interface SettingsSource {
  scope: SettingsScope
  /** The file it came from; absent for the command line. */
  file?: string
  settings: EncodeSettings
  /** What was wrong with the file or its entries; each entry was skipped. */
  problems: string[]
}

/** Reads a file as text; null when it does not exist. Injected so loading is testable. */
export type ReadText = (file: string) => Promise<string | null>

export const SETTINGS_DIR = '.encode'
const MAX_SETTINGS_BYTES = 1024 * 1024

/** The modes a settings file may name, eNCode's and Claude Code's. */
const MODES = new Set([
  'read-only', 'workspace-write', 'auto-review', 'full-access',
  'default', 'acceptEdits', 'plan', 'bypassPermissions',
])

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown, where: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list of strings`)
    return undefined
  }
  const out: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry)
    else problems.push(`${where}[${index}] must be a non-empty string`)
  }
  return out
}

/** Checks a parsed settings object; keeps what is valid, reports the rest. */
export function validateSettings(raw: unknown): { settings: EncodeSettings; problems: string[] } {
  const problems: string[] = []
  if (!isObject(raw)) return { settings: {}, problems: ['settings must be a JSON object'] }
  const settings: EncodeSettings = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      problems.push(`${key} is not a setting`)
      continue
    }
    switch (key) {
      case 'permissions': {
        if (!isObject(value)) {
          problems.push('permissions must be an object')
          break
        }
        const permissions: PermissionSettings = {}
        for (const behavior of ['allow', 'ask', 'deny'] as const) {
          const list = stringList(value[behavior], `permissions.${behavior}`, problems)
          if (list) permissions[behavior] = list
        }
        if (value.defaultMode !== undefined) {
          if (typeof value.defaultMode === 'string' && MODES.has(value.defaultMode)) permissions.defaultMode = value.defaultMode
          else problems.push(`permissions.defaultMode must be one of ${[...MODES].join(', ')}`)
        }
        const directories = stringList(value.additionalDirectories, 'permissions.additionalDirectories', problems)
        if (directories) permissions.additionalDirectories = directories
        settings.permissions = permissions
        break
      }
      case 'env': {
        if (!isObject(value)) {
          problems.push('env must be an object of strings')
          break
        }
        const env: Record<string, string> = {}
        for (const [name, entry] of Object.entries(value)) {
          if (!ENV_NAME.test(name)) problems.push(`env.${name} is not a valid variable name`)
          else if (typeof entry !== 'string') problems.push(`env.${name} must be a string`)
          else env[name] = entry
        }
        settings.env = env
        break
      }
      case 'model':
        if (typeof value === 'string' && value.trim()) settings.model = value.trim()
        else problems.push('model must be a non-empty string')
        break
      case 'enableAllProjectMcpServers':
        if (typeof value === 'boolean') settings.enableAllProjectMcpServers = value
        else problems.push('enableAllProjectMcpServers must be true or false')
        break
      case 'enabledMcpjsonServers':
      case 'disabledMcpjsonServers': {
        const list = stringList(value, key, problems)
        if (list) settings[key] = list
        break
      }
      default:
        settings[key] = value
    }
  }
  return { settings, problems }
}

/** Parses a settings file's text: strict JSON, with a leading byte-order mark allowed. */
export function parseSettings(text: string): { settings: EncodeSettings; problems: string[] } {
  if (text.length > MAX_SETTINGS_BYTES) return { settings: {}, problems: ['the file is larger than 1 MB'] }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { settings: {}, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  return validateSettings(raw)
}

export function settingsFiles(home: string, root: string, api: typeof path.posix = path): Record<'user' | 'project' | 'local', string> {
  return {
    user: api.join(home, SETTINGS_DIR, 'settings.json'),
    project: api.join(root, SETTINGS_DIR, 'settings.json'),
    local: api.join(root, SETTINGS_DIR, 'settings.local.json'),
  }
}

/** Reads every settings source, lowest precedence first: user, project, local, command line. */
export async function loadSettingsSources(options: {
  home: string
  root: string
  read: ReadText
  /** Settings given on the command line, already parsed. */
  cli?: unknown
}): Promise<SettingsSource[]> {
  const files = settingsFiles(options.home, options.root)
  const sources: SettingsSource[] = []
  for (const scope of ['user', 'project', 'local'] as const) {
    let text: string | null
    try {
      text = await options.read(files[scope])
    } catch (error) {
      sources.push({ scope, file: files[scope], settings: {}, problems: [`could not be read: ${error instanceof Error ? error.message : String(error)}`] })
      continue
    }
    if (text === null) continue
    sources.push({ scope, file: files[scope], ...parseSettings(text) })
  }
  if (options.cli !== undefined) sources.push({ scope: 'cli', ...validateSettings(options.cli) })
  return sources
}

/** Whether a source comes with the folder and so needs the user's approval for what it grants. */
export function isFolderSource(scope: SettingsScope): boolean {
  return scope === 'project' || scope === 'local'
}

/** The keys a folder source may restrict with even before the user approves it. */
const RESTRICTING_KEYS = new Set(['disabledMcpjsonServers'])

/**
 * What a folder's settings grant, for the approval digest: everything but
 * deny and ask rules and the list of disabled MCP servers, which only take
 * permissions away.
 */
export function grantingPart(settings: EncodeSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (RESTRICTING_KEYS.has(key)) continue
    if (key === 'permissions' && isObject(value)) {
      const { deny: _deny, ask: _ask, ...granting } = value as PermissionSettings
      if (Object.keys(granting).length) out.permissions = granting
      continue
    }
    out[key] = value
  }
  return out
}

export interface RuleEntry {
  behavior: RuleBehavior
  text: string
  source: RuleSource
}

export interface EffectiveSettings {
  /** Permission rules from every source that applies, for a RuleSet. */
  rules: RuleEntry[]
  defaultMode?: string
  additionalDirectories: string[]
  env: Record<string, string>
  /** Hook configurations in precedence order, each with its source. */
  hooks: Array<{ scope: SettingsScope; config: unknown }>
  model?: string
  mcp: { enableAll: boolean; enabled: string[]; disabled: string[] }
  sandbox: Array<{ scope: SettingsScope; config: unknown }>
  /** Problems from every source, prefixed with the file they came from. */
  problems: string[]
  /** What folder settings would grant once approved; empty when they apply or grant nothing. */
  heldBack: string[]
}

/**
 * Merges the sources the way Claude Code does: lists add up across sources,
 * and for single values the later (higher-precedence) source wins. Folder
 * sources grant only when `folderApproved` (the workspace is trusted and
 * its configuration digest approved); their restrictions always apply.
 */
export function resolveSettings(sources: readonly SettingsSource[], options: { folderApproved: boolean }): EffectiveSettings {
  const out: EffectiveSettings = {
    rules: [],
    additionalDirectories: [],
    env: {},
    hooks: [],
    mcp: { enableAll: false, enabled: [], disabled: [] },
    sandbox: [],
    problems: [],
    heldBack: [],
  }
  for (const source of sources) {
    const label = source.file ?? 'command line'
    for (const problem of source.problems) out.problems.push(`${label}: ${problem}`)
    const { settings } = source
    const grants = !isFolderSource(source.scope) || options.folderApproved
    const ruleSource: RuleSource = source.scope

    for (const behavior of ['deny', 'ask'] as const) {
      for (const text of settings.permissions?.[behavior] ?? []) out.rules.push({ behavior, text, source: ruleSource })
    }
    out.mcp.disabled.push(...(settings.disabledMcpjsonServers ?? []))

    if (!grants) {
      const granting = grantingPart(settings)
      if (Object.keys(granting).length) out.heldBack.push(`${label}: ${Object.keys(granting).sort().join(', ')}`)
      continue
    }
    for (const text of settings.permissions?.allow ?? []) out.rules.push({ behavior: 'allow', text, source: ruleSource })
    if (settings.permissions?.defaultMode) out.defaultMode = settings.permissions.defaultMode
    out.additionalDirectories.push(...(settings.permissions?.additionalDirectories ?? []))
    Object.assign(out.env, settings.env ?? {})
    if (settings.hooks !== undefined) out.hooks.push({ scope: source.scope, config: settings.hooks })
    if (settings.model) out.model = settings.model
    if (settings.enableAllProjectMcpServers !== undefined) out.mcp.enableAll = settings.enableAllProjectMcpServers
    out.mcp.enabled.push(...(settings.enabledMcpjsonServers ?? []))
    if (settings.sandbox !== undefined) out.sandbox.push({ scope: source.scope, config: settings.sandbox })
  }
  return out
}
