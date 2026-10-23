/**
 * A page's text, read from its content streams (PDF 32000-1:2008, 8 and 9).
 *
 * A PDF records where each glyph goes, not words or lines. The text operators are run to find each glyph's place
 * on the page; glyphs that sit next to each other on a baseline become runs, and runs become lines and paragraphs
 * by the gaps between them. Content order is kept, since most writers draw text in reading order and it is the
 * only way to keep the columns of a two-column page apart; a page whose order jumps about is read top to bottom.
 */
import type { PdfDocument, PdfPage } from './document'
import { FontCache, plainText, type Font } from './fonts'
import { Lexer, Parser, PdfDict, PdfError, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from './objects'

export interface TextLimits {
  /** Operators one page may run, its forms included. */
  maxOps: number
  /** Characters one page may give. */
  maxChars: number
  /** The Date.now() past which reading stops. */
  deadline: number
  signal?: AbortSignal
}

export interface PageText {
  text: string
  /** Images the page draws: a scanned page is an image and little or no text. */
  images: number
  /** The share of the page the largest image covers, 0 to 1. */
  largestImage: number
  /** The share all the images cover together, at most 1 (a scan may be drawn in strips). */
  imageArea: number
  /** Paths filled or stroked: a chart or diagram drawn with lines is hundreds of them. */
  paints: number
  /** The page was cut short by a limit, or part of it could not be read. */
  partial: boolean
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m, then n (row vectors, as PDF writes them). */
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

/** Turns the page so its text reads as it is shown: /Rotate turns it clockwise. */
function upright(rotate: number): Matrix {
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, -1, 1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, -1, 0, 0]
    case 270:
      return [0, 1, -1, 0, 0, 0]
    default:
      return IDENTITY
  }
}

interface State {
  ctm: Matrix
  font: Font | undefined
  size: number
  charSpace: number
  wordSpace: number
  /** Horizontal scaling, Tz / 100. */
  scale: number
  leading: number
  rise: number
}

/** Text on one baseline, in the frame of its direction: x along the baseline, y across it. */
interface Run {
  text: string
  x: number
  y: number
  end: number
  height: number
  /** The direction, in whole degrees, of the group it belongs to. */
  dir: number
}

