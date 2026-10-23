/**
 * A PDF file's structure (PDF 32000-1:2008, 7.5 and 7.7): the cross-reference sections that say where each object
 * is, objects packed in object streams, the trailer, the page tree and the outline.
 *
 * Files in the wild are often damaged: offsets that are off, a cross-reference table that is missing, streams
 * whose length is wrong. When the cross-reference data does not hold up, the objects are found by scanning the
 * file, as other readers do.
 */
import { decodeStream, type DecodeBudget } from './filters'
import { openSecurity, streamIsClear, type Decryptor } from './crypt'
import {
  byteString,
  indexOf,
  isDict,
  isWhite,
  lastIndexOf,
  Lexer,
  nameOf,
  numberOf,
  Parser,
  PdfDict,
  PdfError,
  PdfRef,
  PdfStream,
  PdfString,
  textString,
  type PdfObject,
} from './objects'

type XrefEntry = { type: 1; offset: number; gen: number } | { type: 2; stream: number; index: number }

export interface PdfPage {
  dict: PdfDict
  ref?: PdfRef
  resources?: PdfDict
  /** [x0, y0, x1, y1] in default user space. */
  box: [number, number, number, number]
  rotate: number
}

export interface OutlineItem {
  title: string
  depth: number
  /** The 1-based page it leads to, when that can be told. */
  page?: number
}

/** Pages a file may say it has before eNCode stops believing it. */
const MAX_PAGES = 100_000
const MAX_OUTLINE = 400

export class PdfDocument {
  private readonly entries = new Map<number, XrefEntry>()
  private readonly cache = new Map<number, PdfObject>()
  private readonly objectStreams = new Map<number, Map<number, PdfObject>>()
  private readonly resolving = new Set<number>()
  private trailer = new PdfDict()
  private decryptor: Decryptor | undefined
  private encrypt: PdfDict | undefined
  private pageList: PdfPage[] | undefined
  private scanned = false
  /** What could not be read as the file said, for a note. */
  readonly repairs: string[] = []

  private constructor(
    readonly bytes: Uint8Array,
    readonly budget: DecodeBudget,
  ) {}

  static open(bytes: Uint8Array, budget: DecodeBudget): PdfDocument {
    const doc = new PdfDocument(bytes, budget)
    if (indexOf(bytes, '%PDF-', 0, Math.min(bytes.length, 1024)) < 0) throw new PdfError('The file does not start like a PDF.')
    let ok = false
    try {
      ok = doc.readXrefChain()
    } catch {
      ok = false
    }
    if (!ok || !doc.catalog()) {
      doc.reconstruct()
      if (!doc.catalog()) throw new PdfError('The file has no document catalog: it is damaged beyond reading.')
    }
    doc.openEncryption()
    return doc
  }

  // ------------------------------------------------------------ cross-references

  private readXrefChain(): boolean {
    const { bytes } = this
    const at = lastIndexOf(bytes, 'startxref', bytes.length, Math.max(0, bytes.length - 64 * 1024))
    if (at < 0) return false
    const lexer = new Lexer(bytes, at + 9)
    const token = lexer.next()
    if (token.kind !== 'value' || typeof token.value !== 'number') return false
    let offset: number | undefined = token.value
    const seen = new Set<number>()
    let first = true
    while (offset !== undefined && offset >= 0 && offset < bytes.length && !seen.has(offset)) {
      seen.add(offset)
      const section = this.readXrefSection(offset)
      if (!section) {
        // An older section that cannot be read loses only the objects nothing newer redefined.
        if (first) return false
        break
      }
      if (first) this.trailer = section
      first = false
      // A hybrid file: its cross-reference stream holds the objects the classic table leaves out.
      const stream = numberOf(section.get('XRefStm'))
      if (stream !== undefined && !seen.has(stream)) {
        seen.add(stream)
        this.readXrefSection(stream)
      }
      offset = numberOf(section.get('Prev'))
    }
    return this.trailer.has('Root')
  }

