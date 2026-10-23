/**
 * EnterWorktree and ExitWorktree, as in Claude Code: the agent can do its work in a git worktree of the project, on a
 * branch of its own, apart from the checkout the user works in. The worktree lives inside the project, at
 * `.encode-worktrees/<name>`, so the workspace's rules and sandbox cover it as they cover the project. It is not under
 * `.encode`, which is a protected folder: every write there would ask, and the sandbox keeps commands out of it. The
 * session does the git work (`Worktrees`); these tools only ask for it.
 */
import path from 'node:path'
import { fail } from './files'
import type { Tool, ToolContext, WorktreeWork } from './types'

/** Where the project's worktrees are, relative to its root. */
export const WORKTREES_DIR = '.encode-worktrees'
/** The branch of a worktree is `encode/<name>`. */
export const WORKTREE_BRANCH_PREFIX = 'encode/'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** True for a worktree name that is one plain path segment and a valid branch name. */
export function validWorktreeName(name: string): boolean {
  return NAME.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock')
}

function worktreePath(ctx: ToolContext, name: string): string {
  return path.join(ctx.root, WORKTREES_DIR, name)
}

/** "3 changed files (a.ts, b.ts, c.ts) and 2 commits only on its branch". */
export function describeWork(work: WorktreeWork): string {
  const files = work.changed.length
    ? `${work.changed.length} changed ${work.changed.length === 1 ? 'file' : 'files'} not committed (${work.changed.slice(0, 5).join(', ')}${work.changed.length > 5 ? ', ...' : ''})`
    : ''
  const commits = work.commits ? `${work.commits} ${work.commits === 1 ? 'commit' : 'commits'} only on its branch` : ''
  return [files, commits].filter(Boolean).join(' and ')
}

// ---------------------------------------------------------------------------
// EnterWorktree

interface EnterWorktreeInput extends Record<string, unknown> {
  name?: string
}

export const enterWorktreeTool: Tool<EnterWorktreeInput> = {
  definition: {
    name: 'EnterWorktree',
    description: [
      'Creates a git worktree of the project at .encode-worktrees/<name>, on a new branch encode/<name> from the current commit, and moves you into it: relative paths, Glob, Grep and Bash then start there, and the checkout the user works in is left alone.',
      '',
      '- Use it only when the user asks for a worktree, or for work kept apart from their checkout.',
      '- Commit your work on the branch. ExitWorktree takes you back to the project and keeps or removes the worktree.',
      '- name: letters, digits, dots, dashes and underscores. Without one, a name is made up.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 64, description: 'The worktree and its branch are named after it.' },
      },
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: false,
  defer: 'always',
  check(input) {
    const name = input.name?.trim()
    if (name && !validWorktreeName(name)) return 'name must start with a letter or digit and hold only letters, digits, dots, dashes and underscores (at most 64).'
    return undefined
  },
  access(input, ctx) {
    const name = input.name?.trim() || '<name>'
    return { type: 'command', command: `git worktree add -b ${WORKTREE_BRANCH_PREFIX}${name} ${path.join(WORKTREES_DIR, name)} HEAD`, cwd: ctx.root, background: false }
  },
  describe: (input) => ({ title: input.name?.trim() ? `Enter worktree ${input.name.trim()}` : 'Enter a new worktree' }),
  async run(input, ctx) {
    if (!ctx.worktrees) return fail('Worktrees are not available here: the project is not a git repository, or this agent works where the main agent works.')
    if (ctx.worktrees.current()) return fail(`You already work in the worktree ${ctx.worktrees.current()!.name}. ExitWorktree first.`)
    const entered = await ctx.worktrees.enter({ ...(input.name?.trim() ? { name: input.name.trim() } : {}) }, ctx.signal)
    if (!entered.ok) return fail(entered.reason)
    const { worktree } = entered
    const where = path.relative(ctx.root, worktree.path).split(path.sep).join('/')
    return {
      ok: true,
      content: [
        `You now work in the worktree ${where} (${worktree.path}), on branch ${worktree.branch} from ${worktree.base.slice(0, 10)}${worktree.from ? `, which ${worktree.from} was on` : ''}.`,
        'Relative paths, Glob, Grep and Bash start there; the user\'s checkout is untouched. Commit your work on the branch, then ExitWorktree.',
      ].join('\n'),
      display: { output: `${where} on ${worktree.branch}` },
    }
  },
}

// ---------------------------------------------------------------------------
// ExitWorktree

interface ExitWorktreeInput extends Record<string, unknown> {
  action: 'keep' | 'remove'
  discard_changes?: boolean
}

export const exitWorktreeTool: Tool<ExitWorktreeInput> = {
  definition: {
    name: 'ExitWorktree',
    description: [
      'Leaves the worktree you entered with EnterWorktree and takes you back to the project folder.',
      '',
      '- action keep: the folder and its branch stay, for the user to look at or merge.',
      '- action remove: both are deleted. It refuses while the worktree has changes not committed or commits only on its branch; discard_changes true deletes them anyway, so ask the user first.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['keep', 'remove'] },
        discard_changes: { type: 'boolean', description: 'With remove: delete work that is not merged anywhere.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: false,
  defer: 'always',
  access(input, ctx) {
    const current = ctx.worktrees?.current()
    if (input.action !== 'remove' || !current) return { type: 'none' }
    const force = input.discard_changes ? ' --force' : ''
    return {
      type: 'command',
      command: `git worktree remove${force} ${path.relative(ctx.root, current.path) || worktreePath(ctx, current.name)} && git branch -D ${current.branch}`,
      cwd: ctx.root,
      background: false,
    }
  },
  describe: (input, ctx) => {
    const name = ctx.worktrees?.current()?.name ?? 'the worktree'
    return { title: input.action === 'remove' ? `Remove worktree ${name}${input.discard_changes ? ', discarding its work' : ''}` : `Leave worktree ${name}` }
  },
  async run(input, ctx) {
    if (!ctx.worktrees?.current()) return fail('You are not in a worktree. EnterWorktree creates one.')
    const left = await ctx.worktrees.exit({ action: input.action, discard: Boolean(input.discard_changes) }, ctx.signal)
    if (!left.ok) {
      if (!left.work) return fail(left.reason)
      return fail(`${left.reason} It has ${describeWork(left.work)}. Commit and merge what should stay, keep the worktree, or ask the user before you remove it with discard_changes true.`)
    }
    const where = path.relative(ctx.root, left.left.path).split(path.sep).join('/')
    return {
      ok: true,
      content: left.removed
        ? `Removed the worktree ${where} and its branch ${left.left.branch}. You work in the project folder again.`
        : `Left the worktree ${where}; it stays, with its branch ${left.left.branch}. You work in the project folder again.`,
    }
  },
}