/** The direction a baseline runs in: one of the four upright ones when it is close, else the angle itself. */
function directionOf(dx: number, dy: number): number {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI
  const quarter = Math.round(degrees / 90) * 90
  return ((Math.abs(degrees - quarter) < 4 ? quarter : Math.round(degrees)) + 360) % 360
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const YIELD_MS = 40
const MAX_FORM_DEPTH = 10
const MAX_OPERANDS = 64

const isSpace = (text: string) => /^\s+$/.test(text)

class PageReader {
  readonly runs: Run[] = []
  images = 0
  largestImage = 0
  imageArea = 0
  paints = 0
  partial = false
  private area = 1
  private ops = 0
  private chars = 0
  private lastYield = Date.now()
  private stopped = false
  private current: Run | undefined
  private readonly frames = new Map<number, [number, number]>()
  /** Marked content: the ActualText that replaces what is drawn inside it, and where that drawing went. */
  private readonly marked: ({ text: string; start?: [number, number, number, number]; end?: number } | undefined)[] = []
  private readonly forms = new Set<string | PdfStream>()

  constructor(
    private readonly doc: PdfDocument,
    private readonly fonts: FontCache,
    private readonly limits: TextLimits,
  ) {}

  /** Cosine and sine of a direction. */
  private frame(dir: number): [number, number] {
    let frame = this.frames.get(dir)
    if (!frame) {
      const radians = (dir * Math.PI) / 180
      frame = [Math.round(Math.cos(radians) * 1e9) / 1e9, Math.round(Math.sin(radians) * 1e9) / 1e9]
      this.frames.set(dir, frame)
    }
    return frame
  }

  async page(page: PdfPage): Promise<void> {
    const contents = this.doc.resolve(page.dict.get('Contents'))
    const streams = (Array.isArray(contents) ? contents.map((item) => this.doc.resolve(item)) : [contents]).filter((item): item is PdfStream => item instanceof PdfStream)
    // A page's content may be split across streams anywhere, even inside an operator: read them as one.
    const parts: Uint8Array[] = []
    for (const stream of streams) {
      try {
        const data = this.doc.streamData(stream)
        if (data) parts.push(data, Uint8Array.of(0x0a))
      } catch (error) {
        if (!(error instanceof PdfError)) throw error
        this.partial = true
      }
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const data = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      data.set(part, at)
      at += part.length
    }
    const [x0, y0, x1, y1] = page.box
    this.area = Math.max(1, Math.abs((x1 - x0) * (y1 - y0)))
    await this.run(data, page.resources, this.baseState(upright(page.rotate)), 0)
  }

  private baseState(ctm: Matrix): State {
    return { ctm, font: undefined, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0 }
  }

  private async run(data: Uint8Array, resources: PdfDict | undefined, start: State, depth: number): Promise<void> {
    const lexer = new Lexer(data)
    const parser = new Parser(lexer)
    const stack: State[] = []
    let state: State = { ...start }
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    const operands: PdfObject[] = []
    const num = (index: number) => {
      const value = operands[operands.length - index]
      return typeof value === 'number' ? value : 0
    }
    const moveLine = (tx: number, ty: number) => {
      tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
      tm = tlm
    }
    const show = (value: PdfObject | undefined) => {
      if (value instanceof PdfString) tm = this.show(value.bytes, state, tm)
    }
    const fontsOf = () => this.doc.dict(resources?.get('Font'))

    for (;;) {
      if (this.stopped) return
      let value: PdfObject | undefined
      try {
        value = parser.object()
      } catch (error) {
        if (!(error instanceof PdfError)) throw error
        this.partial = true
        return
      }
      if (value !== undefined) {
        if (operands.length < MAX_OPERANDS) operands.push(value)
        continue
      }
      const token = parser.take()
      if (token.kind === 'eof') return
      if (token.kind !== 'keyword') continue
      if (++this.ops > this.limits.maxOps) return this.stop()
      if ((this.ops & 1023) === 0) {
        const now = Date.now()
        if (now > this.limits.deadline || this.limits.signal?.aborted) return this.stop()
        if (now - this.lastYield > YIELD_MS) {
          await tick()
          this.lastYield = Date.now()
        }
      }
      switch (token.word) {
        case 'q':
          if (stack.length < 256) stack.push({ ...state })
          break
        case 'Q':
          state = stack.pop() ?? state
          break
        case 'cm':
          state.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], state.ctm)
          break
        case 'BT':
          tm = tlm = IDENTITY
          this.current = undefined
          break
        case 'ET':
          this.current = undefined
          break
        case 'Tc':
          state.charSpace = num(1)
          break
        case 'Tw':
          state.wordSpace = num(1)
          break
        case 'Tz':
          state.scale = num(1) / 100
          break
        case 'TL':
          state.leading = num(1)
          break
        case 'Ts':
          state.rise = num(1)
          break
        case 'Tf': {
          const name = operands[operands.length - 2]
          if (name instanceof PdfName) state.font = this.fonts.get(fontsOf()?.get(name.name))
          state.size = num(1)
          break
        }
        case 'Td':
          moveLine(num(2), num(1))
          break
        case 'TD':
          state.leading = -num(1)
          moveLine(num(2), num(1))
          break
        case 'Tm':
          tm = tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]
          break
        case 'T*':
          moveLine(0, -state.leading)
          break
        case 'Tj':
          show(operands[operands.length - 1])
          break
        case "'":
          moveLine(0, -state.leading)
          show(operands[operands.length - 1])
          break
        case '"':
          state.wordSpace = num(3)
          state.charSpace = num(2)
          moveLine(0, -state.leading)
          show(operands[operands.length - 1])
          break
        case 'TJ': {
          const items = operands[operands.length - 1]
          if (!Array.isArray(items)) break
          for (const item of items) {
            if (item instanceof PdfString) tm = this.show(item.bytes, state, tm)
            else if (typeof item === 'number') {
              const shift = (-item / 1000) * state.size
              tm = state.font?.vertical ? multiply([1, 0, 0, 1, 0, shift], tm) : multiply([1, 0, 0, 1, shift * state.scale, 0], tm)
            }
          }
          break
        }
        case 'gs': {
          const name = operands[operands.length - 1]
          const gs = name instanceof PdfName ? this.doc.dict(this.doc.dict(resources?.get('ExtGState'))?.get(name.name)) : undefined
          const font = gs ? this.doc.array(gs.get('Font')) : undefined
          if (font && font.length >= 2) {
            state.font = this.fonts.get(font[0])
            state.size = this.doc.number(font[1]) ?? state.size
          }
          break
        }
        case 'Do': {
          const name = operands[operands.length - 1]
          if (name instanceof PdfName) await this.xobject(name.name, resources, state, depth)
          break
        }
        case 'BI':
          this.inlineImage(parser, lexer)
          this.image(state.ctm)
          break
        case 'S':
        case 's':
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'B*':
        case 'b':
        case 'b*':
          this.paints++
          break
        case 'BMC':
          this.marked.push(undefined)
          break
        case 'BDC': {
          const props = operands[operands.length - 1]
          const dict = props instanceof PdfName ? this.doc.dict(this.doc.dict(resources?.get('Properties'))?.get(props.name)) : this.doc.dict(props)
          const actual = dict?.get('ActualText')
          const outer = this.marked.some((item) => item)
          this.marked.push(actual instanceof PdfString && !outer ? { text: textOf(actual) } : undefined)
          break
        }
        case 'EMC': {
          const span = this.marked.pop()
          if (span?.start) this.place(span.text, span.start[0], span.start[1], span.end ?? span.start[0], span.start[2], span.start[3])
          break
        }
      }
      operands.length = 0
    }
  }

  private stop(): void {
    this.stopped = true
    this.partial = true
  }

  /** Draws a string's glyphs; returns the text matrix after them. */
  private show(bytes: Uint8Array, state: State, tm: Matrix): Matrix {
    const font = state.font ?? this.fonts.get(undefined)
    const m = multiply(tm, state.ctm)
    const vertical = font.vertical
    // The baseline's direction and the glyphs' height on the page.
    const dx = vertical ? -m[2] : m[0]
    const dy = vertical ? -m[3] : m[1]
    const height = Math.abs(state.size * font.size) * Math.hypot(vertical ? m[0] : m[2], vertical ? m[1] : m[3])
    const dir = directionOf(dx, dy)
    const [cos, sin] = this.frame(dir)
    const at = (tx: number, ty: number): [number, number] => {
      const px = tx * m[0] + ty * m[2] + m[4]
      const py = tx * m[1] + ty * m[3] + m[5]
      return [px * cos + py * sin, -px * sin + py * cos]
    }
    let advance = 0
    for (const glyph of font.decode(bytes)) {
      const spacing = state.charSpace + (glyph.space ? state.wordSpace : 0)
      const step = vertical ? -state.size + spacing : ((glyph.width / 1000) * state.size + spacing) * state.scale
      const [x, y] = vertical ? at(0, advance) : at(advance, state.rise)
      advance += step
      const [end] = vertical ? at(0, advance) : at(advance, state.rise)
      this.glyph(glyph.text, x, y, end, height, dir)
      if (this.stopped) break
    }
    return vertical ? multiply([1, 0, 0, 1, 0, advance], tm) : multiply([1, 0, 0, 1, advance, 0], tm)
  }

  private glyph(text: string, x: number, y: number, end: number, height: number, dir: number): void {
    const span = this.marked.find((item) => item)
    if (span) {
      // Inside ActualText: the drawing only says where the replacement text goes.
      span.start ??= [x, y, height, dir]
      span.end = end
      return
    }
    if (text) this.place(text, x, y, end, height, dir)
  }

  private place(text: string, x: number, y: number, end: number, height: number, dir: number): void {
    const h = Math.max(height, 0.01)
    const current = this.current
    if (current && current.dir === dir && Math.abs(y - current.y) < 0.2 * h && x >= current.end - 0.25 * h && x - current.end < 0.1 * h && Math.abs(h - current.height) < 0.3 * h) {
      // Spaces the file draws are kept, each one: in code they are the indentation.
      current.text += isSpace(text) ? ' '.repeat(text.length) : text
      current.end = Math.max(current.end, end)
    } else {
      this.current = { text: isSpace(text) ? ' '.repeat(text.length) : text, x, y, end, height: h, dir }
      this.runs.push(this.current)
    }
    this.chars += text.length
    if (this.chars > this.limits.maxChars) this.stop()
  }

  private async xobject(name: string, resources: PdfDict | undefined, state: State, depth: number): Promise<void> {
    const ref = this.doc.dict(resources?.get('XObject'))?.get(name)
    const object = this.doc.resolve(ref)
    if (!(object instanceof PdfStream)) return
    const subtype = this.doc.name(object.dict.get('Subtype'))
    if (subtype === 'Image') {
      this.image(state.ctm)
      return
    }
    if (subtype !== 'Form' || depth >= MAX_FORM_DEPTH) return
    const key = ref instanceof PdfRef ? ref.key : object
    if (this.forms.has(key)) return
    let data: Uint8Array | undefined
    try {
      data = this.doc.streamData(object)
    } catch (error) {
      if (!(error instanceof PdfError)) throw error
      this.partial = true
      return
    }
    if (!data) return
    const matrix = this.doc.array(object.dict.get('Matrix'))?.map((item) => this.doc.number(item) ?? 0)
    const ctm = matrix?.length === 6 ? multiply(matrix as Matrix, state.ctm) : state.ctm
    this.forms.add(key)
    this.current = undefined
    try {
      await this.run(data, this.doc.dict(object.dict.get('Resources')) ?? resources, { ...state, ctm }, depth + 1)
    } finally {
      this.forms.delete(key)
      this.current = undefined
    }
  }

  /** An image fills the unit square of the current matrix. */
  private image(ctm: Matrix): void {
    this.images++
    const share = Math.min(1, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / this.area)
    this.largestImage = Math.max(this.largestImage, share)
    this.imageArea = Math.min(1, this.imageArea + share)
  }

  /** Skips an inline image (BI dictionary ID data EI); the data may hold any bytes. */
  private inlineImage(parser: Parser, lexer: Lexer): void {
    for (let guard = 0; guard < 200; guard++) {
      const value = parser.object()
      if (value !== undefined) continue
      const token = parser.take()
      if (token.kind === 'eof') return
      if (token.kind === 'keyword' && token.word === 'ID') break
    }
    const { bytes, end } = lexer
    let at = lexer.pos + 1
    for (;;) {
      at = indexOfEI(bytes, at, end)
      if (at < 0) {
        lexer.pos = end
        return
      }
      if (looksLikeContent(bytes, at + 2, end)) {
        lexer.pos = at + 2
        return
      }
      at += 2
    }
  }
}