  /** Reads the section at `offset` into the table (entries already known win: they are newer); returns its trailer. */
  private readXrefSection(offset: number): PdfDict | undefined {
    const lexer = new Lexer(this.bytes, offset)
    lexer.skipSpace()
    const start = lexer.pos
    if (indexOf(this.bytes, 'xref', start, start + 4) === start) {
      lexer.pos = start + 4
      return this.readXrefTable(lexer)
    }
    const object = this.parseIndirectAt(start, undefined)
    if (!(object?.value instanceof PdfStream) || nameOf(object.value.dict.get('Type')) !== 'XRef') return undefined
    this.readXrefStream(object.value)
    return object.value.dict
  }

  private readXrefTable(lexer: Lexer): PdfDict | undefined {
    const parser = new Parser(lexer)
    for (;;) {
      const head = parser.take()
      if (head.kind === 'keyword' && head.word === 'trailer') break
      if (head.kind !== 'value' || typeof head.value !== 'number') return undefined
      const countToken = parser.take()
      if (countToken.kind !== 'value' || typeof countToken.value !== 'number') return undefined
      const first = head.value
      const count = Math.min(countToken.value, 10_000_000)
      for (let i = 0; i < count; i++) {
        const a = parser.take()
        const b = parser.take()
        const c = parser.take()
        if (a.kind !== 'value' || b.kind !== 'value' || c.kind !== 'keyword' || typeof a.value !== 'number' || typeof b.value !== 'number') return undefined
        const num = first + i
        if (c.word === 'n' && !this.entries.has(num) && a.value > 0) this.entries.set(num, { type: 1, offset: a.value, gen: b.value })
        else if (c.word === 'f' && !this.entries.has(num)) this.entries.set(num, { type: 1, offset: -1, gen: b.value })
      }
    }
    const trailer = parser.object()
    return isDict(trailer) ? trailer : undefined
  }

  private readXrefStream(stream: PdfStream): void {
    const dict = stream.dict
    const widths = (this.resolve(dict.get('W')) as PdfObject[] | undefined)?.map((value) => numberOf(this.resolve(value)) ?? 0) ?? []
    if (widths.length < 3 || widths.some((width) => width < 0 || width > 8)) return
    const size = numberOf(this.resolve(dict.get('Size'))) ?? 0
    const index = ((this.resolve(dict.get('Index')) as PdfObject[] | undefined) ?? [0, size]).map((value) => numberOf(this.resolve(value)) ?? 0)
    const data = decodeStream(dict, stream.raw, this.budget, (value) => this.resolve(value))
    if (!data) return
    const rowSize = widths[0] + widths[1] + widths[2]
    let at = 0
    const field = (width: number) => {
      let value = 0
      for (let i = 0; i < width; i++) value = value * 256 + data[at++]
      return value
    }
    for (let pair = 0; pair + 1 < index.length; pair += 2) {
      for (let i = 0; i < index[pair + 1] && at + rowSize <= data.length; i++) {
        const num = index[pair] + i
        const type = widths[0] ? field(widths[0]) : 1
        const second = field(widths[1])
        const third = field(widths[2])
        if (this.entries.has(num)) continue
        if (type === 1) this.entries.set(num, { type: 1, offset: second, gen: third })
        else if (type === 2) this.entries.set(num, { type: 2, stream: second, index: third })
        else if (type === 0) this.entries.set(num, { type: 1, offset: -1, gen: third })
      }
    }
  }

