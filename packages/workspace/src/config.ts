import path from 'node:path'
import {
  folderConfigDigest,
  loadSettingsSources,
  resolveSettings,
  settingsFiles,
  TrustStore,
  type EffectiveSettings,
  type FolderState,
  type RuleEntry,
  type SettingsSource,
} from '@encode/config'
import { refuseEverything, type RuleJudge } from '@encode/core'
import { loadHookGroups, type HookGroup } from '@encode/hooks'
import { createShellAssessor, parseRule, RuleSet, type DiskProbe, type PermissionRule } from '@encode/permissions'
import { realPathOf, type ShellCommandAssessor } from '@encode/tools'
import type { WorkspaceFs } from './fs'
import { nodeWorkspaceFs } from './fs'
import { nodeDiskProbe } from './probe'

/**
 * A folder's settings, trust and permission rules as one picture, kept current.
 *
 * Reading is cheap and always done over: before a tool call is judged, `refresh` reads the four files the picture
 * comes from (the user's, the project's and the local settings, and the trust file) and rebuilds it only when the
 * text of one of them is not what it was. So a rule the user saves, a file the agent edits, a folder trusted in
 * another window or a pull that changes the project's settings all apply to the very next call, with nothing to
 * watch and nothing to miss.
 */

export interface WorkspaceConfigOptions {
  /** The workspace root, as a real path. */
  root: string
  home: string
  platform?: NodeJS.Platform
  fs?: WorkspaceFs
  /** Default `<home>/.encode/trust.json`. */
  trustFile?: string
  /** Checks read-only verdicts on disk. Default: the real disk. */
  probe?: DiskProbe
  /** Other files whose change means the picture is stale (the MCP files), by absolute path. */
  also?: readonly string[]
}

export interface ConfigSnapshot {
  root: string
  sources: SettingsSource[]
  effective: EffectiveSettings
  folder: FolderState
  rules: RuleSet
  /** The folders the user counts as part of the workspace, as real paths. */
  extraRoots: string[]
  /** The hooks that apply: the user's own, and the folder's once it is trusted and its settings approved. Empty while the settings are broken. */
  hooks: HookGroup[]
  /** What was wrong with the settings, the rules and the hooks, in words. */
  problems: string[]
  /**
   * Why nothing may run under these settings, or null. A deny or ask rule or a whole file could not be read, so
   * the user's restriction may be missing; carrying on with the rules that did load would run what they meant to stop.
   */
  broken: string | null
  /** What the agent's calls are judged by: the rules, or a refusal of everything while the settings are broken. */
  judge: RuleJudge
  /** Judges shell lines under these rules and this trust, or refuses them all while the settings are broken. */
  assessor: ShellCommandAssessor
}

/**
 * The rules of the effective settings as a rule set. An entry that does not read is reported and left out; if it was
 * a deny or ask rule the user lost a restriction, which is also listed in `unsafe`.
 */
export function buildRuleSet(
  entries: readonly RuleEntry[],
  base: { root: string; home: string; windows: boolean },
): { rules: RuleSet; problems: string[]; unsafe: string[] } {
  const parsed: PermissionRule[] = []
  const problems: string[] = []
  const unsafe: string[] = []
  for (const entry of entries) {
    const result = parseRule(entry.text, entry.behavior, entry.source)
    if (result.ok) {
      parsed.push(result.rule)
      continue
    }
    const problem = `${entry.source} settings: ${result.reason}`
    problems.push(problem)
    if (entry.behavior !== 'allow') unsafe.push(problem)
  }
  const rules = new RuleSet(parsed, base)
  problems.push(...rules.problems)
  const kept = new Set(rules.rules)
  for (const rule of parsed) {
    if (rule.behavior !== 'allow' && !kept.has(rule)) unsafe.push(`${rule.source} settings: ${rule.text} could not be applied`)
  }
  return { rules, problems, unsafe }
}

/** The words a refusal gives for settings that may have lost a restriction. */
export function brokenSettingsMessage(unsafe: readonly string[]): string {
  const shown = unsafe.slice(0, 3).join('; ')
  const more = unsafe.length > 3 ? `, and ${unsafe.length - 3} more` : ''
  return `eNCode cannot tell what your settings forbid (${shown}${more}), so nothing runs until that is fixed. Correct the file, or open Settings, Permissions to see what is wrong.`
}

/** What reading a file gave when it could not be read at all. */
const UNREADABLE = Symbol('unreadable')

export class WorkspaceConfig {
  readonly root: string
  readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly fs: WorkspaceFs
  private readonly trustFile: string
  private readonly trust: TrustStore
  private readonly probe: DiskProbe
  private readonly watched: string[]
  private texts: Array<string | null | typeof UNREADABLE> | undefined
  private loaded: ConfigSnapshot | undefined
  private running: Promise<ConfigSnapshot> | undefined
  private stale = true

