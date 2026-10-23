/**
 * A new, small PDF made of some of a file's pages, for a model that reads PDFs itself: it sees the pages as they
 * look (figures, scans, tables) without being sent the whole file.
 *
 * Each page is copied with what it draws: its content, fonts, images and forms. Links, form fields, thumbnails,
 * metadata and the structure tree are left behind; they point at the rest of the file and add bytes without adding
 * anything a reader sees. The copy is not encrypted: eNCode only opens files anyone may open.
 */
import type { PdfDocument, PdfPage } from './document'
import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from './objects'

/** Keys whose values a copied page does without. */
const LEFT_OUT = new Set(['Parent', 'Annots', 'B', 'Thumb', 'PieceInfo', 'Metadata', 'StructParents', 'StructParent', 'AA', 'Tabs', 'ID', 'PZ', 'SeparationInfo'])

class TooBig extends Error {}

const encoder = new TextEncoder()

function number(value: number): string {
  if (Number.isInteger(value)) return String(value)
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function name(value: string): string {
  let out = '/'
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i) & 0xff
    // Delimiters, white space, # and anything outside printable ASCII are written as #xx.
    if (code < 0x21 || code > 0x7e || '()<>[]{}/%#'.includes(value[i])) out += `#${code.toString(16).padStart(2, '0')}`
    else out += value[i]
  }
  return out
}

function hex(bytes: Uint8Array): string {
  let out = '<'
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out + '>'
}

class Writer {
  private readonly chunks: Uint8Array[] = []
  private length = 0
  readonly offsets: number[] = [0]

  constructor(private readonly maxBytes: number) {}

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    this.length += bytes.length
    if (this.length > this.maxBytes) throw new TooBig()
    this.chunks.push(bytes)
  }

  get position(): number {
    return this.length
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

/** The selected pages as a PDF of their own, or undefined when it would be over `maxBytes`. */
export function subsetPdf(doc: PdfDocument, pages: PdfPage[], maxBytes: number): Uint8Array | undefined {
  // New numbers: 1 is the catalog, 2 the page tree, then the pages, then what they use.
  const numbers = new Map<string, number>()
  const queue: PdfRef[] = []
  let next = 3 + pages.length
  const pageRefs = new Set(pages.map((page) => page.ref?.key).filter(Boolean))
  const numberOf = (ref: PdfRef): number | undefined => {
    let num = numbers.get(ref.key)
    if (num === undefined) {
      const target = doc.resolve(ref)
      // Another page (from a stray link) would pull in the whole file.
      const type = target instanceof PdfDict ? doc.name(target.get('Type')) : undefined
      if ((type === 'Page' || type === 'Pages') && !pageRefs.has(ref.key)) return undefined
      num = next++
      numbers.set(ref.key, num)
      queue.push(ref)
    }
    return num
  }

  const serialize = (value: PdfObject | undefined, depth: number): string => {
    if (depth > 64) return 'null'
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number') return number(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (value instanceof PdfName) return name(value.name)
    if (value instanceof PdfString) return hex(value.bytes)
    if (value instanceof PdfRef) {
      const num = numberOf(value)
      return num === undefined ? 'null' : `${num} 0 R`
    }
    if (Array.isArray(value)) return `[${value.map((item) => serialize(item, depth + 1)).join(' ')}]`
    if (value instanceof PdfDict) return dict(value, depth)
    // A stream inside another object cannot be written; PDF only allows streams as objects of their own.
    return 'null'
  }
  const dict = (value: PdfDict, depth: number, skip?: Set<string>): string => {
    const parts: string[] = []
    for (const [key, item] of value.map) {
      if (skip?.has(key)) continue
      parts.push(`${name(key)} ${serialize(item, depth + 1)}`)
    }
    return `<<${parts.join(' ')}>>`
  }

  const out = new Writer(maxBytes)
  try {
    // The header, then a comment of high bytes that marks the file as binary.
    out.write('%PDF-1.7\n')
    out.write(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a))
    const object = (num: number, body: string | Uint8Array, stream?: Uint8Array) => {
      out.offsets[num] = out.position
      out.write(`${num} 0 obj\n`)
      out.write(body)
      if (stream) {
        out.write('\nstream\n')
        out.write(stream)
        out.write('\nendstream')
      }
      out.write('\nendobj\n')
    }
    object(1, '<</Type /Catalog /Pages 2 0 R>>')
    object(2, `<</Type /Pages /Kids [${pages.map((_, index) => `${3 + index} 0 R`).join(' ')}] /Count ${pages.length}>>`)
    pages.forEach((page, index) => {
      if (page.ref) numbers.set(page.ref.key, 3 + index)
    })
    pages.forEach((page, index) => {
      // What a page inherits from the tree is written on the page itself.
      const own = dict(page.dict, 0, new Set([...LEFT_OUT, 'Resources', 'MediaBox', 'CropBox', 'Rotate', 'Type']))
      const resources = page.dict.get('Resources') instanceof PdfRef ? page.dict.get('Resources') : page.resources
      const extra = [
        '/Type /Page',
        '/Parent 2 0 R',
        `/MediaBox [${page.box.map(number).join(' ')}]`,
        page.rotate ? `/Rotate ${page.rotate}` : '',
        `/Resources ${resources ? serialize(resources, 1) : '<<>>'}`,
      ].filter(Boolean)
      object(3 + index, `<<${extra.join(' ')} ${own.slice(2)}`)
    })
    for (let i = 0; i < queue.length; i++) {
      const ref = queue[i]
      const num = numbers.get(ref.key)!
      const value = doc.resolve(ref)
      if (value instanceof PdfStream) {
        const head = new PdfDict(new Map(value.dict.map))
        head.map.set('Length', value.raw.length)
        object(num, dict(head, 0, new Set(['Metadata', 'PieceInfo', 'DL'])), value.raw)
      } else object(num, serialize(value, 0))
    }
    const xref = out.position
    const size = next
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`
    for (let num = 1; num < size; num++) {
      const offset = out.offsets[num]
      table += offset === undefined ? '0000000000 65535 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`
    }
    out.write(table)
    out.write(`trailer\n<</Size ${size} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`)
    return out.bytes()
  } catch (error) {
    if (error instanceof TooBig) return undefined
    throw error
  }
}
