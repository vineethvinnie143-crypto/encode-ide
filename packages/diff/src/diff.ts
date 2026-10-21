import { DiffSearch, merge, type DiffBlock } from './myers'

export type { DiffBlock }

export interface DiffOptions {
  /** Stop refining after this long and report what is left as one replacement. Default 1500 ms. */
  timeoutMs?: number
}

export interface LineDiff {
  /** Changed regions in order, as line indexes (0-based, half-open). */
  blocks: DiffBlock[]
  /** True when the time limit cut the search short; the blocks are still a correct edit, just not minimal. */
  approximate: boolean
}

/** Maps each distinct string to a small integer, so the search compares numbers. */
function interner(): (items: readonly string[]) => Int32Array {
  const ids = new Map<string, number>()
  return (items) =>
    Int32Array.from(items, (item) => {
      let id = ids.get(item)
      if (id === undefined) {
        id = ids.size
        ids.set(item, id)
      }
      return id
    })
}

/** The changed regions between two lists of lines. */
export function diffLines(a: readonly string[], b: readonly string[], options: DiffOptions = {}): LineDiff {
  const intern = interner()
  const search = new DiffSearch(intern(a), intern(b), Date.now() + (options.timeoutMs ?? 1500))
  const blocks = search.run()
  slide(blocks, a, b)
  return { blocks: merge(blocks), approximate: search.approximate }
}

const WORD = /\s+|[\p{L}\p{N}_]+|[^]/gu

/**
 * The changed regions between two strings, compared word by word (runs of
 * letters and digits, runs of whitespace, single other characters). Blocks
 * are UTF-16 offsets, and never split a surrogate pair.
 */
export function diffWords(a: string, b: string, options: DiffOptions = {}): DiffBlock[] {
  const tokensA = a.match(WORD) ?? []
  const tokensB = b.match(WORD) ?? []
  const intern = interner()
  const search = new DiffSearch(intern(tokensA), intern(tokensB), Date.now() + (options.timeoutMs ?? 200))
  const offsets = (tokens: string[]) => {
    const starts = new Int32Array(tokens.length + 1)
    for (let index = 0; index < tokens.length; index++) starts[index + 1] = starts[index] + tokens[index].length
    return starts
  }
  const startsA = offsets(tokensA)
  const startsB = offsets(tokensB)
  return search.run().map((block) => ({
    fromA: startsA[block.fromA],
    toA: startsA[block.toA],
    fromB: startsB[block.fromB],
    toB: startsB[block.toB],
  }))
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === ''
}

/**
 * Lower is better: a block reads best when it ends before a blank line (or
 * the end of the file), then when it starts after one.
 */
function placement(lines: readonly string[], from: number, to: number): number {
  return (isBlank(lines[to]) ? 0 : 2) + (isBlank(lines[from - 1]) ? 0 : 1)
}

/**
 * Pure insertions and deletions can often sit at several positions with the
 * same meaning (the classic "}\n\nfunction" slide). Moves each one, within
 * the unchanged lines around it, to where it reads best.
 */
function slide(blocks: DiffBlock[], a: readonly string[], b: readonly string[]): void {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const insertion = block.fromA === block.toA
    if (insertion === (block.fromB === block.toB)) continue
    const lines = insertion ? b : a
    const previous = blocks[index - 1]
    const next = blocks[index + 1]
    const floor = previous ? (insertion ? previous.toB : previous.toA) : 0
    const ceiling = next ? (insertion ? next.fromB : next.fromA) : lines.length
    const start = insertion ? block.fromB : block.fromA
    let from = start
    let to = insertion ? block.toB : block.toA
    while (from > floor && lines[from - 1] === lines[to - 1]) {
      from--
      to--
    }
    let best = from
    let bestScore = placement(lines, from, to)
    while (to < ceiling && lines[from] === lines[to]) {
      from++
      to++
      const score = placement(lines, from, to)
      if (score <= bestScore) {
        best = from
        bestScore = score
      }
    }
    const shift = best - start
    block.fromA += shift
    block.toA += shift
    block.fromB += shift
    block.toB += shift
  }
}

export interface HunkLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  /** 1-based line number in the old text (context and deleted lines). */
  oldNo?: number
  /** 1-based line number in the new text (context and added lines). */
  newNo?: number
}

/**
 * A unified-diff hunk. `oldStart` and `newStart` are 1-based and always
 * point at the hunk's first line on that side, also when the side is empty
 * (unlike `diff -u`, which then names the line before).
 */
export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: HunkLine[]
}

/** Groups blocks into hunks with `context` unchanged lines around each change. */
export function toHunks(a: readonly string[], b: readonly string[], blocks: readonly DiffBlock[], context = 3): Hunk[] {
  const hunks: Hunk[] = []
  let index = 0
  while (index < blocks.length) {
    // Blocks whose context would touch share a hunk.
    let last = index
    while (last + 1 < blocks.length && blocks[last + 1].fromA - blocks[last].toA <= 2 * context) last++
    const first = blocks[index]
    const startA = Math.max(0, first.fromA - context)
    const startB = first.fromB - (first.fromA - startA)
    const endA = Math.min(a.length, blocks[last].toA + context)
    const lines: HunkLine[] = []
    let x = startA
    let y = startB
    for (let at = index; at <= last; at++) {
      const block = blocks[at]
      for (; x < block.fromA; x++, y++) lines.push({ type: 'ctx', text: a[x], oldNo: x + 1, newNo: y + 1 })
      for (; x < block.toA; x++) lines.push({ type: 'del', text: a[x], oldNo: x + 1 })
      for (; y < block.toB; y++) lines.push({ type: 'add', text: b[y], newNo: y + 1 })
    }
    for (; x < endA; x++, y++) lines.push({ type: 'ctx', text: a[x], oldNo: x + 1, newNo: y + 1 })
    hunks.push({ oldStart: startA + 1, oldLines: endA - startA, newStart: startB + 1, newLines: y - startB, lines })
    index = last + 1
  }
  return hunks
}

/** The hunks between two texts split into lines, with `context` lines around each change. */
export function diffHunks(before: string, after: string, context = 3, options: DiffOptions = {}): Hunk[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  return toHunks(a, b, diffLines(a, b, options).blocks, context)
}

/**
 * Replays hunks: old lines in, new lines out. Null when a context or deleted
 * line does not match, so a stale patch never applies to the wrong text.
 */
export function applyHunks(old: readonly string[], hunks: readonly Hunk[]): string[] | null {
  return replay(old, hunks, 'old')
}

/** Replays hunks backwards: new lines in, old lines out. Null when the lines do not match. */
export function unapplyHunks(current: readonly string[], hunks: readonly Hunk[]): string[] | null {
  return replay(current, hunks, 'new')
}

function replay(source: readonly string[], hunks: readonly Hunk[], from: 'old' | 'new'): string[] | null {
  // Lines of this type come from the hunk; every other line must match the source.
  const produced = from === 'old' ? 'add' : 'del'
  const out: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    const start = (from === 'old' ? hunk.oldStart : hunk.newStart) - 1
    if (start < cursor || start > source.length) return null
    for (; cursor < start; cursor++) out.push(source[cursor])
    for (const line of hunk.lines) {
      if (line.type === produced) {
        out.push(line.text)
        continue
      }
      if (cursor >= source.length || source[cursor] !== line.text) return null
      if (line.type === 'ctx') out.push(line.text)
      cursor++
    }
  }
  for (; cursor < source.length; cursor++) out.push(source[cursor])
  return out
}
