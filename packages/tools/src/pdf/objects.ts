/**
 * The objects a PDF is made of, and the lexer and parser that read them from bytes (PDF 32000-1:2008, 7.2 and 7.3).
 *
 * Everything here reads untrusted input: nothing recurses without a depth limit, nothing allocates more than the
 * input it was given, and a malformed token reads as the nearest sensible value instead of throwing, the way PDF
 * readers have to.
 */

export class PdfName {
  constructor(readonly name: string) {}
}

/** A string's bytes as the file holds them; what they mean depends on where the string is used. */
export class PdfString {
  constructor(readonly bytes: Uint8Array) {}
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
  get key(): string {
    return `${this.num} ${this.gen}`
  }
}

export class PdfDict {
  constructor(readonly map: Map<string, PdfObject> = new Map()) {}
  get(key: string): PdfObject | undefined {
    return this.map.get(key)
  }
  has(key: string): boolean {
    return this.map.has(key)
  }
}

/** A stream's dictionary and its bytes as stored: still filtered, and still encrypted when the file is. */
export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    public raw: Uint8Array,
  ) {}
}

/** An operator in a content stream (Tj, BT, cm ...). */
export class PdfOp {
  constructor(readonly op: string) {}
}

export type PdfObject = null | boolean | number | PdfName | PdfString | PdfRef | PdfDict | PdfStream | PdfObject[]

export class PdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfError'
  }
}

/** How deep arrays and dictionaries may nest before the input is taken for hostile. */
const MAX_DEPTH = 64

const WHITE = new Uint8Array(256)
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITE[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

export const isWhite = (c: number): boolean => WHITE[c] === 1
const isRegular = (c: number): boolean => !WHITE[c] && !DELIM[c]
const hexValue = (c: number): number => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1)

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let out = ''
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** A byte string as one character per byte, the way names and destination keys compare. */
export const byteString = (bytes: Uint8Array): string => latin1(bytes, 0, bytes.length)

/** A token: an object that is complete in itself, or a structural keyword. */
export type Token =
  | { kind: 'value'; value: number | boolean | null | PdfName | PdfString }
  | { kind: 'open-array' | 'close-array' | 'open-dict' | 'close-dict' }
  | { kind: 'keyword'; word: string }
  | { kind: 'eof' }

