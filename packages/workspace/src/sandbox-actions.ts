import { sandboxChangeProblem, setSandboxSetting, type SandboxChange } from '@encode/config'
import { resolveSandboxSettings, type Sandbox } from '@encode/sandbox'
import type { ShellProgram } from '@encode/tools'
import type { ConfigSnapshot, WorkspaceConfig } from './config'
import type { WorkspaceFs } from './fs'
import { sandboxReport, withMarks, type SandboxReport } from './sandbox-report'

/**
 * What the Sandbox screen can do: change one of the switches in the person's own settings, ask the machine again, take
 * the marks off folders, or fix a folder the system did not let the sandbox prepare (ADR 0118).
 */
export type SandboxAction = ({ type: 'set' } & SandboxChange) | { type: 'recheck' } | { type: 'unmark'; folders?: string[] } | { type: 'fix'; folder: string }

/** The sandbox as it stands after the action, with what happened in words. */
export type SandboxOutcome =
  | { ok: true; report: SandboxReport; note?: string }
  | { ok: false; reason: string; report: SandboxReport }

/** Checks an action that came from a screen; the types are not trusted. Returns the reason it is refused, or null. */
export function sandboxActionProblem(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'That is not an action.'
  const given = action as Record<string, unknown>
  if (given.type === 'recheck') return null
  if (given.type === 'fix') {
    const { folder } = given
    return typeof folder === 'string' && folder.length > 0 && folder.length <= 4096 ? null : 'Name the folder to fix.'
  }
  if (given.type === 'unmark') {
    const { folders } = given
    if (folders === undefined) return null
    return Array.isArray(folders) && folders.length <= 500 && folders.every((folder) => typeof folder === 'string' && folder.length > 0 && folder.length <= 4096) ? null : 'Name the folders to take the marks off.'
  }
  if (given.type !== 'set') return 'That is not an action.'
  return sandboxChangeProblem({ key: given.key, value: given.value })
}

export async function actOnSandbox(
  config: WorkspaceConfig,
  sandbox: Sandbox | undefined,
  action: SandboxAction,
  options: { fs?: WorkspaceFs; platform?: NodeJS.Platform; shell?: (snapshot: ConfigSnapshot) => ShellProgram | undefined } = {},
): Promise<SandboxOutcome> {
  const platform = options.platform ?? process.platform
  const look = async () => {
    const snapshot = await config.refresh()
    return withMarks(sandboxReport(sandbox, snapshot, config.home, platform, options.shell?.(snapshot)), sandbox)
  }
  const refused = async (reason: string): Promise<SandboxOutcome> => ({ ok: false, reason, report: await look() })
  const problem = sandboxActionProblem(action)
  if (problem) return refused(problem)

  if (action.type === 'recheck') {
    if (!sandbox) return refused('This build has no sandbox.')
    await sandbox.refresh()
    return { ok: true, report: await look() }
  }
  if (action.type === 'unmark') {
    if (!sandbox) return refused('This build has no sandbox.')
    let done: string[]
    try {
      done = await sandbox.releaseMarks(action.folders)
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
    const report = await look()
    const again = report.state === 'active' ? ' A folder is marked again the next time the agent runs a command in it.' : ''
    return { ok: true, report, note: done.length ? `Took the marks off ${done.length === 1 ? done[0] : `${done.length} folders`}.${again}` : 'No folder had marks to take off.' }
  }
  if (action.type === 'fix') {
    if (!sandbox) return refused('This build has no sandbox.')
    const settings = resolveSandboxSettings((await config.refresh()).effective.sandbox)
    let fixed: Awaited<ReturnType<Sandbox['fixFolder']>>
    try {
      fixed = await sandbox.fixFolder(action.folder, settings)
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
    if (fixed.ok) {
      const owner = fixed.owner ? ' Windows first had to make the account that said yes its owner.' : ''
      return { ok: true, report: await look(), note: `Your account has Full control of ${action.folder}, and the sandbox has marked it. Commands there run inside the sandbox again.${owner}` }
    }
    if (fixed.cancelled) return { ok: true, report: await look(), note: 'Nothing changed: Windows did not get an administrator’s yes.' }
    return refused(fixed.reason)
  }
  const { type: _type, ...change } = action
  const result = await setSandboxSetting({ change: change as SandboxChange, home: config.home, fs: options.fs ?? config.fileSystem, platform })
  if (!result.ok) return refused(result.reason)
  const report = await look()
  const stuck = overruled(change as SandboxChange, report)
  return { ok: true, report, ...(stuck ? { note: `Saved, but this folder's own settings still decide here: it ${stuck}.` } : {}) }
}

/** What a folder's settings say that outweighs a switch the person just saved (a folder can only tighten), or nothing. */
function overruled(change: SandboxChange, report: SandboxReport): string | undefined {
  const { settings } = report
  switch (change.key) {
    case 'enabled':
      return !change.value && settings.enabled ? 'keeps the sandbox on' : undefined
    case 'required':
      return !change.value && settings.required ? 'requires the sandbox' : undefined
    case 'allowUnsandboxed':
      return change.value && !settings.allowUnsandboxed ? 'does not let a command leave the sandbox' : undefined
    case 'caches':
      return change.value && !settings.caches ? 'keeps the package caches read-only' : undefined
    case 'powershell':
      return !change.value && settings.powershell ? 'runs commands in PowerShell' : undefined
    case 'network':
      return change.value === 'allow' && settings.network === 'block' ? 'blocks the network' : undefined
  }
}