  /** Finds every object by scanning the file, when its cross-references cannot be trusted. */
  private reconstruct(): void {
    if (this.scanned) return
    this.scanned = true
    this.repairs.push('Its cross-reference table is damaged, so eNCode found the objects by scanning the file.')
    const { bytes } = this
    this.entries.clear()
    this.cache.clear()
    const trailers: PdfDict[] = []
    for (let at = indexOf(bytes, 'obj'); at >= 0; at = indexOf(bytes, 'obj', at + 3)) {
      if (at + 3 < bytes.length && !isWhite(bytes[at + 3]) && !'<[/('.includes(String.fromCharCode(bytes[at + 3]))) continue
      // Back over "num gen ".
      let i = at - 1
      while (i >= 0 && isWhite(bytes[i])) i--
      const genEnd = i + 1
      while (i >= 0 && bytes[i] >= 0x30 && bytes[i] <= 0x39) i--
      if (i + 1 === genEnd) continue
      const gen = Number(String.fromCharCode(...bytes.subarray(i + 1, genEnd)))
      while (i >= 0 && isWhite(bytes[i])) i--
      const numEnd = i + 1
      while (i >= 0 && bytes[i] >= 0x30 && bytes[i] <= 0x39) i--
      if (i + 1 === numEnd || (i >= 0 && !isWhite(bytes[i]) && !'>]/)'.includes(String.fromCharCode(bytes[i])))) continue
      const num = Number(String.fromCharCode(...bytes.subarray(i + 1, numEnd)))
      if (num > 10_000_000) continue
      // A later definition of the same object is an incremental update: it wins.
      this.entries.set(num, { type: 1, offset: i + 1, gen })
    }
    for (let at = indexOf(bytes, 'trailer'); at >= 0; at = indexOf(bytes, 'trailer', at + 7)) {
      try {
        const dict = new Parser(new Lexer(bytes, at + 7)).object()
        if (isDict(dict)) trailers.push(dict)
      } catch {
        // A damaged trailer: the next one may be whole.
      }
    }
    // Cross-reference streams stand in for trailers in files that have no other.
    for (const [num, entry] of [...this.entries]) {
      if (entry.type !== 1) continue
      const object = this.safeGet(num)
      if (object instanceof PdfStream && nameOf(object.dict.get('Type')) === 'XRef') trailers.push(object.dict)
    }
    this.indexObjectStreams()
    const merged = new Map<string, PdfObject>()
    for (const dict of trailers) for (const [key, value] of dict.map) merged.set(key, value)
    this.trailer = new PdfDict(merged)
    if (!this.catalog()) {
      for (const num of this.entries.keys()) {
        const object = this.safeGet(num)
        if (isDict(object) && nameOf(object.get('Type')) === 'Catalog') {
          this.trailer.map.set('Root', new PdfRef(num, 0))
          break
        }
      }
    }
  }

  /** Adds the objects packed in object streams to a table rebuilt by scanning. */
  private indexObjectStreams(): void {
    for (const [num, entry] of [...this.entries]) {
      if (entry.type !== 1) continue
      const object = this.safeGet(num)
      if (!(object instanceof PdfStream) || nameOf(object.dict.get('Type')) !== 'ObjStm') continue
      const packed = this.unpack(num, object)
      for (const [inner, index] of packed.order) if (!this.entries.has(inner)) this.entries.set(inner, { type: 2, stream: num, index })
    }
  }

