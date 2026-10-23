/**
 * Fonts, as far as reading text needs them (PDF 32000-1:2008, 9.6 to 9.10): how a string's bytes split into
 * character codes, what text each code stands for, and how far each glyph moves the pen.
 *
 * The text comes from, in order: the font's ToUnicode map; for a composite font with a Unicode CMap (UniJIS-UCS2-H
 * and the like) the codes themselves; for a legacy CJK CMap the codes read in that encoding; for a simple font its
 * encoding and glyph names. A code none of these explain is left out and counted, so Read can say so.
 */
import { BASE_ENCODINGS, glyphText, standardWidth, SYMBOL } from './encodings'
import type { PdfDocument } from './document'
import { byteString, Lexer, nameOf, PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from './objects'

export interface Glyph {
  /** What the glyph says; '' when nothing could tell. */
  text: string
  /** How far the pen moves, in text space units (thousandths of the font size for most fonts). */
  width: number
  /** The single-byte code 32, which word spacing applies to. */
  space: boolean
}

export interface Font {
  decode(bytes: Uint8Array): Glyph[]
  /** Glyphs whose text no map gave. */
  unknown: number
  /** Glyph height in text space, against the usual 1 (Type 3 fonts set their own glyph space). */
  size: number
  /** Vertical writing (WMode 1): the pen moves down, not right. */
  vertical: boolean
}

// ---------------------------------------------------------------------------
// CMaps

interface Range {
  low: number
  high: number
  bytes: number
}

/** A CMap: code space ranges, and codes to text (ToUnicode) or to CIDs (an embedded encoding). */
class CMap {
  readonly spaces: Range[] = []
  readonly single = new Map<number, string | number>()
  readonly ranges: { low: number; high: number; start: Uint8Array | number }[] = []

  lookup(code: number): string | number | undefined {
    const direct = this.single.get(code)
    if (direct !== undefined) return direct
    for (const range of this.ranges) {
      if (code < range.low || code > range.high) continue
      if (typeof range.start === 'number') return range.start + (code - range.low)
      // The last byte of the destination counts up through the range (9.10.3).
      const bytes = Uint8Array.from(range.start)
      let carry = code - range.low
      for (let i = bytes.length - 1; i >= 0 && carry; i--) {
        const sum = bytes[i] + carry
        bytes[i] = sum & 0xff
        carry = sum >> 8
      }
      return utf16(bytes)
    }
    return undefined
  }

  /** Splits a string into codes by the code space ranges (1 byte each when there are none). */
  codes(bytes: Uint8Array): { code: number; length: number }[] {
    const out: { code: number; length: number }[] = []
    const shortest = this.spaces.length ? Math.min(...this.spaces.map((range) => range.bytes)) : 1
    for (let i = 0; i < bytes.length; ) {
      let found = 0
      let value = 0
      for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
        value = value * 256 + bytes[i + n - 1]
        if (this.spaces.some((range) => range.bytes === n && value >= range.low && value <= range.high)) {
          found = n
          break
        }
      }
      const length = found || Math.min(shortest, bytes.length - i)
      let code = 0
      for (let k = 0; k < length; k++) code = code * 256 + bytes[i + k]
      out.push({ code, length })
      i += length
    }
    return out
  }
}

const bigEndian = (bytes: Uint8Array): number => {
  let value = 0
  for (const byte of bytes) value = value * 256 + byte
  return value
}

