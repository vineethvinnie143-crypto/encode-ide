/**
 * Text helpers the tools share: decoding files, spotting binaries, numbering
 * lines the way `cat -n` does, and cutting long output in the middle so both
 * the start and the end survive.
 */
import { createHash } from 'node:crypto'

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A NUL byte in the first 8 KB, the same test git uses. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

export type TextEncodingName = 'utf8' | 'utf8-bom' | 'utf16le'

export interface DecodedText {
  text: string
  encoding: TextEncodingName
}

/**
 * The file as text, or undefined when it is not text. UTF-8 (with or without
 * a byte order mark) and UTF-16 LE with its mark are read; anything else that
 * is not valid UTF-8 counts as binary.
 */
export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf16le' }
  }
  if (looksBinary(bytes)) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), encoding: 'utf8-bom' } : { text, encoding: 'utf8' }
  } catch {
    return undefined
  }
}

/** Bytes for `text` in a file's original encoding. */
export function encodeText(text: string, encoding: TextEncodingName): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    default:
      return Buffer.from(text, 'utf8')
  }
}

/** The line ending a text mostly uses. */
export function lineEndingOf(text: string): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (text[index - 1] === '\r') crlf++
    else lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

/** Splits on \n, \r\n or a lone \r, without a phantom empty line after a final newline. */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export const MAX_LINE_LENGTH = 2000

/** Lines numbered like `cat -n`: the number right-aligned in six columns, a tab, the line. */
export function numberLines(lines: readonly string[], firstLine: number, maxLineLength = MAX_LINE_LENGTH): string {
  return lines
    .map((line, index) => {
      const shown = line.length > maxLineLength ? `${line.slice(0, maxLineLength)}… [line truncated, ${line.length} characters]` : line
      return `${String(firstLine + index).padStart(6, ' ')}\t${shown}`
    })
    .join('\n')
}

/**
 * Keeps the first and last parts of a long text and says how much was cut
 * between them. Output of builds and tests matters most at both ends.
 */
export function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const marker = (cut: number, lines: number) => `\n\n… [${cut} characters${lines ? `, ${lines} lines` : ''} cut] …\n\n`
  const room = Math.max(0, maxLength - marker(text.length, 99999).length)
  const head = Math.ceil(room * 0.4)
  const tail = room - head
  const cutText = text.slice(head, text.length - tail)
  const lines = cutText.split('\n').length - 1
  return text.slice(0, head) + marker(cutText.length, lines) + (tail ? text.slice(text.length - tail) : '')
}

/** Removes terminal escape sequences: colours, cursor moves and window titles. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '')
}

/** Applies carriage returns the way a terminal would, so progress bars collapse to their last state. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      const index = trimmed.lastIndexOf('\r')
      return index === -1 ? trimmed : trimmed.slice(index + 1)
    })
    .join('\n')
}

/** A count with its noun: "1 file", "3 files". */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}
