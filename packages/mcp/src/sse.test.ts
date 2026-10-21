import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { ProtocolError } from './jsonrpc'
import { SseParser, readEvents, type SseEvent } from './sse'

const encode = (text: string) => new TextEncoder().encode(text)

/** Feeds `bytes` to a parser cut at the given offsets, then ends the stream. */
function parseCut(bytes: Uint8Array, cuts: number[], maxChars?: number): SseEvent[] {
  const parser = new SseParser(maxChars)
  const events: SseEvent[] = []
  let at = 0
  for (const cut of [...[...cuts].sort((a, b) => a - b), bytes.length]) {
    if (cut <= at) continue
    events.push(...parser.push(bytes.slice(at, cut)))
    at = cut
  }
  events.push(...parser.end())
  return events
}

const parse = (text: string) => parseCut(encode(text), [])

describe('server-sent events', () => {
  it('reads events with a type, several data lines, comments and ids', () => {
    assert.deepEqual(parse('data: one\n\n'), [{ event: 'message', data: 'one' }])
    assert.deepEqual(parse('event: endpoint\ndata: /messages?x=1\n\n'), [{ event: 'endpoint', data: '/messages?x=1' }])
    assert.deepEqual(parse(': keep-alive\n\ndata: a\ndata: b\n\n'), [{ event: 'message', data: 'a\nb' }])
    assert.deepEqual(parse('id: 7\nretry: 1500\ndata: x\n\ndata: y\n\n'), [
      { event: 'message', data: 'x', id: '7', retry: 1500 },
      { event: 'message', data: 'y', id: '7', retry: 1500 },
    ])
  })

  it('takes one leading space off a value, and no more', () => {
    assert.deepEqual(parse('data:  two\n\n'), [{ event: 'message', data: ' two' }])
    assert.deepEqual(parse('data:none\n\n'), [{ event: 'message', data: 'none' }])
    assert.deepEqual(parse('data\n\n'), [{ event: 'message', data: '' }])
  })

  it('accepts LF, CR and CRLF line ends, mixed', () => {
    assert.deepEqual(parse('data: a\r\ndata: b\ndata: c\r\r'), [{ event: 'message', data: 'a\nb\nc' }])
    assert.deepEqual(parse('event: x\rdata: y\r\n\r\n'), [{ event: 'x', data: 'y' }])
  })

  it('does not dispatch events without data, nor one the server never finished', () => {
    assert.deepEqual(parse('event: x\n\n'), [])
    assert.deepEqual(parse('data: half\n'), [])
    assert.deepEqual(parse('data: whole\n\ndata: half'), [{ event: 'message', data: 'whole' }])
  })

  it('ignores retry values that are not plain numbers, and ids with a NUL', () => {
    assert.deepEqual(parse('retry: soon\nid: a\u0000b\ndata: x\n\n'), [{ event: 'message', data: 'x' }])
  })

  it('drops a byte order mark and joins characters cut inside their bytes', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('data: café € \u{1f600}\n\n')])
    for (let cut = 1; cut < bytes.length; cut++) {
      assert.deepEqual(parseCut(bytes, [cut]), [{ event: 'message', data: 'café € \u{1f600}' }], `cut at ${cut}`)
    }
  })

  it('does not take a CR at the end of a chunk for a whole line end', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push(encode('data: a\r')), [])
    assert.deepEqual(parser.push(encode('\n\r')), [])
    assert.deepEqual(parser.push(encode('\n')), [{ event: 'message', data: 'a' }])
  })

  it('refuses an event larger than the cap, however it arrives', () => {
    assert.throws(() => parseCut(encode('x'.repeat(200)), [50, 100], 100), ProtocolError)
    assert.throws(() => parseCut(encode(`${'data: yyyyyyyyyy\n'.repeat(20)}\n`), [], 100), ProtocolError)
    // Many small events are fine however large they add up to.
    assert.equal(parseCut(encode('data: yyyyyyyyyy\n\n'.repeat(50)), [], 100).length, 50)
  })

  it('reads a body to its end and lets go of it when the reader stops early', async () => {
    let cancelled = false
    const chunks = [encode('data: 1\n\nda'), encode('ta: 2\n\n'), encode('data: 3\n\n')]
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const seen: string[] = []
    for await (const event of readEvents(body)) {
      seen.push(event.data)
      if (seen.length === 2) break
    }
    assert.deepEqual(seen, ['1', '2'])
    assert.equal(cancelled, true)
  })

  it('gives the same events however the bytes are cut', async () => {
    const line = gen.string('ab :é€\t{}"', 0, 12)
    const record = gen.tuple(
      gen.oneOf<string | undefined>(undefined, 'message', 'ping', 'endpoint'),
      gen.array(line, 1, 4),
      gen.oneOf<string | undefined>(undefined, '1', '2', 'x y'),
      gen.oneOf('\n', '\r\n', '\r'),
      gen.oneOf(false, true),
    )
    // A line end is the same for every line of one event, so the blank line that ends it is never glued to the line before.
    await check(gen.tuple(gen.array(record, 1, 6), gen.array(gen.int(0, 1_000_000), 0, 5)), ([records, offsets]) => {
      let text = ''
      const expected: SseEvent[] = []
      let lastId: string | undefined
      for (const [event, data, id, eol, comment] of records) {
        if (comment) text += `: note${eol}`
        if (event !== undefined) text += `event: ${event}${eol}`
        if (id !== undefined) {
          text += `id: ${id}${eol}`
          lastId = id
        }
        for (const part of data) text += `data: ${part}${eol}`
        text += eol
        expected.push({ event: event ?? 'message', data: data.join('\n'), ...(lastId === undefined ? {} : { id: lastId }) })
      }
      const bytes = encode(text)
      assert.deepEqual(parseCut(bytes, []), expected)
      assert.deepEqual(parseCut(bytes, Array.from({ length: bytes.length }, (_, i) => i)), expected, 'one byte at a time')
      const cuts = offsets.map((offset) => offset % bytes.length)
      assert.deepEqual(parseCut(bytes, cuts), expected, `cut at ${cuts.join(',')}`)
    })
  })
})
