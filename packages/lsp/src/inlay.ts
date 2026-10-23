/**
 * Inlay hints as a language server gives them (`textDocument/inlayHint`): the names of the parameters a call passes
 * to, and the types the server worked out, drawn among the text without being part of it. Read defensively, since a
 * server is another program, and capped. Places are the server's, 0-based, in UTF-16 units.
 */

/** A hint the editor draws: where, what, and on which side it keeps a space. */
export interface EditorInlayHint {
  line: number
  character: number
  label: string
  /** A type the server worked out (`: number`), or the name of the parameter an argument goes to (`count:`). */
  kind?: 'type' | 'parameter'
  paddingLeft?: boolean
  paddingRight?: boolean
}

/** The most hints read from one answer. */
export const MAX_INLAY_HINTS = 2_000
/** A label longer than this is cut: a hint is a glance, not the place to read a type. */
export const MAX_INLAY_LABEL = 120

/** A regular expression character class from inclusive code point pairs, so the source holds no hidden characters. */
function characterClass(...pairs: number[]): string {
  let body = ''
  for (let index = 0; index < pairs.length; index += 2) {
    body += String.fromCodePoint(pairs[index])
    if (pairs[index + 1] !== pairs[index]) body += `-${String.fromCodePoint(pairs[index + 1])}`
  }
  return `[${body}]`
}

/** Control, bidi and zero-width characters: a label shows none of them, so a hint cannot reorder or hide the text. */
const UNSEEN = new RegExp(characterClass(0x00, 0x1f, 0x7f, 0x9f, 0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x2069, 0xfeff, 0xfeff), 'g')
const ELLIPSIS = String.fromCodePoint(0x2026)

const isUint = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000

/** The label as one line of plain text: its parts joined, control characters made spaces, runs of blanks one. */
function readLabel(value: unknown): string {
  let text = ''
  if (typeof value === 'string') text = value
  else if (Array.isArray(value)) {
    for (const part of value) {
      if (text.length > MAX_INLAY_LABEL) break
      if (typeof part === 'object' && part !== null && typeof (part as { value?: unknown }).value === 'string') text += (part as { value: string }).value
    }
  }
  text = text.slice(0, MAX_INLAY_LABEL * 2).replace(UNSEEN, ' ').replace(/\s+/g, ' ')
  if (text.length > MAX_INLAY_LABEL) text = `${text.slice(0, MAX_INLAY_LABEL - 1)}${ELLIPSIS}`
  return text
}

/** A server's answer as hints, sorted by place; entries with no place or an empty label are skipped. */
export function readInlayHints(value: unknown): EditorInlayHint[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  const out: EditorInlayHint[] = []
  for (const item of value) {
    if (out.length >= MAX_INLAY_HINTS) break
    if (typeof item !== 'object' || item === null) continue
    const hint = item as Record<string, unknown>
    const position = hint.position as { line?: unknown; character?: unknown } | undefined
    if (typeof position !== 'object' || position === null || !isUint(position.line) || !isUint(position.character)) continue
    const label = readLabel(hint.label)
    if (!label.trim()) continue
    const kind = hint.kind === 1 ? 'type' : hint.kind === 2 ? 'parameter' : undefined
    out.push({
      line: position.line,
      character: position.character,
      label,
      ...(kind ? { kind } : {}),
      ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
      ...(hint.paddingRight === true ? { paddingRight: true } : {}),
    })
  }
  out.sort((a, b) => a.line - b.line || a.character - b.character)
  return out
}
