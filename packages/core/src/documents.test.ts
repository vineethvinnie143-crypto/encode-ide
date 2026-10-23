import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { textBlock, type DocumentBlock, type Message, type UserMessage } from '@encode/providers'
import { DOCUMENT_PAGE_TOKENS, estimateTokens } from './compaction'
import { withoutDocuments } from './documents'
import { sessionHarness } from './testing'

const document = (pages = 2): DocumentBlock => ({ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0xLjc=', name: 'a (pages 2-3).pdf', pages, text: '(Pages 2-3 also have figures.)' })

const result = (...parts: (DocumentBlock | ReturnType<typeof textBlock>)[]): UserMessage => ({
  role: 'user',
  content: [{ type: 'tool-result', toolUseId: 'call', content: parts }],
})

async function everythingStored(dir: string): Promise<string> {
  let all = ''
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
    all += await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8').catch(() => '')
  }
  return all
}

const documentsIn = (messages: readonly Message[]) =>
  messages.flatMap((message) => (message.role === 'user' ? message.content : [])).flatMap((block) => (block.type === 'tool-result' ? block.content : [])).filter((part) => part.type === 'document').length

describe('PDF pages attached for the model', () => {
  it('are stored as their text, and a message without one is stored as it is', () => {
    const message = result(textBlock('PDF a.pdf: 3 pages.'), document())
    assert.deepEqual(withoutDocuments(message), result(textBlock('PDF a.pdf: 3 pages.'), textBlock('(Pages 2-3 also have figures.)')))
    assert.equal(documentsIn([message]), 1, 'the message in memory keeps its document')
    const plain = result(textBlock('done'))
    assert.equal(withoutDocuments(plain), plain)
  })

  it('count as a page of text and a page image each', () => {
    const empty = estimateTokens([result(textBlock(''))])
    assert.equal(estimateTokens([result(textBlock(''), document(3))]) - empty, 3 * DOCUMENT_PAGE_TOKENS)
  })

  it('reach a model that reads PDFs, and stay out of the stored log', async () => {
    const pdf = await fs.readFile(path.join(process.cwd(), 'packages/tools/src/pdf/fixtures/chromium.pdf'))
    const h = await sessionHarness({
      files: { 'c.pdf': pdf },
      client: { documents: true },
      scriptFor: (root) => [{ calls: [{ name: 'Read', input: { file_path: path.join(root, 'c.pdf') } }] }, { text: 'It has a gradient.' }],
    })
    assert.equal((await h.session.start({ text: 'what is in c.pdf?', mode: 'code' })).kind, 'done')
    assert.equal(documentsIn(h.client.requests[1].payload.messages), 1)
    await h.session.flush()
    const stored = await everythingStored(h.dir)
    assert.match(stored, /Page 2 also has figures, charts or scans that the text leaves out/)
    assert.ok(!stored.includes('"type":"document"'), 'the PDF itself was not stored')
  })

  it('are not attached for a model that cannot read them', async () => {
    const pdf = await fs.readFile(path.join(process.cwd(), 'packages/tools/src/pdf/fixtures/chromium.pdf'))
    const h = await sessionHarness({
      files: { 'c.pdf': pdf },
      client: { documents: false },
      scriptFor: (root) => [{ calls: [{ name: 'Read', input: { file_path: path.join(root, 'c.pdf') } }] }, { text: 'Text only.' }],
    })
    await h.session.start({ text: 'what is in c.pdf?', mode: 'code' })
    assert.equal(documentsIn(h.client.requests[1].payload.messages), 0)
  })
})
