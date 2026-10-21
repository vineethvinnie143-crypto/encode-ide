import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GatewayPaths } from '@encode/gateway-protocol'
import type { AccountState } from './accounts'
import { isAccountsError } from './errors'
import { parseSession, StoreKeys } from './store'
import { hang, networkDown, refusal, reply, sessionBody, setup, signedIn, startBody } from './testing'

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    assert.ok(isAccountsError(error), `expected an AccountsError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a rejection')
}

describe('signing in with GitHub through the gateway', () => {
  it('runs the device flow and keeps the session in the store', async () => {
    const made = signedIn()
    const { accounts, gateway, clock, store } = made
    made.gateway.on(GatewayPaths.devicePoll, reply({ status: 'pending', interval: 5 }), reply(made.session))
    const states: AccountState['status'][] = []
    accounts.onChange((state) => states.push(state.status))

    await accounts.restore()
    const startedAt = clock.time
    const flow = await accounts.beginSignIn()
    assert.equal(flow.userCode, 'WDJB-MJHT')
    assert.equal(flow.verificationUri, 'https://github.com/login/device')
    assert.equal(flow.expiresAt, startedAt + 900_000)
    assert.deepEqual(await flow.result, { id: 'acc_octocat0001', login: 'octocat', avatar_url: 'https://avatars.example.test/u/1' })
    assert.deepEqual(states, ['signed_out', 'signing_in', 'signed_in'])
    assert.equal(accounts.state.status, 'signed_in')

    const [start] = gateway.callsTo(GatewayPaths.deviceStart)
    const polls = gateway.callsTo(GatewayPaths.devicePoll)
    assert.match(start.body!.device_id, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(start.headers.get('x-encode-client'), 'desktop/9.9.9')
    assert.equal(start.redirect, 'error')
    assert.equal(polls.length, 2)
    for (const poll of polls) assert.deepEqual(poll.body, { device_code: 'device-code-0001', device_id: start.body!.device_id })

    const saved = parseSession(store.values.get(StoreKeys.session))
    assert.equal(saved?.accessToken, made.session.access_token)
    assert.equal(saved?.refreshToken, made.session.refresh_token)
    assert.equal(saved?.account.login, 'octocat')
    assert.equal(store.values.get(StoreKeys.device), start.body!.device_id)
  })

  it('polls at the pace the gateway asks for, and slows down when told to', async () => {
    const { accounts, gateway, clock } = setup()
    gateway
      .on(GatewayPaths.deviceStart, reply(startBody))
      .on(
        GatewayPaths.devicePoll,
        reply({ status: 'pending', interval: 5 }),
        reply({ status: 'slow_down', interval: 10 }),
        reply({ status: 'pending', interval: 10 }),
        reply(sessionBody()),
      )
    await (await accounts.beginSignIn()).result
    assert.deepEqual(clock.naps, [5000, 5000, 10_000, 10_000])
  })

  it('keeps one device id across sign-ins and restarts', async () => {
    const first = signedIn()
    await (await first.accounts.beginSignIn()).result
    const second = setup({ store: first.store })
    second.gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, reply(sessionBody()))
    await (await second.accounts.beginSignIn()).result
    const ids = [first.gateway, second.gateway].map((gateway) => gateway.callsTo(GatewayPaths.deviceStart)[0].body!.device_id)
    assert.equal(ids[0], ids[1])
  })

  it('makes a new device id when the stored one is not usable', async () => {
    const made = signedIn()
    made.store.values.set(StoreKeys.device, 'short')
    await (await made.accounts.beginSignIn()).result
    const id = made.gateway.callsTo(GatewayPaths.deviceStart)[0].body!.device_id
    assert.notEqual(id, 'short')
    assert.equal(made.store.values.get(StoreKeys.device), id)
  })

  it('ends with denied when the user declines on GitHub, and stores nothing', async () => {
    const { accounts, gateway, store } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, reply({ status: 'denied' }))
    const error = await rejection((await accounts.beginSignIn()).result)
    assert.equal(error.code, 'denied')
    assert.equal(accounts.state.status, 'signed_out')
    assert.equal(store.values.has(StoreKeys.session), false)
  })

  it('ends with expired when GitHub says the code expired', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, reply({ status: 'expired' }))
    assert.equal((await rejection((await accounts.beginSignIn()).result)).code, 'expired')
    assert.equal(accounts.state.status, 'signed_out')
  })

  it('stops polling by itself when the code runs out', async () => {
    const { accounts, gateway } = setup()
    gateway
      .on(GatewayPaths.deviceStart, reply({ ...startBody, expires_in: 30 }))
      .on(GatewayPaths.devicePoll, reply({ status: 'pending', interval: 5 }))
    const error = await rejection((await accounts.beginSignIn()).result)
    assert.equal(error.code, 'expired')
    assert.equal(gateway.callsTo(GatewayPaths.devicePoll).length, 5, 'polls at 5, 10, 15, 20 and 25 seconds, not at 30')
  })

  it('can be cancelled, which stops the poll in flight and restores the state', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, hang())
    const flow = await accounts.beginSignIn()
    assert.equal(accounts.state.status, 'signing_in')
    await new Promise((resolve) => setImmediate(resolve))
    flow.cancel()
    assert.equal((await rejection(flow.result)).code, 'cancelled')
    assert.equal(accounts.state.status, 'signed_out')
  })

  it('can be cancelled through a signal passed to beginSignIn', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, hang())
    const controller = new AbortController()
    const flow = await accounts.beginSignIn({ signal: controller.signal })
    controller.abort()
    assert.equal((await rejection(flow.result)).code, 'cancelled')
  })

  it('cancels a sign-in that is still waiting when another one starts', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, hang())
    const first = await accounts.beginSignIn()
    const second = await accounts.beginSignIn()
    assert.equal((await rejection(first.result)).code, 'cancelled')
    assert.equal(accounts.state.status, 'signing_in', 'the older flow must not reset the state under the newer one')
    second.cancel()
    await rejection(second.result)
    assert.equal(accounts.state.status, 'signed_out')
  })

  it('waits out network errors, gateway hiccups and rate limits while polling', async () => {
    const { accounts, gateway, clock } = setup()
    gateway
      .on(GatewayPaths.deviceStart, reply(startBody))
      .on(GatewayPaths.devicePoll, networkDown(), refusal('upstream_unavailable'), refusal('rate_limited', 'Slow down.', 20), reply(sessionBody()))
    await (await accounts.beginSignIn()).result
    assert.deepEqual(clock.naps, [5000, 5000, 5000, 20_000])
    assert.equal(accounts.state.status, 'signed_in')
  })

  it('gives up after too many failed polls in a row', async () => {
    const { accounts, gateway } = setup()
    gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, networkDown())
    const error = await rejection((await accounts.beginSignIn()).result)
    assert.equal(error.code, 'network')
    assert.equal(gateway.callsTo(GatewayPaths.devicePoll).length, 8)
  })

  it('does not retry a refusal of the account, and shows the gateway message', async () => {
    for (const code of ['signup_closed', 'account_not_eligible', 'account_suspended', 'service_disabled'] as const) {
      const { accounts, gateway, store } = setup()
      const message = `Words for ${code}. Your own keys still work.`
      gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, refusal(code, message))
      const error = await rejection((await accounts.beginSignIn()).result)
      assert.equal(error.code, 'refused', code)
      assert.equal(error.gatewayCode, code)
      assert.equal(error.message, message)
      assert.equal(gateway.callsTo(GatewayPaths.devicePoll).length, 1, `${code} is final`)
      assert.equal(store.values.has(StoreKeys.session), false)
    }
  })

  it('refuses a verification link that is not https on GitHub', async () => {
    for (const uri of [
      'https://evil.example/login/device',
      'http://github.com/login/device',
      'https://user:secret@github.com/login/device',
      'https://github.com.evil.example/login/device',
      'javascript:alert(1)',
      'not a url',
      42,
      undefined,
    ]) {
      const { accounts, gateway } = setup()
      gateway.on(GatewayPaths.deviceStart, reply({ ...startBody, verification_uri: uri }))
      const error = await rejection(accounts.beginSignIn())
      assert.equal(error.code, 'invalid_response', String(uri))
      assert.equal(accounts.state.status, 'signed_out')
    }
  })

  it('accepts another verification host only when the app allows it', async () => {
    const { accounts, gateway } = setup({ options: { verificationHosts: ['github.example.test'] } })
    gateway.on(GatewayPaths.deviceStart, reply({ ...startBody, verification_uri: 'https://github.example.test/login/device' })).on(GatewayPaths.devicePoll, hang())
    const flow = await accounts.beginSignIn()
    assert.equal(flow.verificationUri, 'https://github.example.test/login/device')
    flow.cancel()
    await rejection(flow.result)
  })

  it('refuses malformed start answers', async () => {
    const bad: Array<Record<string, unknown>> = [
      { ...startBody, device_code: 'x' },
      { ...startBody, device_code: 'has spaces in it' },
      { ...startBody, user_code: '<script>' },
      { ...startBody, expires_in: 'soon' },
      { ...startBody, interval: Number.NaN },
    ]
    for (const body of bad) {
      const { accounts, gateway } = setup()
      gateway.on(GatewayPaths.deviceStart, reply(body))
      assert.equal((await rejection(accounts.beginSignIn())).code, 'invalid_response', JSON.stringify(body))
    }
  })

  it('clamps an interval or lifetime the gateway should never send', async () => {
    const { accounts, gateway, clock } = setup()
    gateway
      .on(GatewayPaths.deviceStart, reply({ ...startBody, interval: 0, expires_in: 10_000_000 }))
      .on(GatewayPaths.devicePoll, reply({ status: 'pending', interval: 100_000 }), reply(sessionBody()))
    const startedAt = clock.time
    const flow = await accounts.beginSignIn()
    assert.equal(flow.expiresAt, startedAt + 3600_000)
    await flow.result
    assert.deepEqual(clock.naps, [1000, 60_000])
  })

  it('reports a gateway that is down when the sign-in starts, and leaves the state alone', async () => {
    const down = setup()
    down.gateway.on(GatewayPaths.deviceStart, networkDown())
    assert.equal((await rejection(down.accounts.beginSignIn())).code, 'network')
    assert.equal(down.accounts.state.status, 'signed_out')

    const broken = setup()
    broken.gateway.on(GatewayPaths.deviceStart, reply('<html>Bad gateway</html>', 502))
    assert.equal((await rejection(broken.accounts.beginSignIn())).code, 'unavailable')

    const limited = setup()
    limited.gateway.on(GatewayPaths.deviceStart, refusal('rate_limited', 'Too many sign-in requests from this network.', 30))
    const error = await rejection(limited.accounts.beginSignIn())
    assert.equal(error.code, 'rate_limited')
    assert.equal(error.retryAfterMs, 30_000)

    const wrong = setup()
    wrong.gateway.on(GatewayPaths.deviceStart, reply('<html>Welcome to nginx</html>', 404))
    assert.equal((await rejection(wrong.accounts.beginSignIn())).code, 'invalid_response')

    const disabled = setup()
    disabled.gateway.on(GatewayPaths.deviceStart, refusal('service_disabled', 'Sign-in is turned off on this gateway.'))
    assert.equal((await rejection(disabled.accounts.beginSignIn())).code, 'refused')
  })

  it('refuses a session it cannot read, and keeps nothing', async () => {
    const bad: Array<Record<string, unknown>> = [
      sessionBody({ access_token: 'short' }),
      sessionBody({ refresh_token: 'has a space in it ....' }),
      sessionBody({ expires_in: 'never' }),
      sessionBody({ account: { id: 'acc_1', login: 'not a login!' } }),
      sessionBody({ account: null }),
    ]
    for (const body of bad) {
      const { accounts, gateway, store } = setup()
      gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, reply(body))
      assert.equal((await rejection((await accounts.beginSignIn()).result)).code, 'invalid_response')
      assert.equal(store.values.has(StoreKeys.session), false)
      assert.equal(accounts.state.status, 'signed_out')
    }
  })

  it('ends the old session on the gateway when a new sign-in replaces it', async () => {
    const made = signedIn()
    await (await made.accounts.beginSignIn()).result
    const old = made.session
    const next = sessionBody({ refresh_token: `er1_second_${'y'.repeat(30)}` })
    made.gateway.on(GatewayPaths.devicePoll, reply(next)).on(GatewayPaths.logout, new Response(null, { status: 204 }))
    await (await made.accounts.beginSignIn()).result
    await made.accounts.idle()
    const [logout] = made.gateway.callsTo(GatewayPaths.logout)
    assert.equal(logout.body!.refresh_token, old.refresh_token)
    assert.equal(parseSession(made.store.values.get(StoreKeys.session))?.refreshToken, next.refresh_token)
  })

  it('still signs in for this run when the store refuses to keep the session', async () => {
    const made = signedIn()
    made.store.failSet = true
    await (await made.accounts.beginSignIn()).result
    const state = made.accounts.state
    assert.equal(state.status, 'signed_in')
    assert.equal(state.status === 'signed_in' && state.persisted, false)
    assert.equal(await made.accounts.accessToken(), made.session.access_token)
  })
})
