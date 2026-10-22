import type { RuleScope } from '@encode/config'
import type { RuleBehavior } from '@encode/permissions'
import type { WorkspaceConfig } from './config'
import type { WorkspaceFs } from './fs'
import { addRuleTo, approveFolder, removeRuleFrom, reportOn, revokeFolder, trustFolder, type WorkspaceReport } from './report'
import { whereOf } from './remember'

/** What the Permissions screen can do to a folder's settings. */
export type PermissionsAction =
  | { type: 'trust'; /** The person saw the warning for a folder that trusts far more than a project. */ acknowledged?: boolean }
  | { type: 'approve' }
  | { type: 'revoke' }
  | { type: 'add-rule'; scope: RuleScope; behavior: RuleBehavior; text: string }
  | { type: 'remove-rule'; scope: RuleScope; behavior: RuleBehavior; text: string }

/** The folder as it is after the action, with what happened in words. */
export type PermissionsOutcome =
  | { ok: true; report: WorkspaceReport; note?: string }
  | { ok: false; reason: string; report: WorkspaceReport }

const BEHAVIORS: readonly string[] = ['allow', 'ask', 'deny']
const SCOPES: readonly string[] = ['user', 'project', 'local']
const MAX_RULE_CHARS = 2_000

/** Checks an action that came from a screen; the types are not trusted. Returns the reason it is refused, or null. */
export function actionProblem(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'That is not an action.'
  const given = action as Record<string, unknown>
  switch (given.type) {
    case 'trust':
      return given.acknowledged === undefined || typeof given.acknowledged === 'boolean' ? null : 'acknowledged must be true or false.'
    case 'approve':
    case 'revoke':
      return null
    case 'add-rule':
    case 'remove-rule':
      if (typeof given.scope !== 'string' || !SCOPES.includes(given.scope)) return 'A rule goes to the user, project or local settings.'
      if (typeof given.behavior !== 'string' || !BEHAVIORS.includes(given.behavior)) return 'A rule allows, asks or denies.'
      if (typeof given.text !== 'string' || !given.text.trim()) return 'The rule is empty.'
      if (given.text.length > MAX_RULE_CHARS) return 'The rule is too long.'
      return null
    default:
      return 'That is not an action.'
  }
}

/** Does what the screen asked and says how it went. The folder's picture is read over afterwards, so the report is current. */
export async function actOn(
  config: WorkspaceConfig,
  action: PermissionsAction,
  options: { fs?: WorkspaceFs; platform?: NodeJS.Platform } = {},
): Promise<PermissionsOutcome> {
  const platform = options.platform ?? process.platform
  const refused = async (reason: string): Promise<PermissionsOutcome> => ({ ok: false, reason, report: await reportOn(config, platform) })
  const problem = actionProblem(action)
  if (problem) return refused(problem)
  let note: string | undefined
  switch (action.type) {
    case 'trust': {
      const result = await trustFolder(config, { acknowledged: action.acknowledged === true, platform })
      if (!result.ok) return refused(result.reason)
      break
    }
    case 'approve': {
      const result = await approveFolder(config)
      if (!result.ok) return refused(result.reason)
      break
    }
    case 'revoke':
      await revokeFolder(config)
      break
    case 'add-rule':
    case 'remove-rule': {
      const change = { scope: action.scope, behavior: action.behavior, text: action.text }
      const result =
        action.type === 'add-rule' ? await addRuleTo(config, change, options.fs, platform) : await removeRuleFrom(config, change, options.fs, platform)
      if (!result.ok) return refused(result.reason)
      if (!result.changed) note = action.type === 'add-rule' ? `That rule is already in ${whereOf(action.scope)}.` : `That rule is not in ${whereOf(action.scope)}.`
      else if (action.type === 'add-rule' && !result.approved) note = `Saved in ${whereOf(action.scope)}. It applies once you trust this folder and approve its settings.`
      break
    }
  }
  return { ok: true, report: await reportOn(config, platform), ...(note ? { note } : {}) }
}
