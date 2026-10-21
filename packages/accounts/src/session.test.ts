import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GatewayPaths } from '@encode/gateway-protocol'
import type { AccountState } from './accounts'
import { isAccountsError } from './errors'
import { parseSession, serializeSession, StoreKeys, type StoredSession } from './store'
import { hang, networkDown, refusal, reply, sessionBody, setup, signedIn, SpyStore, type Handler } from './testing'

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    assert.ok(isAccountsError(error), `expected an AccountsError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a rejection')
}

const HOUR = 3_600_000

/** A gateway that rotates like the real one: a refresh token works once, and an older one is refused. */
function rotation(): { handler: Handler; refreshTokens: string[]; presented: string[] } {
  const refreshTokens: string[] = []
  const presented: string[] = []
  const handler: Handler = (call) => {
    const token = call.body!.refresh_token as string
    presented.push(token)
    if (token !== refreshTokens.at(-1)) return refusal('invalid_grant', 'This session has ended. Sign in again.')
    const next = sessionBody()
    refreshTokens.push(next.refresh_token as string)
    return reply(next)
  }
  return { handler, refreshTokens, presented }
}

async function signedInWithRotation() {
  const made = signedIn()
  const rotor = rotation()
  rotor.refreshTokens.push(made.session.refresh_token as string)
  made.gateway.on(GatewayPaths.refresh, rotor.handler)
  await (await made.accounts.beginSignIn()).result
  return { ...made, ...rotor }
}

function saved(store: SpyStore): StoredSession {
  const session = parseSession(store.values.get(StoreKeys.session))
  assert.ok(session, 'a session is stored')
  return session
}

describe('the session', () => {
  it('is restored from the store when the app starts', async () => {
    const first = signedIn()
    await (await first.accounts.beginSignIn()).result
    const second = setup({ store: first.store, clock: first.clock })
    assert.equal(second.accounts.state.status, 'loading')
    const state = await second.accounts.restore()
    assert.equal(state.status, 'signed_in')
    assert.equal(second.accounts.account?.login, 'octocat')
    assert.equal(await second.accounts.accessToken(), first.session.access_token)
    assert.equal(second.gateway.calls.length, 0, 'a fresh token needs no request')
  })

  it('is dropped when the stored copy is damaged or from another format', async () => {
    for (const text of ['{', 'null', '[]', '{"v":2}', JSON.stringify({ v: 1, accessToken: 'x' }), '\u0000\u0001']) {
      const { accounts, store } = setup()
      store.values.set(StoreKeys.session, text)
      assert.equal((await accounts.restore()).status, 'signed_out', text)
      assert.equal(store.values.has(StoreKeys.session), false, 'the damaged entry is removed')
    }
  })

  it('is dropped, with a reason, when the refresh token has expired while the app was closed', async () => {
    const made = signedIn()
    await (await made.accounts.beginSignIn()).result
    made.clock.advance(31 * 24 * HOUR)
    const later = setup({ store: made.store, clock: made.clock })
    const state = await later.accounts.restore()
    assert.equal(state.status, 'signed_out')
    assert.equal(state.status === 'signed_out' && state.ended?.code, 'session_ended')
    assert.equal(made.store.values.has(StoreKeys.session), false)
    assert.equal((await rejection(later.accounts.accessToken())).code, 'signed_out')
  })

  it('survives a store that cannot be read', async () => {
    const { accounts, store } = setup()
    store.failGet = true
    assert.equal((await accounts.restore()).status, 'signed_out')
  })
})

describe('accessToken', () => {
  it('hands out the token without a request while it is fresh', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR - 5 * 60_000)
    assert.equal(await made.accounts.accessToken(), made.session.access_token)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 0)
  })

  it('refreshes inside the margin, and stores the new session before it returns the token', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR - 60_000)
    made.store.log.length = 0
    const token = await made.accounts.accessToken()
    assert.notEqual(token, made.session.access_token)
    assert.equal(saved(made.store).accessToken, token, 'the store already holds what was handed out')
    assert.equal(saved(made.store).refreshToken, made.refreshTokens.at(-1))
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1)
    const [refresh] = made.gateway.callsTo(GatewayPaths.refresh)
    assert.equal(refresh.body!.refresh_token, made.session.refresh_token)
    assert.equal(refresh.body!.device_id, made.gateway.callsTo(GatewayPaths.deviceStart)[0].body!.device_id)
    assert.equal(refresh.token, null, 'a refresh is authorized by the refresh token alone')
    assert.equal(refresh.headers.get('x-encode-client'), 'desktop/9.9.9')
  })

  it('keeps the original sign-in time through refreshes', async () => {
    const made = await signedInWithRotation()
    const signedInAt = saved(made.store).signedInAt
    made.clock.advance(HOUR)
    await made.accounts.accessToken()
    assert.equal(saved(made.store).signedInAt, signedInAt)
  })

  it('shares one refresh among any number of concurrent callers', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    const tokens = await Promise.all(Array.from({ length: 25 }, () => made.accounts.accessToken()))
    assert.equal(new Set(tokens).size, 1)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1)
    assert.deepEqual(made.presented, [made.session.refresh_token])
  })

  it('starts a new refresh for a later expiry', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    const first = await made.accounts.accessToken()
    made.clock.advance(HOUR)
    const second = await made.accounts.accessToken()
    assert.notEqual(first, second)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 2)
  })

  it('returns a newer token for a rejected one without another refresh', async () => {
    const made = await signedInWithRotation()
    const rejected = made.session.access_token as string
    const [a, b] = await Promise.all([made.accounts.accessToken({ rejected }), made.accounts.accessToken({ rejected })])
    assert.equal(a, b)
    assert.notEqual(a, rejected)
    // A caller that was slow to report the same rejection gets the token the others already fetched.
    assert.equal(await made.accounts.accessToken({ rejected }), a)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1)
  })

  it('refreshes at once when the gateway rejected a token this clock thinks is good', async () => {
    const made = await signedInWithRotation()
    const token = await made.accounts.accessToken()
    const next = await made.accounts.accessToken({ rejected: token })
    assert.notEqual(next, token)
  })

  it('lets one caller stop waiting without cancelling the refresh for the others', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    const controller = new AbortController()
    const impatient = made.accounts.accessToken({ signal: controller.signal })
    const patient = made.accounts.accessToken()
    controller.abort()
    assert.equal((await rejection(impatient)).code, 'cancelled')
    assert.ok(await patient)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1)
  })

  it('ends the session when the gateway no longer knows the refresh token', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    made.gateway.on(GatewayPaths.refresh, refusal('invalid_grant', 'This session has ended. Sign in again.'))
    const states: AccountState[] = []
    made.accounts.onChange((state) => states.push(state))

    const error = await rejection(made.accounts.accessToken())
    assert.equal(error.code, 'session_ended')
    assert.equal(error.message, 'This session has ended. Sign in again.')
    assert.equal(made.store.values.has(StoreKeys.session), false)
    assert.equal(made.accounts.account, null)
    assert.deepEqual(states.at(-1), { status: 'signed_out', ended: { code: 'session_ended', message: 'This session has ended. Sign in again.' } })
    assert.equal((await rejection(made.accounts.accessToken())).code, 'signed_out')
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1, 'a session that is gone is not asked about again')
  })

  it('ends the session of a suspended account and says so', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    made.gateway.on(GatewayPaths.refresh, refusal('account_suspended', 'This account cannot use the free tier.'))
    const error = await rejection(made.accounts.accessToken())
    assert.equal(error.code, 'refused')
    assert.equal(error.gatewayCode, 'account_suspended')
    const state = made.accounts.state
    assert.equal(state.status === 'signed_out' && state.ended?.code, 'refused')
    assert.equal(made.store.values.has(StoreKeys.session), false)
  })

  it('keeps the session through network errors, gateway failures and rate limits', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    made.gateway.on(GatewayPaths.refresh, networkDown(), refusal('upstream_unavailable'), refusal('rate_limited', 'Slow down.', 12), made.handler)
    assert.equal((await rejection(made.accounts.accessToken())).code, 'network')
    assert.equal((await rejection(made.accounts.accessToken())).code, 'unavailable')
    const limited = await rejection(made.accounts.accessToken())
    assert.equal(limited.code, 'rate_limited')
    assert.equal(limited.retryAfterMs, 12_000)
    assert.equal(made.accounts.state.status, 'signed_in', 'the session is not ended by an outage')
    assert.ok(await made.accounts.accessToken(), 'and works again once the gateway does')
  })

  it('keeps the session when this build is too old, so an update can fix it', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    made.gateway.on(GatewayPaths.refresh, refusal('client_outdated', 'Update eNCode to keep using the free tier.'))
    assert.equal((await rejection(made.accounts.accessToken())).code, 'client_outdated')
    assert.equal(made.accounts.state.status, 'signed_in')
  })

  it('works for this run even when the new session cannot be stored', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    made.store.failSet = true
    const token = await made.accounts.accessToken()
    assert.ok(token)
    const state = made.accounts.state
    assert.equal(state.status === 'signed_in' && state.persisted, false)
    made.store.failSet = false
    made.clock.advance(HOUR)
    await made.accounts.accessToken()
    const after = made.accounts.state
    assert.equal(after.status === 'signed_in' && after.persisted, true, 'the next refresh writes it again')
  })

  it('never puts a token in an error message', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    for (const handler of [networkDown(), refusal('invalid_grant'), refusal('upstream_unavailable'), reply('garbage', 200)]) {
      made.gateway.on(GatewayPaths.refresh, handler)
      const error = await rejection(made.accounts.accessToken())
      for (const secret of [made.session.access_token, made.session.refresh_token]) assert.ok(!error.message.includes(secret as string))
      if (error.code === 'session_ended') break
    }
  })
})

describe('two processes sharing one store', () => {
  it('adopts a session the other process already refreshed instead of replaying the old token', async () => {
    const a = await signedInWithRotation()
    const b = setup({ store: a.store, gateway: a.gateway, clock: a.clock })
    await b.accounts.restore()

    a.clock.advance(HOUR - 60_000)
    const refreshed = await a.accounts.accessToken()
    assert.equal(a.gateway.callsTo(GatewayPaths.refresh).length, 1)

    // B still holds the first session in memory, close to expiry; replaying its refresh token would end the session for both.
    const adopted = await b.accounts.accessToken()
    assert.equal(adopted, refreshed)
    assert.equal(a.gateway.callsTo(GatewayPaths.refresh).length, 1, 'B made no refresh request')
    assert.deepEqual(a.presented, [a.session.refresh_token])
  })

  it('retries once with the newer token when it loses the race to the gateway', async () => {
    const a = await signedInWithRotation()
    const b = setup({ store: a.store, gateway: a.gateway, clock: a.clock })
    await b.accounts.restore()
    a.clock.advance(HOUR)

    // B reads the store, then A completes a whole refresh before B's request arrives.
    let raced = false
    const original = a.handler
    a.gateway.on(GatewayPaths.refresh, async (call) => {
      if (!raced) {
        raced = true
        await a.accounts.accessToken()
      }
      return original(call)
    })
    const token = await b.accounts.accessToken()
    assert.ok(token)
    assert.equal(b.accounts.state.status, 'signed_in')
    assert.equal(saved(a.store).accessToken, token)
    assert.equal(a.presented.length, 3, 'B was refused once with the old token, then succeeded with the token the other process stored')
  })

  it('does not retry forever when the newer token is refused too', async () => {
    const made = await signedInWithRotation()
    made.clock.advance(HOUR)
    // The store changes under the refresh, but the gateway refuses everything.
    made.gateway.on(GatewayPaths.refresh, async () => {
      const other: StoredSession = { ...saved(made.store), refreshToken: `er1_other_${'z'.repeat(30)}`, signedInAt: made.clock.time + 1 }
      made.store.values.set(StoreKeys.session, serializeSession(other))
      return refusal('invalid_grant')
    })
    assert.equal((await rejection(made.accounts.accessToken())).code, 'session_ended')
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 2)
  })
})

describe('signing out', () => {
  it('removes the session first, then tells the gateway which one to end', async () => {
    const made = await signedInWithRotation()
    let storeWhenTold: string | undefined = 'not called'
    made.gateway.on(GatewayPaths.logout, (call) => {
      storeWhenTold = made.store.values.get(StoreKeys.session)
      assert.equal(call.body!.refresh_token, made.session.refresh_token)
      return new Response(null, { status: 204 })
    })
    await made.accounts.signOut()
    assert.equal(storeWhenTold, undefined, 'the saved session was already gone when the request left')
    assert.equal(made.accounts.state.status, 'signed_out')
    assert.deepEqual(made.accounts.state, { status: 'signed_out' })
    assert.equal(made.gateway.callsTo(GatewayPaths.logout)[0].body!.device_id, made.gateway.callsTo(GatewayPaths.deviceStart)[0].body!.device_id)
    assert.equal((await rejection(made.accounts.accessToken())).code, 'signed_out')
  })

  it('works offline, and when the gateway fails', async () => {
    for (const handler of [networkDown(), refusal('internal_error')]) {
      const made = await signedInWithRotation()
      made.gateway.on(GatewayPaths.logout, handler)
      await made.accounts.signOut()
      assert.deepEqual(made.accounts.state, { status: 'signed_out' })
      assert.equal(made.store.values.has(StoreKeys.session), false)
    }
  })

  it('does not make the user wait for a gateway that never answers', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.logout, hang())
    void made.accounts.signOut()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(made.accounts.state, { status: 'signed_out' }, 'signed out locally while the request is still open')
    assert.equal(made.store.values.has(StoreKeys.session), false)
    assert.equal(made.gateway.callsTo(GatewayPaths.logout).length, 1)
  })

  it('cancels a sign-in in progress', async () => {
    const { accounts, gateway } = signedIn()
    gateway.on(GatewayPaths.devicePoll, hang())
    const flow = await accounts.beginSignIn()
    await accounts.signOut()
    assert.equal((await rejection(flow.result)).code, 'cancelled')
    assert.equal(accounts.state.status, 'signed_out')
  })

  it('is harmless when nobody is signed in', async () => {
    const { accounts, gateway } = setup()
    await accounts.signOut()
    assert.equal(accounts.state.status, 'signed_out')
    assert.equal(gateway.calls.length, 0)
  })
})

describe('me and status', () => {
  const quota = {
    requests: { used: 3, limit: 50, remaining: 47 },
    input_tokens: { used: 1000, limit: 1_000_000 },
    output_tokens: { used: 200, limit: 200_000 },
    requests_per_minute: 6,
    concurrent_streams: 2,
    reset_at: 1_790_000_000_000,
  }
  const account = { id: 'acc_octocat0001', login: 'octocat' }

  it('sends the bearer token and returns the account with its quota', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.me, reply({ account, quota }))
    const me = await made.accounts.me()
    assert.equal(me.quota.requests.remaining, 47)
    assert.equal(made.gateway.callsTo(GatewayPaths.me)[0].token, made.session.access_token)
  })

  it('renews the session once when the gateway says the token expired', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.me, refusal('token_expired', 'Refresh your token.'), reply({ account, quota }))
    const me = await made.accounts.me()
    assert.equal(me.account.login, 'octocat')
    const [first, second] = made.gateway.callsTo(GatewayPaths.me)
    assert.equal(first.token, made.session.access_token)
    assert.notEqual(second.token, first.token)
    assert.equal(made.gateway.callsTo(GatewayPaths.refresh).length, 1)
  })

  it('ends the session when a fresh token is rejected too', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.me, refusal('invalid_token', 'This session was signed out. Sign in again.'))
    const error = await rejection(made.accounts.me())
    assert.equal(error.code, 'session_ended')
    assert.equal(made.accounts.state.status, 'signed_out')
    assert.equal(made.store.values.has(StoreKeys.session), false)
  })

  it('needs a session', async () => {
    const { accounts } = setup()
    assert.equal((await rejection(accounts.me())).code, 'signed_out')
  })

  it('ends the session and says why when the gateway reports the account suspended', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.me, refusal('account_suspended', 'This account cannot use the free tier.'))
    const error = await rejection(made.accounts.me())
    assert.equal(error.code, 'refused')
    const state = made.accounts.state
    assert.equal(state.status === 'signed_out' && state.ended?.code, 'refused')
    assert.equal(made.store.values.has(StoreKeys.session), false)
  })

  it('keeps the session when the free tier is switched off, since that passes', async () => {
    const made = await signedInWithRotation()
    made.gateway.on(GatewayPaths.me, refusal('service_disabled', 'Upgrading.'))
    assert.equal((await rejection(made.accounts.me())).code, 'refused')
    assert.equal(made.accounts.state.status, 'signed_in')
  })

  it('refuses an account summary it cannot read', async () => {
    const made = await signedInWithRotation()
    for (const body of [{}, { account, quota: {} }, { account: { id: 1 }, quota }, { account, quota: { ...quota, requests: { used: '3' } } }, 'text']) {
      made.gateway.on(GatewayPaths.me, reply(body))
      assert.equal((await rejection(made.accounts.me())).code, 'invalid_response', JSON.stringify(body))
    }
  })

  it('reads the gateway status without a session', async () => {
    const { accounts, gateway } = setup()
    const status = { service: 'encode-gateway', api_version: 1, free_tier: { available: false, message: 'Busy.' }, data_policy: 'Prompts go to free providers.' }
    gateway.on(GatewayPaths.status, reply(status))
    assert.deepEqual(await accounts.status(), status)
    assert.equal(gateway.calls[0].token, null)
  })

  it('refuses a status from something that is not the gateway', async () => {
    const { accounts, gateway } = setup()
    for (const body of [{}, { service: 'other', api_version: 1, free_tier: { available: true }, data_policy: 'x' }, '<html>', { service: 'encode-gateway' }]) {
      gateway.on(GatewayPaths.status, reply(body))
      assert.equal((await rejection(accounts.status())).code, 'invalid_response', JSON.stringify(body))
    }
  })
})