  constructor(options: WorkspaceConfigOptions) {
    this.root = options.root
    this.home = options.home
    this.platform = options.platform ?? process.platform
    this.fs = options.fs ?? nodeWorkspaceFs
    const api = this.platform === 'win32' ? path.win32 : path.posix
    this.trustFile = options.trustFile ?? api.join(options.home, '.encode', 'trust.json')
    this.trust = new TrustStore(this.trustFile, this.fs, this.platform === 'win32')
    this.probe = options.probe ?? nodeDiskProbe(options.root, { platform: this.platform })
    const files = settingsFiles(options.home, options.root, api)
    this.watched = [files.user, files.project, files.local, this.trustFile, ...(options.also ?? [])]
  }

  /** The trust store this folder's picture is built from; the same file every folder's is. */
  get trustStore(): TrustStore {
    return this.trust
  }

  /** The files this picture is read from and saved to. */
  get fileSystem(): WorkspaceFs {
    return this.fs
  }

  /** The picture as of the last `refresh`. Throws before the first. */
  current(): ConfigSnapshot {
    if (!this.loaded) throw new Error('The settings of this folder have not been read yet.')
    return this.loaded
  }

  /** The next `refresh` reads everything over, whatever the files say. */
  invalidate(): void {
    this.stale = true
  }

  /** Judges shell lines with whatever the picture is when the line arrives. */
  readonly assessor: ShellCommandAssessor = (line, context) => this.current().assessor(line, context)

  /** Answers rule questions with whatever the picture is when they arrive. */
  readonly rules: RuleJudge = { evaluate: (query) => this.current().judge.evaluate(query) }

  /**
   * Reads the files and rebuilds the picture if any of them changed; callers that arrive meanwhile share the work.
   * A rebuild that fails leaves the last picture in place but refusing everything, and the next refresh tries again.
   */
  refresh(): Promise<ConfigSnapshot> {
    this.running ??= this.load()
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }

  private failed(error: unknown): ConfigSnapshot {
    // Before the first picture there is nothing to keep: the caller hears of it.
    if (!this.loaded) throw error
    const broken = `eNCode could not read this folder's settings again (${error instanceof Error ? error.message : String(error)}), so nothing runs until it can.`
    const refusal = refuseEverything(broken)
    this.loaded = { ...this.loaded, broken, judge: refusal.rules, assessor: refusal.assessor }
    this.stale = true
    return this.loaded
  }

  private async read(file: string): Promise<string | null | typeof UNREADABLE> {
    try {
      return await this.fs.read(file)
    } catch {
      // Told apart from a file that is not there, so that a picture built while one could not be read is built again.
      return UNREADABLE
    }
  }

  private async load(): Promise<ConfigSnapshot> {
    const texts = await Promise.all(this.watched.map((file) => this.read(file)))
    if (this.loaded && !this.stale && this.texts && texts.every((text, index) => text === this.texts![index])) return this.loaded
    const fresh = await this.build()
    this.texts = texts
    this.loaded = fresh
    this.stale = texts.includes(UNREADABLE)
    return fresh
  }

  private async build(): Promise<ConfigSnapshot> {
    const windows = this.platform === 'win32'
    const sources = await loadSettingsSources({ home: this.home, root: this.root, read: (file) => this.fs.read(file), platform: this.platform })
    const digest = folderConfigDigest(sources)
    const folder = await this.trust.state(this.root, digest)
    const effective = resolveSettings(sources, { folderApproved: folder.configApproved })
    const { rules, problems, unsafe } = buildRuleSet(effective.rules, { root: this.root, home: this.home, windows })
    // A PreToolUse hook that cannot be read may have been a guard: like a deny rule that cannot be read, it stops everything.
    const hooks = loadHookGroups(effective.hooks)
    const broken = effective.unsafe.length || unsafe.length || hooks.unsafe.length ? brokenSettingsMessage([...effective.unsafe, ...unsafe, ...hooks.unsafe]) : null
    const refusal = broken ? refuseEverything(broken) : null
    const api = windows ? path.win32 : path.posix
    const extraRoots: string[] = []
    for (const directory of effective.additionalDirectories) {
      const expanded = directory === '~' ? this.home : /^~[\\/]/.test(directory) ? api.join(this.home, directory.slice(2)) : directory
      extraRoots.push(await realPathOf(api.resolve(this.root, expanded)).catch(() => api.resolve(this.root, expanded)))
    }
    return {
      root: this.root,
      sources,
      effective,
      folder,
      rules,
      extraRoots,
      hooks: broken ? [] : hooks.groups,
      problems: [...effective.problems, ...problems, ...hooks.problems],
      broken,
      judge: refusal?.rules ?? rules,
      assessor: refusal?.assessor ?? createShellAssessor({ rules, trusted: folder.trusted, probe: this.probe, platform: windows ? 'win32' : 'posix' }),
    }
  }
}