export class Lexer {
  pos: number
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length,
  ) {
    this.pos = start
  }

  skipSpace(): void {
    const { bytes, end } = this
    while (this.pos < end) {
      const c = bytes[this.pos]
      if (WHITE[c]) this.pos++
      else if (c === 0x25) {
        while (this.pos < end && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d) this.pos++
      } else return
    }
  }

  next(): Token {
    this.skipSpace()
    const { bytes, end } = this
    if (this.pos >= end) return { kind: 'eof' }
    const c = bytes[this.pos]
    switch (c) {
      case 0x5b: // [
        this.pos++
        return { kind: 'open-array' }
      case 0x5d: // ]
        this.pos++
        return { kind: 'close-array' }
      case 0x28: // (
        return { kind: 'value', value: this.literalString() }
      case 0x2f: // /
        return { kind: 'value', value: this.name() }
      case 0x3c: // <
        if (bytes[this.pos + 1] === 0x3c) {
          this.pos += 2
          return { kind: 'open-dict' }
        }
        return { kind: 'value', value: this.hexString() }
      case 0x3e: // >
        if (bytes[this.pos + 1] === 0x3e) {
          this.pos += 2
          return { kind: 'close-dict' }
        }
        this.pos++
        return this.next()
      case 0x7b: // { } belong to PostScript functions; they carry nothing a reader of text needs.
      case 0x7d:
      case 0x29: // a stray )
        this.pos++
        return this.next()
    }
    const start = this.pos
    while (this.pos < end && isRegular(bytes[this.pos])) this.pos++
    const word = latin1(bytes, start, this.pos)
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const number = parseNumber(word)
      if (number !== undefined) return { kind: 'value', value: number }
    }
    if (word === 'true') return { kind: 'value', value: true }
    if (word === 'false') return { kind: 'value', value: false }
    if (word === 'null') return { kind: 'value', value: null }
    return { kind: 'keyword', word }
  }

  private name(): PdfName {
    const { bytes, end } = this
    this.pos++
    let out = ''
    while (this.pos < end && isRegular(bytes[this.pos])) {
      const c = bytes[this.pos]
      if (c === 0x23 && this.pos + 2 < end) {
        const high = hexValue(bytes[this.pos + 1])
        const low = hexValue(bytes[this.pos + 2])
        if (high >= 0 && low >= 0) {
          out += String.fromCharCode(high * 16 + low)
          this.pos += 3
          continue
        }
      }
      out += String.fromCharCode(c)
      this.pos++
    }
    return new PdfName(out)
  }

  private literalString(): PdfString {
    const { bytes, end } = this
    this.pos++
    const out: number[] = []
    let depth = 1
    while (this.pos < end) {
      let c = bytes[this.pos++]
      if (c === 0x28) depth++
      else if (c === 0x29) {
        if (--depth === 0) break
      } else if (c === 0x5c) {
        c = bytes[this.pos++]
        switch (c) {
          case 0x6e: out.push(0x0a); continue // n
          case 0x72: out.push(0x0d); continue // r
          case 0x74: out.push(0x09); continue // t
          case 0x62: out.push(0x08); continue // b
          case 0x66: out.push(0x0c); continue // f
          case 0x0d: // a line continuation
            if (bytes[this.pos] === 0x0a) this.pos++
            continue
          case 0x0a:
            continue
        }
        if (c >= 0x30 && c <= 0x37) {
          let value = c - 0x30
          for (let digits = 1; digits < 3 && bytes[this.pos] >= 0x30 && bytes[this.pos] <= 0x37; digits++) value = value * 8 + bytes[this.pos++] - 0x30
          out.push(value & 0xff)
          continue
        }
        if (c !== undefined) out.push(c)
        continue
      } else if (c === 0x0d) {
        // An end of line inside a string is a line feed, whichever bytes wrote it.
        if (bytes[this.pos] === 0x0a) this.pos++
        out.push(0x0a)
        continue
      }
      out.push(c)
    }
    return new PdfString(Uint8Array.from(out))
  }

  private hexString(): PdfString {
    const { bytes, end } = this
    this.pos++
    const out: number[] = []
    let high = -1
    while (this.pos < end) {
      const c = bytes[this.pos++]
      if (c === 0x3e) break
      const value = hexValue(c)
      if (value < 0) continue
      if (high < 0) high = value
      else {
        out.push(high * 16 + value)
        high = -1
      }
    }
    if (high >= 0) out.push(high * 16)
    return new PdfString(Uint8Array.from(out))
  }
}

function parseNumber(word: string): number | undefined {
  // Writers produce "--5", "4.-2" and "-" alone; readers take the number that was meant, or 0.
  const clean = word.replace(/^([+-])[+-]+/, '$1').replace(/(\d)-(?=\d)/g, '$1')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(clean)) return clean === '-' || clean === '+' || clean === '.' ? 0 : undefined
  const value = Number(clean)
  return Number.isFinite(value) ? value : undefined
}

/** Reads objects from a lexer: `N G R` references, arrays and dictionaries; streams are left to the caller. */
export class Parser {
  private buffer: Token[] = []

  constructor(readonly lexer: Lexer) {}

  peek(): Token {
    if (!this.buffer.length) this.buffer.push(this.lexer.next())
    return this.buffer[0]
  }

  take(): Token {
    return this.buffer.length ? this.buffer.shift()! : this.lexer.next()
  }

  /** Where the next token starts, once the tokens already looked at are read. */
  get position(): number {
    return this.buffer.length ? -1 : this.lexer.pos
  }

