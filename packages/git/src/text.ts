/**
 * A file's bytes as lines a review can compare and write back: each line keeps its own ending, so a file is written
 * back with the endings it had, and lines it gains take its usual one. A NUL in the first 8000 bytes makes a file
 * binary, as git decides it.
 */

export type LineEnding = '\n' | '\r\n'

export interface TextContent {
  kind: 'text'
  /** The lines, without their endings. */
  lines: string[]
  /** Each line's ending; the last line's is '' when the file does not end with one. */
  endings: Array<LineEnding | ''>
  /** The ending most lines have, for the lines this file gains. */
  eol: LineEnding
  /** The file starts with a UTF-8 byte order mark (not part of the first line). */
  bom: boolean
  /** Some bytes are not UTF-8 and are shown as replacement characters: such a file is not written back by hunks. */
  lossy: boolean
}

export type Content =
  | TextContent
  | { kind: 'none' }
  | { kind: 'binary'; size: number }
  | { kind: 'large'; size: number }

const BINARY_PROBE = 8000
const BOM = [0xef, 0xbb, 0xbf]

export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE)
  for (let index = 0; index < end; index++) if (bytes[index] === 0) return true
  return false
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const lenient = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

/** Splits text into lines and their endings. A lone `\r` stays part of its line, as git treats it. */
export function splitLines(text: string): { lines: string[]; endings: Array<LineEnding | ''> } {
  const lines: string[] = []
  const endings: Array<LineEnding | ''> = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) {
      lines.push(text.slice(start))
      endings.push('')
      break
    }
    if (newline > start && text.charCodeAt(newline - 1) === 13) {
      lines.push(text.slice(start, newline - 1))
      endings.push('\r\n')
    } else {
      lines.push(text.slice(start, newline))
      endings.push('\n')
    }
    start = newline + 1
  }
  return { lines, endings }
}

export function dominantEnding(endings: ReadonlyArray<LineEnding | ''>): LineEnding {
  let crlf = 0
  let lf = 0
  for (const ending of endings) {
    if (ending === '\r\n') crlf++
    else if (ending === '\n') lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

export function decode(bytes: Uint8Array, limit = Infinity): Content {
  if (bytes.length > limit) return { kind: 'large', size: bytes.length }
  if (isBinary(bytes)) return { kind: 'binary', size: bytes.length }
  const bom = bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
  const body = bom ? bytes.subarray(3) : bytes
  let text: string
  let lossy = false
  try {
    text = strict.decode(body)
  } catch {
    text = lenient.decode(body)
    lossy = true
  }
  const { lines, endings } = splitLines(text)
  return { kind: 'text', lines, endings, eol: dominantEnding(endings), bom, lossy }
}

export function emptyText(eol: LineEnding = '\n'): TextContent {
  return { kind: 'text', lines: [], endings: [], eol, bom: false, lossy: false }
}

/** The bytes of lines with their endings. */
export function encode(content: Pick<TextContent, 'lines' | 'endings' | 'bom'>): Buffer {
  let text = ''
  for (let index = 0; index < content.lines.length; index++) text += content.lines[index] + content.endings[index]
  const body = Buffer.from(text, 'utf8')
  return content.bom ? Buffer.concat([Buffer.from(BOM), body]) : body
}
