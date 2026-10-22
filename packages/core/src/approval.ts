/**
 * Whether a tool call needs the user's approval before it runs, judged from
 * what the call would touch (`ToolAccess`) and never from the tool's name.
 *
 * Policies:
 * - Read Only: reads, and commands the assessor proves read-only; nothing
 *   else runs and nothing asks.
 * - Workspace Write: edits inside the workspace run unasked, every command
 *   asks.
 * - Auto review: like Workspace Write, but commands the assessor proves
 *   read-only run unasked.
 * - Full access: nothing asks. The assessor's `deny` still holds: a rule the
 *   user wrote must not stop applying because a policy is permissive.
 *
 * Under every policy but Full access, writes into protected directories ask
 * (they can make tools run code or steer later turns), as does touching
 * anything outside the workspace, the first fetch from each site in a
 * session (a URL can carry data out) and the first use of each application
 * on the desktop (the mouse and keyboard reach anything the user can).
 * Applications the Computer tool never operates are refused under every
 * policy, like a deny rule.
 *
 * A command that asks to run outside the sandbox (`unsandboxed`) is the
 * person's to allow, under every policy including Full access: the sandbox is
 * what bounds a command that was approved, or never asked about, and a
 * command must not be able to lift it for itself. No rule, no Always allow
 * and no Reviewer answers that question; the settings can refuse it outright.
 *
 * The user's permission rules (settings files, `@encode/permissions`) come in
 * three places, always in this order: a deny rule refuses under every policy;
 * a policy that denies (Read Only) or that never asks (Full access) is not
 * changed by an ask rule; an allow rule skips the question the policy would
 * have asked, except where the question guards something a rule cannot vouch
 * for (protected folders, a Read Only policy, desktop applications).
 */
import path from 'node:path'
import { assessCommand, checkFetchUrl, isGuardedPath, isProtectedPath, suggestRule, type RuleQuery, type RuleSuggestion, type RuleVerdict } from '@encode/permissions'
import type { ShellAssessment, ShellCommandAssessor, ShellState, ToolAccess } from '@encode/tools'
import { classifyApp, isInsideReal, realPathOf, searchPath, toPosix } from '@encode/tools'
import type { ApprovalPolicy } from './ui'

export type ApprovalDecision =
  | { kind: 'allow' }
  /**
   * `grantable`: the user may approve this and its like for the rest of the session. Protected folders never are.
   * `byRule`: a rule of the user's says to ask, so no rule of theirs could stop the question (an allow rule loses
   * to it) and approving covers this call only.
   * `reviewable`: under Auto review the Reviewer may answer it, after the safety floor has passed it. Only a command
   * the assessor could not prove read-only is; every other question (outside the workspace, protected folders, sites,
   * outside tools, applications, a user's own rule) is the person's alone.
   */
  | { kind: 'ask'; reason: string; grantable: boolean; byRule?: true; reviewable?: true }
  | { kind: 'deny'; reason: string }

/** What decisions ask of the user's permission rules; a `RuleSet` is one. */
export interface RuleJudge {
  evaluate(query: RuleQuery): RuleVerdict | null
}

/** A judge of rules and an assessor of shell lines that refuse everything and say why: for a folder whose settings cannot be relied on. */
export function refuseEverything(reason: string): { rules: RuleJudge; assessor: ShellCommandAssessor } {
  return {
    assessor: async () => ({ decision: 'deny', reason }),
    rules: { evaluate: () => ({ decision: 'deny', reason, rule: { behavior: 'deny', tool: '*', source: 'managed', text: '*' } }) },
  }
}

export interface ApprovalContext {
  policy: ApprovalPolicy
  /** The workspace root, as a real path. */
  root: string
  home: string
  platform: NodeJS.Platform
  /** Real paths of directories read without asking, besides the workspace: skills, memory files. */
  readRoots?: readonly string[]
  /**
   * The user's rules for reads, edits, sites, outside tools and tools by name. Shell lines are judged by the
   * assessor, which holds the same rules (so a Bash rule and the read-only check are weighed together).
   */
  rules?: RuleJudge
  /** Folders outside the workspace the user listed as part of it: read and edited as if inside it. */
  extraRoots?: readonly string[]
  /** The tool being called, for rules that name a tool: `WebSearch`, `Skill(deploy)`, `Task(reviewer)`. */
  tool?: { name: string; specifier?: string }
  /** Sites the user already let the agent contact in this session. */
  approvedHosts: ReadonlySet<string>
  /** Applications the user already let the agent use in this session, by program name. */
  approvedApps: ReadonlySet<string>
  shell: ShellState
  assessor: ShellCommandAssessor
}

