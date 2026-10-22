/**
 * The Review tab's list as rows: a header for each file, a note where lines cannot be shown, a header for each hunk,
 * and its lines (one per row in the unified layout, an old and a new side per row in the split one), with the
 * comments under the lines they are about. Every row has a known height, except comments, whose drawn height is
 * measured and given back, so the list can draw only what is on screen whatever the size of the review.
 */
import type { ReviewFile, ReviewFileChange, ReviewHunk, ReviewLine, ReviewSnapshot } from '@shared/types'

export type DiffLayout = 'unified' | 'split'

/** Which line a comment is about: a line number on the old or the new side of the file. */
export interface Anchor {
  path: string
  side: 'old' | 'new'
  line: number
}

export interface ReviewComment extends Anchor {
  id: string
  text: string
  /** The line as it read when the comment was written, for the message to the agent. */
  excerpt: string
}

export type Row =
  | { kind: 'file'; key: string; file: number }
  | { kind: 'note'; key: string; file: number; text: string }
  | { kind: 'hunk'; key: string; file: number; hunk: number }
  | { kind: 'line'; key: string; file: number; hunk: number; line: number }
  | { kind: 'pair'; key: string; file: number; hunk: number; left: number | null; right: number | null }
  | { kind: 'comment'; key: string; file: number; comment: ReviewComment; detached: boolean }
  | { kind: 'editor'; key: string; file: number; anchor: Anchor; comment: ReviewComment | null }
  | { kind: 'gap'; key: string }

/** Heights in pixels; the stylesheet draws each row at exactly these. */
export const ROW_HEIGHT = {
  file: 40,
  note: 36,
  hunk: 28,
  line: 20,
  pair: 20,
  comment: 76,
  editor: 136,
  gap: 12,
} as const

export interface RowOptions {
  layout: DiffLayout
  /** Paths whose file is folded to its header. */
  collapsed: ReadonlySet<string>
  /** The comments of this view. */
  comments: readonly ReviewComment[]
  /** Where a comment is being written, if anywhere; with `comment`, the one being edited. */
  editing: { anchor: Anchor; comment: ReviewComment | null } | null
}

const anchorKey = (side: 'old' | 'new', line: number) => `${side}:${line}`

/** The lines a row of the unified layout stands for: a removed line its old number, any other its new one, a kept line both. */
function lineAnchors(line: ReviewLine): string[] {
  const keys: string[] = []
  if (line.kind !== 'add' && line.old !== undefined) keys.push(anchorKey('old', line.old))
  if (line.kind !== 'del' && line.new !== undefined) keys.push(anchorKey('new', line.new))
  return keys
}

/** The removed and added lines of a change side by side, kept lines on both sides. */
export function pairLines(lines: readonly ReviewLine[]): Array<[number | null, number | null]> {
  const pairs: Array<[number | null, number | null]> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.kind === 'ctx') {
      pairs.push([index, index])
      index++
      continue
    }
    const removed: number[] = []
    const added: number[] = []
    while (index < lines.length && lines[index].kind === 'del') removed.push(index++)
    while (index < lines.length && lines[index].kind === 'add') added.push(index++)
    for (let at = 0; at < Math.max(removed.length, added.length); at++) pairs.push([removed[at] ?? null, added[at] ?? null])
  }
  return pairs
}

/** The anchor a click on a line asks a comment for: its new number, or the old one for a removed line. */
export function anchorOf(path: string, line: ReviewLine, side?: 'old' | 'new'): Anchor | null {
  const chosen = side ?? (line.kind === 'del' ? 'old' : 'new')
  const number = chosen === 'old' ? line.old : line.new
  return number === undefined ? null : { path, side: chosen, line: number }
}

