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
}
