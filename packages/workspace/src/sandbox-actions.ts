import { sandboxChangeProblem, setSandboxSetting, type SandboxChange } from '@encode/config'
import type { Sandbox } from '@encode/sandbox'
import type { WorkspaceConfig } from './config'
import type { WorkspaceFs } from './fs'
import { sandboxReport, type SandboxReport } from './sandbox-report'

/** What the Sandbox screen can do: change one of the switches in the person's own settings, or ask the machine again. */
export type SandboxAction = ({ type: 'set' } & SandboxChange) | { type: 'recheck' }

/** The sandbox as it stands after the action, with what happened in words. */
export type SandboxOutcome =
  | { ok: true; report: SandboxReport; note?: string }
  | { ok: false; reason: string; report: SandboxReport }

/** Checks an action that came from a screen; the types are not trusted. Returns the reason it is refused, or null. */
export function sandboxActionProblem(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'That is not an action.'
  const given = action as Record<string, unknown>
  if (given.type === 'recheck') return null
  if (given.type !== 'set') return 'That is not an action.'
  return sandboxChangeProblem({ key: given.key, value: given.value })
}

export async function actOnSandbox(
  config: WorkspaceConfig,
  sandbox: Sandbox | undefined,
  action: SandboxAction,
  options: { fs?: WorkspaceFs; platform?: NodeJS.Platform } = {},
): Promise<SandboxOutcome> {
  const platform = options.platform ?? process.platform
  const look = async () => sandboxReport(sandbox, await config.refresh(), config.home, platform)
  const refused = async (reason: string): Promise<SandboxOutcome> => ({ ok: false, reason, report: await look() })
  const problem = sandboxActionProblem(action)
  if (problem) return refused(problem)

  if (action.type === 'recheck') {
    if (!sandbox) return refused('This build has no sandbox.')
    await sandbox.refresh()
    return { ok: true, report: await look() }
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
    case 'network':
      return change.value === 'allow' && settings.network === 'block' ? 'blocks the network' : undefined
  }
}
