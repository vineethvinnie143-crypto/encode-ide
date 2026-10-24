import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { Peer } from './rpc'
import { decodeLine, encodeLine, streamChannels } from './stream'

type Api = {
  requests: { echo: { params: unknown; result: unknown } }
  events: { note: string }
}

/** Two ends of a pipe pair, as `ssh` gives the main process and the program at the other end. */
function pipes(options: { maxLineBytes?: number; problems?: Error[] } = {}) {
  const there = new PassThrough()
  const back = new PassThrough()
  const onProblem = (error: Error) => options.problems?.push(error)
  const near = streamChannels(back, there, { ...options, onProblem })
  const far = streamChannels(there, back, { ...options, onProblem })
  return { near, far, there, back }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('messages over a byte stream', () => {
  it('carry requests, answers and events, each channel on its own', async () => {
    const { near, far } = pipes()
    const client = new Peer<{ requests: {}; events: {} }, Api>(near.port('host'))
    const server = new Peer<Api>(far.port('host'))
    const other = new Peer<Api>(far.port('fs'))
    server.handle('echo', (params) => ({ host: params }))
    other.handle('echo', (params) => ({ fs: params }))
    const fsClient = new Peer<{ requests: {}; events: {} }, Api>(near.port('fs'))

    assert.deepEqual(await client.request('echo', { a: [1, 'two', null] }), { host: { a: [1, 'two', null] } })
    assert.deepEqual(await fsClient.request('echo', 'x'), { fs: 'x' })

    const notes: string[] = []
    client.on('note', (text) => notes.push(text))
    server.notify('note', 'line one\nline two')
    await tick()
    assert.deepEqual(notes, ['line one\nline two'])
  })

  it('keep bytes as bytes, a Buffer among them', () => {
    const value = { data: new Uint8Array([0, 10, 255]), buffer: Buffer.from('hi'), raw: new Uint8Array([1, 2]).buffer, text: 'plain' }
    const back = decodeLine(encodeLine(value)) as Record<string, unknown>
    assert.ok(back.data instanceof Uint8Array)
    assert.deepEqual([...(back.data as Uint8Array)], [0, 10, 255])
    assert.equal(Buffer.from(back.buffer as Uint8Array).toString(), 'hi')
    assert.deepEqual([...(back.raw as Uint8Array)], [1, 2])
    assert.equal(back.text, 'plain')
    assert.ok(!encodeLine(value).includes('\n'))
  })

  it('put a message split across chunks back together, and several in one chunk apart', async () => {
    const back = new PassThrough()
    const channels = streamChannels(back, new PassThrough())
    const seen: unknown[] = []
    channels.port('host').listen((message) => seen.push(message))
    const one = `${encodeLine({ c: 'host', e: { n: 1 } })}\n`
    const two = `${encodeLine({ c: 'host', e: { n: 2, text: 'é ✓' } })}\n`
    const bytes = Buffer.from(one + two)
    // Split inside a multi-byte character too.
    for (const piece of [bytes.subarray(0, 5), bytes.subarray(5, one.length + 12), bytes.subarray(one.length + 12)]) back.write(piece)
    await tick()
    assert.deepEqual(seen, [{ n: 1 }, { n: 2, text: 'é ✓' }])
  })

  it('drop what is not a message, and close a stream whose line has no end within the limit', async () => {
    const problems: Error[] = []
    const back = new PassThrough()
    const channels = streamChannels(back, new PassThrough(), { maxLineBytes: 64, onProblem: (error) => problems.push(error) })
    const seen: unknown[] = []
    channels.port('host').listen((message) => seen.push(message))
    let closed = false
    channels.onClose(() => (closed = true))
    back.write('motd from a login script\n{"no":"channel"}\n')
    back.write(`${encodeLine({ c: 'host', e: 'ok' })}\n`)
    await tick()
    assert.deepEqual(seen, ['ok'])
    assert.equal(problems.length, 2)
    assert.equal(closed, false)
    back.write('x'.repeat(100))
    await tick()
    assert.equal(closed, true)
    assert.match(problems.at(-1)!.message, /longer than 64 bytes/)
  })

  it('close every channel when the stream ends, and refuse to send after', async () => {
    const { near, far, back } = pipes()
    const client = new Peer<{ requests: {}; events: {} }, Api>(near.port('host'))
    new Peer<Api>(far.port('host')).handle('echo', () => new Promise(() => {}))
    const waiting = client.request('echo', 1)
    back.end()
    await assert.rejects(waiting, /closed/)
    assert.equal(near.closed, true)
    assert.throws(() => near.port('host').post({ v: 1, t: 'evt', m: 'note' }), /closed/)
  })
})