function utf16(bytes: Uint8Array): string {
  let out = ''
  let start = 0
  if (bytes[0] === 0xfe && bytes[1] === 0xff) start = 2
  if (bytes.length === 1) return String.fromCharCode(bytes[0])
  for (let i = start; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  // A lone surrogate is a broken map: drop it rather than pass on text that cannot be encoded.
  return out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
}

/** At most this many entries a CMap may hold before the rest is ignored. */
const MAX_CMAP_ENTRIES = 200_000

function parseCMap(data: Uint8Array): CMap {
  const cmap = new CMap()
  const lexer = new Lexer(data)
  const stack: PdfObject[] = []
  let entries = 0
  const value = (token: ReturnType<Lexer['next']>): PdfObject | undefined => (token.kind === 'value' ? token.value : undefined)
  for (;;) {
    const token = lexer.next()
    if (token.kind === 'eof') break
    if (token.kind === 'open-array') {
      const items: PdfObject[] = []
      for (;;) {
        const inner = lexer.next()
        if (inner.kind === 'close-array' || inner.kind === 'eof') break
        const item = value(inner)
        if (item !== undefined) items.push(item)
      }
      stack.push(items)
      continue
    }
    if (token.kind === 'value') {
      stack.push(token.value)
      if (stack.length > 4096) stack.splice(0, stack.length - 16)
      continue
    }
    if (token.kind !== 'keyword') continue
    switch (token.word) {
      case 'begincodespacerange':
      case 'beginbfchar':
      case 'beginbfrange':
      case 'begincidchar':
      case 'begincidrange':
        stack.length = 0
        break
      case 'endcodespacerange':
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const low = stack[i]
          const high = stack[i + 1]
          if (low instanceof PdfString && high instanceof PdfString && low.bytes.length) cmap.spaces.push({ low: bigEndian(low.bytes), high: bigEndian(high.bytes), bytes: low.bytes.length })
        }
        stack.length = 0
        break
      case 'endbfchar':
        for (let i = 0; i + 1 < stack.length && entries < MAX_CMAP_ENTRIES; i += 2, entries++) {
          const source = stack[i]
          const target = stack[i + 1]
          if (!(source instanceof PdfString)) continue
          const text = target instanceof PdfString ? utf16(target.bytes) : target instanceof PdfName ? glyphText(target.name) : undefined
          if (text !== undefined) cmap.single.set(bigEndian(source.bytes), text)
        }
        stack.length = 0
        break
      case 'endbfrange':
        for (let i = 0; i + 2 < stack.length && entries < MAX_CMAP_ENTRIES; i += 3) {
          const low = stack[i]
          const high = stack[i + 1]
          const target = stack[i + 2]
          if (!(low instanceof PdfString) || !(high instanceof PdfString)) continue
          const from = bigEndian(low.bytes)
          const to = bigEndian(high.bytes)
          if (to < from) continue
          if (target instanceof PdfString) {
            cmap.ranges.push({ low: from, high: to, start: target.bytes })
            entries++
          } else if (Array.isArray(target)) {
            target.forEach((item, index) => {
              if (item instanceof PdfString && from + index <= to && entries++ < MAX_CMAP_ENTRIES) cmap.single.set(from + index, utf16(item.bytes))
            })
          }
        }
        stack.length = 0
        break
      case 'endcidchar':
        for (let i = 0; i + 1 < stack.length && entries < MAX_CMAP_ENTRIES; i += 2, entries++) {
          const source = stack[i]
          const cid = stack[i + 1]
          if (source instanceof PdfString && typeof cid === 'number') cmap.single.set(bigEndian(source.bytes), cid)
        }
        stack.length = 0
        break
      case 'endcidrange':
        for (let i = 0; i + 2 < stack.length && entries < MAX_CMAP_ENTRIES; i += 3, entries++) {
          const low = stack[i]
          const high = stack[i + 1]
          const cid = stack[i + 2]
          if (low instanceof PdfString && high instanceof PdfString && typeof cid === 'number') cmap.ranges.push({ low: bigEndian(low.bytes), high: bigEndian(high.bytes), start: cid })
        }
        stack.length = 0
        break
      default:
        stack.length = 0
    }
  }
  return cmap
}

// ---------------------------------------------------------------------------
// Predefined CMaps that need no data: Identity, the Unicode ones, and legacy CJK encodings TextDecoder knows

type Predefined =
  | { kind: 'identity' }
  | { kind: 'unicode'; utf16: boolean }
  | { kind: 'legacy'; encoding: string; lead: (byte: number) => boolean }

const doubleLead = (from: number, to: number) => (byte: number) => byte >= from && byte <= to

