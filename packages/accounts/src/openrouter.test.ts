import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { describe, it } from 'node:test'
import { AccountsError, isAccountsError } from './errors'
import { authorizationUrl, challengeFor, connectOpenRouter, connectOpenRouterByCode, createPkce, type OpenRouterConnection } from './openrouter'
import { reply } from './testing'

const KEY = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`

interface Exchange {
  url: string
  body: Record<string, any>
}

/** An OpenRouter that answers the code exchange from a queue and records what it was sent. */
function openrouter(...answers: Array<Response | (() => Response)>) {
  const exchanges: Exchange[] = []
  const queue = [...answers]
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    exchanges.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, any> })
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (!next) return reply({ key: KEY })
    return typeof next === 'function' ? next() : next.clone()
  }) as typeof fetch
  return { exchanges, fetch: fetchImpl }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    assert.ok(isAccountsError(error), `expected an AccountsError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a rejection')
}

function details(connection: OpenRouterConnection) {
  const url = new URL(connection.url)
  const callback = new URL(url.searchParams.get('callback_url')!)
  return {
    url,
    state: url.searchParams.get('state')!,
    challenge: url.searchParams.get('code_challenge')!,
    port: Number(callback.port),
    /** The callback on 127.0.0.1, so the test does not depend on how this machine resolves localhost. */
    callback: (query: Record<string, string>) => `http://127.0.0.1:${callback.port}${callback.pathname}?${new URLSearchParams(query)}`,
  }
}

/** Resolves once nothing listens on the port any more. */
async function released(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (!open) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`port ${port} is still open`)
}

/** Fetches without following redirects, as the browser's first request to the callback would. */
function browse(url: string, init: RequestInit = {}) {
  return fetch(url, { redirect: 'manual', ...init })
}

