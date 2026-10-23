/**
 * The git work behind the agent's worktrees (EnterWorktree, ExitWorktree). eNCode runs it itself with fixed arguments,
 * never as a command line of the agent's, and with hooks off: `git worktree add` runs post-checkout, and a hook folder
 * the project names for itself (husky's `.husky/_`) is one the agent can write, so a hook there would run outside the
 * sandbox. Worktrees live in the project at `.encode-worktrees/<name>`, on a branch `encode/<name>`, and the folder is
 * kept out of the project's own `git status` by a line in the clone's `info/exclude`.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GitError, GitRunner } from './runner'

export const WORKTREE_FOLDER = '.encode-worktrees'
export const WORKTREE_BRANCH_PREFIX = 'encode/'

/** A worktree as the agent core keeps it (the `WorktreeInfo` of @encode/tools). */
export interface WorktreeRecord {
  name: string
  /** The folder, absolute and real. */
  path: string
  branch: string
  /** The commit it started from. */
  base: string
  /** The branch the project was on, when it was on one. */
  from?: string
}

/** What removing a worktree would lose. */
export interface WorktreeChanges {
  /** Files with changes not committed, as git shows them (at most 50). */
  changed: string[]
  /** Commits on its branch that no other branch has. */
  commits: number
}

export interface WorktreeGitOptions {
  /** git by absolute path, or null when there is none; asked at each use, so git installed later is found. */
  git(): string | null
  /** What git starts from. Default: this process's environment. */
  env?: () => Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export interface WorktreeGit {
  unavailable(root: string, signal?: AbortSignal): Promise<string | undefined>
  create(root: string, name: string, signal?: AbortSignal): Promise<WorktreeRecord>
  work(worktree: WorktreeRecord, signal?: AbortSignal): Promise<WorktreeChanges>
  remove(root: string, worktree: WorktreeRecord, options: { force: boolean }, signal?: AbortSignal): Promise<void>
}

const NO_GIT = 'git was not found. Install Git from git-scm.com, then restart eNCode.'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Checking out or removing a large tree takes a while. */
const LONG_MS = 5 * 60_000
const MAX_CHANGED = 50

/** One plain path segment that is also a valid branch name. */
export function isWorktreeName(name: string): boolean {
  return NAME.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock')
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

export function createWorktreeGit(options: WorktreeGitOptions): WorktreeGit {
  const platform = options.platform ?? process.platform
  const api = platform === 'win32' ? path.win32 : path.posix
  const same = (a: string, b: string) => (platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b)
  // A folder that is never there: git finds no hook in it. Made up once, so nothing can be put there ahead of time.
  const noHooks: ReadonlyArray<readonly [string, string]> = [['core.hooksPath', api.join(os.tmpdir(), `encode-no-hooks-${randomUUID()}`)]]

  const runner = (cwd: string): GitRunner => {
    const git = options.git()
    if (!git) throw new GitError(NO_GIT, 'missing')
    return new GitRunner({ git, cwd, env: options.env?.() ?? process.env, platform })
  }

  /** The folder git calls the top of the working tree, as a real path, or null outside a repository. */
  const topOf = async (root: string, signal?: AbortSignal): Promise<string | null> => {
    const result = await runner(root).run(['rev-parse', '--show-toplevel'], { signal })
    if (result.code !== 0) return null
    const top = result.stdout.toString('utf8').trim()
    return fs.realpath(api.resolve(top)).catch(() => api.resolve(top))
  }

  /** Keeps `.encode-worktrees/` out of the project's own status: one line in the clone's `info/exclude`. */
  const exclude = async (root: string, signal?: AbortSignal): Promise<void> => {
    const common = await runner(root).text(['rev-parse', '--git-common-dir'], { signal })
    const file = api.join(api.resolve(root, common), 'info', 'exclude')
    const line = `/${WORKTREE_FOLDER}/`
    const current = await fs.readFile(file, 'utf8').catch(() => '')
    if (current.split(/\r?\n/).some((entry) => entry.trim() === line)) return
    await fs.mkdir(api.dirname(file), { recursive: true })
    await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8')
  }

  return {
    async unavailable(root, signal) {
      if (!options.git()) return NO_GIT
      const top = await topOf(root, signal)
      if (!top) return 'The project is not a git repository, so there is no worktree to make.'
      const real = await fs.realpath(root).catch(() => root)
      if (!same(top, real)) return `Worktrees are made for a whole repository; this folder is inside the repository at ${top}. Open that folder to use one.`
      const head = await runner(root).run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal })
      if (head.code !== 0) return 'The repository has no commit yet, and a worktree starts from one. Commit first.'
      return undefined
    },

    async create(root, name, signal) {
      if (!isWorktreeName(name)) throw new Error(`"${name}" cannot name a worktree: use letters, digits, dots, dashes and underscores.`)
      const git = runner(root)
      const folder = api.join(root, WORKTREE_FOLDER, name)
      const branch = `${WORKTREE_BRANCH_PREFIX}${name}`
      if (await exists(folder)) throw new Error(`A worktree named ${name} is there already. Pick another name.`)
      const taken = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { signal })
      if (taken.code === 0) throw new Error(`The branch ${branch} is there already. Pick another name.`)
      const base = await git.text(['rev-parse', '--verify', 'HEAD^{commit}'], { signal })
      const on = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal })
      const from = on.code === 0 ? on.stdout.toString('utf8').trim() : ''
      await exclude(root, signal)
      await git.ok(['worktree', 'add', '-b', branch, folder, base], { signal, timeoutMs: LONG_MS, config: noHooks })
      const real = await fs.realpath(folder)
      return { name, path: real, branch, base, ...(from ? { from } : {}) }
    },

    async work(worktree, signal) {
      const git = runner(worktree.path)
      const status = await git.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal })
      const changed: string[] = []
      const fields = status.toString('utf8').split('\0')
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]
        if (!field) continue
        if (changed.length < MAX_CHANGED) changed.push(field.slice(3))
        // A rename or copy is followed by the name it had.
        if (field[0] === 'R' || field[0] === 'C') index++
      }
      // Commits since it started that no other branch holds: merged work is not lost with the branch.
      const others = await git.text(['rev-list', '--count', 'HEAD', '--not', worktree.base, `--exclude=${worktree.branch}`, '--branches', '--remotes'], { signal })
      return { changed, commits: Number(others) || 0 }
    },

    async remove(root, worktree, { force }, signal) {
      const git = runner(root)
      const result = await git.run(['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path], { signal, timeoutMs: LONG_MS, config: noHooks })
      // A folder git no longer knows (removed by hand, then made again) is only taken off its list.
      if (result.code !== 0 && (await exists(worktree.path))) {
        const said = result.stderr.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('hint:'))
        throw new Error(said ? said.replace(/^fatal: /, '') : `The worktree ${worktree.name} could not be removed.`)
      }
      await git.run(['worktree', 'prune'], { signal })
      const branch = await git.run(['branch', '-D', worktree.branch], { signal, config: noHooks })
      if (branch.code !== 0 && (await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`], { signal })).code === 0) {
        throw new Error(`The worktree is gone, but its branch ${worktree.branch} could not be deleted.`)
      }
      // The folder of worktrees goes too once it is empty.
      await fs.rmdir(api.join(root, WORKTREE_FOLDER)).catch(() => undefined)
    },
  }
}