function predefined(name: string): Predefined | undefined {
  if (/^Identity-[HV]$/.test(name)) return { kind: 'identity' }
  if (/^Uni\w+-UCS2-[HV]$/.test(name)) return { kind: 'unicode', utf16: false }
  if (/^Uni\w+-UTF16-[HV]$/.test(name)) return { kind: 'unicode', utf16: true }
  if (/RKSJ/.test(name)) return { kind: 'legacy', encoding: 'shift_jis', lead: (byte) => (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc) }
  if (/^(?:EUC|Ext-EUC|H|V)-?[HV]?$|^EUC-[HV]$/.test(name)) return { kind: 'legacy', encoding: 'euc-jp', lead: doubleLead(0x8e, 0xfe) }
  if (/^GBK|^GB18030|^GBK2K/.test(name)) return { kind: 'legacy', encoding: 'gb18030', lead: doubleLead(0x81, 0xfe) }
  if (/^GB/.test(name)) return { kind: 'legacy', encoding: 'gbk', lead: doubleLead(0xa1, 0xfe) }
  if (/B5|CNS-EUC|ETen|HKscs/.test(name)) return { kind: 'legacy', encoding: 'big5', lead: doubleLead(0x81, 0xfe) }
  if (/KSC|UHC/.test(name)) return { kind: 'legacy', encoding: 'euc-kr', lead: doubleLead(0x81, 0xfe) }
  return undefined
}

function decoderFor(encoding: string): TextDecoder | undefined {
  try {
    return new TextDecoder(encoding)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Loading a font

const LIGATURES: Record<number, string> = { 0xfb00: 'ff', 0xfb01: 'fi', 0xfb02: 'fl', 0xfb03: 'ffi', 0xfb04: 'ffl', 0xfb05: 'st', 0xfb06: 'st' }

/** Text as people type it: ligatures spelled out, soft hyphens and no-break spaces as plain ones. */
export function plainText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (LIGATURES[code]) out += LIGATURES[code]
    else if (code === 0xad) out += '-'
    else if (code === 0xa0 || code === 0x2002 || code === 0x2003 || code === 0x2009 || code === 0x202f) out += ' '
    else if (code < 0x20 && code !== 0x09 && code !== 0x0a) out += ''
    else if (code === 0xfffd) out += ''
    else out += char
  }
  return out
}

function widthsOfSimple(doc: PdfDocument, dict: PdfDict, baseFont: string): (code: number) => number {
  const first = doc.number(dict.get('FirstChar')) ?? 0
  const list = doc.array(dict.get('Widths'))?.map((value) => doc.number(value) ?? 0)
  const descriptor = doc.dict(dict.get('FontDescriptor'))
  const missing = doc.number(descriptor?.get('MissingWidth'))
  return (code) => {
    const listed = list?.[code - first]
    if (listed !== undefined && (listed > 0 || !missing)) return listed
    return standardWidth(baseFont, code) ?? missing ?? 500
  }
}

function widthsOfCid(doc: PdfDocument, descendant: PdfDict | undefined): (cid: number) => number {
  const fallback = doc.number(descendant?.get('DW')) ?? 1000
  const map = new Map<number, number>()
  const ranges: { from: number; to: number; width: number }[] = []
  const w = doc.array(descendant?.get('W')) ?? []
  for (let i = 0; i < w.length && map.size < MAX_CMAP_ENTRIES; ) {
    const first = doc.number(w[i])
    const next = doc.resolve(w[i + 1])
    if (first === undefined) break
    if (Array.isArray(next)) {
      next.forEach((value, index) => map.set(first + index, doc.number(value) ?? fallback))
      i += 2
    } else {
      const last = doc.number(next)
      const width = doc.number(w[i + 2])
      if (last === undefined || width === undefined) break
      ranges.push({ from: first, to: last, width })
      i += 3
    }
  }
  return (cid) => map.get(cid) ?? ranges.find((range) => cid >= range.from && cid <= range.to)?.width ?? fallback
}

/** The encoding of a Type 1 font program: "dup <code> /<name> put" lines before the encrypted part. */
function builtInEncoding(doc: PdfDocument, descriptor: PdfDict | undefined): Map<number, string> | undefined {
  const program = doc.resolve(descriptor?.get('FontFile'))
  if (!(program instanceof PdfStream)) return undefined
  try {
    const data = doc.streamData(program)
    if (!data) return undefined
    const clear = doc.number(program.dict.get('Length1')) ?? data.length
    const text = byteString(data.subarray(0, Math.min(clear, data.length, 64 * 1024)))
    if (/\/Encoding\s+StandardEncoding\s+def/.test(text)) return undefined
    const names = new Map<number, string>()
    for (const match of text.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g)) names.set(Number(match[1]), match[2])
    return names.size ? names : undefined
  } catch {
    return undefined
  }
}

