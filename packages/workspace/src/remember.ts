import path from 'node:path'
import { saveRule } from '@encode/config'
import type { RememberResult, RuleScope } from '@encode/core'
import type { WorkspaceConfig } from './config'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'

/** Where a scope's file is, in words for people. */
export function whereOf(scope: RuleScope): string {
  return scope === 'user' ? 'your user settings' : scope === 'project' ? '.encode/settings.json' : '.encode/settings.local.json'
}

const LOCAL_SETTINGS = '.encode/settings.local.json'

/**
 * Keeps the private settings file out of the project's commits, the way git is asked to ignore any local file:
 * one line in `.git/info/exclude`, which belongs to this clone alone. Nothing is done where there is no `.git`
 * folder (a worktree or a submodule keeps its own elsewhere), or where the line is already there.
 */
export async function keepLocalSettingsOutOfGit(root: string, fs: WorkspaceFs, api: typeof path.posix = path): Promise<void> {
  const git = api.join(root, '.git')
  if (!(await fs.isDirectory(git))) return
  const file = api.join(git, 'info', 'exclude')
  const current = (await fs.read(file).catch(() => null)) ?? ''
  if (current.split(/\r?\n/).some((line) => line.trim() === LOCAL_SETTINGS || line.trim() === `/${LOCAL_SETTINGS}`)) return
  await fs.append(file, `${current && !current.endsWith('\n') ? '\n' : ''}${LOCAL_SETTINGS}\n`)
}

/**
 * The `remember` of a session's scope: saves the rules "Always allow" offered as allow rules in the settings file
 * the user chose. Nothing else in the file is touched. A rule saved in the folder's own files applies at once while
 * the folder's settings are the ones the user approved; otherwise it waits for their review (`approved: false`).
 */
export function rememberRules(config: WorkspaceConfig, fs: WorkspaceFs = nodeWorkspaceFs, platform: NodeJS.Platform = process.platform) {
  return async (rules: string[], scope: RuleScope): Promise<RememberResult> => {
    let changed = false
    let approved = true
    for (const text of rules) {
      const result = await saveRule({ scope, behavior: 'allow', text, home: config.home, root: config.root, fs, trust: config.trustStore, platform })
      if (!result.ok) {
        config.invalidate()
        return { ok: false, reason: result.reason }
      }
      changed ||= result.changed
      approved &&= result.approved
    }
    config.invalidate()
    if (scope === 'local' && changed) {
      // Best effort: failing to tidy a git file must not lose the rule that was just saved.
      await keepLocalSettingsOutOfGit(config.root, fs, platform === 'win32' ? path.win32 : path.posix).catch(() => undefined)
    }
    return { ok: true, where: whereOf(scope), approved, changed }
  }
}
