import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Peer, RpcError, createPortPair, type Port } from './rpc'

type HostApi = {
  requests: {
    add: { params: { a: number; b: number }; result: number }
    wait: { params: undefined; result: string }
    fail: { params: { code: string }; result: never }
    clone: { params: undefined; result: unknown }
  }
  events: { tick: { n: number } }
}

type ClientApi = {
  requests: { hello: { params: string; result: string } }
  events: {}
}

function connect() {
  const [left, right] = createPortPair()
  const host = new Peer<HostApi, ClientApi>(left)
  const client = new Peer<ClientApi, HostApi>(right)
  return { host, client, left, right }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Peer', () => {
  it('answers requests both ways and delivers events', async () => {
    const { host, client } = connect()
    host.handle('add', ({ a, b }) => a + b)
    client.handle('hello', (name) => `hello ${name}`)
    const ticks: number[] = []
    client.on('tick', ({ n }) => ticks.push(n))

    assert.equal(await client.request('add', { a: 2, b: 3 }), 5)
    assert.equal(await host.request('hello', 'host'), 'hello host')
    host.notify('tick', { n: 1 })
    host.notify('tick', { n: 2 })
    await tick()
    assert.deepEqual(ticks, [1, 2])
  })

  it('refuses unknown methods and params that fail the schema', async () => {
    const { host, client } = connect()
    host.handle('add', ({ a, b }) => a + b, {
      schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
    })
    await assert.rejects(client.request('add', { a: 1 } as never), (error: RpcError) => error.code === 'invalid-params' && /b is required/.test(error.message))
    await assert.rejects(client.request('wait'), (error: RpcError) => error.code === 'unknown-method')
  })

  it('carries a handler error as a code and a message, without the stack', async () => {
    const { host, client } = connect()
    host.handle('fail', ({ code }) => {
      throw Object.assign(new Error('No such session.'), { code })
    })
    await assert.rejects(client.request('fail', { code: 'not-found' }), (error: RpcError) => {
      assert.equal(error.code, 'not-found')
      assert.equal(error.message, 'No such session.')
      return true
    })
    host.handle('fail', () => {
      throw 'plain'
    })
    await assert.rejects(client.request('fail', { code: '' }), (error: RpcError) => error.code === 'internal' && error.message === 'plain')
  })

  it('cancels a running handler when the caller aborts', async () => {
    const { host, client } = connect()
    let handlerSignal: AbortSignal | undefined
    host.handle('wait', (_params, { signal }) => {
      handlerSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    })
    const controller = new AbortController()
    const pending = client.request('wait', undefined, { signal: controller.signal })
    await tick()
    controller.abort(new Error('user stopped'))
    await assert.rejects(pending, /user stopped/)
    await tick()
    assert.equal(handlerSignal?.aborted, true)
    assert.equal((handlerSignal?.reason as RpcError).code, 'cancelled')
  })

  it('times out, and tells the other side to stop', async () => {
    const { host, client } = connect()
    let aborted = false
    host.handle('wait', (_params, { signal }) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))))
    await assert.rejects(client.request('wait', undefined, { timeoutMs: 20 }), (error: RpcError) => error.code === 'timeout')
    await tick()
    assert.equal(aborted, true)
  })

  it('rejects pending requests and aborts handlers when either side closes', async () => {
    const { host, client } = connect()
    let aborted = false
    host.handle('wait', (_params, { signal }) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))))
    const pending = client.request('wait')
    await tick()
    host.close()
    await assert.rejects(pending, (error: RpcError) => error.code === 'closed')
    assert.equal(aborted, true)
    assert.equal(client.closed, true)
    await assert.rejects(client.request('add', { a: 1, b: 1 }), (error: RpcError) => error.code === 'closed')
  })

  it('answers with an error when a result cannot be cloned', async () => {
    const { host, client } = connect()
    host.handle('clone', () => ({ run: () => 1 }))
    await assert.rejects(client.request('clone'), (error: RpcError) => error.code === 'internal' && /cannot be sent/.test(error.message))
  })

  it('ignores malformed envelopes, but answers a broken request that has an id', async () => {
    const received: unknown[] = []
    const errors: string[] = []
    const fake: Port & { deliver(message: unknown): void } = {
      post: (message) => received.push(message),
      listen(handler) {
        fake.deliver = handler
        return () => {}
      },
      deliver: () => {},
    }
    const peer = new Peer<HostApi, ClientApi>(fake, { onProtocolError: (error) => errors.push(error.message) })
    peer.handle('add', ({ a, b }) => a + b)
    for (const message of [null, 'x', [], { v: 2, t: 'req', id: 1, m: 'add' }, { v: 1, t: 'nope' }, { v: 1, t: 'res', id: 0 }, { v: 1, t: 'res', id: 3, e: 'bad' }]) {
      fake.deliver(message)
    }
    fake.deliver({ v: 1, t: 'req', id: 7, m: '' })
    await tick()
    assert.equal(errors.length, 8)
    assert.deepEqual(received, [
      { v: 1, t: 'res', id: 1, e: { code: 'invalid-message', message: 'unsupported protocol version 2' } },
      { v: 1, t: 'res', id: 7, e: { code: 'invalid-message', message: 'a request needs a method name' } },
    ])
    fake.deliver({ v: 1, t: 'req', id: 8, m: 'add', p: { a: 1, b: 2 } })
    await tick()
    assert.deepEqual(received.at(-1), { v: 1, t: 'res', id: 8, r: 3 })
  })

  it('keeps listener failures away from the connection', async () => {
    const errors: string[] = []
    const [left, right] = createPortPair()
    const host = new Peer<HostApi, ClientApi>(left)
    const client = new Peer<ClientApi, HostApi>(right, { onProtocolError: (error) => errors.push(error.message) })
    const seen: number[] = []
    client.on('tick', () => {
      throw new Error('listener broke')
    })
    client.on('tick', ({ n }) => seen.push(n))
    host.notify('tick', { n: 4 })
    await tick()
    assert.deepEqual(seen, [4])
    assert.deepEqual(errors, ['listener broke'])
  })
})
