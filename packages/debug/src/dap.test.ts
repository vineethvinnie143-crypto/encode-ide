import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { DapConnection, DapError, dapErrorText, type DapEvent } from './dap'

/** A connection, and the adapter's end of it: what it was sent, and a way to send it messages. */
function pair(options: { maxMessageBytes?: number; onRequest?: (command: string, args: Record<string, unknown>) => unknown } = {}) {
  const fromAdapter = new PassThrough()
  const toAdapter = new PassThrough()
  const events: DapEvent[] = []
  const closed: string[] = []
  const dap = new DapConnection(fromAdapter, toAdapter, { onEvent: (event) => events.push(event), onClose: (reason) => closed.push(reason), ...options })
  const sent: Record<string, unknown>[] = []
  let buffer = ''
  toAdapter.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer)
      if (!match || buffer.length < match[0].length + Number(match[1])) return
      sent.push(JSON.parse(buffer.slice(match[0].length, match[0].length + Number(match[1]))))
      buffer = buffer.slice(match[0].length + Number(match[1]))
    }
  })
  const frame = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  }
  return { dap, events, closed, sent, send: (message: unknown) => fromAdapter.write(frame(message)), raw: (data: string | Buffer) => fromAdapter.write(data), frame }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('the Debug Adapter Protocol connection (ADR 0144)', () => {
  it('answers a request by its sequence number, and gives the error the adapter wrote with its variables filled in', async () => {
    const p = pair()
    const first = p.dap.request('threads')
    const second = p.dap.request('evaluate', { expression: 'x' })
    await tick()
    assert.deepEqual(p.sent.map((message) => [message.seq, message.command]), [[1, 'threads'], [2, 'evaluate']])
    p.send({ seq: 9, type: 'response', request_seq: 2, success: false, command: 'evaluate', message: 'error', body: { error: { id: 1, format: 'Unable to evaluate {expr}: {why}', variables: { expr: 'x', why: 'not defined' } } } })
    p.send({ seq: 10, type: 'response', request_seq: 1, success: true, command: 'threads', body: { threads: [{ id: 1, name: 'main' }] } })
    assert.deepEqual(await first, { threads: [{ id: 1, name: 'main' }] })
    await assert.rejects(second, (error: unknown) => error instanceof DapError && error.code === 'failed' && error.message === 'Unable to evaluate x: not defined')
  })

  it('reads messages split anywhere and run together, and drops answers to requests never made', async () => {
    const p = pair()
    const asked = p.dap.request('threads')
    const both = Buffer.concat([p.frame({ seq: 1, type: 'event', event: 'output', body: { output: 'héllo\n' } }), p.frame({ seq: 2, type: 'response', request_seq: 77, success: true }), p.frame({ seq: 3, type: 'response', request_seq: 1, success: true, body: {} })])
    for (let at = 0; at < both.length; at += 7) p.raw(both.subarray(at, at + 7))
    assert.deepEqual(await asked, {})
    assert.deepEqual(p.events, [{ event: 'output', body: { output: 'héllo\n' } }])
    assert.equal(p.closed.length, 0)
  })

  it('answers what the adapter asks of it, as not supported unless it is handled', async () => {
    const quiet = pair()
    quiet.send({ seq: 5, type: 'request', command: 'runInTerminal', arguments: { args: ['sh'] } })
    await tick()
    await tick()
    assert.equal(quiet.sent[0]?.type, 'response')
    assert.equal(quiet.sent[0]?.request_seq, 5)
    assert.equal(quiet.sent[0]?.success, false)
    const handled = pair({ onRequest: (command) => ({ handled: command }) })
    handled.send({ seq: 6, type: 'request', command: 'handshake', arguments: {} })
    await tick()
    await tick()
    assert.deepEqual([handled.sent[0]?.success, handled.sent[0]?.body], [true, { handled: 'handshake' }])
  })

  it('ends the connection on a header that never ends, a message over the limit or one that is not JSON, and refuses what waited', async () => {
    const header = pair()
    const waiting = header.dap.request('threads')
    header.raw('X'.repeat(9_000))
    await assert.rejects(waiting, (error: unknown) => error instanceof DapError && error.code === 'closed')
    assert.match(header.closed[0] ?? '', /header that never ended/)

    const big = pair({ maxMessageBytes: 100 })
    big.raw('Content-Length: 101\r\n\r\n')
    assert.match(big.closed[0] ?? '', /more than the 100 allowed/)

    const garbled = pair()
    garbled.raw('Content-Length: 3\r\n\r\n{x}')
    assert.match(garbled.closed[0] ?? '', /not JSON/)
    await assert.rejects(garbled.dap.request('threads'), /not JSON/)

    const noLength = pair()
    noLength.raw('Content-Type: x\r\n\r\n')
    assert.match(noLength.closed[0] ?? '', /without a valid Content-Length/)
  })

  it('gives up on a request never answered', async () => {
    const p = pair()
    await assert.rejects(p.dap.request('threads', {}, { timeoutMs: 20 }), (error: unknown) => error instanceof DapError && error.code === 'timeout')
  })

  it('reads an error with no format from its message, else names the request', () => {
    assert.equal(dapErrorText({ message: 'notStopped' }, 'next'), 'notStopped')
    assert.equal(dapErrorText({ body: { error: { format: 'Missing {name}', variables: {} } } }, 'x'), 'Missing {name}')
    assert.equal(dapErrorText({}, 'scopes'), 'The debugger could not do scopes.')
  })
})
