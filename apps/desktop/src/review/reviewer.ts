/**
 * The Reviewer's findings as comments of the Review tab. The Reviewer reads more lines around each change than the
 * view may show, so a finding on a line the view leaves out goes to the nearest line it shows, and says which line it
 * was about.
 */
import type { ReviewFile, ReviewFinding, ReviewSnapshot } from '@shared/types'
import { lineAt, type Anchor, type ReviewComment } from './rows'

/** The line of the file the view shows nearest to `line` on `side`, else on the other side; null when it shows none. */
export function nearestAnchor(file: ReviewFile, side: 'old' | 'new', line: number): Anchor | null {
  const on = (wanted: 'old' | 'new'): Anchor | null => {
    let best: Anchor | null = null
    for (const hunk of file.hunks) {
      for (const shown of hunk.lines) {
        const number = wanted === 'old' ? (shown.kind !== 'add' ? shown.old : undefined) : shown.kind !== 'del' ? shown.new : undefined
        if (number === undefined) continue
        if (!best || Math.abs(number - line) < Math.abs(best.line - line)) best = { path: file.path, side: wanted, line: number }
      }
    }
    return best
  }
  return on(side) ?? on(side === 'old' ? 'new' : 'old')
}

/** Comments for the findings, on the lines of `snapshot` (the view they go into, when it is the one shown). */
export function findingComments(findings: readonly ReviewFinding[], snapshot: ReviewSnapshot | null, newId: () => string = () => crypto.randomUUID()): ReviewComment[] {
  return findings.map((finding) => {
    const file = snapshot?.files.find((candidate) => candidate.path === finding.path)
    const asked: Anchor = { path: finding.path, side: finding.side, line: finding.line }
    const anchor = (file && (lineAt(file, asked) ? asked : nearestAnchor(file, finding.side, finding.line))) || asked
    const moved = anchor.line !== asked.line || anchor.side !== asked.side
    const about = `${finding.side === 'old' ? 'old line' : 'line'} ${finding.line}`
    const body = finding.body.trim() || finding.title
    return {
      id: newId(),
      ...anchor,
      text: moved ? `About ${about}: ${body}` : body,
      excerpt: (file && lineAt(file, anchor)?.text) ?? '',
      by: 'reviewer',
      priority: finding.priority,
      title: finding.title,
    }
  })
}