  private safeGet(num: number): PdfObject | undefined {
    try {
      return this.get(num)
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------ objects

  /** The object `num` (generation numbers are not checked: damaged files get them wrong more often than right). */
  get(num: number): PdfObject {
    if (this.cache.has(num)) return this.cache.get(num)!
    if (this.resolving.has(num)) return null
    const entry = this.entries.get(num)
    if (!entry) return null
    this.resolving.add(num)
    try {
      let value: PdfObject = null
      if (entry.type === 1) {
        if (entry.offset < 0) return null
        const parsed = this.parseIndirectAt(entry.offset, num)
        if (parsed && parsed.num === num) value = parsed.value
        else if (!this.scanned) {
          // The table pointed somewhere else: trust the file over the table.
          this.reconstruct()
          this.resolving.delete(num)
          return this.cache.get(num) ?? this.get(num)
        }
        if (this.decryptor && value !== null) value = this.decryptObject(value, num, entry.gen)
      } else {
        const container = this.get(entry.stream)
        if (container instanceof PdfStream) value = this.unpack(entry.stream, container).objects.get(num) ?? null
      }
      this.cache.set(num, value)
      return value
    } finally {
      this.resolving.delete(num)
    }
  }

  /** Follows references to the object they name; other values are returned as they are. */
  resolve(value: PdfObject | undefined): PdfObject | undefined {
    for (let hops = 0; value instanceof PdfRef && hops < 32; hops++) value = this.get(value.num)
    return value instanceof PdfRef ? null : value
  }

  dict(value: PdfObject | undefined): PdfDict | undefined {
    const resolved = this.resolve(value)
    if (resolved instanceof PdfDict) return resolved
    if (resolved instanceof PdfStream) return resolved.dict
    return undefined
  }

  array(value: PdfObject | undefined): PdfObject[] | undefined {
    const resolved = this.resolve(value)
    return Array.isArray(resolved) ? resolved : undefined
  }

  number(value: PdfObject | undefined): number | undefined {
    return numberOf(this.resolve(value))
  }

  name(value: PdfObject | undefined): string | undefined {
    return nameOf(this.resolve(value))
  }

  /** A stream's decoded data; undefined for image data, or when it cannot be decoded. */
  streamData(stream: PdfStream): Uint8Array | undefined {
    return decodeStream(stream.dict, stream.raw, this.budget, (value) => this.resolve(value))
  }

  private parseIndirectAt(offset: number, expect: number | undefined): { num: number; value: PdfObject } | undefined {
    const lexer = new Lexer(this.bytes, offset)
    const parser = new Parser(lexer)
    const a = parser.take()
    const b = parser.take()
    const c = parser.take()
    if (a.kind !== 'value' || typeof a.value !== 'number' || b.kind !== 'value' || typeof b.value !== 'number' || c.kind !== 'keyword' || c.word !== 'obj') return undefined
    if (expect !== undefined && a.value !== expect) return { num: a.value, value: null }
    const value = parser.object() ?? null
    const after = parser.peek()
    if (isDict(value) && after.kind === 'keyword' && after.word === 'stream') {
      parser.take()
      return { num: a.value, value: this.streamAt(value, lexer.pos) }
    }
    return { num: a.value, value }
  }

  private streamAt(dict: PdfDict, keywordEnd: number): PdfStream {
    const { bytes } = this
    let start = keywordEnd
    while (bytes[start] === 0x20) start++
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2
    else if (bytes[start] === 0x0a || bytes[start] === 0x0d) start++
    const declared = numberOf(this.resolve(dict.get('Length')))
    if (declared !== undefined && declared >= 0 && start + declared <= bytes.length) {
      let end = start + declared
      while (end < bytes.length && isWhite(bytes[end])) end++
      if (indexOf(bytes, 'endstream', end, end + 9) === end) return new PdfStream(dict, bytes.subarray(start, start + declared))
    }
    // The length is wrong or missing: the data runs to the "endstream" keyword.
    let stop = indexOf(bytes, 'endstream', start)
    if (stop < 0) stop = bytes.length
    let end = stop
    if (bytes[end - 1] === 0x0a) end--
    if (bytes[end - 1] === 0x0d) end--
    return new PdfStream(dict, bytes.subarray(start, Math.max(start, end)))
  }

  /** The objects of an object stream, parsed once. */
  private unpack(num: number, stream: PdfStream): { objects: Map<number, PdfObject>; order: Map<number, number> } {
    const known = this.objectStreams.get(num)
    const order = new Map<number, number>()
    if (known) {
      let i = 0
      for (const key of known.keys()) order.set(key, i++)
      return { objects: known, order }
    }
    const objects = new Map<number, PdfObject>()
    this.objectStreams.set(num, objects)
    const count = numberOf(this.resolve(stream.dict.get('N'))) ?? 0
    const first = numberOf(this.resolve(stream.dict.get('First'))) ?? 0
    const data = this.streamData(stream)
    if (!data) return { objects, order }
    const header = new Parser(new Lexer(data, 0, Math.min(first, data.length)))
    const places: [number, number][] = []
    for (let i = 0; i < count; i++) {
      const objectNum = header.take()
      const offset = header.take()
      if (objectNum.kind !== 'value' || offset.kind !== 'value' || typeof objectNum.value !== 'number' || typeof offset.value !== 'number') break
      places.push([objectNum.value, offset.value])
    }
    places.forEach(([objectNum, offset], index) => {
      try {
        const parser = new Parser(new Lexer(data, first + offset))
        objects.set(objectNum, parser.object() ?? null)
      } catch {
        objects.set(objectNum, null)
      }
      order.set(objectNum, index)
    })
    return { objects, order }
  }

  // ------------------------------------------------------------ encryption

  private openEncryption(): void {
    const encrypt = this.dict(this.trailer.get('Encrypt'))
    if (!encrypt) return
    const ids = this.array(this.trailer.get('ID'))
    const first = ids?.[0] instanceof PdfString ? ids[0].bytes : new Uint8Array(0)
    const security = openSecurity(encrypt, first, (value) => this.resolve(value))
    if (!security.ok) throw new PdfError(security.reason === 'password' ? 'password' : 'The file uses an encryption eNCode cannot open.')
    this.encrypt = encrypt
    this.decryptor = security.decryptor
    // Objects parsed before the encryption was known were read as they are stored.
    const encryptRef = this.trailer.get('Encrypt')
    const keep = encryptRef instanceof PdfRef ? encryptRef.num : -1
    for (const num of [...this.cache.keys()]) if (num !== keep && this.entries.get(num)?.type === 1) this.cache.delete(num)
    this.objectStreams.clear()
    // A scan read the object streams while they were still encrypted.
    if (this.scanned) this.indexObjectStreams()
  }

  private decryptObject(value: PdfObject, num: number, gen: number, depth = 0): PdfObject {
    if (depth > 64 || !this.decryptor || !this.encrypt) return value
    const encryptRef = this.trailer.get('Encrypt')
    if (encryptRef instanceof PdfRef && encryptRef.num === num) return value
    if (value instanceof PdfString) return new PdfString(this.decryptor.decrypt(value.bytes, num, gen, 'string'))
    if (Array.isArray(value)) return value.map((item) => this.decryptObject(item, num, gen, depth + 1))
    if (value instanceof PdfDict) {
      const map = new Map<string, PdfObject>()
      for (const [key, item] of value.map) map.set(key, this.decryptObject(item, num, gen, depth + 1))
      return new PdfDict(map)
    }
    if (value instanceof PdfStream) {
      const dict = this.decryptObject(value.dict, num, gen, depth + 1) as PdfDict
      const raw = streamIsClear(dict, this.encrypt, (item) => this.resolve(item)) ? value.raw : this.decryptor.decrypt(value.raw, num, gen, 'stream')
      return new PdfStream(dict, raw)
    }
    return value
  }

  // ------------------------------------------------------------ document level

  catalog(): PdfDict | undefined {
    const root = this.dict(this.trailer.get('Root'))
    return root && (root.has('Pages') || nameOf(root.get('Type')) === 'Catalog') ? root : undefined
  }

  /** The document's title from its information dictionary. */
  title(): string | undefined {
    const info = this.dict(this.trailer.get('Info'))
    const title = textString(this.resolve(info?.get('Title')))?.trim()
    return title || undefined
  }

  pages(): PdfPage[] {
    if (this.pageList) return this.pageList
    const pages: PdfPage[] = []
    const seen = new Set<string>()
    const walk = (node: PdfObject | undefined, inherited: { resources?: PdfDict; box?: number[]; rotate?: number }, depth: number) => {
      if (depth > 64 || pages.length >= MAX_PAGES) return
      const key = node instanceof PdfRef ? node.key : undefined
      if (key) {
        if (seen.has(key)) return
        seen.add(key)
      }
      const dict = this.dict(node)
      if (!dict) return
      const resources = this.dict(dict.get('Resources')) ?? inherited.resources
      const box = (this.array(dict.get('CropBox')) ?? this.array(dict.get('MediaBox')))?.map((value) => this.number(value) ?? 0) ?? inherited.box
      const rotate = this.number(dict.get('Rotate')) ?? inherited.rotate
      const kids = this.array(dict.get('Kids'))
      const type = this.name(dict.get('Type'))
      if (kids && type !== 'Page') {
        for (const kid of kids) walk(kid, { resources, box, rotate }, depth + 1)
        return
      }
      const b = box && box.length >= 4 ? box : [0, 0, 612, 792]
      pages.push({
        dict,
        ...(node instanceof PdfRef ? { ref: node } : {}),
        ...(resources ? { resources } : {}),
        box: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])],
        rotate: (((rotate ?? 0) % 360) + 360) % 360,
      })
    }
    const catalog = this.catalog()
    walk(catalog?.get('Pages'), {}, 0)
    if (!pages.length) {
      // No page tree to follow: the pages are the objects that say they are pages, in file order.
      this.reconstruct()
      for (const num of [...this.entries.keys()].sort((a, b) => a - b)) {
        const object = this.safeGet(num)
        if (isDict(object) && nameOf(object.get('Type')) === 'Page') walk(new PdfRef(num, 0), {}, 0)
      }
    }
    this.pageList = pages
    return pages
  }

  /** The outline (bookmarks), up to a few hundred entries, with the page each leads to. */
  outline(): OutlineItem[] {
    const catalog = this.catalog()
    const outlines = this.dict(catalog?.get('Outlines'))
    if (!outlines) return []
    const pageIndex = new Map<string, number>()
    this.pages().forEach((page, index) => {
      if (page.ref) pageIndex.set(page.ref.key, index + 1)
    })
    const items: OutlineItem[] = []
    const seen = new Set<string>()
    let named: Map<string, PdfObject> | undefined
    const destination = (value: PdfObject | undefined, depth = 0): number | undefined => {
      const resolved = this.resolve(value)
      if (depth > 4) return undefined
      if (Array.isArray(resolved)) {
        const target = resolved[0]
        if (target instanceof PdfRef) return pageIndex.get(target.key)
        if (typeof target === 'number') return target + 1
        return undefined
      }
      if (resolved instanceof PdfDict) return destination(resolved.get('D'), depth + 1)
      const name = resolved instanceof PdfString ? byteString(resolved.bytes) : nameOf(resolved)
      if (name === undefined) return undefined
      named ??= this.namedDestinations()
      return destination(named.get(name), depth + 1)
    }
    const walk = (first: PdfObject | undefined, depth: number) => {
      let node: PdfObject | undefined = first
      while (node && items.length < MAX_OUTLINE) {
        const key = node instanceof PdfRef ? node.key : undefined
        if (!key || seen.has(key)) return
        seen.add(key)
        const dict = this.dict(node)
        if (!dict) return
        const title = textString(this.resolve(dict.get('Title')))?.replace(/\s+/g, ' ').trim()
        const action = this.dict(dict.get('A'))
        const page = dict.has('Dest') ? destination(dict.get('Dest')) : action && this.name(action.get('S')) === 'GoTo' ? destination(action.get('D')) : undefined
        if (title) items.push({ title, depth, ...(page ? { page } : {}) })
        if (depth < 3) walk(dict.get('First'), depth + 1)
        node = dict.get('Next')
      }
    }
    walk(outlines.get('First'), 0)
    return items
  }

  /** Named destinations, from the catalog's Dests dictionary (PDF 1.1) and the Dests name tree. */
  private namedDestinations(): Map<string, PdfObject> {
    const names = new Map<string, PdfObject>()
    const catalog = this.catalog()
    const old = this.dict(catalog?.get('Dests'))
    if (old) for (const [key, value] of old.map) names.set(key, value)
    const tree = this.dict(this.dict(catalog?.get('Names'))?.get('Dests'))
    const seen = new Set<PdfDict>()
    const walk = (node: PdfDict | undefined, depth: number) => {
      if (!node || depth > 32 || seen.has(node) || names.size > 20_000) return
      seen.add(node)
      const pairs = this.array(node.get('Names'))
      if (pairs) {
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const key = this.resolve(pairs[i])
          if (key instanceof PdfString) names.set(byteString(key.bytes), pairs[i + 1])
        }
      }
      for (const kid of this.array(node.get('Kids')) ?? []) walk(this.dict(kid), depth + 1)
    }
    walk(tree, 0)
    return names
  }

  /** The object number a page's dictionary lives at, for copying it. */
  get trailerDict(): PdfDict {
    return this.trailer
  }
}
