/**
 * Folding ranges as a language server gives them (`textDocument/foldingRange`): read defensively, since a server is
 * another program, and capped. Lines are the server's, 0-based; the editor turns them into its own.
 */

/** A block a server says can fold. `endCharacter` is where on its last line it ends, when the server says. */
export interface EditorFoldRange {
  startLine: number
  endLine: number
  endCharacter?: number
  kind?: 'comment' | 'imports' | 'region'
}

/** The most ranges read from one answer. */
export const MAX_FOLD_RANGES = 5_000

const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000

/** A server's answer as fold ranges: entries that are no range, or end above where they start, are skipped. */
export function readFoldingRanges(value: unknown): EditorFoldRange[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  const out: EditorFoldRange[] = []
  for (const item of value) {
    if (out.length >= MAX_FOLD_RANGES) break
    if (typeof item !== 'object' || item === null) continue
    const range = item as Record<string, unknown>
    if (!isLine(range.startLine) || !isLine(range.endLine) || range.endLine <= range.startLine) continue
    const kind = range.kind === 'comment' || range.kind === 'imports' || range.kind === 'region' ? range.kind : undefined
    out.push({
      startLine: range.startLine,
      endLine: range.endLine,
      ...(isLine(range.endCharacter) ? { endCharacter: range.endCharacter } : {}),
      ...(kind ? { kind } : {}),
    })
  }
  return out
}
