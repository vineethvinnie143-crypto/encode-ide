/**
 * The Review tab's side of the main process: the open folder's repository through @encode/git, opened again when the
 * folder changes. Answers are data the tab shows (a review, or why there is none; what an action did, or why it did
 * not), so a refusal is not an error; only a fault is.
 */
import { GitError, GitRunner, Repository, ReviewError, type RepositoryOptions } from '@encode/git'
import type {
  ReviewAction,
  ReviewActOutcome,
  ReviewBranches,
  ReviewCommit,
  ReviewCommitOutcome,
  ReviewCommitRequest,
  ReviewLoad,
  ReviewOptions,
  ReviewScope,
} from '../../shared/types'
import type { CommitDraftInput } from '../agent-host/commit-message'

export interface ReviewServiceOptions {
  /** The folder open now, or null. */
  folder: () => string | null
  /** git by absolute path, or null when it is not installed. */
  git: () => string | null
  env?: () => Readonly<Record<string, string | undefined>>
  /** Where a reverted file git does not track goes (the Recycle Bin); without it the file is deleted. */
  trash?: RepositoryOptions['trash']
  /** Asks the Tools role's model for a commit message. */
  draft?: (input: CommitDraftInput) => Promise<string>
  platform?: NodeJS.Platform
}

const NO_GIT = 'git was not found. Install Git from git-scm.com, then restart eNCode.'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ReviewService {
  private opened: { folder: string; repository: Promise<Repository | { reason: string }> } | null = null

  constructor(private readonly options: ReviewServiceOptions) {}

  /** The repository of the open folder, opened once per folder. */
  private repository(): Promise<Repository | { reason: string }> {
    const folder = this.options.folder()
    if (!folder) return Promise.resolve({ reason: 'Open a folder to review its changes.' })
    const git = this.options.git()
    if (!git) return Promise.resolve({ reason: NO_GIT })
    if (this.opened?.folder !== folder) {
      const runner = (cwd: string) => new GitRunner({ git, cwd, env: this.options.env?.() ?? process.env, platform: this.options.platform ?? process.platform })
      const repository = Repository.open(runner, folder, this.options.trash ? { trash: this.options.trash } : {})
      this.opened = { folder, repository }
      // A folder that is not a repository may become one (git init): ask again next time.
      void repository.then((result) => {
        if (!(result instanceof Repository) && this.opened?.repository === repository) this.opened = null
      })
    }
    return this.opened.repository
  }

  async load(scope: ReviewScope, options: ReviewOptions): Promise<ReviewLoad> {
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { ok: false, message: repository.reason }
    try {
      return { ok: true, snapshot: await repository.review(scope, options), undo: repository.undoLabel }
    } catch (error) {
      if (error instanceof ReviewError || error instanceof GitError) return { ok: false, message: error.message }
      throw error
    }
  }

  async act(scope: ReviewScope, action: ReviewAction, options: ReviewOptions): Promise<ReviewActOutcome> {
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { ok: false, message: repository.reason, stale: false, load: { ok: false, message: repository.reason } }
    try {
      const result = await repository.act(scope, action, options)
      return { ok: true, message: result.message, undoable: result.undoable, load: await this.load(scope, options) }
    } catch (error) {
      if (error instanceof ReviewError || error instanceof GitError) {
        return { ok: false, message: error.message, stale: error instanceof ReviewError && error.code === 'stale', load: await this.load(scope, options) }
      }
      throw error
    }
  }

  async undo(scope: ReviewScope, options: ReviewOptions): Promise<ReviewActOutcome> {
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { ok: false, message: repository.reason, stale: false, load: { ok: false, message: repository.reason } }
    try {
      const result = await repository.undo()
      return { ok: true, message: result.message, undoable: false, load: await this.load(scope, options) }
    } catch (error) {
      if (error instanceof ReviewError || error instanceof GitError) return { ok: false, message: error.message, stale: true, load: await this.load(scope, options) }
      throw error
    }
  }

  async commits(): Promise<ReviewCommit[]> {
    const repository = await this.repository()
    return repository instanceof Repository ? repository.commits(80) : []
  }

  async branches(): Promise<ReviewBranches> {
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { current: null, base: null, refs: [] }
    const status = await repository.status()
    const [refs, base] = await Promise.all([repository.refs(), repository.defaultBase(status)])
    return { current: status.branch.head, base, refs }
  }

  async commit(request: ReviewCommitRequest): Promise<ReviewCommitOutcome> {
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { ok: false, message: repository.reason }
    let commit: ReviewCommit
    try {
      commit = await repository.commit({ message: request.message, all: request.all, amend: request.amend })
    } catch (error) {
      if (error instanceof ReviewError || error instanceof GitError) return { ok: false, message: error.message }
      throw error
    }
    if (!request.push) return { ok: true, commit }
    try {
      const pushed = await repository.push()
      return { ok: true, commit, pushed: `${pushed.remote}/${pushed.branch}` }
    } catch (error) {
      // The commit is made; only the push failed, and the person reads why.
      return { ok: true, commit, pushError: describe(error) }
    }
  }

  /** A message for what the commit would take: what is staged, or with `all` every change. */
  async draft(all: boolean): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    if (!this.options.draft) return { ok: false, message: 'Drafting is not available here.' }
    const repository = await this.repository()
    if (!(repository instanceof Repository)) return { ok: false, message: repository.reason }
    let context: CommitDraftInput
    try {
      context = await repository.commitContext({ all })
    } catch (error) {
      if (error instanceof ReviewError || error instanceof GitError) return { ok: false, message: error.message }
      throw error
    }
    if (!context.files.length) return { ok: false, message: all ? 'There are no changes to describe.' : 'Nothing is staged to describe.' }
    try {
      const message = (await this.options.draft(context)).trim()
      return message ? { ok: true, message } : { ok: false, message: 'The model did not write a message.' }
    } catch (error) {
      return { ok: false, message: describe(error) }
    }
  }
}
