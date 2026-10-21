import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorAction, GATEWAY_ERRORS, GatewayPaths, type GatewayErrorCode } from '@encode/gateway-protocol'
import { Accounts } from './accounts'
import { isAccountsError } from './errors'
import { failureOf } from './http'
import { BASE, hang, refusal, reply, ScriptedGateway, setup, startBody } from './testing'
import { MemorySecretStore } from './store'

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    assert.ok(isAccountsError(error), `expected an AccountsError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a rejection')
}

const status = { service: 'encode-gateway', api_version: 1, free_tier: { available: true }, data_policy: 'Prompts go to free providers.' }

describe('the gateway address', () => {
  const make = (gatewayUrl: string) => () =>
    new Accounts({ gatewayUrl, store: new MemorySecretStore(), client: { app: 'desktop', version: '1.0.0' } })

  it('must be https, or http on this machine while developing', () => {
    for (const url of ['https://gateway.example.test', 'https://gateway.example.test/', 'https://workers.example.test/encode', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      assert.doesNotThrow(make(url), url)
    }
    for (const url of ['http://gateway.example.test', 'ftp://gateway.example.test', 'gateway.example.test', '', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example']) {
      assert.throws(make(url), TypeError, url)
    }
  })

  it('carries no credentials, query or fragment', () => {
    for (const url of ['https://user:pw@gateway.example.test', 'https://gateway.example.test/?key=1', 'https://gateway.example.test/#frag']) {
      assert.throws(make(url), TypeError, url)
    }
  })

  it('keeps a path prefix and drops a trailing slash', async () => {
    const gateway = new ScriptedGateway().on('/encode/v1/status', reply(status))
    const accounts = new Accounts({ gatewayUrl: 'https://gateway.example.test/encode/', store: new MemorySecretStore(), client: { app: 'desktop', version: '1.0.0' }, fetch: gateway.fetch })
    await accounts.status()
    assert.equal(gateway.calls[0].path, '/encode/v1/status')
  })
})

describe('talking to the gateway', () => {
  it('sends the client header on every request and never follows a redirect', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.status, reply(status))
    await accounts.status()
    const [call] = gateway.calls
    assert.equal(call.headers.get('x-encode-client'), 'desktop/9.9.9')
    assert.equal(call.headers.get('accept'), 'application/json')
    assert.equal(call.redirect, 'error')
    assert.equal(call.headers.get('authorization'), null)
  })

  it('treats a redirect as a failure to reach the gateway', async () => {
    const { accounts } = setup({
      options: {
        fetch: (async () => {
          throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
        }) as typeof fetch,
      },
    })
    assert.equal((await rejection(accounts.status())).code, 'network')
  })

  it('refuses an answer larger than the protocol has any use for', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.status, reply({ ...status, data_policy: 'x'.repeat(300_000) }))
    assert.equal((await rejection(accounts.status())).code, 'invalid_response')
  })

  it('gives up on a gateway that does not answer, after the request timeout', async () => {
    const { accounts, gateway } = setup({ options: { requestTimeoutMs: 30 } })
    gateway.on(GatewayPaths.status, hang())
    // A real request holds a socket open; the fake holds nothing, and the timeout timer alone does not keep Node alive.
    const keepAlive = setTimeout(() => undefined, 2000)
    try {
      const error = await rejection(accounts.status())
      assert.equal(error.code, 'network')
      assert.match(error.message, /did not answer in time/)
    } finally {
      clearTimeout(keepAlive)
    }
  })

  it('cancels a request through the signal the caller passes', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.status, hang())
    const controller = new AbortController()
    const pending = accounts.status(controller.signal)
    setTimeout(() => controller.abort(), 10)
    assert.equal((await rejection(pending)).code, 'cancelled')
    assert.equal((await rejection(accounts.status(AbortSignal.abort()))).code, 'cancelled')
  })

  it('shows the gateway message safely: no control or direction characters, and a length limit', async () => {
    const { accounts, gateway } = setup()
    const bidi = String.fromCodePoint(0x202e, 0x2066, 0x2069)
    const nasty = `Invite only.\u0007\u001b[31m red ${bidi} reversed ${'long '.repeat(200)}`
    gateway.on(GatewayPaths.deviceStart, refusal('signup_closed', nasty))
    const error = await rejection(accounts.beginSignIn())
    assert.ok(error.message.length <= 300)
    assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/)
    assert.ok(![...error.message].some((char) => [0x202e, 0x2066, 0x2069].includes(char.codePointAt(0)!)))
    assert.match(error.message, /^Invite only\./)
  })

  it('uses a fallback when the gateway sends no usable message', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply({ error: { code: 'signup_closed', type: 'permission_error', message: '\u0007\u0007' } }, 403))
    assert.equal((await rejection(accounts.beginSignIn())).message, 'The eNCode gateway refused the request.')
  })
})

describe('what a refusal means', () => {
  const expected: Record<string, string> = {
    wait: 'rate_limited',
    next_tier: 'refused',
    backoff: 'unavailable',
    update: 'client_outdated',
    refresh: 'session_ended',
    sign_in: 'session_ended',
    fix: 'invalid_response',
  }

  it('follows the protocol action for every code the gateway can send', () => {
    for (const code of Object.keys(GATEWAY_ERRORS) as GatewayErrorCode[]) {
      const spec = GATEWAY_ERRORS[code]
      const error = failureOf({ ok: false, status: spec.status, detail: { code, type: spec.type, message: 'm' } })
      assert.equal(error.code, expected[errorAction(code)], code)
      assert.equal(error.gatewayCode, code)
      assert.equal(error.status, spec.status)
    }
  })

  it('judges an answer without a gateway error by its status', () => {
    assert.equal(failureOf({ ok: false, status: 429 }).code, 'rate_limited')
    assert.equal(failureOf({ ok: false, status: 429, retryAfterMs: 5000 }).retryAfterMs, 5000)
    for (const code of [500, 502, 503, 504, 522]) assert.equal(failureOf({ ok: false, status: code }).code, 'unavailable', String(code))
    for (const code of [301, 400, 401, 403, 404]) assert.equal(failureOf({ ok: false, status: code }).code, 'invalid_response', String(code))
  })

  it('reads retry-after from the header when the body has none', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply('slow down', 429, { 'retry-after': '42' }))
    assert.equal((await rejection(accounts.beginSignIn())).retryAfterMs, 42_000)
    gateway.on(GatewayPaths.deviceStart, reply('slow down', 429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
    assert.equal((await rejection(accounts.beginSignIn())).retryAfterMs, undefined)
  })

  it('does not take a gateway error code from the wrong place', async () => {
    const { accounts, gateway } = setup()
    // OpenRouter-style numeric codes are not gateway codes; they fall back to the status.
    gateway.on(GatewayPaths.deviceStart, reply({ error: { code: 502, message: 'Provider returned error' } }, 502))
    assert.equal((await rejection(accounts.beginSignIn())).code, 'unavailable')
    gateway.on(GatewayPaths.deviceStart, reply({ error: { code: 'constructor', message: 'x' } }, 403))
    assert.equal((await rejection(accounts.beginSignIn())).code, 'invalid_response')
  })

  it('accepts a start answer after a refusal, so a retry works', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, refusal('upstream_unavailable'), reply(startBody)).on(GatewayPaths.devicePoll, hang())
    await rejection(accounts.beginSignIn())
    const flow = await accounts.beginSignIn()
    assert.equal(flow.userCode, 'WDJB-MJHT')
    flow.cancel()
    await rejection(flow.result)
    assert.equal(BASE, 'https://gateway.test')
  })
})
