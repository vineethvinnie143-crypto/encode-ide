import assert from 'node:assert/strict'
import type dns from 'node:dns'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'
import { safeFetch } from './web'

let server: http.Server
let origin = ''
const seen: string[] = []
const everywhere = () => true

before(async () => {
  server = http.createServer((request, response) => {
    const path = request.url ?? '/'
    seen.push(path)
    if (path === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('hello from the test server')
    } else if (path === '/latin1') {
      response.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
      response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    } else if (path === '/gzip') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      response.end(zlib.gzipSync(JSON.stringify({ ok: true })))
    } else if (path === '/bomb') {
      // 64 MB of zeros, about 64 KB on the wire.
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      response.end(zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024)))
    } else if (path === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(5000))
    } else if (path === '/image') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.alloc(1024))
    } else if (path.startsWith('/hop/')) {
      const left = Number(path.slice(5))
      response.writeHead(302, { location: left > 0 ? `/hop/${left - 1}` : '/text' })
      response.end()
    } else if (path === '/elsewhere') {
      response.writeHead(301, { location: 'https://other.example/landing?from=test' })
      response.end()
    } else if (path === '/stall') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial')
      // Never ends.
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('missing')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A resolver that answers every name with the given addresses. */
function resolvesTo(...addresses: string[]): typeof dns.lookup {
  return ((_hostname: string, _options: unknown, callback: (error: Error | null, list: dns.LookupAddress[]) => void) => {
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
  }) as unknown as typeof dns.lookup
}

describe('safeFetch address checks', () => {
  it('never connects to a loopback address, however it is spelled', async () => {
    const before = seen.length
    const port = new URL(origin).port
    for (const url of [`${origin}/text`, `http://[::ffff:127.0.0.1]:${port}/text`, `http://2130706433:${port}/text`]) {
      const outcome = await safeFetch(url)
      assert.equal(outcome.kind, 'refused', url)
    }
    assert.equal(seen.length, before, 'the server saw a request')
  })

  it('refuses a host name that resolves to a private address, at connect time', async () => {
    const before = seen.length
    const port = new URL(origin).port
    const outcome = await safeFetch(`http://intranet.test:${port}/text`, { lookup: resolvesTo('127.0.0.1') })
    assert.equal(outcome.kind, 'refused')
    assert.match((outcome as { reason: string }).reason, /intranet\.test resolves to 127\.0\.0\.1/)
    assert.equal(seen.length, before)
  })

  it('refuses a name with any private answer, so DNS rebinding cannot pick it', async () => {
    const port = new URL(origin).port
    const outcome = await safeFetch(`http://mixed.test:${port}/text`, { lookup: resolvesTo('93.184.215.14', '10.0.0.7') })
    assert.equal(outcome.kind, 'refused')
  })

  it('refuses other schemes and credentials', async () => {
    assert.equal((await safeFetch('file:///etc/passwd')).kind, 'refused')
    assert.equal((await safeFetch('https://user:pass@example.com/')).kind, 'refused')
  })
})

describe('safeFetch responses', () => {
  it('reads text and honours the charset', async () => {
    const text = await safeFetch(`${origin}/text`, { allowAddress: everywhere })
    assert.equal(text.kind, 'response')
    assert.equal((text as { text: string }).text, 'hello from the test server')
    const latin = await safeFetch(`${origin}/latin1`, { allowAddress: everywhere })
    assert.equal((latin as { text: string }).text, 'café')
  })

  it('decompresses, and caps the decoded size of a compression bomb', async () => {
    const json = await safeFetch(`${origin}/gzip`, { allowAddress: everywhere })
    assert.equal((json as { text: string }).text, '{"ok":true}')
    const started = Date.now()
    const bomb = await safeFetch(`${origin}/bomb`, { allowAddress: everywhere, maxBytes: 64 * 1024 })
    assert.equal(bomb.kind, 'response')
    assert.equal((bomb as { text: string }).text.length, 64 * 1024)
    assert.equal((bomb as { truncated: boolean }).truncated, true)
    assert.ok(Date.now() - started < 5000)
  })

  it('truncates a large body at the cap', async () => {
    const big = await safeFetch(`${origin}/big`, { allowAddress: everywhere, maxBytes: 1000 })
    assert.equal((big as { text: string }).text.length, 1000)
    assert.equal((big as { truncated: boolean }).truncated, true)
  })

  it('does not read binary bodies', async () => {
    const image = await safeFetch(`${origin}/image`, { allowAddress: everywhere })
    assert.deepEqual(image, { kind: 'binary', url: `${origin}/image`, status: 200, contentType: 'image/png' })
  })

  it('follows same-host redirects up to the limit', async () => {
    const followed = await safeFetch(`${origin}/hop/3`, { allowAddress: everywhere })
    assert.equal(followed.kind, 'response')
    assert.equal((followed as { url: string }).url, `${origin}/text`)
    const loop = await safeFetch(`${origin}/hop/9`, { allowAddress: everywhere, maxRedirects: 5 })
    assert.deepEqual(loop, { kind: 'refused', reason: 'more than 5 redirects' })
  })

  it('hands back a redirect to another host instead of following it', async () => {
    const outcome = await safeFetch(`${origin}/elsewhere`, { allowAddress: everywhere })
    assert.deepEqual(outcome, {
      kind: 'redirect',
      url: `${origin}/elsewhere`,
      status: 301,
      location: 'https://other.example/landing?from=test',
    })
  })

  it('times out a stalled response and can be cancelled', async () => {
    await assert.rejects(safeFetch(`${origin}/stall`, { allowAddress: everywhere, timeoutMs: 300 }), /timed out after 300 ms/)
    const controller = new AbortController()
    const pending = safeFetch(`${origin}/stall`, { allowAddress: everywhere, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError')
  })
})
