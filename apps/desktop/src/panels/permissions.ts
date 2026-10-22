/**
 * What the Permissions screen and the "Always allow" control say, as data and pure functions so the wording and
 * the rules about what to show are unit tested. The components in components/permissions draw it.
 */
import type { PermissionRuleView, PermissionsReport, RuleScope } from '@shared/types'

export interface ScopeChoice {
  value: RuleScope
  label: string
  /** The file the rule is written to, as a person would say it. */
  where: string
}

/** Where "Always allow" and "Add a rule" can write, the narrowest first. */
export const SCOPE_CHOICES: readonly ScopeChoice[] = [
  { value: 'local', label: 'This project, only for me', where: '.encode/settings.local.json' },
  { value: 'project', label: 'This project, for everyone who uses it', where: '.encode/settings.json' },
  { value: 'user', label: 'Every project', where: 'your user settings' },
]

/** The narrowest scope, and the one that needs nobody's review: a rule only the person sees. */
export const DEFAULT_ALWAYS_SCOPE: RuleScope = 'local'

export const SCOPE_NAMES: Record<PermissionRuleView['scope'], string> = {
  user: 'Every project',
  project: 'This project',
  local: 'Only me',
  cli: 'This run',
}

export type RuleBehavior = PermissionRuleView['behavior']

/** What a rule does, as a heading. Denials come first: they are what protects. */
export const BEHAVIOR_ORDER: readonly RuleBehavior[] = ['deny', 'ask', 'allow']

export const BEHAVIOR_NAMES: Record<RuleBehavior, { title: string; help: string }> = {
  deny: { title: 'Never allow', help: 'Refused, whatever the approval mode.' },
  ask: { title: 'Always ask', help: 'Asks first, even where the mode would not.' },
  allow: { title: 'Allowed', help: 'Runs without asking, where the approval mode allows it.' },
}

export interface RuleGroup {
  behavior: RuleBehavior
  rules: PermissionRuleView[]
}

/** The rules by what they do, in the order of BEHAVIOR_ORDER; a kind with no rules is left out. */
export function groupRules(rules: readonly PermissionRuleView[]): RuleGroup[] {
  return BEHAVIOR_ORDER.map((behavior) => ({ behavior, rules: rules.filter((rule) => rule.behavior === behavior) })).filter((group) => group.rules.length > 0)
}

/** Whether a rule can be removed from the screen: the command line's cannot, it is not in a file. */
export function removable(rule: PermissionRuleView): rule is PermissionRuleView & { scope: RuleScope } {
  return rule.scope !== 'cli'
}

export type TrustState = 'broken' | 'untrusted' | 'untrusted-waiting' | 'changed' | 'trusted'

/**
 * Where the open folder stands. `broken`: the settings cannot be relied on and nothing runs. `untrusted-waiting`: the
 * folder asks for things its own settings cannot give until it is trusted. `changed`: trusted, but its settings
 * changed since they were approved.
 */
export function trustState(report: PermissionsReport): TrustState {
  if (report.broken) return 'broken'
  if (!report.trusted) return report.heldBack.length > 0 ? 'untrusted-waiting' : 'untrusted'
  return report.configApproved ? 'trusted' : 'changed'
}

/** A line for the banner above the composer, or null when there is nothing the person has to know. */
export function bannerOf(report: PermissionsReport | null): { tone: 'warning' | 'danger'; text: string; action: string } | null {
  if (!report) return null
  switch (trustState(report)) {
    case 'broken':
      return { tone: 'danger', text: 'eNCode cannot read this folder’s settings, so it runs nothing here until they are fixed.', action: 'Show what is wrong' }
    case 'untrusted-waiting':
      return { tone: 'warning', text: 'This folder’s own settings are waiting for your review. They apply once you trust it.', action: 'Review' }
    case 'changed':
      return { tone: 'warning', text: 'This folder’s settings changed since you approved them. The changes wait for you.', action: 'Review' }
    default:
      return null
  }
}

/** The rules "Always allow" will write, one per line, as they will appear in the file. */
export function alwaysRulesText(rules: readonly string[]): string {
  return rules.join('\n')
}

/** When a rule saved to a scope starts to apply: at once, or only after the person has dealt with the folder. */
export type RuleTiming = 'now' | 'after-trust' | 'after-review'

/**
 * A rule in the user's own settings applies at once. One saved in the folder applies once the folder is trusted and
 * its settings, as they are, are approved (the settings are the folder's, whoever wrote them last).
 */
export function ruleTiming(report: PermissionsReport | null, scope: RuleScope): RuleTiming {
  if (scope === 'user' || !report) return 'now'
  if (!report.trusted) return 'after-trust'
  return report.configApproved ? 'now' : 'after-review'
}

/** The sentence under the choices, for the scope picked and when it will apply. */
export function scopeNote(scope: RuleScope, timing: RuleTiming = 'now'): string {
  if (scope === 'user') return 'Saved in your user settings. It applies in every project, at once.'
  const where = scope === 'local' ? 'Saved in .encode/settings.local.json. Git is asked to ignore that file.' : 'Saved in .encode/settings.json, which is shared with everyone who uses the project.'
  switch (timing) {
    case 'after-trust':
      return `${where} This folder is not trusted yet, so the rule starts to apply once it is.`
    case 'after-review':
      return `${where} This folder’s settings changed since you approved them, so the rule starts to apply once you review them (Settings, Permissions).`
    default:
      return `${where} It applies at once.`
  }
}

/**
 * Whether "Always allow" should offer to trust the folder with the rule: it does when the rule would otherwise wait
 * for trust. A folder whose own settings are waiting for review is not trusted on the way (the person has not read
 * them), and the home folder or a drive root is never trusted from here.
 */
export function trustOffer(report: PermissionsReport | null, scope: RuleScope): { kind: 'offer'; checked: boolean; note: string } | { kind: 'warn'; note: string } | null {
  if (ruleTiming(report, scope) !== 'after-trust' || !report) return null
  if (report.trustWarning) return { kind: 'warn', note: `${report.trustWarning} Trust it from Settings, Permissions if you mean to.` }
  if (report.heldBack.length > 0) {
    return { kind: 'offer', checked: false, note: 'This folder’s own settings are waiting for your review, so it is not trusted unless you say so.' }
  }
  return { kind: 'offer', checked: true, note: 'The folder has no settings of its own that grant anything.' }
}

/** A path made shorter for a line of text: the end of it, with the folder it is in. */
export function shortPath(file: string, max = 56): string {
  if (file.length <= max) return file
  return `…${file.slice(file.length - (max - 1))}`
}
