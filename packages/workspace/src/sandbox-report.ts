import path from 'node:path'
import { settingsFiles } from '@encode/config'
import { resolveSandboxSettings, type EngineLimits, type EngineName, type Sandbox, type SandboxSettings } from '@encode/sandbox'
import type { ConfigSnapshot } from './config'

/** How the sandbox around the agent's commands stands in one folder, for the Sandbox screen. */
export interface SandboxReport {
  /** `active`: commands are confined. `off`: the settings turn it off. `unavailable`: this machine cannot run it. */
  state: 'active' | 'off' | 'unavailable'
  engine?: EngineName
  /** Why it is off or unavailable, in words for the person. */
  reason?: string
  /** What this engine can hold back, so the screen can say what is not covered here. */
  limits?: EngineLimits
  /** What applies in this folder: the person's own settings, tightened by the folder's. */
  settings: Pick<SandboxSettings, 'enabled' | 'required' | 'allowUnsandboxed' | 'caches' | 'allowWrite' | 'denyWrite' | 'denyRead' | 'allowRead'> & { network: 'allow' | 'block' }
  /** What the folder's own files made stricter than the person's settings, in words. */
  tightened: string[]
  /** What was wrong in the settings files, in words. */
  problems: string[]
  /** What is being prepared right now ("Preparing C:\\work for the sandbox"), when something is. */
  working?: string
  /** The person's own settings file, where the switches are saved. */
  file: string
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function sandboxReport(sandbox: Sandbox | undefined, snapshot: ConfigSnapshot, home: string, platform: NodeJS.Platform): SandboxReport {
  const sources = snapshot.effective.sandbox
  const all = resolveSandboxSettings(sources)
  const own = resolveSandboxSettings(sources.filter((source) => source.scope === 'user' || source.scope === 'cli'))
  const tightened: string[] = []
  if (all.required && !own.required) tightened.push("This folder's settings require the sandbox: commands do not run without it.")
  if (!all.allowUnsandboxed && own.allowUnsandboxed) tightened.push("This folder's settings do not let a command leave the sandbox.")
  if (!all.network && own.network) tightened.push("This folder's settings block the network for commands.")
  if (!all.caches && own.caches) tightened.push("This folder's settings keep the package caches read-only.")
  if (all.denyWrite.length > own.denyWrite.length) tightened.push(`This folder's settings keep ${plural(all.denyWrite.length - own.denyWrite.length, 'more path', 'more paths')} read-only.`)
  if (all.denyRead.length > own.denyRead.length) tightened.push(`This folder's settings hide ${plural(all.denyRead.length - own.denyRead.length, 'more path', 'more paths')} from commands.`)

  const status = sandbox?.status()
  let state: SandboxReport['state']
  let reason: string | undefined
  if (!all.enabled) {
    state = 'off'
    reason = 'The sandbox is turned off in the settings.'
  } else if (!sandbox || !status || status.state !== 'active') {
    state = 'unavailable'
    reason = status?.reason ?? 'This build has no sandbox.'
  } else {
    state = 'active'
  }
  const working = sandbox?.working()
  return {
    state,
    ...(status?.engine ? { engine: status.engine } : {}),
    ...(reason ? { reason } : {}),
    ...(status?.limits ? { limits: status.limits } : {}),
    settings: {
      enabled: all.enabled,
      required: all.required,
      allowUnsandboxed: all.allowUnsandboxed,
      caches: all.caches,
      network: all.network ? 'allow' : 'block',
      allowWrite: all.allowWrite,
      denyWrite: all.denyWrite,
      denyRead: all.denyRead,
      allowRead: all.allowRead,
    },
    tightened,
    problems: all.problems,
    ...(working ? { working } : {}),
    file: settingsFiles(home, '', platform === 'win32' ? path.win32 : path.posix).user,
  }
}
