/**
 * What Read gives for a PDF: the pages' text, the outline on a first look, and the pages with something to see
 * (a figure, a chart, a scan) as a PDF of their own for a model that reads PDFs. Text alone would lose those; the
 * whole file would cost thousands of tokens a page for pages that are only text.
 */
import path from 'node:path'
import type { DocumentBlock, TextBlock } from '@encode/providers'
import { readPdf, type OutlineItem, type PdfReading } from './pdf'
import { plural } from './text'
import type { ToolContext, ToolOutcome } from './types'

export const PDF_MAX_BYTES = 100 * 1024 * 1024
export const PDF_MAX_PAGES = 20
/** Text one read gives: about 7,500 tokens. */
const PDF_MAX_CHARS = 30_000
const PDF_TIME_MS = 20_000
/** Pages one read attaches as a document, and the most that attachment may weigh. */
const DOCUMENT_MAX_PAGES = 10
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
const OUTLINE_MAX_ITEMS = 60
const OUTLINE_MAX_CHARS = 2_500
/** Glyphs with no text before Read says some are missing: a stray symbol is not worth a note. */
const UNKNOWN_NOTE_MIN = 20

/** "1-7", "3, 5 and 9", "1-3, 6 and 8-9". */
export function pageList(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    ranges.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return ranges.length > 1 ? `${ranges.slice(0, -1).join(', ')} and ${ranges[ranges.length - 1]}` : (ranges[0] ?? '')
}

const pagesWord = (numbers: number[]) => (numbers.length === 1 && !pageList(numbers).includes('-') ? 'Page' : 'Pages')

function outlineText(items: OutlineItem[]): string {
  const lines: string[] = []
  let chars = 0
  let shown = 0
  for (const item of items) {
    const line = `${'  '.repeat(Math.min(item.depth, 2))}${item.title}${item.page ? ` (p. ${item.page})` : ''}`
    if (shown >= OUTLINE_MAX_ITEMS || chars + line.length > OUTLINE_MAX_CHARS) break
    lines.push(line)
    chars += line.length + 1
    shown++
  }
  if (shown < items.length) lines.push(`(${items.length - shown} more entries)`)
  return lines.join('\n')
}

/** A title worth showing: not a placeholder, and not the path the file was printed from. */
function titleOf(reading: PdfReading, file: string): string | undefined {
  const title = reading.title?.trim()
  if (!title || title.length > 200 || /^(?:untitled|file:|https?:)/i.test(title)) return undefined
  return title === path.basename(file) ? undefined : title
}

export async function readPdfFile(file: string, name: string, bytes: Uint8Array, pages: string | undefined, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await readPdf(bytes, { pages, maxPages: PDF_MAX_PAGES, maxChars: PDF_MAX_CHARS, timeMs: PDF_TIME_MS, signal: ctx.signal })
  if (!result.ok) return { ok: false, content: `${name} ${result.error}` }
  const reading = result.reading
  const read = reading.pages.map((page) => page.number)
  const title = titleOf(reading, file)
  const head = [`PDF ${name}: ${plural(reading.pageCount, 'page')}${title ? `, titled "${title}"` : ''}.`]
  if (!reading.chosen && reading.outline.length) head.push(`Outline:\n${outlineText(reading.outline)}`)
  if (reading.rest.length) {
    const next = reading.rest.slice(0, Math.max(1, read.length))
    head.push(`(${pagesWord(read)} ${pageList(read)} of ${reading.pageCount}. Pass pages, like "${pageList(next).replace(/ and /g, ',').replace(/ /g, '')}", to read on.)`)
  }

  const visual = reading.pages.filter((page) => page.visual).map((page) => page.number)
  // The pages to see go as a PDF of their own, to a model that reads PDFs.
  let attached: number[] = []
  let document: DocumentBlock | undefined
  if (visual.length && ctx.readsDocuments?.()) {
    attached = visual.slice(0, DOCUMENT_MAX_PAGES)
    const data = reading.subset(attached, DOCUMENT_MAX_BYTES)
    if (data) {
      const which = `${pagesWord(attached).toLowerCase()} ${pageList(attached)}`
      document = {
        type: 'document',
        mediaType: 'application/pdf',
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
        name: `${path.basename(file, path.extname(file))} (${which}).pdf`,
        pages: attached.length,
        text: `(${pagesWord(attached)} ${pageList(attached)} also ${attached.length === 1 ? 'has' : 'have'} figures, charts or scans that the text leaves out.)`,
      }
    } else attached = []
  }

  const notes: string[] = []
  if (attached.length) notes.push(`${pagesWord(attached)} ${pageList(attached)} ${attached.length === 1 ? 'has' : 'have'} figures, charts or scans; ${attached.length === 1 ? 'it is' : 'they are'} attached below as a PDF of just ${attached.length === 1 ? 'that page' : 'those pages'}, so you can see ${attached.length === 1 ? 'it' : 'them'}.`)
  const unseen = visual.filter((number) => !attached.includes(number))
  if (unseen.length) {
    const scanned = reading.pages.filter((page) => page.scanned && unseen.includes(page.number)).map((page) => page.number)
    const them = unseen.length === 1 ? 'it' : 'them'
    const reason = !ctx.readsDocuments?.() ? `this model cannot see ${them}` : attached.length ? `read ${them} with pages to see ${them}` : `${unseen.length === 1 ? 'it was' : 'they were'} too large to attach`
    notes.push(`${pagesWord(unseen)} ${pageList(unseen)} ${unseen.length === 1 ? 'has' : 'have'} figures, charts or scans that the text leaves out; ${reason}.`)
    if (scanned.length) notes.push(`${pagesWord(scanned)} ${pageList(scanned)} ${scanned.length === 1 ? 'is' : 'are'} mostly an image, such as a scan without a text layer, so ${scanned.length === 1 ? 'its' : 'their'} text here is incomplete.`)
  }
  const partial = reading.pages.filter((page) => page.partial).map((page) => page.number)
  if (partial.length) notes.push(`${pagesWord(partial)} ${pageList(partial)} could only be read in part.`)
  const chars = reading.pages.reduce((sum, page) => sum + page.text.length, 0)
  if (reading.unknownGlyphs >= UNKNOWN_NOTE_MIN && reading.unknownGlyphs > chars * 0.02) {
    notes.push(`About ${reading.unknownGlyphs} characters are missing: their fonts give no way to turn them into text.`)
  }
  if (reading.repaired) notes.push('The file is damaged; it was read the way PDF viewers read it, so some text may be missing or out of place.')

  const body = reading.pages.map((page) => `<page number="${page.number}">\n${page.text || '(no text on this page)'}\n</page>`).join('\n\n')
  const text = [head.join('\n'), body, notes.length ? `(${notes.join(' ')})` : ''].filter(Boolean).join('\n\n')
  const display = `${plural(read.length, 'page')}${read.length < reading.pageCount ? ` of ${reading.pageCount}` : ''}${attached.length ? `, ${plural(attached.length, 'page')} attached` : ''}`
  const content: (TextBlock | DocumentBlock)[] = [{ type: 'text', text }]
  if (document) content.push(document)
  return { ok: true, content: document ? content : text, display: { output: display } }
}