/** The next "EI" with white space or the end on both sides. */
function indexOfEI(bytes: Uint8Array, from: number, end: number): number {
  for (let i = from; i + 1 < end; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue
    const before = bytes[i - 1]
    const after = i + 2 < end ? bytes[i + 2] : 0x20
    if ((before === 0x20 || before === 0x0a || before === 0x0d || before === 0x09) && (after === 0x20 || after === 0x0a || after === 0x0d || after === 0x09 || after === 0x51 || after === 0x25)) return i
  }
  return -1
}

/** Whether what follows reads like operators and operands, not more image bytes. */
function looksLikeContent(bytes: Uint8Array, from: number, end: number): boolean {
  for (let i = from; i < Math.min(end, from + 48); i++) {
    const c = bytes[i]
    if (c === 0 || c > 0x7e || (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09)) return false
  }
  return true
}

function textOf(value: PdfString): string {
  const bytes = value.bytes
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] * 256 + bytes[i + 1])
    return out
  }
  return String.fromCharCode(...bytes.subarray(0, 4096))
}

// ---------------------------------------------------------------------------
// From runs to lines

interface Line {
  text: string
  y: number
  x: number
  end: number
  height: number
  last: Run
}

function lines(runs: Run[]): Line[] {
  const out: Line[] = []
  let line: Line | undefined
  for (const run of runs) {
    if (line) {
      const h = Math.max(line.height, run.height)
      const sameLine = Math.abs(run.y - line.y) <= 0.45 * h
      const gap = run.x - line.end
      const unit = Math.min(line.last.height, run.height)
      const last = line.last
      // The same text drawn again a hair to the side: a bold face faked by overprinting.
      if (sameLine && run.text === last.text && Math.abs(run.x - last.x) < 0.2 * unit && Math.abs(run.y - last.y) < 0.2 * unit) continue
      if (sameLine && gap >= -2 * unit) {
        const joined = line.text.endsWith(' ') || run.text.startsWith(' ')
        line.text += gap > 3 * unit ? (joined ? '  ' : '   ') : gap > 0.16 * unit && !joined ? ' ' : ''
        line.text += run.text
        line.end = Math.max(line.end, run.end)
        line.height = Math.max(line.height, run.height)
        line.last = run
        continue
      }
    }
    line = { text: run.text, y: run.y, x: run.x, end: run.end, height: run.height, last: run }
    out.push(line)
  }
  return out
}

