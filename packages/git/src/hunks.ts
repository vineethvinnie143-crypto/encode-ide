/**
 * Two versions of a file as hunks a person reviews, with the words that changed marked, and one hunk put in or taken
 * out of a version: what staging, unstaging and reverting a single hunk write.
 */
import { createHash } from 'node:crypto'
import { diffLines, diffWords, type DiffBlock } from '@encode/diff'
import type { LineEnding, TextContent } from './text'

export interface ReviewLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  /** 1-based number in the old version (context and removed lines). */
  old?: number
  /** 1-based number in the new version (context and added lines). */
  new?: number
  /** The last line of its version, without a line ending. */
  noEol?: true
  /** The parts of the line that changed, when only part of it did: UTF-16 offsets, end exclusive. */
  words?: Array<[number, number]>
}

export interface ReviewHunk {
  /** Names the hunk by where it is and what it holds; the same change gets the same id. */
  id: string
  /** 1-based first line of the hunk in the old version; when that side is empty, the line it would come before. */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ReviewLine[]
  added: number
  removed: number
}

export interface HunkOptions {
  /** Unchanged lines shown around each change. Default 3; Infinity shows the whole file. */
  context?: number
  /** Lines that differ only in whitespace count as the same. Such hunks cannot be written back on their own. */
  ignoreWhitespace?: boolean
  /** Mark the words that changed. Default true. */
  words?: boolean
  timeoutMs?: number
}

export interface FileDiff {
  hunks: ReviewHunk[]
  added: number
  removed: number
  /** The diff ran out of time: correct, but coarser than it could be. */
  approximate: boolean
}

const NO_EOL = '\u0000'
/** Changed words are marked only where at least this share of a block's text stayed the same. */
const WORDS_MIN_KEPT = 0.3
const WORDS_MAX_CHARS = 20_000

function keys(content: TextContent, ignoreWhitespace: boolean): string[] {
  return content.lines.map((line, index) => {
    const text = ignoreWhitespace ? line.replace(/\s+/g, '') : line
    return content.endings[index] === '' ? text + NO_EOL : text
  })
}

/** A range the way git writes it: no count when it is one line, and an empty range at the line before it. */
function range(start: number, count: number): string {
  return count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`
}

/** The line git puts above a hunk: `@@ -3,7 +3,8 @@`. */
export function hunkHeader(hunk: Pick<ReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): string {
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`
}

export function hunkId(hunk: Omit<ReviewHunk, 'id'>): string {
  const body = hunk.lines.map((line) => `${line.kind[0]}${line.noEol ? '!' : ' '}${line.text}`)
  return createHash('sha1').update(JSON.stringify([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, body])).digest('hex').slice(0, 16)
}

export function diffContents(a: TextContent, b: TextContent, options: HunkOptions = {}): FileDiff {
  const context = Math.max(0, options.context ?? 3)
  const ignoreWhitespace = options.ignoreWhitespace ?? false
  const result = diffLines(keys(a, ignoreWhitespace), keys(b, ignoreWhitespace), { timeoutMs: options.timeoutMs ?? 400 })
  const blocks = result.blocks
  const hunks: ReviewHunk[] = []
  let added = 0
  let removed = 0
  let index = 0
  while (index < blocks.length) {
    // Blocks whose context would touch share a hunk.
    let last = index
    while (last + 1 < blocks.length && blocks[last + 1].fromA - blocks[last].toA <= 2 * context) last++
    const first = blocks[index]
    const startA = Math.max(0, first.fromA - Math.min(context, first.fromA))
    const startB = first.fromB - (first.fromA - startA)
    const endA = Math.min(a.lines.length, blocks[last].toA + context)
    const lines: ReviewLine[] = []
    let x = startA
    let y = startB
    let hunkAdded = 0
    let hunkRemoved = 0
    const push = (line: ReviewLine) => lines.push(line)
    for (let at = index; at <= last; at++) {
      const block = blocks[at]
      for (; x < block.fromA; x++, y++) push(contextLine(a, b, x, y))
      for (; x < block.toA; x++) {
        push({ kind: 'del', text: a.lines[x], old: x + 1, ...(a.endings[x] === '' ? { noEol: true as const } : {}) })
        hunkRemoved++
      }
      for (; y < block.toB; y++) {
        push({ kind: 'add', text: b.lines[y], new: y + 1, ...(b.endings[y] === '' ? { noEol: true as const } : {}) })
        hunkAdded++
      }
    }
    for (; x < endA; x++, y++) push(contextLine(a, b, x, y))
    if (options.words !== false) markWords(lines)
    const body = { oldStart: startA + 1, oldLines: endA - startA, newStart: startB + 1, newLines: y - startB, lines, added: hunkAdded, removed: hunkRemoved }
    hunks.push({ id: hunkId(body), ...body })
    added += hunkAdded
    removed += hunkRemoved
    index = last + 1
  }
  return { hunks, added, removed, approximate: result.approximate }
}