const ALLOW: ApprovalDecision = { kind: 'allow' }
const ask = (reason: string, grantable = true): ApprovalDecision => ({ kind: 'ask', reason, grantable })
const askByRule = (reason: string): ApprovalDecision => ({ kind: 'ask', reason, grantable: false, byRule: true })
const askReviewable = (reason: string): ApprovalDecision => ({ kind: 'ask', reason, grantable: true, reviewable: true })
const deny = (reason: string): ApprovalDecision => ({ kind: 'deny', reason })

function shown(file: string, root: string): string {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? toPosix(relative) : file
}

async function outsideWorkspace(paths: readonly string[], context: ApprovalContext, extraRoots: readonly string[] = []): Promise<string | undefined> {
  for (const target of paths) {
    if (await isInsideReal(context.root, target)) continue
    let covered = false
    for (const extra of extraRoots) if (await isInsideReal(extra, target)) covered = true
    if (!covered) return target
  }
  return undefined
}

async function protectedTarget(paths: readonly string[], context: ApprovalContext): Promise<string | undefined> {
  for (const target of paths) {
    if (isGuardedPath(path.relative(context.root, target))) return target
    // Spellings that only resolve to .git on disk, such as Windows short names (GIT~1).
    const real = await realPathOf(target)
    if (isGuardedPath(path.relative(context.root, real))) return target
  }
  return undefined
}

/** The site a call would contact, as remembered for the session; null for addresses the tool refuses anyway. */
export function hostOf(url: string): string | null {
  const checked = checkFetchUrl(url)
  return checked.ok ? checked.host : null
}

/**
 * What the policy and the user's rules make of one call. Rules that name the tool (`WebSearch`, `Skill(deploy)`) are
 * weighed after the call's own access: a deny refuses, an ask asks where the policy would have run it, and an allow
 * answers only the question of a first visit to a site.
 */
export async function decideApproval(access: ToolAccess, context: ApprovalContext): Promise<ApprovalDecision> {
  const decided = await decideAccess(access, context)
  const named = context.tool && context.rules ? context.rules.evaluate({ type: 'tool', tool: context.tool.name, ...(context.tool.specifier !== undefined ? { specifier: context.tool.specifier } : {}) }) : null
  if (!named) return decided
  if (named.decision === 'deny') return deny(named.reason)
  if (decided.kind === 'deny') return decided
  if (named.decision === 'ask') return decided.kind === 'allow' && context.policy !== 'full-access' ? askByRule(named.reason) : decided
  return decided.kind === 'ask' && access.type === 'web' && !decided.byRule ? ALLOW : decided
}

