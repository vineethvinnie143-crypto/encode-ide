import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { linkedTransports } from './fake-server'
import {
  Connection,
  ConnectionClosedError,
  ErrorCode,
  McpError,
  ProtocolError,
  RequestTimeoutError,
  parseMessages,
  toMessage,
  type JsonRpcMessage,
} from './jsonrpc'

function pair(clientHandlers = {}, serverHandlers = {}) {
  const [a, b] = linkedTransports()
  const client = new Connection(a, clientHandlers)
  const server = new Connection(b, serverHandlers)
  return { client, server, a, b }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('JSON-RPC messages', () => {
  it('accepts requests, notifications and responses', () => {
    assert.deepEqual(toMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.deepEqual(toMessage({ jsonrpc: '2.0', id: 'a', method: 'x', params: { k: 1 } }), { jsonrpc: '2.0', id: 'a', method: 'x', params: { k: 1 } })
    assert.deepEqual(toMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.deepEqual(toMessage({ jsonrpc: '2.0', id: 2, result: { ok: true } }), { jsonrpc: '2.0', id: 2, result: { ok: true } })
    assert.deepEqual(toMessage({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'no', data: 1 } }), { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'no', data: 1 } })
    assert.deepEqual(toMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad' } }), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad' } })
  })

  it('refuses everything else', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      { jsonrpc: '1.0', id: 1, method: 'x' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, method: '' },
      { jsonrpc: '2.0', id: {}, method: 'x' },
      { jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } },
      { jsonrpc: '2.0', id: 1, error: { code: 'x', message: 'x' } },
      { jsonrpc: '2.0', id: 1, error: { code: 1 } },
      { jsonrpc: '2.0', result: 1 },
      { jsonrpc: '2.0', id: Number.NaN, method: 'x' },
    ]) {
      assert.equal(toMessage(bad), null, JSON.stringify(bad))
    }
  })

  it('parses text, with batches from older servers', () => {
    assert.equal(parseMessages('{"jsonrpc":"2.0","id":1,"result":{}}').length, 1)
    assert.equal(parseMessages('[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","method":"n"}]').length, 2)
    assert.throws(() => parseMessages('not json'), ProtocolError)
    assert.throws(() => parseMessages('[]'), ProtocolError)
    assert.throws(() => parseMessages('[{"jsonrpc":"2.0"}]'), ProtocolError)
    assert.throws(() => parseMessages(JSON.stringify(Array.from({ length: 65 }, () => ({ jsonrpc: '2.0', method: 'x' })))), ProtocolError)
  })
})

