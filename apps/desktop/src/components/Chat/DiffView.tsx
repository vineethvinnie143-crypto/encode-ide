import type { DiffHunk } from '@shared/types'

/** A step's diff shows this many lines at most. */
export const MAX_DIFF_LINES = 260

/** The lines a step's diff shows, in order. */
export function shownDiffLines(diff: readonly DiffHunk[]): string[] {
  return diff.flatMap((hunk) => hunk.lines.map((line) => line.text)).slice(0, MAX_DIFF_LINES)
}

export default function DiffView({ diff }: { diff: DiffHunk[] }) {
  if (!diff.length) return null
  const maxLines = MAX_DIFF_LINES
  let rendered = 0

  return (
    <div className="diff-view">
      {diff.map((hunk, hunkIndex) => {
        const lines = hunk.lines.slice(0, Math.max(0, maxLines - rendered))
        rendered += lines.length
        return (
          <div className="diff-hunk" key={hunkIndex}>
            <div className="diff-hunk-header">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {lines.map((line, lineIndex) => (
              <div className={`diff-line diff-${line.type}`} key={lineIndex}>
                <span className="diff-gutter">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                </span>
                <span className="diff-text">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        )
      })}
      {rendered < diff.reduce((total, hunk) => total + hunk.lines.length, 0) && (
        <div className="diff-more">Diff truncated for display.</div>
      )}
    </div>
  )
}
