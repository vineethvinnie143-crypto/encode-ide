import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { JSONRPC_ERRORS, JsonRpcConnection, RpcFailure } from './jsonrpc'

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** A connection whose other end the test plays. */
function pair(options: ConstructorParameters<typeof JsonRpcConnection>[2] = {}) {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const written: unknown[] = []
  let pending = Buffer.alloc(0)
  toServer.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      const length = Number(/Content-Length: (\d+)/.exec(pending.subarray(0, end).toString())![1])
      if (pending.length < end + 4 + length) return
      written.push(JSON.parse(pending.subarray(end + 4, end + 4 + length).toString('utf8')))
      pending = pending.subarray(end + 4 + length)
    }
  })
  let closed: string | null = null
  const connection = new JsonRpcConnection(fromServer, toServer, { ...options, onClose: (reason) => (closed = reason) })
  return { connection, fromServer, written, closed: () => closed }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('the wire format', () => {
  it('reads messages split anywhere, even one byte at a time, and several in one chunk', async () => {
    const seen: unknown[] = []
    const { fromServer } = pair({ onNotification: (method, params) => seen.push([method, params]) })
    const both = Buffer.concat([frame({ jsonrpc: '2.0', method: 'a', params: { text: 'café \u{1F600}' } }), frame({ jsonrpc: '2.0', method: 'b' })])
    for (const byte of both) fromServer.write(Buffer.from([byte]))
    fromServer.write(Buffer.concat([frame({ jsonrpc: '2.0', method: 'c' }), frame({ jsonrpc: '2.0', method: 'd' })]))
    await tick()
    assert.deepEqual(seen, [['a', { text: 'café \u{1F600}' }], ['b', undefined], ['c', undefined], ['d', undefined]])
  })

  it('takes headers in any case and with a content type', async () => {
    const seen: string[] = []
    const { fromServer } = pair({ onNotification: (method) => seen.push(method) })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x' }))
    fromServer.write(Buffer.concat([Buffer.from(`content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`), body]))
    await tick()
    assert.deepEqual(seen, ['x'])
  })

  it('pairs answers with their requests, errors included', async () => {
    const { connection, fromServer, written } = pair()
    const first = connection.request('one', { a: 1 })
    const second = connection.request('two', null)
    await tick()
    const [a, b] = written as { id: number; method: string }[]
    assert.equal(a.method, 'one')
    fromServer.write(frame({ jsonrpc: '2.0', id: b.id, error: { code: -32803, message: 'nope', data: { why: 1 } } }))
    fromServer.write(frame({ jsonrpc: '2.0', id: a.id, result: { ok: true } }))
    assert.deepEqual(await first, { ok: true })
    await assert.rejects(second, (error: unknown) => error instanceof RpcFailure && error.code === -32803 && error.message === 'nope')
  })

  it('answers the server\'s requests, and says when it does not know a method', async () => {
    const { fromServer, written } = pair({
      onRequest: (method) => {
        if (method === 'workspace/configuration') return [{ x: 1 }]
        throw new RpcFailure('unknown', JSONRPC_ERRORS.methodNotFound)
      },
    })
    fromServer.write(frame({ jsonrpc: '2.0', id: 'a', method: 'workspace/configuration', params: {} }))
    fromServer.write(frame({ jsonrpc: '2.0', id: 7, method: 'something/else' }))
    await tick()
    await tick()
    // Answers go out as they are ready, in any order.
    const sorted = [...(written as { id: string | number }[])].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    assert.deepEqual(sorted, [
      { jsonrpc: '2.0', id: 7, error: { code: JSONRPC_ERRORS.methodNotFound, message: 'unknown' } },
      { jsonrpc: '2.0', id: 'a', result: [{ x: 1 }] },
    ])
  })

  it('cancels a request that is stopped or times out, and drops its late answer', async () => {
    const { connection, fromServer, written } = pair()
    const controller = new AbortController()
    const stopped = connection.request('slow', {}, { signal: controller.signal })
    controller.abort()
    await assert.rejects(stopped, (error: unknown) => error instanceof RpcFailure && error.code === 'cancelled')
    const timed = connection.request('slower', {}, { timeoutMs: 20 })
    await assert.rejects(timed, (error: unknown) => error instanceof RpcFailure && error.code === 'timeout')
    await tick()
    const cancels = (written as { method?: string; params?: { id: number } }[]).filter((item) => item.method === '$/cancelRequest')
    assert.equal(cancels.length, 2)
    // The answer that comes after is ignored, and the connection carries on.
    fromServer.write(frame({ jsonrpc: '2.0', id: cancels[0].params!.id, result: 'late' }))
    const next = connection.request('next', {})
    await tick()
    fromServer.write(frame({ jsonrpc: '2.0', id: (written.at(-1) as { id: number }).id, result: 'fine' }))
    assert.equal(await next, 'fine')
  })

  it('ends the connection on a header that never ends', async () => {
    const { connection, fromServer, closed } = pair()
    const waiting = connection.request('x', {})
    fromServer.write(Buffer.alloc(9000, 'a'))
    await assert.rejects(waiting, (error: unknown) => error instanceof RpcFailure && error.code === 'closed')
    assert.match(closed() ?? '', /header that never ended/)
  })

  it('ends the connection on a message over the limit, before reading it', async () => {
    const { fromServer, closed } = pair({ maxMessageBytes: 1000 })
    fromServer.write(Buffer.from('Content-Length: 5000\r\n\r\n'))
    await tick()
    assert.match(closed() ?? '', /5000 bytes/)
  })

  it('ends the connection on a bad length or a body that is not JSON', async () => {
    const one = pair()
    one.fromServer.write(Buffer.from('Content-Length: -4\r\n\r\n'))
    await tick()
    assert.match(one.closed() ?? '', /valid Content-Length/)
    const two = pair()
    two.fromServer.write(Buffer.from('Content-Length: 3\r\n\r\n{x}'))
    await tick()
    assert.match(two.closed() ?? '', /not JSON/)
  })

  it('refuses what waits when the server goes away, and what is asked after', async () => {
    const { connection, fromServer } = pair()
    const waiting = connection.request('x', {})
    fromServer.end()
    await assert.rejects(waiting, /closed its output/)
    await assert.rejects(connection.request('y', {}), (error: unknown) => error instanceof RpcFailure && error.code === 'closed')
    connection.notify('ignored')
  })

  it('keeps going when a notification handler throws', async () => {
    const seen: string[] = []
    const { fromServer } = pair({
      onNotification: (method) => {
        seen.push(method)
        throw new Error('handler bug')
      },
    })
    fromServer.write(Buffer.concat([frame({ jsonrpc: '2.0', method: 'a' }), frame({ jsonrpc: '2.0', method: 'b' })]))
    await tick()
    assert.deepEqual(seen, ['a', 'b'])
  })
})
