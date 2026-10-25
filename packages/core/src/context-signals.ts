/**
 * What compaction did in a request, and the signs that it cut something the model still needed (ADR 0132).
 *
 * The bench measures accuracy on its own tasks; these count it in real use. A rewrite shortens old outputs or
 * summarizes old steps. A read-back is the model reading a shortened output again: the file that keeps it whole, or a
 * file whose Read was shortened and has not changed since. An edit miss after a rewrite is an Edit whose old text was
 * not in the file, in a request the conversation was rewritten in. A bounce is a gate sending the agent back: the
 * project's checks, or the check of what its reply claims.
 *
 * The session keeps one ContextWatch across its turns. Once the model has read back READ_BACKS_TO_KEEP_MORE shortened
 * outputs, the session keeps more from then on: one more step whole, and twice the characters of each old output.
 */
import path from 'node:path'
import type { ShorteningPolicy } from './shortening'

export interface ContextSignals {
  /** Rewrites of the conversation: old outputs shortened, or old steps summarized. */
  rewrites: number
  /** Of those, the ones that summarized. */
  summaries: number
  /** Shortened outputs the model read again. */
  readBacks: number
  /** Edits whose old text was not found, after a rewrite in the same request. */
  editMisses: number
  /** Times the project's checks sent the agent back (ADR 0095). */
  checkBounces: number
  /** Times the check of what its reply claims sent it back (ADR 0095). */
  claimBounces: number
}

export type ContextSignal = keyof ContextSignals

export const SIGNALS: readonly ContextSignal[] = ['rewrites', 'summaries', 'readBacks', 'editMisses', 'checkBounces', 'claimBounces']

export function noSignals(): ContextSignals {
  return { rewrites: 0, summaries: 0, readBacks: 0, editMisses: 0, checkBounces: 0, claimBounces: 0 }
}

/** The two added, a missing or malformed count as none. */
export function addSignals(a: Partial<ContextSignals> | undefined, b: Partial<ContextSignals> | undefined): ContextSignals {
  const out = noSignals()
  for (const key of SIGNALS) out[key] = count(a?.[key]) + count(b?.[key])
  return out
}

/** Whether any count is above zero. */
export function anySignals(signals: Partial<ContextSignals> | undefined): boolean {
  return SIGNALS.some((key) => count(signals?.[key]) > 0)
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

/** Read-backs in a session after which it keeps more of each old output. */
export const READ_BACKS_TO_KEEP_MORE = 3

/** An Edit's error when its old text is not in the file. */
const NOT_FOUND = /old_string was not found/

/** Calls that change a file, after which reading it again is no sign of anything. */
const CHANGES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'LSPEdit'])

/** Whether a failed call is an edit that missed its text. */
export function isEditMiss(name: string, failure: string | undefined): boolean {
  return (name === 'Edit' || name === 'MultiEdit') && failure !== undefined && NOT_FOUND.test(failure)
}

export class ContextWatch {
  /** Files that keep a shortened output whole. */
  private readonly kept = new Set<string>()
  /** Files whose latest Read was shortened, not changed since. */
  private readonly reads = new Set<string>()
  private backs = 0

  /** How many shortened outputs the model read again in this session. */
  get readBacks(): number {
    return this.backs
  }

  /** How much more the session keeps: 0, or 1 once the model has read back enough. */
  get level(): number {
    return this.backs >= READ_BACKS_TO_KEEP_MORE ? 1 : 0
  }

  /** A rewrite shortened these: the files that keep outputs whole, and the files whose Reads it cut. */
  shortened(found: { files: readonly string[]; reads: readonly string[] }, root: string): void {
    for (const file of found.files) this.kept.add(resolved(file, root))
    for (const file of found.reads) this.reads.add(resolved(file, root))
  }

  /** A call of the main agent's ran; true when it read a shortened output back, which is then counted, once for each output. */
  called(name: string, input: Record<string, unknown>, root: string): boolean {
    const target = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (CHANGES.has(name)) {
      if (target) this.reads.delete(resolved(target, root))
      return false
    }
    let back = false
    if (name === 'Read' && target) {
      const file = resolved(target, root)
      back = this.kept.delete(file) || this.reads.delete(file)
    } else if ((name === 'Grep' || name === 'Glob') && typeof input.path === 'string') {
      back = this.kept.delete(resolved(input.path, root))
    } else if (name === 'Bash' && typeof input.command === 'string') {
      const command = input.command
      const file = [...this.kept].find((kept) => command.includes(kept) || command.includes(kept.replace(/\\/g, '/')))
      back = file !== undefined && this.kept.delete(file)
    }
    if (back) this.backs++
    return back
  }
}

function resolved(file: string, root: string): string {
  return path.resolve(root, file)
}

/** The policy, keeping more at a higher level: `level` more steps whole, and the characters of each old output doubled as often. */
export function keepingMore(policy: ShorteningPolicy, level: number): ShorteningPolicy {
  if (level <= 0) return policy
  return {
    ...policy,
    recent: { ...policy.recent, steps: policy.recent.steps + level, reads: policy.recent.reads + level },
    limit: policy.limit * 2 ** level,
  }
}