export function loadFont(doc: PdfDocument, value: PdfObject | undefined): Font {
  const dict = doc.dict(value)
  if (!dict) return emptyFont()
  const subtype = doc.name(dict.get('Subtype'))
  const baseFont = doc.name(dict.get('BaseFont')) ?? ''
  let toUnicode: CMap | undefined
  const map = doc.resolve(dict.get('ToUnicode'))
  if (map instanceof PdfStream) {
    try {
      const data = doc.streamData(map)
      if (data) toUnicode = parseCMap(data)
    } catch {
      toUnicode = undefined
    }
  }
  if (subtype === 'Type0') return compositeFont(doc, dict, toUnicode)
  return simpleFont(doc, dict, subtype, baseFont, toUnicode)
}

function emptyFont(): Font {
  const font: Font = {
    unknown: 0,
    size: 1,
    vertical: false,
    decode(bytes) {
      // No font at all: the bytes are most likely Latin-1 text.
      return [...bytes].map((byte) => ({ text: String.fromCharCode(WIN_ANSI_OR_SELF(byte)), width: 500, space: byte === 32 }))
    },
  }
  return font
}

/** What a TextDecoder writes for bytes it cannot read. */
const REPLACEMENT = String.fromCharCode(0xfffd)

const WIN_ANSI_OR_SELF = (byte: number): number => BASE_ENCODINGS.WinAnsiEncoding[byte] || byte

function simpleFont(doc: PdfDocument, dict: PdfDict, subtype: string | undefined, baseFont: string, toUnicode: CMap | undefined): Font {
  const descriptor = doc.dict(dict.get('FontDescriptor'))
  const flags = doc.number(descriptor?.get('Flags')) ?? 0
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0
  const encodingValue = doc.resolve(dict.get('Encoding'))
  const encodingDict = encodingValue instanceof PdfDict ? encodingValue : undefined
  const baseName = encodingDict ? doc.name(encodingDict.get('BaseEncoding')) : nameOf(encodingValue)
  const plainName = baseFont.replace(/^[A-Z]{6}\+/, '')
  let base: Uint16Array
  if (baseName && BASE_ENCODINGS[baseName]) base = BASE_ENCODINGS[baseName]
  else if (/^Symbol/.test(plainName)) base = SYMBOL
  else if (subtype === 'TrueType' || symbolic) base = BASE_ENCODINGS.WinAnsiEncoding
  else base = BASE_ENCODINGS.StandardEncoding
  // Codes the font program or the Differences array name.
  const names = new Map<number, string>(subtype === 'Type1' && !baseName ? (builtInEncoding(doc, descriptor) ?? []) : [])
  const differences = encodingDict ? doc.array(encodingDict.get('Differences')) : undefined
  if (differences) {
    let code = 0
    for (const item of differences) {
      const resolved = doc.resolve(item)
      if (typeof resolved === 'number') code = resolved
      else if (resolved instanceof PdfName) names.set(code++, resolved.name)
    }
  }
  const width = widthsOfSimple(doc, dict, baseFont)
  const matrix = subtype === 'Type3' ? doc.array(dict.get('FontMatrix'))?.map((item) => doc.number(item) ?? 0) : undefined
  const scale = matrix && matrix.length >= 1 && matrix[0] ? matrix[0] * 1000 : 1
  const cache = new Map<number, string>()
  const font: Font = {
    unknown: 0,
    size: matrix && matrix.length >= 4 && matrix[3] ? Math.abs(matrix[3]) * 1000 : Math.abs(scale),
    vertical: false,
    decode(bytes) {
      const glyphs: Glyph[] = []
      for (const code of bytes) {
        let text = cache.get(code)
        if (text === undefined) {
          const mapped = toUnicode?.lookup(code)
          if (typeof mapped === 'string') text = mapped
          else {
            const glyph = names.get(code)
            const fromName = glyph !== undefined ? glyphText(glyph) : undefined
            const fromBase = base[code]
            text = fromName ?? (glyph === undefined && fromBase ? String.fromCharCode(fromBase) : '')
            if (!text && glyph !== undefined && /^(?:[A-Za-z]|[A-Za-z]{2,}\d*)$/.test(glyph) === false && code >= 32 && code < 127 && !symbolic) text = String.fromCharCode(code)
          }
          cache.set(code, text)
        }
        if (!text && code !== 0) font.unknown++
        glyphs.push({ text, width: width(code) * scale, space: code === 32 })
      }
      return glyphs
    },
  }
  return font
}