/** Lines in content order, unless that order jumps up the page so often that it cannot be reading order. */
function ordered(runs: Run[]): Line[] {
  const inOrder = lines(runs)
  let jumps = 0
  for (let i = 1; i < inOrder.length; i++) if (inOrder[i].y > inOrder[i - 1].y + 0.5 * inOrder[i - 1].height) jumps++
  if (jumps <= 3 || jumps <= inOrder.length * 0.25) return inOrder
  const sorted = [...runs].sort((a, b) => {
    const h = Math.max(a.height, b.height)
    return Math.abs(a.y - b.y) <= 0.45 * h ? a.x - b.x : b.y - a.y
  })
  return lines(sorted)
}

const similar = (a: Line, b: Line) => Math.max(a.height, b.height) <= 1.25 * Math.min(a.height, b.height)

/**
 * Whether a blank line goes before line `i`: the text went back up (another column or block), changed size (a
 * heading), or dropped further than the lines around it do. Comparing with the neighbours keeps a table's rows,
 * or a double-spaced page, together while a paragraph's end still shows.
 */
function startsParagraph(lines: Line[], i: number): boolean {
  const previous = lines[i - 1]
  const line = lines[i]
  const drop = previous.y - line.y
  const h = Math.max(previous.height, line.height)
  if (drop < -0.5 * previous.height || !similar(previous, line)) return true
  if (drop > 2.5 * h) return true
  const near: number[] = []
  for (const j of [i - 1, i + 1]) {
    if (j < 1 || j >= lines.length || !similar(lines[j - 1], lines[j])) continue
    const other = lines[j - 1].y - lines[j].y
    if (other > 0.5 * h) near.push(other)
  }
  if (near.length) return drop > 1.25 * Math.min(...near) && drop > 1.3 * h
  return drop > 1.8 * h
}