/** The text that stands in for a file's lines, when there are none to show. */
export function fileNote(file: ReviewFile): string | null {
  const parts: string[] = []
  if (file.note) parts.push(file.note)
  if (file.size && (file.size.old !== undefined || file.size.new !== undefined)) {
    const { old, new: now } = file.size
    parts.push(old !== undefined && now !== undefined ? `${formatBytes(old)} to ${formatBytes(now)}.` : `${formatBytes((now ?? old)!)}.`)
  }
  if (!parts.length && !file.hunks.length) parts.push('Nothing to show.')
  return parts.length ? parts.join(' ') : null
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Builds the rows of a review. */
export function buildRows(snapshot: ReviewSnapshot, options: RowOptions): Row[] {
  const rows: Row[] = []
  const byPath = new Map<string, ReviewComment[]>()
  for (const comment of options.comments) {
    const list = byPath.get(comment.path)
    if (list) list.push(comment)
    else byPath.set(comment.path, [comment])
  }
  const editing = options.editing

  snapshot.files.forEach((file, fileIndex) => {
    const id = `${file.oldPath ?? ''}>${file.path}`
    rows.push({ kind: 'file', key: `f:${id}`, file: fileIndex })
    if (options.collapsed.has(file.path)) {
      rows.push({ kind: 'gap', key: `g:${id}` })
      return
    }
    const note = fileNote(file)
    if (note) rows.push({ kind: 'note', key: `n:${id}`, file: fileIndex, text: note })

    const pending = new Map<string, ReviewComment[]>()
    for (const comment of byPath.get(file.path) ?? []) {
      const key = anchorKey(comment.side, comment.line)
      pending.set(key, [...(pending.get(key) ?? []), comment])
    }
    const editKey = editing && editing.anchor.path === file.path ? anchorKey(editing.anchor.side, editing.anchor.line) : null
    let editorPlaced = false

    /** The comments (and the comment being written) on the lines a row stands for. */
    const after = (keys: readonly string[]) => {
      for (const key of keys) {
        for (const comment of pending.get(key) ?? []) {
          if (editing?.comment?.id === comment.id) continue
          rows.push({ kind: 'comment', key: `c:${comment.id}`, file: fileIndex, comment, detached: false })
        }
        pending.delete(key)
      }
      if (editKey && !editorPlaced && keys.includes(editKey)) {
        editorPlaced = true
        rows.push({ kind: 'editor', key: `e:${editKey}`, file: fileIndex, anchor: editing!.anchor, comment: editing!.comment })
      }
    }

    file.hunks.forEach((hunk: ReviewHunk, hunkIndex) => {
      rows.push({ kind: 'hunk', key: `h:${id}:${hunk.id}`, file: fileIndex, hunk: hunkIndex })
      if (options.layout === 'split') {
        for (const [left, right] of pairLines(hunk.lines)) {
          rows.push({ kind: 'pair', key: `p:${id}:${hunk.id}:${left ?? ''}:${right ?? ''}`, file: fileIndex, hunk: hunkIndex, left, right })
          const keys: string[] = []
          if (left !== null) keys.push(...lineAnchors(hunk.lines[left]))
          if (right !== null && right !== left) keys.push(...lineAnchors(hunk.lines[right]))
          after(keys)
        }
      } else {
        hunk.lines.forEach((line, lineIndex) => {
          rows.push({ kind: 'line', key: `l:${id}:${hunk.id}:${lineIndex}`, file: fileIndex, hunk: hunkIndex, line: lineIndex })
          after(lineAnchors(line))
        })
      }
    })

    // Comments on lines this view no longer shows stay at the end of their file, so nothing written is lost.
    for (const list of pending.values()) {
      for (const comment of list) {
        if (editing?.comment?.id === comment.id) continue
        rows.push({ kind: 'comment', key: `c:${comment.id}`, file: fileIndex, comment, detached: true })
      }
    }
    if (editKey && !editorPlaced && editing?.comment) {
      rows.push({ kind: 'editor', key: `e:${editKey}`, file: fileIndex, anchor: editing.anchor, comment: editing.comment })
    }
    rows.push({ kind: 'gap', key: `g:${id}` })
  })
  return rows
}

export interface RowLayout {
  /** Where each row starts; one more entry than rows, the last being the total height. */
  tops: Float64Array
  total: number
}

export interface HeightContext {
  /** Heights comments and the comment editor were drawn at, by row key. */
  measured: ReadonlyMap<string, number>
  /** The visual lines of a line row, or of the taller side of a pair, when long lines wrap; one otherwise. */
  lines?: (row: Extract<Row, { kind: 'line' | 'pair' }>) => number
}

/** The position of every row: its known height, the lines it wraps to, or the height it was measured at. */
export function layoutRows(rows: readonly Row[], context: HeightContext): RowLayout {
  const tops = new Float64Array(rows.length + 1)
  let top = 0
  for (let index = 0; index < rows.length; index++) {
    tops[index] = top
    const row = rows[index]
    if (row.kind === 'comment' || row.kind === 'editor') top += context.measured.get(row.key) ?? ROW_HEIGHT[row.kind]
    else if ((row.kind === 'line' || row.kind === 'pair') && context.lines) top += ROW_HEIGHT[row.kind] * context.lines(row)
    else top += ROW_HEIGHT[row.kind]
  }
  tops[rows.length] = top
  return { tops, total: top }
}

/** The row at a vertical position (the last one when past the end). */
export function rowAt(layout: RowLayout, offset: number): number {
  const count = layout.tops.length - 1
  if (count <= 0) return -1
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (layout.tops[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/** The file whose header should be pinned at the top when the list is scrolled to `offset`: the one the top row is in. */
export function pinnedFile(rows: readonly Row[], layout: RowLayout, offset: number): number | null {
  const at = rowAt(layout, offset)
  for (let index = at; index >= 0; index--) {
    const row = rows[index]
    if (row.kind === 'gap') return null
    if (row.kind === 'file') return index === at && layout.tops[index] >= offset ? null : row.file
  }
  return null
}

/** The index of each file's header row, for jumping to a file. */
export function fileRows(rows: readonly Row[]): number[] {
  const found: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'file') found[row.file] = index
  })
  return found
}

/** The index of each hunk's header row, in order, for moving from change to change. */
export function hunkRows(rows: readonly Row[]): number[] {
  const found: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'hunk') found.push(index)
  })
  return found
}

