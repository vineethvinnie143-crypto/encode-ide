/**
 * Applying a server's text edits to a document's text. Positions count UTF-16 code units, the way JavaScript strings
 * index, and a line ends at `\n`, `\r\n` or `\r`, as the protocol has it. A character past the end of its line means
 * the line's end, and a line past the end of the text means the text's end. Edits that overlap are refused: the
 * protocol forbids them, and applying them in some order would write something no one computed.
 */
import type { Position, TextEdit } from './protocol'

/** The offset of each line's first character. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++
      starts.push(index + 1)
    } else if (code === 10) starts.push(index + 1)
  }
  return starts
}

function offsetAt(text: string, starts: number[], position: Position): number {
  if (position.line >= starts.length) return text.length
  const start = starts[position.line]
  let end = position.line + 1 < starts.length ? starts[position.line + 1] : text.length
  // The line's own end, before its line break.
  if (end > start && text.charCodeAt(end - 1) === 10) end--
  if (end > start && text.charCodeAt(end - 1) === 13) end--
  return Math.min(start + position.character, end)
}

export class EditConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditConflict'
  }
}

/** The text after the edits. Throws an EditConflict for edits that overlap. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (!edits.length) return text
  const starts = lineStarts(text)
  const spans = edits.map((edit, order) => {
    const start = offsetAt(text, starts, edit.range.start)
    const end = Math.max(start, offsetAt(text, starts, edit.range.end))
    return { start, end, newText: edit.newText, order }
  })
  // Inserts at one place keep the order the server gave them.
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
  for (let index = 1; index < spans.length; index++) {
    if (spans[index].start < spans[index - 1].end) throw new EditConflict('The language server sent edits that overlap, so none of them was applied.')
  }
  const parts: string[] = []
  let at = 0
  for (const span of spans) {
    parts.push(text.slice(at, span.start), span.newText)
    at = span.end
  }
  parts.push(text.slice(at))
  return parts.join('')
}
