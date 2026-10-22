/**
 * Comments written in the Review tab go to the agent as one message: each names its file and line and quotes the
 * line, so the agent can find it without reading the review, and the message stays short.
 */
import type { ReviewScope, ReviewSnapshot } from '@shared/types'
import type { ReviewComment } from './rows'

const EXCERPT_CHARS = 200

const REQUEST_CHARS = 80

/**
 * What the comments are about, in words: "the unstaged changes", "commit 1a2b3c4 (Fix the parser)". In the Turn view,
 * `request` is what the person asked, which names the changes for the agent.
 */
export function scopePhrase(scope: ReviewScope, snapshot: ReviewSnapshot | null, request?: string): string {
  switch (scope.kind) {
    case 'turn': {
      const asked = request?.replace(/\s+/g, ' ').trim()
      if (!asked) return 'the changes you made in your last turn'
      return `the changes you made for my request "${asked.length > REQUEST_CHARS ? `${asked.slice(0, REQUEST_CHARS)}…` : asked}"`
    }
    case 'unstaged':
      return 'the unstaged changes'
    case 'staged':
      return 'the staged changes'
    case 'branch': {
      const base = snapshot?.scope.kind === 'branch' ? snapshot.base?.ref : scope.base
      const branch = snapshot?.repo.branch
      return `the changes on ${branch ? `branch ${branch}` : 'this branch'}${base ? ` against ${base}` : ''}`
    }
    case 'commit': {
      const commit = snapshot?.commit
      return commit ? `commit ${commit.short} (${commit.subject})` : `commit ${scope.commit.slice(0, 7)}`
    }
  }
}

/** The message that hands the comments to the agent; `name` gives a file the name the agent knows it by. */
export function commentsMessage(comments: readonly ReviewComment[], phrase: string, name: (path: string) => string = (path) => path): string {
  const sorted = [...comments].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
  const items = sorted.map((comment, index) => {
    const file = name(comment.path)
    const where = comment.side === 'old' ? `${file}, line ${comment.line} before the change` : `${file}:${comment.line}`
    const excerpt = comment.excerpt.trim()
    const quoted = excerpt ? `\n> ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}` : ''
    return `${index + 1}. ${where}${quoted}\n${comment.text.trim()}`
  })
  const lead = comments.length === 1 ? `A review comment on ${phrase}. Address it:` : `Review comments on ${phrase}. Address each one:`
  return `${lead}\n\n${items.join('\n\n')}`
}
