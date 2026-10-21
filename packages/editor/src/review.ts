import { diffLines, diffWords, type DiffOptions } from '@encode/diff'
import { ChangeSet, type ChangeSpec, type Text } from '@encode/text'
import type { EditorState, Transaction } from './state'

/**
 * Hunk-level review of changes against a baseline: the file as it was
 * before the agent edited it. Accepting a hunk moves it into the baseline;
 * rejecting it puts the baseline's lines back into the document. Both work
 * on whole lines, as the diff does.
 */
export interface ReviewHunk {
  /** Baseline lines, 0-based and half-open. Empty when lines were only added. */
  readonly fromA: number
  readonly toA: number
  /** Document lines, 0-based and half-open. Empty when lines were only removed. */
  readonly fromB: number
  readonly toB: number
  /** The baseline's lines, shown as removed. */
  readonly removed: readonly string[]
  /** Identifies the hunk for a list while the document does not change around it. */
  readonly key: string
}

export interface ReviewResult {
  hunks: ReviewHunk[]
  /** True when the diff hit its time limit; the hunks are correct but may be coarser than necessary. */
  approximate: boolean
}

/** The hunks between `baseline` (split into lines) and the document. */
export function reviewHunks(baseline: readonly string[], doc: Text, options: DiffOptions = {}): ReviewResult {
  const current = doc.lineTexts()
  const { blocks, approximate } = diffLines(baseline, current, options)
  return {
    approximate,
    hunks: blocks.map((block) => ({
      ...block,
      removed: baseline.slice(block.fromA, block.toA),
      key: `${block.fromB}:${block.toB - block.fromB}:${block.toA - block.fromA}`,
    })),
  }
}

/** The baseline with `hunk` accepted: its document lines replace the baseline's. */
export function acceptHunk(baseline: readonly string[], hunk: ReviewHunk, doc: Text): string[] {
  const added = hunk.toB > hunk.fromB ? doc.lineTexts(hunk.fromB + 1, hunk.toB) : []
  return [...baseline.slice(0, hunk.fromA), ...added, ...baseline.slice(hunk.toA)]
}

/** A change that replaces 0-based document lines [from, to) with `lines`, line breaks included. */
export function replaceLines(doc: Text, from: number, to: number, lines: readonly string[]): ChangeSpec {
  if (from < to) {
    const start = doc.line(from + 1).from
    const end = doc.line(to).to
    if (lines.length) return { from: start, to: end, insert: lines.join('\n') }
    // Removing whole lines takes one line break with them.
    if (to < doc.lineCount) return { from: start, to: doc.line(to + 1).from }
    if (from > 0) return { from: doc.line(from).to, to: end }
    return { from: 0, to: doc.length }
  }
  if (!lines.length) return { from: 0 }
  if (from < doc.lineCount) return { from: doc.line(from + 1).from, insert: `${lines.join('\n')}\n` }
  return { from: doc.length, insert: `\n${lines.join('\n')}` }
}

/** Rejects hunks: their baseline lines go back into the document, as one undoable step. */
export function rejectHunks(state: EditorState, hunks: readonly ReviewHunk[]): Transaction | null {
  if (!hunks.length) return null
  const changes = ChangeSet.of(
    hunks.map((hunk) => replaceLines(state.doc, hunk.fromB, hunk.toB, hunk.removed)),
    state.doc.length,
  )
  if (changes.empty) return null
  return state.update({ changes, origin: 'review.reject', isolateHistory: true, scrollIntoView: false })
}

export interface WordChange {
  /** Offsets in the removed text (joined with "\n"). */
  fromA: number
  toA: number
  /** Offsets in the document. */
  fromB: number
  toB: number
}

/**
 * Character ranges that changed inside a modified hunk, for highlighting
 * the words that differ. Null for pure additions or removals and for hunks
 * too large to be worth comparing word by word.
 */
export function wordChanges(hunk: ReviewHunk, doc: Text, maxChars = 4000): WordChange[] | null {
  if (hunk.fromA === hunk.toA || hunk.fromB === hunk.toB) return null
  const removed = hunk.removed.join('\n')
  const start = doc.line(hunk.fromB + 1).from
  const added = doc.sliceString(start, doc.line(hunk.toB).to)
  if (removed.length + added.length > maxChars) return null
  const blocks = diffWords(removed, added)
  // Mostly different: highlighting every word is noise, the line colours say enough.
  const changed = blocks.reduce((sum, block) => sum + (block.toB - block.fromB), 0)
  if (changed > added.length * 0.6) return null
  return blocks.map((block) => ({ fromA: block.fromA, toA: block.toA, fromB: start + block.fromB, toB: start + block.toB }))
}

/** Lines added and removed across hunks, for a summary such as "+12 −3". */
export function reviewStats(hunks: readonly ReviewHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    added += hunk.toB - hunk.fromB
    removed += hunk.toA - hunk.fromA
  }
  return { added, removed }
}
