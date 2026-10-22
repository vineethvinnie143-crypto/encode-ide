import path from 'node:path'
import { assessBashCommand } from './bash-policy'
import type { CommandAssessment } from './command-policy'
import { confirmOnDisk, type DiskProbe } from './disk'
import type { Environment } from './environment'
import { assessPwshCommand } from './pwsh-policy'
import { wordsAsPaths, type RuleSet } from './rules'

/**
 * The judge for agent shell commands, in the shape the agent core takes
 * (ShellCommandAssessor). In order:
 *
 * 1. Deny and ask rules, on the commands of the line and on every word that
 *    could be a path (so `Read(./.env)` also stops `cat .env`).
 * 2. Allow rules, which must cover every command of the line.
 * 3. The read-only check for the line's dialect, finished on disk.
 *
 * Anything else asks, and the approval policy decides what an ask means in
 * the current mode. `source` tells it whether a rule or the read-only check
 * allowed the line, since a mode may honour one and not the other.
 */

export type ShellDialect = 'bash' | 'pwsh'

export interface ShellLineContext {
  root: string
  cwd: string
  home: string
  env: Environment
  dialect: ShellDialect
}

export interface ShellVerdict {
  decision: 'allow' | 'ask' | 'deny'
  /** Short, user-facing. */
  reason: string
  /** What decided: a permission rule, the read-only check, or neither. */
  source: 'rule' | 'read-only' | 'default'
  /** For an allow by a rule: whether the line is also proven read-only, which is all a Read Only policy runs. */
  readOnly?: boolean
  /** Paths the line may read, when the read-only check allowed it. */
  paths?: string[]
  /** Programs the line starts, when the read-only check allowed it. */
  programs?: string[]
}

export interface ShellAssessorOptions {
  /** Rules from every settings source that applies (see @encode/config for trust). */
  rules: RuleSet
  /** Whether the user trusts the workspace; git runs unasked only then. */
  trusted: boolean
  /** Checks the read-only verdict on disk. Without it the verdict stays lexical, for tests. */
  probe?: DiskProbe
  /** Path rules of the machine that runs the line. Defaults to this machine's. */
  platform?: 'win32' | 'posix'
}

export function createShellAssessor(options: ShellAssessorOptions): (line: string, context: ShellLineContext) => Promise<ShellVerdict> {
  const windows = (options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32'
  const api = windows ? path.win32 : path.posix

  return async (line, context) => {
    const command = options.rules.evaluate({ type: 'command', line, cwd: context.cwd, dialect: context.dialect })
    if (command?.decision === 'deny') return { decision: 'deny', reason: command.reason, source: 'rule' }
    const words = wordsAsPaths(line, context.dialect, context.cwd, context.home, windows)
    const reads = options.rules.evaluate({ type: 'read', paths: words })
    const writes = options.rules.evaluate({ type: 'write', paths: words })
    for (const verdict of [reads, writes]) {
      if (verdict?.decision === 'deny') return { decision: 'deny', reason: verdict.reason, source: 'rule' }
    }
    for (const verdict of [command, reads, writes]) {
      if (verdict?.decision === 'ask') return { decision: 'ask', reason: verdict.reason, source: 'rule' }
    }

    const lineContext = { ...context, platform: windows ? ('win32' as const) : ('posix' as const), trusted: options.trusted }
    let verdict: CommandAssessment =
      context.dialect === 'pwsh' ? assessPwshCommand(line, lineContext) : assessBashCommand(line, lineContext)
    if (verdict.decision === 'allow' && options.probe) verdict = await confirmOnDisk(verdict, context.root, options.probe, api)
    // A rule says the user wants the line to run; it says nothing about what the line does. A Read Only policy runs
    // only what is proven, so the proof travels with the rule's verdict.
    if (command?.decision === 'allow') return { decision: 'allow', reason: command.reason, source: 'rule', readOnly: verdict.decision === 'allow' }
    if (verdict.decision === 'allow') {
      return { decision: 'allow', reason: 'read-only', source: 'read-only', paths: verdict.paths, programs: verdict.programs }
    }
    return { decision: 'ask', reason: verdict.reason, source: 'default' }
  }
}
