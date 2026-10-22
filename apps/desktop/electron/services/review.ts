/**
 * The Review tab's side of the main process: the open folder's repository through @encode/git, opened again when the
 * folder changes. Answers are data the tab shows (a review, or why there is none; what an action did, or why it did
 * not), so a refusal is not an error; only a fault is.
 */
import { GitError, GitRunner, Repository, ReviewError, type RepositoryOptions } from '@encode/git'
import type {
  ReviewAction,
  ReviewActOutcome,
  ReviewAskOutcome,
  ReviewBranches,
  ReviewCommit,
  ReviewCommitOutcome,
  ReviewCommitRequest,
  ReviewLoad,
  ReviewOptions,
  ReviewScope,
} from '../../shared/types'
import type { CodeReviewInput, CodeReviewResult } from '../agent-host/code-review'
import type { CommitDraftInput } from '../agent-host/commit-message'
import { codeReviewInput, REVIEW_CONTEXT } from './review-prompt'
import { TurnReview, type TurnSource } from './turn-review'

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
  /** Asks the Review role's model what is wrong with a change. */
  reviewCode?: (input: CodeReviewInput) => Promise<CodeReviewResult>
  /** The agent's record of what each request changed, for the Turn view; without it that view has nothing to show. */
  turns?: TurnSource
  platform?: NodeJS.Platform
}

const NO_GIT = 'git was not found. Install Git from git-scm.com, then restart eNCode.'
const NO_TURNS = 'The agent’s record of its changes is not available here.'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ReviewService {
  private opened: { folder: string; repository: Promise<Repository | { reason: string }> } | null = null
  private readonly turns: TurnReview | null

  constructor(private readonly options: ReviewServiceOptions) {
    this.turns = options.turns ? new TurnReview(options.turns) : null
  }

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
    if (scope.kind === 'turn') return this.turns ? this.turns.load(scope, options) : { ok: false, message: NO_TURNS }
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
    if (scope.kind === 'turn') return this.turns ? this.turns.act(scope, action, options) : { ok: false, message: NO_TURNS, stale: false, load: { ok: false, message: NO_TURNS } }
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
    if (scope.kind === 'turn') return this.turns ? this.turns.undo(scope, options) : { ok: false, message: NO_TURNS, stale: false, load: { ok: false, message: NO_TURNS } }
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

  /**
   * The Reviewer's findings on a scope's changes. It reads more lines around each change than the person may show
   * (REVIEW_CONTEXT at least), every whitespace change, and as many files as one request holds.
   */
  async askReviewer(scope: ReviewScope, options: ReviewOptions): Promise<ReviewAskOutcome> {
    if (!this.options.reviewCode) return { ok: false, message: 'The Reviewer is not available here.' }
    const load = await this.load(scope, { context: options.context === Infinity ? Infinity : Math.max(options.context, REVIEW_CONTEXT), ignoreWhitespace: false })
    if (!load.ok) return { ok: false, message: load.message }
    const { request, read } = codeReviewInput(load.snapshot)
    if (!read) {
      return {
        ok: false,
        message: request.left ? 'This change is too large for the Reviewer to read at once. Ask about a part of it: the staged changes, or one commit.' : 'There are no changed lines here for the Reviewer to read.',
      }
    }
    try {
      const result = await this.options.reviewCode(request)
      return { ok: true, summary: result.summary, findings: result.findings, files: read, left: request.left }
    } catch (error) {
      return { ok: false, message: describe(error) }
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
