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

/**
 * A worktree brought to the project as it is, for an attempt of a best-of-N run (ADR 0098): the files the project
 * changed, added or deleted since HEAD copied in and committed as `base`, its dependency folders linked and its `.env`
 * files copied.
 */
export interface WorktreeSeed {
  /** The commit that holds the project as it was; what the attempt changes is measured from it. */
  base: string
  /** Folders linked from the project (`node_modules`, `.venv`, ...), relative, with `/`: not the attempt's work. */
  linked: string[]
}

/** A file an attempt changed since its seed, with `/` in its relative path. */
export interface SeedChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
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
  /** Brings a new worktree to the project as it is now, uncommitted work included (ADR 0098). */
  seed(root: string, worktree: WorktreeRecord, signal?: AbortSignal): Promise<WorktreeSeed>
  /** The files changed in the worktree since its seed, links left out. */
  changes(worktree: WorktreeRecord, seed: WorktreeSeed, signal?: AbortSignal): Promise<SeedChange[]>
  /** A file as the seed holds it, or null when it was not there. */
  original(worktree: WorktreeRecord, seed: WorktreeSeed, file: string, signal?: AbortSignal): Promise<Buffer | null>
  /** Takes the links a seed made out of the worktree, so removing it can never reach what they point to. */
  unlink(worktree: WorktreeRecord, seed: WorktreeSeed): Promise<void>
}

const NO_GIT = 'git was not found. Install Git from git-scm.com, then restart eNCode.'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Checking out or removing a large tree takes a while. */
const LONG_MS = 5 * 60_000
const MAX_CHANGED = 50
/** Folders a seed links rather than copies: installed dependencies, large and the same for every attempt. */
const LINKED = new Set(['node_modules', '.venv', 'venv', '.yarn', 'bower_components'])
/** Ignored files a seed copies: the settings a project's commands read from the environment. */
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/
const MAX_ENV_BYTES = 64 * 1024
/** A seed copies at most this much uncommitted work; a project with more is better served without attempts. */
const MAX_SEED_FILES = 2_000
const MAX_SEED_BYTES = 200 * 1024 * 1024
/** The seed's commit is eNCode's, with no hook, signature or editor. */
const SEED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['user.name', 'eNCode'],
  ['user.email', 'encode@localhost'],
  ['commit.gpgsign', 'false'],
  ['core.autocrlf', 'false'],
]

/** The entries of `git status --porcelain=v1 -z --no-renames`: the two status letters and the path. */
function statusEntries(output: Buffer): { x: string; y: string; path: string }[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((field) => field.length > 3)
    .map((field) => ({ x: field[0], y: field[1], path: field.slice(3) }))
}

const insideLinked = (file: string, linked: readonly string[]) => linked.some((link) => file === link || file.startsWith(`${link}/`))

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

    async seed(root, worktree, signal) {
      const project = runner(root)
      const into = (file: string) => api.join(worktree.path, ...file.split('/'))
      const from = (file: string) => api.join(root, ...file.split('/'))
      const ownFolder = (file: string) => file === WORKTREE_FOLDER || file.startsWith(`${WORKTREE_FOLDER}/`)
      // What the project has that HEAD does not: changed, new and deleted files; ignored ones are not the project's work.
      const status = statusEntries(await project.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { signal })).filter((entry) => !ownFolder(entry.path))
      if (status.length > MAX_SEED_FILES) throw new Error(`The project has ${status.length} files changed since the last commit; attempts copy at most ${MAX_SEED_FILES}. Commit or stash some first.`)
      let bytes = 0
      for (const entry of status) {
        signal?.throwIfAborted()
        const target = into(entry.path)
        const source = from(entry.path)
        const stats = await fs.lstat(source).catch(() => null)
        if (!stats) {
          await fs.rm(target, { force: true })
          continue
        }
        await fs.mkdir(api.dirname(target), { recursive: true })
        if (stats.isSymbolicLink()) {
          await fs.rm(target, { force: true })
          await fs.symlink(await fs.readlink(source), target)
        } else if (stats.isFile()) {
          bytes += stats.size
          if (bytes > MAX_SEED_BYTES) throw new Error('The uncommitted work in the project is over 200 MB; attempts do not copy that much. Commit some of it first.')
          await fs.copyFile(source, target)
        }
      }
      const attempt = runner(worktree.path)
      await attempt.ok(['add', '-A'], { signal, config: noHooks })
      await attempt.ok(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'eNCode: the project as it was when the attempts started'], { signal, config: [...noHooks, ...SEED_CONFIG] })
      const base = await attempt.text(['rev-parse', 'HEAD^{commit}'], { signal })

      // Then what git ignores but the project's commands need: links after the commit, so they are never part of it.
      const linked: string[] = []
      const ignored = (await project.ok(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { signal })).toString('utf8').split('\0')
      for (const raw of ignored) {
        if (!raw || ownFolder(raw)) continue
        const folder = raw.endsWith('/') ? raw.slice(0, -1) : null
        const name = (folder ?? raw).split('/').pop() ?? ''
        if (folder && LINKED.has(name)) {
          const target = into(folder)
          if (await exists(target)) continue
          await fs.mkdir(api.dirname(target), { recursive: true })
          // A junction needs no rights on Windows and is removed without touching what it points to.
          await fs.symlink(from(folder), target, platform === 'win32' ? 'junction' : 'dir')
          linked.push(folder)
        } else if (!folder && ENV_FILE.test(name)) {
          const stats = await fs.lstat(from(raw)).catch(() => null)
          if (!stats?.isFile() || stats.size > MAX_ENV_BYTES) continue
          await fs.mkdir(api.dirname(into(raw)), { recursive: true })
          await fs.copyFile(from(raw), into(raw))
        }
      }
      return { base, linked }
    },

    async changes(worktree, seed, signal) {
      const git = runner(worktree.path)
      const status = statusEntries(await git.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { signal }))
      const changes: SeedChange[] = []
      for (const entry of status) {
        if (insideLinked(entry.path, seed.linked)) continue
        const kind = entry.x === '?' || entry.x === 'A' ? 'added' : entry.x === 'D' || entry.y === 'D' ? 'deleted' : 'modified'
        changes.push({ path: entry.path, kind })
      }
      // Commits the attempt made, against the instructions, count too: what differs from the seed is its work.
      const committed = (await git.ok(['diff', '--name-status', '-z', '--no-renames', seed.base, 'HEAD'], { signal })).toString('utf8').split('\0')
      for (let index = 0; index + 1 < committed.length; index += 2) {
        const letter = committed[index]
        const file = committed[index + 1]
        if (!letter || !file || insideLinked(file, seed.linked) || changes.some((change) => change.path === file)) continue
        changes.push({ path: file, kind: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' })
      }
      return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },

    async original(worktree, seed, file, signal) {
      const result = await runner(worktree.path).run(['cat-file', 'blob', `${seed.base}:${file}`], { signal })
      return result.code === 0 ? result.stdout : null
    },

    async unlink(worktree, seed) {
      for (const link of seed.linked) {
        const target = api.join(worktree.path, ...link.split('/'))
        const stats = await fs.lstat(target).catch(() => null)
        if (!stats?.isSymbolicLink()) continue
        // unlink takes a symlink away; a junction on Windows is a folder to it, and rmdir takes that away alone.
        await fs.unlink(target).catch(() => fs.rmdir(target))
      }
    },
  }
}
