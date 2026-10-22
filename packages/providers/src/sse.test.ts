import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { readSse, type SseItem } from './sse'

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SseItem[]> {
  const items: SseItem[] = []
  for await (const item of readSse(body(chunks))) items.push(item)
  return items
}

const STREAM = [
  ': OPENROUTER PROCESSING\r\n\r\n',
  'event: message_start\r\ndata: {"a":1}\r\n\r\n',
  'data: line one\ndata: line two\n\n',
  'id: 7\rdata:no-space\r\r',
  'retry: 100\nevent: ignored-without-data\n\n',
  'data: {"last":true}',
].join('')

const EXPECTED: SseItem[] = [
  { kind: 'comment', text: 'OPENROUTER PROCESSING' },
  { kind: 'event', event: 'message_start', data: '{"a":1}' },
  { kind: 'event', event: 'message', data: 'line one\nline two' },
  { kind: 'event', event: 'message', data: 'no-space', id: '7' },
  { kind: 'event', event: 'message', data: '{"last":true}', id: '7' },
]

describe('readSse', () => {
  it('reads events, multi-line data, comments, ids and every line ending', async () => {
    assert.deepEqual(await collect([STREAM]), EXPECTED)
  })

  it('reads the same events however the bytes are chunked, CRLF pairs split included', async () => {
    await check(gen.array(gen.int(1, STREAM.length - 1), 0, 12), async (cuts) => {
      const points = [...new Set(cuts)].sort((a, b) => a - b)
      const chunks: string[] = []
      let start = 0
      for (const point of points) {
        chunks.push(STREAM.slice(start, point))
        start = point
      }
      chunks.push(STREAM.slice(start))
      assert.deepEqual(await collect(chunks), EXPECTED)
    })
  })

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo ✓\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const items: SseItem[] = []
    for await (const item of readSse(stream)) items.push(item)
    assert.deepEqual(items, [{ kind: 'event', event: 'message', data: 'héllo ✓' }])
  })
})
