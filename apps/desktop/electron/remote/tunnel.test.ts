import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { Peer } from '@encode/protocol'
import { streamChannels } from '@encode/protocol/stream'
import { KeyTokens, serveTunnel, tunnelFetch, type KeyBinding, type NetHostApi, type NetMainApi } from './tunnel'

const KEY = 'sk-or-v1-real-key-0123456789'

interface Seen {
  url: string
  init: RequestInit
}

function setup(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const there = new PassThrough()
  const back = new PassThrough()
  const near = streamChannels(back, there)
  const far = streamChannels(there, back)
  const seen: Seen[] = []
  const tokens = new KeyTokens()
  const main = new Peer<NetMainApi, NetHostApi>(near.port('net'))
  serveTunnel(main, tokens, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return answer(url, init)
    },
    allowed: (origin) => origin === 'https://openrouter.ai' || origin === 'https://api.search.brave.com',
    keyFor: (binding: KeyBinding, url) => (binding.kind === 'model' && binding.profileId === 'openrouter' && new URL(url).origin === 'https://openrouter.ai' ? KEY : ''),
  })
  const host = new Peer<NetHostApi, NetMainApi>(far.port('net'))
  return { fetch: tunnelFetch(host), seen, tokens }
}

const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

describe('model calls from another machine', () => {
  it('go out from this PC and stream their answer back as it comes', async () => {
    const { fetch, seen } = setup(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: one\n\n'))
          controller.enqueue(new TextEncoder().encode('data: two\n\n'))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(await response.text(), 'data: one\n\ndata: two\n\n')
    assert.equal(seen[0]!.init.method, 'POST')
    assert.equal(String(seen[0]!.init.body), '{"stream":true}')
  })

  it('carry a stand-in that this PC swaps for the key, in a header, for the server the key was entered for', async () => {
    const { fetch, seen, tokens } = setup(() => new Response('{}', { status: 200 }))
    const token = tokens.token({ kind: 'model', profileId: 'openrouter' })
    assert.ok(!token.includes(KEY))
    await fetch('https://openrouter.ai/api/v1/models', { headers: { authorization: `Bearer ${token}` } })
    assert.equal(headerOf(seen[0]!.init, 'authorization'), `Bearer ${KEY}`)
    // The same token, sent to another server the settings allow: the key does not go there.
    await assert.rejects(fetch('https://api.search.brave.com/res/v1/web/search', { headers: { 'x-subscription-token': token } }), /not for this server/)
    // Anywhere but a header.
    await assert.rejects(fetch(`https://openrouter.ai/api/v1/models?key=${token}`), /only go in a request header/)
    await assert.rejects(fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: `{"echo":"${token}"}` }), /only go in a request header/)
    // A token this PC never gave out.
    await assert.rejects(fetch('https://openrouter.ai/api/v1/models', { headers: { authorization: 'Bearer encode-remote-key-feedface' } }), /not known on this PC/)
    assert.equal(seen.length, 1)
  })

  it('reach only the servers the settings name', async () => {
    const { fetch, seen } = setup(() => new Response('{}'))
    await assert.rejects(fetch('http://127.0.0.1:8080/admin'), /does not reach http:\/\/127\.0\.0\.1:8080/)
    await assert.rejects(fetch('file:///etc/passwd'), /does not reach that address/)
    assert.equal(seen.length, 0)
  })

  it('take the key out of an error that quotes it', async () => {
    const { fetch, tokens } = setup(() => new Response(`{"error":"Invalid key ${KEY}"}`, { status: 401, statusText: 'Unauthorized' }))
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${tokens.token({ kind: 'model', profileId: 'openrouter' })}` }, body: '{}' })
    assert.equal(response.status, 401)
    const text = await response.text()
    assert.ok(!text.includes(KEY), text)
    assert.match(text, /Invalid key \[the key\]/)
  })

  it('stop the request here when the agent there stops it', async () => {
    let upstream: AbortSignal | undefined
    const { fetch } = setup((_url, init) => {
      upstream = init.signal ?? undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'))
        },
      })
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}', signal: controller.signal })
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n')
    controller.abort()
    await assert.rejects(reader.read())
    for (let i = 0; i < 20 && !upstream?.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(upstream?.aborted, true)
  })

  it('answer a reply with no body without one', async () => {
    const { fetch } = setup(() => new Response(null, { status: 204 }))
    const response = await fetch('https://openrouter.ai/api/v1/ping', { method: 'HEAD' })
    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
  })
})
