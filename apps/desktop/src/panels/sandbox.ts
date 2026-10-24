/**
 * What the Sandbox screen says, as data and pure functions so the wording and the rules about what can be changed
 * are unit tested. The component in components/sandbox draws it.
 */
import type { SandboxAction, SandboxReport } from '@shared/types'

export type SandboxTone = 'success' | 'warning' | 'danger'

const ENGINES: Record<NonNullable<SandboxReport['engine']>, string> = {
  bubblewrap: 'Linux namespaces (bubblewrap)',
  seatbelt: 'macOS Seatbelt',
  'integrity-level': 'the low integrity level of Windows',
}

export interface Headline {
  tone: SandboxTone
  title: string
  detail: string
}

/** The one sentence above the switches: is the agent's shell confined, and if not, what that means. */
export function headline(report: SandboxReport): Headline {
  if (report.state === 'active') {
    const through = report.engine ? ENGINES[report.engine] : 'the system’s sandbox'
    return {
      tone: 'success',
      title: 'Commands run in a sandbox',
      detail: `Through ${through}. A command can change files only in this folder, the git folders of its worktrees and a temp folder of its own.`,
    }
  }
  if (report.state === 'off') {
    return { tone: 'warning', title: 'The sandbox is off', detail: 'Commands run with everything you can do on this computer. Turn it on below.' }
  }
  // The sandbox itself works; the shell the agent uses is one it cannot confine.
  if (report.shell?.unsupported) {
    const offer = report.engine === 'integrity-level' ? ' Turn on “Run commands in PowerShell” below to confine them.' : ''
    return report.settings.required
      ? { tone: 'danger', title: `${report.shell.name} cannot run in the sandbox, so no command runs`, detail: `${report.shell.unsupported} The settings require the sandbox.${offer}` }
      : { tone: 'warning', title: `${report.shell.name} cannot run in the sandbox`, detail: `${report.shell.unsupported} Commands run with everything you can do on this computer.${offer}` }
  }
  const reason = report.reason ?? 'It did not pass its test.'
  return report.settings.required
    ? { tone: 'danger', title: 'The sandbox cannot start, so no command runs', detail: `${reason} The settings require it. Fix that, or stop requiring it below.` }
    : { tone: 'warning', title: 'This computer cannot run the sandbox', detail: `${reason} Commands run with everything you can do on this computer.` }
}

/** What this system's sandbox does not hold back, said plainly. Empty where it holds everything the screen promises. */
export function limitLines(report: SandboxReport): string[] {
  if (report.state !== 'active' || !report.limits) return []
  const lines: string[] = []
  if (!report.limits.reads) lines.push('Commands can still read any file you can, such as your SSH keys. The sandbox limits what they change.')
  if (!report.limits.network) lines.push('Commands can still use the network. This system cannot block it for them.')
  if (!report.limits.processes) lines.push('Commands can still end other programs you run. The sandbox limits what they change, not what they stop.')
  if (report.limits.protectedPaths === 'best-effort') {
    lines.push('.git/hooks, .git/config, .encode and .mcp.json cannot be written by a command, but one that owns the folder around them could delete and recreate them.')
  }
  return lines
}

export type SwitchKey = 'enabled' | 'required' | 'allowUnsandboxed' | 'network' | 'caches' | 'powershell'

export interface SwitchRow {
  key: SwitchKey
  label: string
  help: string
  checked: boolean
  /** Why it cannot be changed here, when it cannot. */
  locked?: string
}

/** The switches, as they stand: what each says is what turning it on does. */
export function switchRows(report: SandboxReport): SwitchRow[] {
  const { settings, limits } = report
  const windows = report.engine === 'integrity-level'
  return [
    {
      key: 'enabled',
      label: 'Run commands in the sandbox',
      help: 'Applies to every command the agent runs, whatever the approval policy. Turning it off is your choice alone: a project’s settings cannot do it.',
      checked: settings.enabled,
    },
    ...(windows
      ? [
          {
            key: 'powershell' as const,
            label: 'Run commands in PowerShell',
            help: 'Git Bash cannot be confined by the Windows sandbox; PowerShell can. With this on (the default), the agent’s commands run in PowerShell, so the sandbox applies to them. Turned off, they run in Git Bash outside the sandbox. Applies to the conversations you start from now on.',
            checked: settings.powershell,
          },
        ]
      : []),
    {
      key: 'required',
      label: 'Refuse to run commands without it',
      help: 'If the sandbox cannot start on this computer, no command runs, instead of running unconfined.',
      checked: settings.required,
    },
    {
      key: 'allowUnsandboxed',
      label: 'Let a command ask to leave the sandbox',
      help: 'For what a sandbox cannot do, such as git push over SSH. You are asked each time under every approval policy but Full access, which runs them without asking, and no rule, “Always allow” or reviewer can answer for you.',
      checked: settings.allowUnsandboxed,
    },
    {
      key: 'network',
      label: 'Block the network for commands',
      help: 'Installs and downloads fail while this is on; the agent’s own web tools are not affected.',
      checked: settings.network === 'block',
      ...(limits && !limits.network ? { locked: 'This system cannot block the network for commands.' } : {}),
    },
    {
      key: 'caches',
      label: 'Let commands use package caches',
      help: windows
        ? 'npm, pnpm, pip and similar keep their downloads in a cache folder of the sandbox’s own, so installs are not repeated each time.'
        : 'npm, pnpm, pip, cargo and similar keep their downloads in your home folder; this lets commands use them.',
      checked: settings.caches,
    },
  ]
}

/** The action that sets a switch to a value. */
export function actionFor(key: SwitchKey, checked: boolean): SandboxAction {
  if (key === 'network') return { type: 'set', key, value: checked ? 'block' : 'allow' }
  return { type: 'set', key, value: checked }
}

/** "Preparing C:\work for the sandbox", or nothing. */
export function workingLine(report: SandboxReport): string | undefined {
  return report.working || undefined
}