/** Spaces before each line of a block, for indentation drawn by position (code, nested lists) rather than with spaces. */
function indents(block: Line[]): number[] {
  const widths = block
    .filter((line) => line.text.length >= 4)
    .map((line) => (line.end - line.x) / line.text.length)
    .sort((a, b) => a - b)
  const width = widths[Math.floor(widths.length / 2)]
  if (!width || block.length < 2) return block.map(() => 0)
  const left = Math.min(...block.map((line) => line.x))
  const right = Math.max(...block.map((line) => line.end))
  // A line that starts far in (a centred title, a page number on the right) is placed, not indented.
  return block.map((line) => (line.x - left < 0.4 * (right - left) ? Math.min(24, Math.max(0, Math.round((line.x - left) / width))) : 0))
}

function layout(runs: Run[]): string {
  const result = ordered(runs).filter((line) => line.text.trim())
  const blocks: Line[][] = []
  for (let i = 0; i < result.length; i++) {
    if (!i || startsParagraph(result, i)) blocks.push([])
    blocks[blocks.length - 1].push(result[i])
  }
  return blocks
    .map((block) => {
      const spaces = indents(block)
      return block.map((line, index) => ' '.repeat(spaces[index]) + line.text.replace(/\s+$/, '')).join('\n')
    })
    .join('\n\n')
}

/** The text of one page, laid out as lines and paragraphs. */
export async function pageText(doc: PdfDocument, page: PdfPage, fonts: FontCache, limits: TextLimits): Promise<PageText> {
  const reader = new PageReader(doc, fonts, limits)
  await reader.page(page)
  // Each direction of text on its own, the main one first (a margin note turned on its side comes after).
  const groups = new Map<number, Run[]>()
  for (const run of reader.runs) {
    const group = groups.get(run.dir)
    if (group) group.push(run)
    else groups.set(run.dir, [run])
  }
  const weight = (group: Run[]) => group.reduce((sum, run) => sum + run.text.length, 0)
  const parts = [...groups.values()].sort((a, b) => weight(b) - weight(a)).map(layout).filter(Boolean)
  const text = plainText(parts.join('\n\n')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, images: reader.images, largestImage: reader.largestImage, imageArea: reader.imageArea, paints: reader.paints, partial: reader.partial }
}
