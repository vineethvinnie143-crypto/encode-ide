import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { DocumentBlock, TextBlock } from '@encode/providers'
import { readTool } from './files'
import { readPdf } from './pdf'
import { pageList } from './pdf-read'
import { line, pages } from './pdf/testing'
import { tempWorkspace, testContext } from './testing'
import type { ToolContext, ToolOutcome } from './types'

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'packages/tools/src/pdf/fixtures', name))

async function readIn(files: Record<string, string | Buffer>, input: { file_path: string; pages?: string }, overrides: Partial<ToolContext> = {}): Promise<ToolOutcome> {
  const root = await tempWorkspace(files)
  const ctx = testContext(root, overrides)
  return readTool.run({ ...input, file_path: path.join(root, input.file_path) }, ctx)
}

const textIn = (outcome: ToolOutcome) =>
  typeof outcome.content === 'string'
    ? outcome.content
    : outcome.content
        .filter((part): part is TextBlock => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

describe('Read: PDFs', () => {
  it('shows the outline and each page on a first read', async () => {
    const outcome = await readIn({ 'r.pdf': fixture('reportlab.pdf') }, { file_path: 'r.pdf' })
    assert.equal(outcome.ok, true)
    const text = textIn(outcome)
    assert.ok(text.startsWith('PDF r.pdf: 2 pages, titled "Canvas test".\nOutline:\nTwo columns (p. 1)\nRotated page (p. 2)\n\n<page number="1">\nThe left column starts here and\n'), text)
    assert.match(text, /\n<\/page>\n\n<page number="2">\nThis page is rotated ninety degrees\.\nSecond line of the rotated page\.\n<\/page>$/)
    assert.deepEqual(outcome.display, { output: '2 pages' })
  })

  it('reads the pages asked for, without the outline again', async () => {
    const outcome = await readIn({ 'r.pdf': fixture('reportlab.pdf') }, { file_path: 'r.pdf', pages: '2' })
    assert.equal(textIn(outcome), 'PDF r.pdf: 2 pages, titled "Canvas test".\n\n<page number="2">\nThis page is rotated ninety degrees.\nSecond line of the rotated page.\n</page>')
    assert.deepEqual(outcome.display, { output: '1 page of 2' })
  })

  it('says which pages are left and how to ask for them', async () => {
    const many = Buffer.from(pages(Array.from({ length: 25 }, (_, i) => line(`Page ${i + 1}`))))
    const text = textIn(await readIn({ 'long.pdf': many }, { file_path: 'long.pdf' }))
    assert.match(text, /^PDF long\.pdf: 25 pages\.\n\(Pages 1-20 of 25\. Pass pages, like "21-25", to read on\.\)\n\n<page number="1">\nPage 1\n<\/page>/)
    assert.match(text, /<page number="20">\nPage 20\n<\/page>$/)
  })

  it('attaches the pages with something to see as a PDF of their own, for a model that reads PDFs', async () => {
    const outcome = await readIn({ 'c.pdf': fixture('chromium.pdf') }, { file_path: 'c.pdf' }, { readsDocuments: () => true })
    assert.ok(Array.isArray(outcome.content))
    const [text, document] = outcome.content as [TextBlock, DocumentBlock]
    assert.match(text.text, /\(Page 2 has figures, charts or scans; it is attached below as a PDF of just that page, so you can see it\.\)$/)
    assert.equal(document.type, 'document')
    assert.equal(document.name, 'c (page 2).pdf')
    assert.equal(document.pages, 1)
    assert.equal(document.text, '(Page 2 also has figures, charts or scans that the text leaves out.)')
    const attached = await readPdf(new Uint8Array(Buffer.from(document.data, 'base64')), { maxPages: 20, maxChars: 30_000, timeMs: 5_000 })
    assert.ok(attached.ok)
    assert.equal(attached.reading.pageCount, 1)
    assert.equal(attached.reading.pages[0].text, 'A figure\n\nFigure 1: a gradient.')
    assert.deepEqual(outcome.display, { output: '2 pages, 1 page attached' })
  })

  it('says what the text leaves out when the model cannot see it', async () => {
    const outcome = await readIn({ 'c.pdf': fixture('chromium.pdf') }, { file_path: 'c.pdf' }, { readsDocuments: () => false })
    assert.equal(typeof outcome.content, 'string')
    assert.match(textIn(outcome), /\(Page 2 has figures, charts or scans that the text leaves out; this model cannot see it\.\)$/)
  })

  it('explains a password, a damaged file and pages given for another kind of file', async () => {
    const locked = await readIn({ 'p.pdf': fixture('password.pdf') }, { file_path: 'p.pdf' })
    assert.deepEqual(locked, { ok: false, content: 'p.pdf is protected by a password, so it cannot be opened without it. Ask the user for a copy without the password.' })
    const broken = await readIn({ 'b.pdf': 'not a pdf at all' }, { file_path: 'b.pdf' })
    assert.deepEqual(broken, { ok: false, content: 'b.pdf could not be read as a PDF: The file does not start like a PDF.' })
    const past = await readIn({ 'r.pdf': fixture('reportlab.pdf') }, { file_path: 'r.pdf', pages: '5' })
    assert.deepEqual(past, { ok: false, content: 'r.pdf has 2 pages, so page 5 is past its end.' })
    const text = await readIn({ 'a.txt': 'hello\n' }, { file_path: 'a.txt', pages: '1' })
    assert.deepEqual(text, { ok: false, content: 'pages is for PDFs; a.txt is not one. Use offset and limit to read part of it.' })
  })

  it('writes page lists the way people do', () => {
    assert.equal(pageList([3]), '3')
    assert.equal(pageList([1, 2, 3, 4]), '1-4')
    assert.equal(pageList([9, 3, 5]), '3, 5 and 9')
    assert.equal(pageList([1, 2, 3, 6, 8, 9]), '1-3, 6 and 8-9')
  })
})
