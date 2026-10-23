/**
 * Reading a PDF for Read: its pages' text, its outline, and, for a model that reads PDFs itself, the pages that
 * have something to see (a figure, a chart, a scan) as a PDF of their own.
 *
 * eNCode's own reader, written to the PDF standard (ISO 32000) with the repairs other readers make for damaged
 * files. A PDF comes from anywhere, so every step has a limit: decoded bytes, operators, time and characters.
 */
import { PdfDocument, type OutlineItem, type PdfPage } from './document'
import { DecodeLimitError } from './filters'
import { FontCache } from './fonts'
import { PdfError } from './objects'
import { subsetPdf } from './subset'
import { pageText } from './text'

export type { OutlineItem } from './document'

export interface PdfReadOptions {
  /** Which pages: "3", "1-5", "1,3,5-7", "10-" (to the end). Left out, Read starts at the first page. */
  pages?: string
  /** Pages one read may take. */
  maxPages: number
  /** Characters of text one read may give, across its pages. */
  maxChars: number
  /** How long one read may take. */
  timeMs: number
  signal?: AbortSignal
}

export interface PdfPageText {
  /** 1-based. */
  number: number
  text: string
  /** Something to see that the text leaves out: a figure, a chart or table drawn with lines, a scan. */
  visual: boolean
  /** Mostly one image with little text: a scan without a text layer, or a full-page figure. */
  scanned: boolean
  /** Cut short by a limit, or partly unreadable. */
  partial: boolean
}

export interface PdfReading {
  pageCount: number
  title?: string
  outline: OutlineItem[]
  pages: PdfPageText[]
  /** Pages asked for (or, with no pages given, the pages after these) that this read left for another. */
  rest: number[]
  /** Whether `pages` was given. */
  chosen: boolean
  /** Glyphs whose font gave no text, across the pages read. */
  unknownGlyphs: number
  /** The file was damaged and eNCode read it the way other readers do. */
  repaired: boolean
  /** The given pages as a PDF of their own; undefined when that would be over `maxBytes`. */
  subset(numbers: number[], maxBytes: number): Uint8Array | undefined
}

export type PdfResult = { ok: true; reading: PdfReading } | { ok: false; error: string }

const PAGE_SPEC = /^\s*(\d+)\s*(?:(-)\s*(\d+)?)?\s*$/

/** The pages a `pages` value names, in the order given, or what is wrong with it. */
export function parsePages(spec: string, count: number, maxPages: number): number[] | string {
  const out: number[] = []
  const seen = new Set<number>()
  const parts = spec.split(',').filter((part) => part.trim())
  if (!parts.length) return 'pages is empty; give pages like "3", "1-5" or "1,3,5-7".'
  for (const part of parts) {
    const match = PAGE_SPEC.exec(part)
    if (!match) return `pages "${spec.trim()}" is not a page list; give pages like "3", "1-5" or "1,3,5-7".`
    const from = Number(match[1])
    const to = match[2] ? (match[3] ? Number(match[3]) : count) : from
    if (from < 1) return 'pages start at 1.'
    if (from > count) return `has ${count} ${count === 1 ? 'page' : 'pages'}, so page ${from} is past its end.`
    if (to < from) return `pages "${part.trim()}" runs backwards; write it as "${to}-${from}".`
    for (let page = from; page <= Math.min(to, count); page++) {
      if (seen.has(page)) continue
      seen.add(page)
      out.push(page)
      if (out.length > maxPages) return `pages "${spec.trim()}" names more than ${maxPages} pages; Read takes at most ${maxPages} at a time, such as "${from}-${from + maxPages - 1}".`
    }
  }
  return out
}

/** A page with something to see that its text cannot carry. */
function isVisual(page: { largestImage: number; imageArea: number; paints: number }): boolean {
  return page.largestImage >= 0.08 || page.imageArea >= 0.3 || page.paints >= 150
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

export async function readPdf(bytes: Uint8Array, options: PdfReadOptions): Promise<PdfResult> {
  // Decoded bytes for the whole read: enough for 20 dense pages and their fonts, never gigabytes.
  const budget = { perStream: 48 * 1024 * 1024, left: 256 * 1024 * 1024 }
  const deadline = Date.now() + options.timeMs
  let doc: PdfDocument
  let all: PdfPage[]
  try {
    doc = PdfDocument.open(bytes, budget)
    all = doc.pages()
  } catch (error) {
    if (error instanceof PdfError && error.message === 'password') return { ok: false, error: 'is protected by a password, so it cannot be opened without it. Ask the user for a copy without the password.' }
    if (error instanceof DecodeLimitError) return { ok: false, error: 'holds more compressed data than eNCode reads from one PDF.' }
    if (error instanceof PdfError) return { ok: false, error: `could not be read as a PDF: ${error.message.replace(/\.$/, '')}.` }
    throw error
  }
  const count = all.length
  if (!count) return { ok: false, error: 'is damaged: no pages could be found in it.' }

  let wanted: number[]
  if (options.pages !== undefined && options.pages.trim()) {
    const parsed = parsePages(options.pages, count, options.maxPages)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    wanted = parsed
  } else wanted = Array.from({ length: count }, (_, index) => index + 1)

  const fonts = new FontCache(doc)
  const pages: PdfPageText[] = []
  let chars = 0
  let index = 0
  for (; index < wanted.length && pages.length < options.maxPages; index++) {
    if (options.signal?.aborted) break
    const number = wanted[index]
    const left = options.maxChars - chars
    if (pages.length && left < 200) break
    let read
    try {
      read = await pageText(doc, all[number - 1], fonts, { maxOps: 2_000_000, maxChars: Math.max(left, 2000) + 2000, deadline, signal: options.signal })
    } catch (error) {
      if (!(error instanceof PdfError)) throw error
      read = { text: '', images: 0, largestImage: 0, imageArea: 0, paints: 0, partial: true }
    }
    let text = read.text
    // A page longer than what is left: whole when it is the first, else it waits for the next read.
    if (text.length > left) {
      if (pages.length) break
      text = text.slice(0, left)
      read.partial = true
    }
    chars += text.length
    pages.push({ number, text, visual: isVisual(read), scanned: read.imageArea >= 0.5 && read.text.length < 200, partial: read.partial })
    if (Date.now() > deadline) {
      index++
      break
    }
    await tick()
  }

  const rest = wanted.slice(index)
  let outline: OutlineItem[] = []
  let title: string | undefined
  try {
    outline = doc.outline()
    title = doc.title()
  } catch (error) {
    if (!(error instanceof PdfError)) throw error
  }
  return {
    ok: true,
    reading: {
      pageCount: count,
      ...(title ? { title } : {}),
      outline,
      pages,
      rest,
      chosen: options.pages !== undefined && options.pages.trim() !== '',
      unknownGlyphs: fonts.unknown(),
      repaired: doc.repairs.length > 0,
      subset: (numbers, maxBytes) => {
        try {
          return subsetPdf(
            doc,
            numbers.map((number) => all[number - 1]),
            maxBytes,
          )
        } catch (error) {
          if (error instanceof PdfError) return undefined
          throw error
        }
      },
    },
  }
}
