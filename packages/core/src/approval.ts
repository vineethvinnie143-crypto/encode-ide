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
 * anything outside the workspace, and the first fetch from each site in a
 * session (a URL can carry data out).
 */
import path from 'node:path'
import { assessCommand, checkFetchUrl, isProtectedPath } from '@encode/permissions'
import type { ShellAssessment, ShellCommandAssessor, ShellState, ToolAccess } from '@encode/tools'
import { isInsideReal, realPathOf, searchPath, toPosix } from '@encode/tools'
import type { ApprovalPolicy } from './ui'

export type ApprovalDecision =
  | { kind: 'allow' }
  /** `grantable`: the user may approve this and its like for the rest of the session. Protected folders never are. */
  | { kind: 'ask'; reason: string; grantable: boolean }
  | { kind: 'deny'; reason: string }

export interface ApprovalContext {
  policy: ApprovalPolicy
  /** The workspace root, as a real path. */
  root: string
  home: string
  platform: NodeJS.Platform
  /** Real paths of directories read without asking, besides the workspace: skills, memory files. */
  readRoots?: readonly string[]
  /** Sites the user already let the agent contact in this session. */
  approvedHosts: ReadonlySet<string>
  shell: ShellState
  assessor: ShellCommandAssessor
}

const ALLOW: ApprovalDecision = { kind: 'allow' }
const ask = (reason: string, grantable = true): ApprovalDecision => ({ kind: 'ask', reason, grantable })
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
    if (isProtectedPath(path.relative(context.root, target))) return target
    // Spellings that only resolve to .git on disk, such as Windows short names (GIT~1).
    const real = await realPathOf(target)
    if (isProtectedPath(path.relative(context.root, real))) return target
  }
  return undefined
}

/** The site a call would contact, as remembered for the session; null for addresses the tool refuses anyway. */
export function hostOf(url: string): string | null {
  const checked = checkFetchUrl(url)
  return checked.ok ? checked.host : null
}

export async function decideApproval(access: ToolAccess, context: ApprovalContext): Promise<ApprovalDecision> {
  const { policy } = context
  switch (access.type) {
    case 'none':
    case 'agent':
      return ALLOW

    case 'read': {
      if (policy === 'full-access') return ALLOW
      const outside = await outsideWorkspace(access.paths, context, context.readRoots)
      return outside ? ask(`${shown(outside, context.root)} is outside the workspace, and what the agent reads is sent to the model.`) : ALLOW
    }

    case 'write': {
      if (policy === 'full-access') return ALLOW
      if (policy === 'read-only') return deny('The approval policy is Read Only, so eNCode does not change files. Ask the user to switch to Workspace Write.')
      const outside = await outsideWorkspace(access.paths, context)
      if (outside) return ask(`${shown(outside, context.root)} is outside the workspace.`)
      const guarded = await protectedTarget(access.paths, context)
      return guarded ? ask(`${shown(guarded, context.root)} is in a protected folder: changes there can run code or steer the agent.`, false) : ALLOW
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
      if (policy === 'full-access') return ALLOW
      if (policy === 'read-only') {
        return verdict.decision === 'allow'
          ? ALLOW
          : deny(`The approval policy is Read Only, which runs only commands proven read-only. ${verdict.reason} Ask the user to switch to Workspace Write if the command is needed.`)
      }
      if (verdict.decision === 'ask') return ask(verdict.reason)
      return policy === 'workspace-write' ? ask('Workspace Write asks before every command.') : ALLOW
    }

    case 'web': {
      if (policy === 'full-access') return ALLOW
      const host = hostOf(access.url)
      if (!host || context.approvedHosts.has(host)) return ALLOW
      return ask(
        `eNCode asks before the agent contacts a site for the first time in a session, because anything in the address leaves your machine. Approving allows ${host} until the session ends.`,
        false,
      )
    }

    case 'external':
      return policy === 'full-access' ? ALLOW : ask(`${access.server} is an outside tool server, and eNCode cannot tell what its tools change.`, false)
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
      return `command\u0000${access.cwd}\u0000${access.command.replace(/\s+/g, ' ').trim()}`
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
