import path from 'node:path'
import { assessCommand, checkFetchUrl, isInside, isProtectedPath } from '@encode/permissions'
import type { AgentMode, ApprovalPolicy } from '../../shared/types'
import { isInsideReal, realPathOf } from '../services/real-path'
import { locateProgram } from '../services/shell'

/**
 * Whether a tool call needs the user's approval before it runs. Policies:
 *
 * - Read Only: nothing asks; edits and commands are refused when they run.
 * - Workspace Write: edits run unasked, every command asks.
 * - Auto review: like Workspace Write, but commands the command policy proves
 *   read-only (and whose paths and programs check out on disk) run unasked.
 * - Full access: nothing asks.
 *
 * Under every policy but Full access, writes into protected directories
 * (.git, .eNCode) ask, because they can make tools run code or steer later
 * turns, and the first web fetch from each site in a session asks, because a
 * URL can carry data out. Ask and Plan modes never run edits or commands.
 */

export type ToolKind = 'write' | 'command' | 'web' | 'other'

const TOOL_KINDS: Record<string, ToolKind> = {
  write: 'write',
  write_file: 'write',
  edit: 'write',
  replace_in_file: 'write',
  pwsh: 'command',
  run_command: 'command',
  web_fetch: 'web',
}

export function toolKind(name: string): ToolKind {
  return Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name] : 'other'
}

export interface ApprovalContext {
  mode: AgentMode
  policy: ApprovalPolicy
  /** Workspace root as opened. */
  root: string
  /** Workspace root with links resolved. */
  rootReal: string
  /** Environment commands run with, for PATH lookups. */
  env: Record<string, string>
  home: string
  /** Sites the user already let web_fetch reach in this session. */
  approvedHosts: ReadonlySet<string>
}

export interface ApprovalDecision {
  ask: boolean
  /** Why approval is needed, shown on the approval card. */
  reason?: string
}

const RUN: ApprovalDecision = { ask: false }

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Same confinement as WorkspaceService.resolve; null when the path leaves the root. */
function resolveInRoot(root: string, relative: string): string | null {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  const absolute = path.resolve(root, cleaned)
  return isInside(root, absolute, path) ? absolute : null
}

async function protectedTarget(relative: string, context: ApprovalContext): Promise<boolean> {
  if (isProtectedPath(relative)) return true
  const absolute = resolveInRoot(context.root, relative)
  if (!absolute) return false
  // Catch spellings that only resolve to .git on disk, such as Windows short names (GIT~1).
  const real = await realPathOf(absolute)
  return isProtectedPath(path.relative(context.rootReal, real))
}

async function assessCommandCall(input: Record<string, unknown>, context: ApprovalContext): Promise<ApprovalDecision> {
  const command = asString(input.command).trim()
  const cwdInput = asString(input.cwd).trim()
  const cwd = cwdInput ? resolveInRoot(context.root, cwdInput) : context.root
  if (!cwd) return { ask: true, reason: 'Its working directory is outside the workspace.' }

  const verdict = assessCommand(command, { root: context.root, cwd, home: context.home })
  if (verdict.decision === 'ask') return { ask: true, reason: `Auto review asks because it ${verdict.reason}.` }

  for (const target of verdict.paths) {
    if (!(await isInsideReal(context.rootReal, target))) {
      return { ask: true, reason: `Auto review asks because ${path.relative(context.root, target)} leads outside the workspace.` }
    }
  }
  for (const program of verdict.programs) {
    for (const file of locateProgram(program, cwd, context.env)) {
      if (!path.isAbsolute(file) || (await isInsideReal(context.rootReal, file))) {
        return { ask: true, reason: `Auto review asks because ${program} would run from inside the workspace.` }
      }
    }
  }
  return RUN
}

/** The site a web_fetch call would contact, as remembered for the session; null for URLs the tool refuses anyway. */
export function fetchHost(input: Record<string, unknown>): string | null {
  const checked = checkFetchUrl(asString(input.url))
  return checked.ok ? checked.host : null
}

export async function decideApproval(
  tool: string,
  input: Record<string, unknown>,
  context: ApprovalContext,
): Promise<ApprovalDecision> {
  if (context.policy === 'full-access') return RUN
  if (toolKind(tool) === 'web') {
    // Any mode and policy: what the agent puts in a URL leaves the machine.
    const host = fetchHost(input)
    if (!host || context.approvedHosts.has(host)) return RUN
    return {
      ask: true,
      reason: `eNCode asks before the agent contacts a site for the first time in a session, because anything in the address leaves your machine. Approving allows ${host} until the session ends.`,
    }
  }
  if (context.mode !== 'code') return RUN
  if (context.policy === 'read-only') return RUN

  switch (toolKind(tool)) {
    case 'write': {
      const target = asString(input.path).trim()
      if (target && (await protectedTarget(target, context))) {
        return { ask: true, reason: `${target} is in a protected folder: changes there can run code or steer the agent.` }
      }
      return RUN
    }
    case 'command':
      if (context.policy === 'workspace-write') return { ask: true, reason: 'Workspace Write asks before every command.' }
      return await assessCommandCall(input, context)
    default:
      return RUN
  }
}