/** A path's folder and name, for a header that dims the folder. */
export function pathParts(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** The letter and tone of a change, as the file header shows it. */
export function changeBadge(change: ReviewFileChange): { letter: string; tone: 'add' | 'del' | 'mod' | 'ren' | 'conflict'; label: string } {
  switch (change) {
    case 'added':
      return { letter: 'A', tone: 'add', label: 'Added' }
    case 'untracked':
      return { letter: 'U', tone: 'add', label: 'New, not tracked yet' }
    case 'deleted':
      return { letter: 'D', tone: 'del', label: 'Deleted' }
    case 'renamed':
      return { letter: 'R', tone: 'ren', label: 'Renamed' }
    case 'copied':
      return { letter: 'C', tone: 'ren', label: 'Copied' }
    case 'typechange':
      return { letter: 'T', tone: 'mod', label: 'Type changed' }
    case 'conflicted':
      return { letter: '!', tone: 'conflict', label: 'Conflict' }
    default:
      return { letter: 'M', tone: 'mod', label: 'Modified' }
  }
}

/** Files people rarely read line by line; they start folded. */
const GENERATED = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock|packages\.lock\.json)$|\.(?:min\.(?:js|css)|map|snap)$/i
/** Changed lines past which a file starts folded too, so a huge rewrite does not bury the rest. */
const LARGE_CHANGE = 1_500

export function startsFolded(file: ReviewFile): boolean {
  return GENERATED.test(file.path) || file.added + file.removed > LARGE_CHANGE
}

/**
 * Which files are folded: those that start folded, except the ones the person opened, and the ones they folded.
 * `toggled` holds the paths whose state the person changed.
 */
export function foldedPaths(files: readonly ReviewFile[], toggled: ReadonlySet<string>): Set<string> {
  const folded = new Set<string>()
  for (const file of files) if (startsFolded(file) !== toggled.has(file.path)) folded.add(file.path)
  return folded
}

/** The toggles that fold every file, or open every one. */
export function toggledForAll(files: readonly ReviewFile[], fold: boolean): Set<string> {
  return new Set(files.filter((file) => startsFolded(file) !== fold).map((file) => file.path))
}

/** A range the way git writes it: no count for one line, an empty range at the line before it. */
function range(start: number, count: number): string {
  return count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`
}

/** The line git puts above a hunk: `@@ -3,7 +3,8 @@`. */
export function hunkRange(hunk: Pick<ReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): string {
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`
}

/** The line an anchor points at in a file of the review, if the review shows it. */
export function lineAt(file: ReviewFile, anchor: Anchor): ReviewLine | null {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (anchor.side === 'old' ? line.kind !== 'add' && line.old === anchor.line : line.kind !== 'del' && line.new === anchor.line) return line
    }
  }
  return null
}

/** The first line a file's changes touch on the new side, to open the editor there. */
export function firstChangedLine(file: ReviewFile): number {
  for (const hunk of file.hunks) {
    // A removed line is where the line after the last kept one now is.
    let after = hunk.newStart
    for (const line of hunk.lines) {
      if (line.kind !== 'ctx') return line.new ?? after
      after = (line.new ?? after - 1) + 1
    }
  }
  return 1
}