  /** The next object; `undefined` at the end or at a keyword (which is then the next token). */
  object(depth = 0): PdfObject | undefined {
    const token = this.peek()
    switch (token.kind) {
      case 'eof':
        return undefined
      case 'keyword':
        return undefined
      case 'value': {
        this.take()
        if (typeof token.value === 'number' && Number.isInteger(token.value) && token.value >= 0) return this.maybeRef(token.value)
        return token.value
      }
      case 'open-array': {
        this.take()
        if (depth > MAX_DEPTH) throw new PdfError('Arrays nest too deeply.')
        const items: PdfObject[] = []
        for (;;) {
          const next = this.peek()
          if (next.kind === 'close-array') {
            this.take()
            return items
          }
          if (next.kind === 'eof') return items
          const item = this.object(depth + 1)
          if (item === undefined) {
            // A keyword inside an array (an operator in a broken stream, or R without numbers): skip it.
            if (this.peek().kind === 'keyword') this.take()
            else if (this.peek().kind === 'close-dict') this.take()
            continue
          }
          items.push(item)
        }
      }
      case 'open-dict': {
        this.take()
        if (depth > MAX_DEPTH) throw new PdfError('Dictionaries nest too deeply.')
        const map = new Map<string, PdfObject>()
        for (;;) {
          const next = this.take()
          if (next.kind === 'close-dict' || next.kind === 'eof') return new PdfDict(map)
          if (next.kind !== 'value' || !(next.value instanceof PdfName)) continue
          const value = this.object(depth + 1)
          if (value === undefined) {
            const after = this.peek()
            if (after.kind === 'close-dict') continue
            if (after.kind === 'keyword') this.take()
            continue
          }
          map.set(next.value.name, value)
        }
      }
      case 'close-array':
      case 'close-dict':
        this.take()
        return this.object(depth)
    }
  }

  private maybeRef(num: number): PdfObject {
    const second = this.peek()
    if (second.kind !== 'value' || typeof second.value !== 'number' || !Number.isInteger(second.value) || second.value < 0) return num
    // Two numbers and an R: a reference. Anything else leaves both numbers to be read as numbers.
    const gen = this.take() as { kind: 'value'; value: number }
    const third = this.peek()
    if (third.kind === 'keyword' && third.word === 'R') {
      this.take()
      return new PdfRef(num, gen.value)
    }
    this.buffer.unshift(gen)
    return num
  }
}

// ---------------------------------------------------------------------------
// Helpers for reading values

export const nameOf = (value: PdfObject | undefined): string | undefined => (value instanceof PdfName ? value.name : undefined)
export const numberOf = (value: PdfObject | undefined): number | undefined => (typeof value === 'number' ? value : undefined)
export const isDict = (value: PdfObject | undefined): value is PdfDict => value instanceof PdfDict

/** A text string (7.9.2.2): UTF-16BE or UTF-8 behind a byte order mark, else PDFDocEncoding. */
export function textString(value: PdfObject | undefined): string | undefined {
  if (!(value instanceof PdfString)) return undefined
  const bytes = value.bytes
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    return out
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(PDF_DOC_CODES[byte] ?? byte)
  return out
}

/** PDFDocEncoding where it differs from Latin-1 (Annex D.2). */
const PDF_DOC_CODES: Record<number, number> = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
}

/** Finds `needle` (ASCII) in `bytes` from `from`, or -1. */
export function indexOf(bytes: Uint8Array, needle: string, from = 0, to = bytes.length): number {
  const first = needle.charCodeAt(0)
  const last = to - needle.length
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] !== first) continue
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer
    return i
  }
  return -1
}

/** Finds the last `needle` (ASCII) in `bytes` that starts before `before`, or -1. */
export function lastIndexOf(bytes: Uint8Array, needle: string, before = bytes.length, notBelow = 0): number {
  const first = needle.charCodeAt(0)
  outer: for (let i = Math.min(before, bytes.length - needle.length); i >= notBelow; i--) {
    if (bytes[i] !== first) continue
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer
    return i
  }
  return -1
}