async function decideAccess(access: ToolAccess, context: ApprovalContext): Promise<ApprovalDecision> {
  const { policy, rules } = context
  switch (access.type) {
    case 'none':
    case 'agent':
      return ALLOW

    case 'read': {
      const verdict = rules?.evaluate({ type: 'read', paths: access.paths })
      if (verdict?.decision === 'deny') return deny(verdict.reason)
      if (policy === 'full-access') return ALLOW
      if (verdict?.decision === 'ask') return askByRule(verdict.reason)
      if (verdict?.decision === 'allow') return ALLOW
      const outside = await outsideWorkspace(access.paths, context, [...(context.readRoots ?? []), ...(context.extraRoots ?? [])])
      return outside ? ask(`${shown(outside, context.root)} is outside the workspace, and what the agent reads is sent to the model.`) : ALLOW
    }

    case 'write': {
      const verdict = rules?.evaluate({ type: 'write', paths: access.paths })
      if (verdict?.decision === 'deny') return deny(verdict.reason)
      if (policy === 'full-access') return ALLOW
      if (policy === 'read-only') return deny('The approval policy is Read Only, so eNCode does not change files. Ask the user to switch to Workspace Write.')
      // A protected folder is asked about whatever a rule says: a rule cannot vouch for what could run code later.
      const guarded = await protectedTarget(access.paths, context)
      if (guarded) {
        const folder = isProtectedPath(path.relative(context.root, guarded))
        return ask(`${shown(guarded, context.root)} ${folder ? 'is in a protected folder' : 'is a protected file'}: changes there can run code or steer the agent.`, false)
      }
      if (verdict?.decision === 'ask') return askByRule(verdict.reason)
      if (verdict?.decision === 'allow') return ALLOW
      const outside = await outsideWorkspace(access.paths, context, context.extraRoots)
      return outside ? ask(`${shown(outside, context.root)} is outside the workspace.`) : ALLOW
    }

    case 'command': {
      const verdict = await context.assessor(access.command, {
        root: context.root,
        cwd: access.cwd,
        home: context.home,
        env: context.shell.env,
        dialect: context.shell.dialect,
      })
      if (verdict.decision === 'deny') return deny(verdict.reason)
      if (access.unsandboxed && context.shell.sandbox?.active) {
        if (policy === 'read-only') return deny('The approval policy is Read Only, which keeps every command in the sandbox. Ask the user to switch to Workspace Write if the command is needed.')
        if (!context.shell.sandbox.allowUnsandboxed) return deny('The settings do not let commands run outside the sandbox.')
        return ask('This command asks to run outside the sandbox, which is what limits what a command can change. Only you can allow that.')
      }
      if (policy === 'full-access') return ALLOW
      const byRule = verdict.source === 'rule'
      if (policy === 'read-only') {
        // A rule that allows a line says the user wants it to run, not that it changes nothing.
        const proven = verdict.decision === 'allow' && (!byRule || verdict.readOnly === true)
        return proven
          ? ALLOW
          : deny(`The approval policy is Read Only, which runs only commands proven read-only. ${verdict.reason} Ask the user to switch to Workspace Write if the command is needed.`)
      }
      if (verdict.decision === 'ask') {
        if (byRule) return askByRule(verdict.reason)
        return policy === 'auto-review' ? askReviewable(verdict.reason) : ask(verdict.reason)
      }
      if (byRule) return ALLOW
      return policy === 'workspace-write' ? ask('Workspace Write asks before every command.') : ALLOW
    }

    case 'web': {
      const verdict = rules?.evaluate({ type: 'web', url: access.url })
      if (verdict?.decision === 'deny') return deny(verdict.reason)
      if (policy === 'full-access') return ALLOW
      if (verdict?.decision === 'ask') return askByRule(verdict.reason)
      if (verdict?.decision === 'allow') return ALLOW
      const host = hostOf(access.url)
      if (!host || context.approvedHosts.has(host)) return ALLOW
      return ask(
        `eNCode asks before the agent contacts a site for the first time in a session, because anything in the address leaves your machine. Approving allows ${host} until the session ends.`,
        false,
      )
    }

    case 'external': {
      const verdict = rules?.evaluate({ type: 'mcp', server: access.server, tool: access.tool ?? '' })
      if (verdict?.decision === 'deny') return deny(verdict.reason)
      if (policy === 'full-access') return ALLOW
      if (verdict?.decision === 'ask') return askByRule(verdict.reason)
      if (verdict?.decision === 'allow') return ALLOW
      return ask(`${access.server} is an outside tool server, and eNCode cannot tell what its tools change.`, false)
    }

    case 'desktop': {
      if (access.blocked) return deny(`${access.label} is never used: ${access.blocked}.`)
      if (policy === 'read-only') return deny('The approval policy is Read Only, so eNCode does not use the mouse or the keyboard. Ask the user to switch to Workspace Write.')
      if (policy === 'full-access' || context.approvedApps.has(access.app)) return ALLOW
      const caution = classifyApp(access.app).caution
      return ask(
        `eNCode asks before the agent uses an application for the first time in a session, because it can click and type anywhere in it. Approving allows ${access.label} until the session ends.${caution ? ` ${caution}` : ''}`,
        false,
      )
    }
  }
}

/**
 * The rule "Always allow" would save for a call the user is asked about: the narrowest one that would have allowed
 * it, or null when no rule could say what the call does (or when the question cannot be answered by a rule).
 */