function contextLine(a: TextContent, b: TextContent, x: number, y: number): ReviewLine {
  // Where whitespace is ignored the two may differ; the newer one is what the file holds.
  return { kind: 'ctx', text: b.lines[y] ?? a.lines[x], old: x + 1, new: y + 1, ...(b.endings[y] === '' ? { noEol: true as const } : {}) }
}

/** Marks, in each run of removed lines followed by added ones, the words that changed. */
function markWords(lines: ReviewLine[]): void {
  let index = 0
  while (index < lines.length) {
    if (lines[index].kind !== 'del') {
      index++
      continue
    }
    const delStart = index
    while (index < lines.length && lines[index].kind === 'del') index++
    const addStart = index
    while (index < lines.length && lines[index].kind === 'add') index++
    const dels = lines.slice(delStart, addStart)
    const adds = lines.slice(addStart, index)
    if (!adds.length) continue
    const before = dels.map((line) => line.text).join('\n')
    const after = adds.map((line) => line.text).join('\n')
    if (before.length + after.length > WORDS_MAX_CHARS) continue
    const changes = diffWords(before, after, { timeoutMs: 50 })
    const changedA = changes.reduce((sum, change) => sum + (change.toA - change.fromA), 0)
    const changedB = changes.reduce((sum, change) => sum + (change.toB - change.fromB), 0)
    const kept = before.length + after.length - changedA - changedB
    if (!before.length || !after.length || kept / (before.length + after.length) < WORDS_MIN_KEPT) continue
    spread(dels, changes, 'A')
    spread(adds, changes, 'B')
  }
}

/** Splits ranges of the joined text (lines joined with "\n") into ranges of each line. */
function spread(lines: ReviewLine[], changes: readonly DiffBlock[], side: 'A' | 'B'): void {
  let offset = 0
  for (const line of lines) {
    const start = offset
    const end = start + line.text.length
    const ranges: Array<[number, number]> = []
    for (const change of changes) {
      const from = side === 'A' ? change.fromA : change.fromB
      const to = side === 'A' ? change.toA : change.toB
      if (to <= start || from >= end) continue
      const a = Math.max(from, start) - start
      const b = Math.min(to, end) - start
      if (b > a) ranges.push([a, b])
    }
    // A line that changed all over says nothing more with marks.
    if (ranges.length && !(ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === line.text.length)) line.words = ranges
    offset = end + 1
  }
}

/**
 * Walks the hunk over `target` from `start`: context and `taken` lines must be there (and are dropped when taken),
 * `given` lines are put in. Unchanged lines keep their own endings; lines the target gains take its usual one.
 */
function rewrite(target: TextContent, start: number, hunk: ReviewHunk, taken: 'add' | 'del'): TextContent | null {
  if (start < 0 || start > target.lines.length) return null
  const lines = target.lines.slice(0, start)
  const endings: Array<LineEnding | ''> = target.endings.slice(0, start)
  let at = start
  for (const line of hunk.lines) {
    if (line.kind === 'ctx' || line.kind === taken) {
      if (at >= target.lines.length || target.lines[at] !== line.text) return null
      if (Boolean(line.noEol) !== (target.endings[at] === '')) return null
      if (line.kind === 'ctx') {
        lines.push(target.lines[at])
        endings.push(target.endings[at])
      }
      at++
    } else {
      lines.push(line.text)
      endings.push(line.noEol ? '' : target.eol)
    }
  }
  for (; at < target.lines.length; at++) {
    lines.push(target.lines[at])
    endings.push(target.endings[at])
  }
  // Every line but the last ends with a line break; the last keeps what it had.
  for (let index = 0; index < lines.length - 1; index++) if (endings[index] === '') endings[index] = target.eol
  return { ...target, lines, endings }
}

/** The old version with the hunk put in: what staging the hunk makes of the index. Null when it does not fit. */
export function applyHunk(target: TextContent, hunk: ReviewHunk): TextContent | null {
  return rewrite(target, hunk.oldStart - 1, hunk, 'del')
}

/** The new version with the hunk taken out: what unstaging it makes of the index, or reverting it of the file. */
export function reverseHunk(target: TextContent, hunk: ReviewHunk): TextContent | null {
  return rewrite(target, hunk.newStart - 1, hunk, 'add')
}
