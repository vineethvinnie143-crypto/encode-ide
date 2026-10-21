import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GatewayPaths, readGatewayError, type SessionTokens } from '@encode/gateway-protocol'
import { DEVICE_ID, Harness } from '../testing/harness'

const OTHER_DEVICE = 'device_zyxwvutsrqponmlkjihgfedcba9876543210'
const DAY = 86_400_000

async function errorOf(response: Response) {
  const error = readGatewayError(await response.json())
  assert.ok(error)
  return error
}

async function poll(harness: Harness, deviceCode = 'device-code-0123456789', deviceId = DEVICE_ID) {
  return harness.fetch(GatewayPaths.devicePoll, { json: { device_code: deviceCode, device_id: deviceId } })
}

function refresh(harness: Harness, token: string, deviceId = DEVICE_ID) {
  return harness.fetch(GatewayPaths.refresh, { json: { refresh_token: token, device_id: deviceId } })
}

describe('GitHub sign-in', () => {
  it('runs the device flow through the gateway and returns a session, never the GitHub token', async () => {
    const harness = await Harness.create()
    const start = await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID } })
    assert.equal(start.status, 200)
    assert.deepEqual(await start.json(), {
      device_code: 'device-code-0123456789',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    })

    harness.github.polls.push({ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 })
    assert.deepEqual(await (await poll(harness)).json(), { status: 'pending', interval: 5 })
    assert.deepEqual(await (await poll(harness)).json(), { status: 'slow_down', interval: 10 })
    const done = await poll(harness)
    const text = await done.text()
    const session = JSON.parse(text) as { status: string } & SessionTokens
    assert.equal(session.status, 'complete')
    assert.equal(session.token_type, 'Bearer')
    assert.equal(session.expires_in, 3600)
    assert.equal(session.refresh_expires_in, 30 * 86_400)
    assert.match(session.refresh_token, /^er1_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(session.account, { id: session.account.id, login: 'octocat', avatar_url: 'https://avatars.example.test/u/1001' })
    assert.match(session.account.id, /^acc_/)
    assert.ok(!text.includes('gho_test_token'))
    assert.ok(!harness.log.text().includes('gho_test_token'))
    assert.deepEqual(harness.github.tokensSeen, ['Bearer gho_test_token'])

    const me = await harness.fetch(GatewayPaths.me, { token: session.access_token })
    const body = (await me.json()) as { account: { login: string }; quota: { requests: { remaining: number } } }
    assert.equal(body.account.login, 'octocat')
    assert.equal(body.quota.requests.remaining, harness.config.user.requestsPerDay)
  })

  it('reports denied and expired codes', async () => {
    const harness = await Harness.create()
    harness.github.polls.push({ error: 'access_denied' }, { error: 'expired_token' })
    assert.deepEqual(await (await poll(harness)).json(), { status: 'denied' })
    assert.deepEqual(await (await poll(harness)).json(), { status: 'expired' })
  })

  it('checks the device id and limits sign-in starts per network', async () => {
    const harness = await Harness.create()
    const bad = await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: 'short' } })
    assert.equal((await errorOf(bad)).code, 'invalid_request')
    for (let index = 0; index < harness.config.signIn.startsPerIpPerHour; index++) {
      assert.equal((await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID } })).status, 200)
    }
    const limited = await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID } })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
    assert.equal((await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID }, ip: '198.51.100.9' })).status, 200)
    const v6 = (ip: string) => harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID }, ip })
    for (let index = 0; index < harness.config.signIn.startsPerIpPerHour; index++) assert.equal((await v6(`2001:db8:1:2::${index + 1}`)).status, 200)
    assert.equal((await v6('2001:db8:1:2:ffff::1')).status, 429, 'addresses in one /64 share a limit')
  })

  it('turns sign-in off when no GitHub client id is set', async () => {
    const harness = await Harness.create({ env: { GITHUB_CLIENT_ID: '' } })
    const response = await harness.fetch(GatewayPaths.deviceStart, { json: { device_id: DEVICE_ID } })
    assert.equal((await errorOf(response)).code, 'service_disabled')
  })

  it('maps GitHub misconfiguration and outages to errors that blame no one', async () => {
    const harness = await Harness.create()
    harness.github.polls.push({ error: 'incorrect_client_credentials' }, { error: 'something_new' })
    assert.equal((await errorOf(await poll(harness))).code, 'internal_error')
    assert.equal((await errorOf(await poll(harness))).code, 'upstream_unavailable')
  })
})

