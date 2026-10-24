/**
 * What the Reviewer is given: a review's files as hunks whose lines carry their numbers in the file, so a finding can
 * name its line, cut to a size one request can hold. Lock files and minified code are named but not read; files past
 * the budget are counted, not sent.
 */
import type { ReviewFile, ReviewSnapshot } from '../../shared/types'
import type { CodeReviewFile, CodeReviewInput } from '@encode/core'

/** About 30,000 tokens of change. */
export const MAX_REVIEW_CHARS = 120_000
/** Unchanged lines around each change the Reviewer reads, at least: three are too few to judge a change by. */
export const REVIEW_CONTEXT = 10
const MAX_LINE_CHARS = 400

const UNREAD = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$|\.min\.(?:js|css)$|\.map$/i

/** The change in words, for the Reviewer. */
export function reviewerScope(snapshot: ReviewSnapshot): string {
  const scope = snapshot.scope
  switch (scope.kind) {
    case 'unstaged':
      return 'the unstaged changes in the working tree'
    case 'staged':
      return 'the staged changes, which the next commit takes'
    case 'branch': {
      const branch = snapshot.repo.branch
      const base = snapshot.base?.ref
      return `the changes on ${branch ? `branch ${branch}` : 'this branch'}${base ? ` against ${base}` : ''}`
    }
    case 'commit':
      return snapshot.commit ? `commit ${snapshot.commit.short} ("${snapshot.commit.subject}")` : `commit ${scope.commit.slice(0, 7)}`
    case 'turn':
      return 'what a coding agent changed for one request'
  }
}

/** Why a file's lines are not in the request, when they are not. */
function withoutLines(file: ReviewFile): string | null {
  if (UNREAD.test(file.path)) return '(generated or lock file: not reviewed)'
  switch (file.kind) {
    case 'binary':
      return '(binary file: not shown)'
    case 'large':
      return '(too large to show)'
    case 'submodule':
      return '(submodule: the commit it points at changed)'
    case 'symlink':
      return '(symbolic link)'
    case 'folder':
      return '(folder)'
  }
  return file.hunks.length ? null : `(${file.note ?? 'no lines to show'})`
}

/** A file's hunks, each line marked "+", "-" or " " and numbered in its file: a removed line by its old number. */
export function numberedHunks(file: ReviewFile): string {
  const out: string[] = []
  for (const hunk of file.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      const number = line.kind === 'del' ? line.old : line.new
      const text = line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text
      out.push(`${mark}${number ?? '?'} | ${text}`)
    }
  }
  return out.join('\n')
}

/**
 * The Reviewer's request for a review: the files whose lines fit in `budget` characters, with those lines, and the
 * files that have none to read, by name. `read`: how many files went with their lines.
 */
export function codeReviewInput(snapshot: ReviewSnapshot, budget = MAX_REVIEW_CHARS): { request: CodeReviewInput; read: number } {
  const files: CodeReviewFile[] = []
  let left = snapshot.skipped
  let used = 0
  let read = 0
  for (const file of snapshot.files) {
    const named = { path: file.path, ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}), change: file.change }
    const note = withoutLines(file)
    if (note) {
      files.push({ ...named, text: note })
      continue
    }
    const text = numberedHunks(file)
    if (used + text.length > budget) {
      left++
      continue
    }
    used += text.length
    read++
    files.push({ ...named, text })
  }
  return { request: { scope: reviewerScope(snapshot), files, left }, read }
}
