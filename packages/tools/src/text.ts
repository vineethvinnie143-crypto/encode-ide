/**
 * Text helpers the tools share: decoding files, spotting binaries, numbering
 * lines the way `cat -n` does, and cutting long output in the middle so both
 * the start and the end survive.
 */
import { createHash } from 'node:crypto'

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** How much of a file is looked at to tell text from binary. */
export const SNIFF_BYTES = 8192

/** The biggest file the tools load whole: Read, Edit, Write and Grep leave larger ones to a command. */
export const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024

/** A NUL byte in the first 8 KB, the same test git uses. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0)
}

/** Whether the start of a file can be text: a UTF-16 byte order mark, or no NUL byte. */
export function looksLikeText(head: Uint8Array): boolean {
  return (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) || !looksBinary(head)
}

/**
 * Bytes 0x80 to 0x9F in Windows-1252. The five bytes it leaves undefined keep their own
 * code points, as browsers do, so every byte has a character and every character its byte.
 */
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
]
const WINDOWS_1252_BYTE = new Map(WINDOWS_1252_HIGH.map((code, index) => [code, 0x80 + index]))

export type TextEncodingName = 'utf8' | 'utf8-bom' | 'utf16le' | 'windows-1252'

export interface DecodedText {
  text: string
  encoding: TextEncodingName
}

/** A character a file's encoding has no byte for. */
export class UnencodableTextError extends Error {
  constructor(
    readonly character: string,
    readonly encoding: TextEncodingName,
  ) {
    super(`${JSON.stringify(character)} cannot be written in a ${encoding} file.`)
  }
}

/** Binary data has many control bytes; text has almost none. */
function mostlyControlBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES)
  let control = 0
  for (const byte of head) if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x08 && byte !== 0x1b) || byte === 0x7f) control++
  return control > head.length * 0.01
}

function decodeWindows1252(bytes: Uint8Array): string {
  let text = ''
  const step = 8192
  for (let from = 0; from < bytes.length; from += step) {
    const chunk = Array.from(bytes.subarray(from, from + step), (byte) => (byte >= 0x80 && byte < 0xa0 ? WINDOWS_1252_HIGH[byte - 0x80] : byte))
    text += String.fromCharCode(...chunk)
  }
  return text
}

function encodeWindows1252(text: string): Buffer {
  const out = Buffer.allocUnsafe(text.length)
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const byte = code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : WINDOWS_1252_BYTE.get(code)
    if (byte === undefined) throw new UnencodableTextError(String.fromCodePoint(text.codePointAt(index)!), 'windows-1252')
    out[index] = byte
  }
  return out
}

/**
 * The file as text, or undefined when it is not text. UTF-8 (with or without
 * a byte order mark) and UTF-16 LE with its mark are read. Text that is not
 * valid UTF-8 is an older Windows file and is read as Windows-1252, which
 * writes back byte for byte; data with many control bytes, or any NUL, counts
 * as binary.
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
    return mostlyControlBytes(bytes) || bytes.includes(0) ? undefined : { text: decodeWindows1252(bytes), encoding: 'windows-1252' }
  }
}

/** Bytes for `text` in a file's original encoding; throws UnencodableTextError for a character the encoding cannot hold. */
export function encodeText(text: string, encoding: TextEncodingName): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'windows-1252':
      return encodeWindows1252(text)
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