describe('who may get an account', () => {
  it('admits only invited logins in allowlist mode, binding each invite to one GitHub user', async () => {
    const harness = await Harness.create({ env: { SIGNUP_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'Vineeth' } })
    await assert.rejects(harness.signIn({ id: 1001, login: 'octocat' }), /signup_closed/)
    const invited = await harness.signIn({ id: 4242, login: 'vineeth' })
    assert.equal(invited.account.login, 'vineeth')
    // The login now belongs to user 4242; someone who takes it over after a rename is a stranger.
    await assert.rejects(harness.signIn({ id: 9999, login: 'vineeth' }), /signup_closed/)

    await harness.accounts.allow('octocat')
    assert.equal((await harness.signIn({ id: 1001, login: 'octocat' })).account.login, 'octocat')
  })

  it('needs a GitHub account of a minimum age unless invited', async () => {
    const harness = await Harness.create({ env: { SIGNUP_MODE: 'open', MIN_GITHUB_ACCOUNT_AGE_DAYS: '30', ALLOWED_GITHUB_LOGINS: 'newbie' } })
    const young = new Date(harness.clock.now - 10 * DAY).toISOString()
    await assert.rejects(harness.signIn({ id: 1, login: 'fresh', created_at: young }), /account_not_eligible/)
    assert.ok(await harness.signIn({ id: 2, login: 'newbie', created_at: young }))
    assert.ok(await harness.signIn({ id: 3, login: 'veteran', created_at: '2012-01-01T00:00:00Z' }))
  })

  it('takes no new accounts when closed, but lets existing ones back in', async () => {
    const open = await Harness.create()
    await open.signIn()
    const closed = await Harness.create({ env: { SIGNUP_MODE: 'closed' } })
    await assert.rejects(closed.signIn(), /signup_closed/)
    closed.accounts.accounts.set('acc_existing1', { id: 'acc_existing1', githubId: 1001, login: 'octocat', status: 'active', createdAt: 0, lastSignInAt: 0 })
    assert.equal((await closed.signIn()).account.id, 'acc_existing1')
  })

  it('refuses organizations and bots, and suspended accounts', async () => {
    const harness = await Harness.create()
    await assert.rejects(harness.signIn({ type: 'Organization' }), /account_not_eligible/)
    await assert.rejects(harness.signIn({ type: 'Bot' }), /account_not_eligible/)
    const session = await harness.signIn({ type: 'User' })
    await harness.accounts.setStatus(session.account.id, 'suspended', 'abuse')
    await assert.rejects(harness.signIn(), /account_suspended/)
  })
})