describe('PKCE', () => {
  it('derives the S256 challenge exactly as RFC 7636 appendix B does', () => {
    assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('makes a 43 character verifier from 32 random bytes, and its challenge', () => {
    const { verifier, challenge } = createPkce()
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
    assert.notEqual(createPkce().verifier, verifier)
    let asked = 0
    createPkce((size) => {
      asked = size
      return new Uint8Array(size)
    })
    assert.equal(asked, 32)
  })
})

describe('the authorization page', () => {
  it('asks for S256 PKCE and the callback, state and label it is given', () => {
    const url = new URL(authorizationUrl({ callbackUrl: 'http://localhost:4000/callback', challenge: 'abc', state: 'xyz', keyLabel: 'eNCode laptop' }))
    assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth')
    assert.equal(url.searchParams.get('callback_url'), 'http://localhost:4000/callback')
    assert.equal(url.searchParams.get('code_challenge'), 'abc')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('state'), 'xyz')
    assert.equal(url.searchParams.get('key_label'), 'eNCode laptop')
  })

  it('leaves out the callback when the code is pasted instead', () => {
    const url = new URL(authorizationUrl({ challenge: 'abc' }))
    assert.equal(url.searchParams.has('callback_url'), false)
    assert.equal(url.searchParams.has('state'), false)
    assert.equal(url.searchParams.get('key_label'), 'eNCode')
  })
})

describe('Connect OpenRouter with a local callback', () => {
  it('trades the code from the browser for the user key and tells the browser it worked', async () => {
    const upstream = openrouter()
    const connection = await connectOpenRouter({ fetch: upstream.fetch, timeoutMs: 5000 })
    const { url, state, challenge, port, callback } = details(connection)
    assert.match(url.searchParams.get('callback_url')!, /^http:\/\/localhost:\d+\/callback$/)
    assert.match(state, /^[A-Za-z0-9_-]{32}$/)
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)

    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    assert.deepEqual(await connection.result, { key: KEY })
    const redirect = await arriving
    assert.equal(redirect.status, 303)
    assert.equal(redirect.headers.get('location'), '/connected')

    assert.equal(upstream.exchanges.length, 1)
    const [{ url: target, body }] = upstream.exchanges
    assert.equal(target, 'https://openrouter.ai/api/v1/auth/keys')
    assert.equal(body.code, 'one-time-code-123')
    assert.equal(body.code_challenge_method, 'S256')
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge, 'the verifier proves this app started the flow')

    const done = await browse(`http://127.0.0.1:${port}/connected`)
    assert.equal(done.status, 200)
    assert.match(await done.text(), /eNCode is connected/)
    assert.match(done.headers.get('content-security-policy')!, /default-src 'none'/)
    assert.equal(done.headers.get('cache-control'), 'no-store')
    assert.equal(done.headers.get('referrer-policy'), 'no-referrer')
    await released(port)
  })

  it('also answers on the name localhost, which is what the browser will use', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { url, state } = details(connection)
    const response = await browse(`${url.searchParams.get('callback_url')}?${new URLSearchParams({ code: 'one-time-code-123', state })}`)
    assert.equal(response.headers.get('location'), '/connected')
    await connection.result
    connection.cancel()
  })

  it('ignores a callback with the wrong state and keeps waiting', async () => {
    const upstream = openrouter()
    const connection = await connectOpenRouter({ fetch: upstream.fetch, timeoutMs: 5000 })
    const { state, callback } = details(connection)
    const attempts: Array<Record<string, string>> = [{ code: 'one-time-code-123', state: 'guess' }, { code: 'one-time-code-123' }, { state }, { code: 'bad code', state }, { code: 'x', state }]
    for (const query of attempts) {
      const response = await browse(callback(query))
      assert.equal(response.status, 400, JSON.stringify(query))
      assert.doesNotMatch(await response.text(), /one-time-code|guess|bad code/, 'nothing from the request is echoed')
    }
    assert.equal(upstream.exchanges.length, 0)

    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    assert.deepEqual(await connection.result, { key: KEY })
    await arriving
    connection.cancel()
  })

  it('accepts a single callback, so a replayed link cannot start a second exchange', async () => {
    const upstream = openrouter()
    const connection = await connectOpenRouter({ fetch: upstream.fetch, timeoutMs: 5000 })
    const { state, callback } = details(connection)
    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    await connection.result
    await arriving
    const again = await browse(callback({ code: 'one-time-code-456', state }))
    assert.equal(again.status, 400)
    assert.equal(upstream.exchanges.length, 1)
    connection.cancel()
  })

  it('refuses a request that arrives under another host name (DNS rebinding)', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { state, port } = details(connection)
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: `/callback?${new URLSearchParams({ code: 'one-time-code-123', state })}`, headers: { host: 'rebound.example.test' } },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end()
    })
    assert.equal(status, 400)
    connection.cancel()
    await rejection(connection.result)
  })

  it('answers GET on its own paths only', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { port, state } = details(connection)
    assert.equal((await browse(`http://127.0.0.1:${port}/`)).status, 404)
    assert.equal((await browse(`http://127.0.0.1:${port}/callback/extra?state=${state}`)).status, 404)
    assert.equal((await browse(`http://127.0.0.1:${port}/callback`, { method: 'POST' })).status, 405)
    assert.equal((await browse(`http://127.0.0.1:${port}/callback?code=one-time-code-123&state=${state}`, { method: 'DELETE' })).status, 405)
    connection.cancel()
    await rejection(connection.result)
  })

  it('survives a request line the URL parser rejects', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { port } = details(connection)
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(`GET //[ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`))
      let text = ''
      socket.on('data', (chunk) => (text += chunk.toString()))
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)))
      socket.on('error', reject)
    })
    assert.equal(status, 400)
    const { state, callback } = details(connection)
    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    await connection.result
    await arriving
    connection.cancel()
  })

  it('ends with denied when OpenRouter reports an error with the right state', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { state, callback, port } = details(connection)
    const response = await browse(callback({ error: 'access_denied', state }))
    assert.equal(response.headers.get('location'), '/failed')
    assert.equal((await rejection(connection.result)).code, 'denied')
    await browse(`http://127.0.0.1:${port}/failed`)
    await released(port)
  })

  it('gives up when the user never approves, and releases the port', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 40 })
    const { port } = details(connection)
    assert.equal((await rejection(connection.result)).code, 'timeout')
    await released(port)
  })

  it('can be cancelled, by hand or by signal, and releases the port', async () => {
    const first = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000 })
    const { port } = details(first)
    first.cancel()
    assert.equal((await rejection(first.result)).code, 'cancelled')
    await released(port)

    const controller = new AbortController()
    const second = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    assert.equal((await rejection(second.result)).code, 'cancelled')
    await released(details(second).port)

    const already = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000, signal: AbortSignal.abort() })
    assert.equal((await rejection(already.result)).code, 'cancelled')
  })

  it('tells the browser and the app when OpenRouter rejects the code', async () => {
    const upstream = openrouter(reply({ error: { message: 'Invalid code or code_verifier' } }, 403))
    const connection = await connectOpenRouter({ fetch: upstream.fetch, timeoutMs: 5000 })
    const { state, callback } = details(connection)
    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    const error = await rejection(connection.result)
    assert.equal(error.code, 'exchange_failed')
    assert.equal(error.message, 'Invalid code or code_verifier')
    assert.equal(error.status, 403)
    assert.equal((await arriving).headers.get('location'), '/failed')
    connection.cancel()
  })

  it('names the failure when OpenRouter or the network is down', async () => {
    const cases: Array<[Response | (() => Response), string]> = [
      [reply({ error: { message: 'Overloaded' } }, 503), 'unavailable'],
      [reply({}, 429), 'rate_limited'],
      [reply('<html>', 400), 'exchange_failed'],
      [() => {
        throw new TypeError('fetch failed')
      }, 'network'],
      [reply({}, 200), 'invalid_response'],
      [reply({ key: 'short' }, 200), 'invalid_response'],
      [reply({ key: 'has a space in it, long enough' }, 200), 'invalid_response'],
      [reply({ key: 42 }, 200), 'invalid_response'],
    ]
    for (const [answer, expected] of cases) {
      const connection = await connectOpenRouter({ fetch: openrouter(answer).fetch, timeoutMs: 5000 })
      const { state, callback } = details(connection)
      const arriving = browse(callback({ code: 'one-time-code-123', state }))
      assert.equal((await rejection(connection.result)).code, expected)
      await arriving
      connection.cancel()
    }
  })

  it('does not follow a redirect from the OpenRouter API', async () => {
    let redirect: RequestInit['redirect']
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      redirect = init?.redirect
      return reply({ key: KEY })
    }) as typeof fetch
    const connection = await connectOpenRouter({ fetch: fetchImpl, timeoutMs: 5000 })
    const { state, callback } = details(connection)
    const arriving = browse(callback({ code: 'one-time-code-123', state }))
    await connection.result
    await arriving
    connection.cancel()
    assert.equal(redirect, 'error')
  })

  it('passes on a listener that could not start', async () => {
    const failure = new AccountsError('listen_failed', 'No port.')
    await assert.rejects(
      connectOpenRouter({
        listen: async () => {
          throw failure
        },
      }),
      failure,
    )
  })

  it('labels the key and honours another auth address for tests', async () => {
    const connection = await connectOpenRouter({ fetch: openrouter().fetch, timeoutMs: 5000, keyLabel: 'eNCode on my laptop', authUrl: 'https://auth.example.test/auth' })
    const { url, port } = details(connection)
    assert.equal(url.origin, 'https://auth.example.test')
    assert.equal(url.searchParams.get('key_label'), 'eNCode on my laptop')
    connection.cancel()
    await rejection(connection.result)
    await released(port)
  })
})