export function alwaysAllowFor(access: ToolAccess, context: { root: string; platform: NodeJS.Platform; dialect: 'bash' | 'pwsh' }): RuleSuggestion | null {
  const windows = context.platform === 'win32'
  switch (access.type) {
    case 'command':
      // A rule lets a line run; it does not lift the sandbox, so there is nothing to remember for a call that asks to.
      return access.unsandboxed ? null : suggestRule({ type: 'command', line: access.command, dialect: context.dialect })
    case 'write':
      return access.paths.length === 1 ? suggestRule({ type: 'edit', path: access.paths[0], root: context.root, windows }) : null
    case 'read':
      return access.paths.length === 1 ? suggestRule({ type: 'read', path: access.paths[0], root: context.root, windows }) : null
    case 'web':
      return suggestRule({ type: 'web', url: access.url })
    case 'external':
      return access.tool ? suggestRule({ type: 'mcp', server: access.server, tool: access.tool }) : null
    default:
      return null
  }
}

/**
 * What approving "for this session" would cover: the same paths, or the same
 * command in the same directory. Anything else is asked each time.
 */
export function grantKey(access: ToolAccess): string | undefined {
  switch (access.type) {
    case 'read':
    case 'write':
      return access.paths.length ? `${access.type}\u0000${[...access.paths].sort().join('\u0000')}` : undefined
    case 'command':
      return `${access.unsandboxed ? 'command-outside-sandbox' : 'command'}\u0000${access.cwd}\u0000${access.command.replace(/\s+/g, ' ').trim()}`
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- the interim command assessor

/**
 * Plain words joined by `;`, `&&`, `||` and `|`: no quotes, expansion, globs,
 * redirects, substitution, backgrounding, comments or line breaks. A line like
 * that means the same in bash and in eNCode's own command grammar, so the
 * command policy can judge it. Anything else asks until the permissions work
 * covers bash's full grammar.
 */
const PLAIN_LINE = /^[A-Za-z0-9_./:=@%+,\-\\ \t]+(?:\s*(?:;|&&|\|\||\|)\s*[A-Za-z0-9_./:=@%+,\-\\ \t]+)*$/

export function isPlainCommandLine(line: string): boolean {
  return PLAIN_LINE.test(line.trim())
}

/** Where a program a line starts would come from, or null when the shell will not find one. */
function locate(program: string, cwd: string, env: Record<string, string>, platform: NodeJS.Platform): string | null {
  if (/[\\/]/.test(program)) return path.resolve(cwd, program)
  return searchPath(program, env, platform)
}

/**
 * The assessor core uses until the permissions work supplies bash's grammar:
 * it proves a line read-only only when the line is plain words the command
 * policy understands, no path leaves the workspace and no program would run
 * from inside it. Everything else asks.
 */
export function createDefaultAssessor(platform: NodeJS.Platform = process.platform): ShellCommandAssessor {
  return async (line, context): Promise<ShellAssessment> => {
    if (context.dialect !== 'bash') return { decision: 'ask', reason: 'PowerShell commands are not checked automatically yet.' }
    if (!isPlainCommandLine(line)) return { decision: 'ask', reason: 'The command uses shell syntax that is not checked automatically yet.' }

    const verdict = assessCommand(line, { root: context.root, cwd: context.cwd, home: context.home, platform: platform === 'win32' ? 'win32' : 'posix' })
    if (verdict.decision === 'ask') {
      return { decision: 'ask', reason: `Not proven read-only: the command ${verdict.reason}.`, paths: verdict.paths, programs: verdict.programs }
    }

    for (const target of verdict.paths) {
      if (!(await isInsideReal(context.root, target))) {
        return { decision: 'ask', reason: `Not proven read-only: ${shown(target, context.root)} leads outside the workspace.`, paths: verdict.paths }
      }
    }
    for (const program of verdict.programs) {
      const file = locate(program, context.cwd, context.env, platform)
      if (file && (await isInsideReal(context.root, file))) {
        return { decision: 'ask', reason: `Not proven read-only: ${program} would run from inside the workspace.`, programs: verdict.programs }
      }
    }
    return { decision: 'allow', reason: verdict.reason, paths: verdict.paths, programs: verdict.programs }
  }
}