function compositeFont(doc: PdfDocument, dict: PdfDict, toUnicode: CMap | undefined): Font {
  const descendant = doc.dict(doc.array(dict.get('DescendantFonts'))?.[0])
  const width = widthsOfCid(doc, descendant)
  const encodingValue = doc.resolve(dict.get('Encoding'))
  let embedded: CMap | undefined
  let named: Predefined | undefined
  let vertical = false
  if (encodingValue instanceof PdfStream) {
    vertical = doc.number(encodingValue.dict.get('WMode')) === 1
    try {
      const data = doc.streamData(encodingValue)
      if (data) embedded = parseCMap(data)
      const parent = doc.name(encodingValue.dict.get('UseCMap'))
      if (parent) named = predefined(parent)
      if (parent?.endsWith('-V')) vertical = true
    } catch {
      embedded = undefined
    }
  } else {
    const name = nameOf(encodingValue) ?? 'Identity-H'
    named = predefined(name)
    vertical = name.endsWith('-V')
  }
  const legacy = named?.kind === 'legacy' ? decoderFor(named.encoding) : undefined
  const font: Font = {
    unknown: 0,
    size: 1,
    vertical,
    decode(bytes) {
      const glyphs: Glyph[] = []
      let codes: { code: number; length: number }[]
      if (embedded?.spaces.length) codes = embedded.codes(bytes)
      else if (toUnicode?.spaces.length && named?.kind !== 'legacy') codes = toUnicode.codes(bytes)
      else if (named?.kind === 'legacy') {
        codes = []
        for (let i = 0; i < bytes.length; ) {
          const length = named.lead(bytes[i]) && i + 1 < bytes.length ? 2 : 1
          codes.push({ code: length === 2 ? bytes[i] * 256 + bytes[i + 1] : bytes[i], length })
          i += length
        }
      } else {
        codes = []
        for (let i = 0; i + 1 < bytes.length; i += 2) codes.push({ code: bytes[i] * 256 + bytes[i + 1], length: 2 })
      }
      for (const { code, length } of codes) {
        const cidValue = embedded?.lookup(code)
        const cid = typeof cidValue === 'number' ? cidValue : code
        let text = ''
        const mapped = toUnicode?.lookup(code)
        if (typeof mapped === 'string') text = mapped
        else if (named?.kind === 'unicode') text = named.utf16 && length === 4 ? String.fromCharCode(code >>> 16, code & 0xffff) : String.fromCharCode(code)
        else if (named?.kind === 'legacy' && legacy) text = legacy.decode(length === 2 ? Uint8Array.from([code >> 8, code & 0xff]) : Uint8Array.from([code])).split(REPLACEMENT).join('')
        if (!text) font.unknown++
        glyphs.push({ text, width: width(cid), space: length === 1 && code === 32 })
      }
      return glyphs
    },
  }
  return font
}

/** Fonts by the object they come from, so a font used on every page is read once. */
export class FontCache {
  private readonly fonts = new Map<string | PdfDict, Font>()
  constructor(private readonly doc: PdfDocument) {}

  get(value: PdfObject | undefined): Font {
    const key = value instanceof PdfRef ? value.key : this.doc.dict(value)
    if (!key) return emptyFont()
    let font = this.fonts.get(key)
    if (!font) {
      try {
        font = loadFont(this.doc, value)
      } catch {
        font = emptyFont()
      }
      this.fonts.set(key, font)
    }
    return font
  }

  /** Glyphs no map explained, across every font used so far. */
  unknown(): number {
    let total = 0
    for (const font of this.fonts.values()) total += font.unknown
    return total
  }
}
