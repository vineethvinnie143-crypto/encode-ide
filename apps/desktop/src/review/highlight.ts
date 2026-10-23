/**
 * Syntax colours for the Review tab's lines, from the editor's own tokenizers. A hunk is read as two runs of text:
 * the old side (kept and removed lines) and the new side (kept and added lines), each from the language's start
 * state, so a removed line is coloured as the old file read and an added one as the new file reads. A string or
 * comment that opened above the hunk is not known; whole-file context makes it exact.
 */
import type { ReviewHunk } from '@shared/types'
import { lineColoursFor, tokenClass, type LineColours } from '../editor/surface'

/** Characters of one line drawn; a minified bundle's line stops here with an ellipsis. */
export const DISPLAY_LIMIT = 2_000

export interface Segment {
  text: string
  /** The token's class, or '' for plain text. */
  className: string
  /** Part of a word that changed on this line. */
  changed: boolean
}

/** Each line's tokens ([start, kind, ...]), in the order of the hunk's lines. */
export function tokenizeHunk(colours: LineColours, hunk: ReviewHunk): Array<readonly number[]> {
  const out: Array<readonly number[]> = new Array(hunk.lines.length)
  let oldState = colours.start
  let newState = colours.start
  hunk.lines.forEach((line, index) => {
    if (line.kind === 'del') {
      const result = colours.line(line.text, oldState)
      out[index] = result.tokens
      oldState = result.state
    } else if (line.kind === 'add') {
      const result = colours.line(line.text, newState)
      out[index] = result.tokens
      newState = result.state
    } else {
      const result = colours.line(line.text, newState)
      out[index] = result.tokens
      // A kept line is on both sides; the old side moves on from its own state.
      oldState = oldState === newState ? result.state : colours.line(line.text, oldState).state
      newState = result.state
    }
  })
  return out
}

/** Tokens by hunk, worked out once per hunk and kept while the same hunk is shown. */
export class HunkTokens {
  private readonly cache = new Map<string, Array<readonly number[]>>()

  get(path: string, hunk: ReviewHunk): Array<readonly number[]> {
    const key = `${path}\u0000${hunk.id}`
    let tokens = this.cache.get(key)
    if (!tokens) {
      tokens = tokenizeHunk(lineColoursFor(path), hunk)
      // Hunks of earlier reviews are let go of in bulk; a review rarely has this many.
      if (this.cache.size > 4_000) this.cache.clear()
      this.cache.set(key, tokens)
    }
    return tokens
  }
}

/** A line's text as runs of one token kind and one changed state, cut to DISPLAY_LIMIT characters. */
export function segmentsOf(text: string, tokens: readonly number[] | undefined, words: ReadonlyArray<readonly [number, number]> | undefined): Segment[] {
  const length = Math.min(text.length, DISPLAY_LIMIT)
  if (!length) return []
  const cuts = new Set<number>([0, length])
  const kinds: Array<[number, number]> = []
  if (tokens) {
    for (let index = 0; index < tokens.length; index += 2) {
      const start = tokens[index]
      if (start >= length) break
      cuts.add(start)
      kinds.push([start, tokens[index + 1]])
    }
  }
  const marks: Array<[number, number]> = []
  for (const [from, to] of words ?? []) {
    if (from >= length || to <= from) continue
    cuts.add(from)
    cuts.add(Math.min(to, length))
    marks.push([from, Math.min(to, length)])
  }
  const points = [...cuts].sort((a, b) => a - b)
  const segments: Segment[] = []
  let kindAt = 0
  let kind = 0
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index]
    const to = points[index + 1]
    while (kindAt < kinds.length && kinds[kindAt][0] <= from) kind = kinds[kindAt++][1]
    const changed = marks.some(([start, end]) => start <= from && to <= end)
    const piece = { text: text.slice(from, to), className: tokenClass(kind), changed }
    const last = segments[segments.length - 1]
    if (last && last.className === piece.className && last.changed === piece.changed) last.text += piece.text
    else segments.push(piece)
  }
  if (text.length > length) segments.push({ text: '…', className: 'rv-cut', changed: false })
  return segments
}
