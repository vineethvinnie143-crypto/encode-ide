/**
 * The git work behind EnterWorktree and ExitWorktree. eNCode runs it itself, with fixed commands and its own git
 * settings (see @encode/workspace), never as a command of the agent's: the agent only asks for it.
 */
import type { WorktreeInfo, WorktreeWork } from '@encode/tools'

export interface WorktreeGit {
  /** Why no worktree can be made in `root` (not a git repository, no commit yet), or undefined when one can. */
  unavailable(root: string, signal?: AbortSignal): Promise<string | undefined>
  /** Makes `.encode-worktrees/<name>` on a new branch `encode/<name>` from HEAD. Throws an Error with a plain message. */
  create(root: string, name: string, signal?: AbortSignal): Promise<WorktreeInfo>
  /** What removing it would lose. */
  work(worktree: WorktreeInfo, signal?: AbortSignal): Promise<WorktreeWork>
  /** Removes the folder and its branch; `force` also when there is work in it. */
  remove(root: string, worktree: WorktreeInfo, options: { force: boolean }, signal?: AbortSignal): Promise<void>
  /** For best of N (ADR 0098): brings a new worktree to the project as it is now, uncommitted work included. */
  seed?(root: string, worktree: WorktreeInfo, signal?: AbortSignal): Promise<WorktreeSeed>
  /** The files changed in the worktree since its seed. */
  changes?(worktree: WorktreeInfo, seed: WorktreeSeed, signal?: AbortSignal): Promise<SeedChange[]>
  /** A file as the seed holds it, or null when it was not there. */
  original?(worktree: WorktreeInfo, seed: WorktreeSeed, file: string, signal?: AbortSignal): Promise<Buffer | null>
  /** Takes the seed's links out before the worktree is removed. */
  unlink?(worktree: WorktreeInfo, seed: WorktreeSeed): Promise<void>
}

/** The commit an attempt starts from, and the folders linked into it from the project (`node_modules`, ...). */
export interface WorktreeSeed {
  base: string
  linked: string[]
}

/** A file an attempt changed since its seed, relative with `/`. */
export interface SeedChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
}