describe('Connect OpenRouter by pasting the code', () => {
  it('shows the page without a callback, and trades the pasted code for the key', async () => {
    const upstream = openrouter()
    const connection = connectOpenRouterByCode({ fetch: upstream.fetch })
    const url = new URL(connection.url)
    assert.equal(url.searchParams.has('callback_url'), false)
    assert.deepEqual(await connection.submit('  pasted-code-123456\n'), { key: KEY })
    const [{ body }] = upstream.exchanges
    assert.equal(body.code, 'pasted-code-123456')
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'))
  })

  it('does not send anything that is not shaped like a code', async () => {
    const upstream = openrouter()
    const connection = connectOpenRouterByCode({ fetch: upstream.fetch })
    for (const pasted of ['', '   ', 'two words', 'short', 'x'.repeat(600), 'new\nline-code-123']) {
      assert.equal((await rejection(connection.submit(pasted))).code, 'exchange_failed', JSON.stringify(pasted))
    }
    assert.equal(upstream.exchanges.length, 0)
  })

  it('reports a code OpenRouter refuses, so the user can try again', async () => {
    const upstream = openrouter(reply({ error: { message: 'Authorization code expired' } }, 403), reply({ key: KEY }))
    const connection = connectOpenRouterByCode({ fetch: upstream.fetch })
    assert.equal((await rejection(connection.submit('expired-code-1234'))).message, 'Authorization code expired')
    assert.deepEqual(await connection.submit('fresh-code-123456'), { key: KEY })
  })
})