describe('requests', () => {
  it('matches answers to requests, whatever the order', async () => {
    const { client } = pair({}, {
      async request(method: string, params: unknown) {
        await wait(method === 'slow' ? 30 : 1)
        return { method, params }
      },
    })
    const [slow, fast] = await Promise.all([client.request('slow', { n: 1 }), client.request('fast', { n: 2 })])
    assert.deepEqual(slow, { method: 'slow', params: { n: 1 } })
    assert.deepEqual(fast, { method: 'fast', params: { n: 2 } })
  })

  it('rejects with the error the other side answered', async () => {
    const { client } = pair({}, {
      async request() {
        throw new McpError(-32602, 'bad params', { why: 'because' })
      },
    })
    await assert.rejects(client.request('x'), (error: McpError) => error instanceof McpError && error.code === -32602 && error.message === 'bad params' && (error.data as { why: string }).why === 'because')
  })

  it('answers the other side: ping, unknown methods, and failures without leaking their message', async () => {
    const { client } = pair({}, {
      async request(method: string) {
        if (method === 'boom') throw new Error('secret path /home/u/.ssh/id_rsa')
        throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`)
      },
    })
    assert.deepEqual(await client.request('ping'), {})
    await assert.rejects(client.request('nope'), (error: McpError) => error.code === ErrorCode.MethodNotFound)
    await assert.rejects(client.request('boom'), (error: McpError) => error.code === ErrorCode.InternalError && error.message === 'Internal error')
    const bare = pair()
    await assert.rejects(bare.client.request('anything'), (error: McpError) => error.code === ErrorCode.MethodNotFound)
  })

  it('ignores answers nobody waits for', async () => {
    const [a, b] = linkedTransports()
    const client = new Connection(a)
    const seen: JsonRpcMessage[] = []
    b.onmessage = (message) => seen.push(message)
    const pending = client.request('x', undefined, { timeoutMs: 1000 })
    await wait(5)
    for (const stray of [{ jsonrpc: '2.0', id: 99, result: 1 }, { jsonrpc: '2.0', id: null, error: { code: 1, message: 'x' } }] as JsonRpcMessage[]) a.onmessage?.(stray)
    await b.send({ jsonrpc: '2.0', id: (seen[0] as { id: number }).id, result: 'right one' })
    assert.equal(await pending, 'right one')
  })

  it('gives up after the timeout and tells the server', async () => {
    const [a, b] = linkedTransports()
    const client = new Connection(a)
    const seen: JsonRpcMessage[] = []
    b.onmessage = (message) => seen.push(message)
    await assert.rejects(client.request('hang', undefined, { timeoutMs: 20 }), RequestTimeoutError)
    await wait(5)
    const asked = seen[0] as { id: number }
    const cancel = seen.find((message) => 'method' in message && message.method === 'notifications/cancelled') as { params: { requestId: number; reason: string } } | undefined
    assert.ok(cancel, 'the server was not told')
    assert.equal(cancel.params.requestId, asked.id)
    assert.match(cancel.params.reason, /timed out/)
  })

  it('stops when aborted, and the server learns of it', async () => {
    let serverSignal: AbortSignal | undefined
    const { client } = pair({}, {
      request: (_method: string, _params: unknown, signal: AbortSignal) => {
        serverSignal = signal
        return new Promise(() => {})
      },
    })
    const controller = new AbortController()
    const pending = client.request('hang', undefined, { signal: controller.signal, timeoutMs: 5000 })
    await wait(5)
    controller.abort(new Error('user pressed stop'))
    await assert.rejects(pending, /user pressed stop/)
    await wait(10)
    assert.equal(serverSignal?.aborted, true)
    await assert.rejects(client.request('x', undefined, { signal: controller.signal }), /user pressed stop/)
  })

  it('passes progress on and lets it keep a request alive, up to a limit', async () => {
    const { client, server } = pair({}, {
      async request(method: string, params: { _meta?: { progressToken: number } }) {
        const token = params._meta?.progressToken
        for (let step = 1; step <= 4; step++) {
          await wait(25)
          if (token !== undefined) await serverNotify(step, token)
        }
        return method
      },
    })
    async function serverNotify(step: number, token: number) {
      await server.notify('notifications/progress', { progressToken: token, progress: step, total: 4, message: `step ${step}` })
    }
    const seen: number[] = []
    const result = await client.request('long', { a: 1 }, { timeoutMs: 40, resetTimeoutOnProgress: true, onProgress: (p) => seen.push(p.progress) })
    assert.equal(result, 'long')
    assert.deepEqual(seen, [1, 2, 3, 4])
    // Without the reset the same request times out; with it, a total cap still ends it.
    await assert.rejects(client.request('long', {}, { timeoutMs: 40, onProgress: () => {} }), RequestTimeoutError)
    await assert.rejects(client.request('long', {}, { timeoutMs: 40, resetTimeoutOnProgress: true, maxTotalMs: 60, onProgress: () => {} }), RequestTimeoutError)
  })

  it('fails what is waiting when the connection ends', async () => {
    const { client, a } = pair({}, { request: () => new Promise(() => {}) })
    const reasons: Array<Error | undefined> = []
    client.onclose = (reason) => reasons.push(reason)
    const pending = client.request('hang', undefined, { timeoutMs: 5000 })
    await wait(5)
    await a.close()
    await assert.rejects(pending, ConnectionClosedError)
    await assert.rejects(client.request('late'), ConnectionClosedError)
    assert.equal(reasons.length, 1)
  })

  it('survives a notification handler that throws', async () => {
    const { client, server } = pair({
      notification() {
        throw new Error('handler bug')
      },
    })
    await server.notify('notifications/anything')
    await wait(5)
    assert.deepEqual(await server.request('ping'), {})
    assert.deepEqual(await client.request('ping'), {})
  })

  it('cancels a request being served when the other side cancels it', async () => {
    let aborted = false
    const { client } = pair({}, {
      request: (_method: string, _params: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('stopped'))
          })
        }),
    })
    const controller = new AbortController()
    const pending = client.request('serve', undefined, { signal: controller.signal })
    await wait(5)
    controller.abort()
    await assert.rejects(pending)
    await wait(10)
    assert.equal(aborted, true)
  })
})