describe('sessions', () => {
  it('rotate the refresh token on every refresh', async () => {
    const harness = await Harness.create()
    const first = await harness.signIn()
    harness.advance(60_000)
    const response = await refresh(harness, first.refresh_token)
    assert.equal(response.status, 200)
    const second = (await response.json()) as SessionTokens
    assert.notEqual(second.refresh_token, first.refresh_token)
    assert.notEqual(second.access_token, first.access_token)
    assert.equal((await harness.fetch(GatewayPaths.me, { token: second.access_token })).status, 200)
    assert.equal((await refresh(harness, second.refresh_token)).status, 200)
  })

  it('honor the previous token once more within the grace window, for a lost response', async () => {
    const harness = await Harness.create()
    const first = await harness.signIn()
    const second = (await (await refresh(harness, first.refresh_token)).json()) as SessionTokens
    harness.advance(30_000)
    const replay = await refresh(harness, first.refresh_token)
    assert.equal(replay.status, 200)
    const third = (await replay.json()) as SessionTokens
    assert.equal((await refresh(harness, second.refresh_token)).status, 401, 'the token the client never saw is replaced')
    assert.equal((await refresh(harness, third.refresh_token)).status, 200)
  })

  it('end the whole session when an old token is reused after the grace window', async () => {
    const harness = await Harness.create()
    const first = await harness.signIn()
    const second = (await (await refresh(harness, first.refresh_token)).json()) as SessionTokens
    harness.advance(harness.config.tokens.refreshGraceSeconds * 1000 + 1)
    const reuse = await refresh(harness, first.refresh_token)
    assert.equal(reuse.status, 401)
    assert.equal((await errorOf(reuse)).code, 'invalid_grant')
    assert.equal((await refresh(harness, second.refresh_token)).status, 401, 'the thief and the owner both lose the session')
    assert.equal((await errorOf(await harness.fetch(GatewayPaths.me, { token: second.access_token }))).code, 'invalid_token')
    assert.ok(harness.log.events.some((event) => event.name === 'refresh_refused' && event.fields.reason === 'reuse'))
  })

  it('are bound to the device that signed in', async () => {
    const harness = await Harness.create()
    const session = await harness.signIn()
    assert.equal((await refresh(harness, session.refresh_token, OTHER_DEVICE)).status, 401)
    assert.equal((await refresh(harness, session.refresh_token)).status, 401, 'a stolen token presented elsewhere ends the session')
  })

  it('expire after 30 idle days and 180 days in all', async () => {
    const idle = await Harness.create()
    const session = await idle.signIn()
    idle.advance(30 * DAY)
    assert.equal((await refresh(idle, session.refresh_token)).status, 401)

    const active = await Harness.create()
    let token = (await active.signIn()).refresh_token
    for (let day = 0; day < 179; day += 20) {
      active.advance(20 * DAY)
      const response = await refresh(active, token)
      if (day + 20 >= 180) {
        assert.equal(response.status, 401)
        return
      }
      assert.equal(response.status, 200, `day ${day + 20}`)
      token = ((await response.json()) as SessionTokens).refresh_token
    }
    assert.fail('the session outlived its 180 days')
  })

  it('refuse malformed refresh requests without saying why', async () => {
    const harness = await Harness.create()
    for (const body of [{}, { refresh_token: 'er1_nope', device_id: DEVICE_ID }, { refresh_token: `er1_${'a'.repeat(43)}`, device_id: DEVICE_ID }]) {
      const response = await harness.fetch(GatewayPaths.refresh, { json: body })
      assert.equal((await errorOf(response)).code, 'invalid_grant')
    }
  })

  it('sign out on logout: the refresh token and live access tokens stop working', async () => {
    const harness = await Harness.create()
    const session = await harness.signIn()
    const out = await harness.fetch(GatewayPaths.logout, { json: { refresh_token: session.refresh_token, device_id: DEVICE_ID } })
    assert.equal(out.status, 204)
    assert.equal((await refresh(harness, session.refresh_token)).status, 401)
    assert.equal((await errorOf(await harness.fetch(GatewayPaths.me, { token: session.access_token }))).code, 'invalid_token')
    const chat = await harness.chat(session.access_token, {})
    assert.equal((await errorOf(chat)).code, 'invalid_token')
    for (const body of [{}, { refresh_token: 'junk', device_id: DEVICE_ID }]) {
      assert.equal((await harness.fetch(GatewayPaths.logout, { json: body })).status, 204)
    }
  })

  it('refresh into a suspension ends the session', async () => {
    const harness = await Harness.create()
    const session = await harness.signIn()
    await harness.accounts.setStatus(session.account.id, 'suspended', 'abuse')
    assert.equal((await errorOf(await refresh(harness, session.refresh_token))).code, 'account_suspended')
    assert.equal((await errorOf(await harness.fetch(GatewayPaths.me, { token: session.access_token }))).code, 'account_suspended')
  })
})
