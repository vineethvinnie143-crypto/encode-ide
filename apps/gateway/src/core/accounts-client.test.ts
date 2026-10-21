import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Accounts, isAccountsError, MemorySecretStore, StoreKeys, type AccountsErrorCode } from '@encode/accounts'
import { GatewayPaths } from '@encode/gateway-protocol'
import { ADMIN_TOKEN, Harness, readSse, type HarnessOptions } from '../testing/harness'

/**
 * The real app-side client (@encode/accounts) against the real gateway core,
 * with nothing in between but the clock: whatever the two disagree about shows
 * up here, which neither package's own tests can show.
 */

const HOUR = 3_600_000
const GATEWAY = 'https://gateway.example.test'

interface Rig {
  harness: Harness
  accounts: Accounts
  store: MemorySecretStore
  /** Requests the client made, by path. */
  seen: string[]
  /** Makes the gateway process the next request and then lose its answer, as a dropped connection would. */
  loseNextAnswer(path: string): void
  /** Another client of the same gateway: its own device, its own store. */
  another(store?: MemorySecretStore): Accounts
}

async function rig(options: HarnessOptions = {}): Promise<Rig> {
  const harness = await Harness.create(options)
  const seen: string[] = []
  const lost = new Set<string>()
  const connect = (store: MemorySecretStore) =>
    new Accounts({
      gatewayUrl: GATEWAY,
      store,
      client: { app: 'desktop', version: '0.1.0' },
      now: () => harness.clock.now,
      sleep: async (ms, signal) => {
        if (!signal?.aborted) harness.advance(ms)
      },
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input))
        seen.push(url.pathname)
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((value, name) => (headers[name] = value))
        const response = await harness.fetch(url.pathname, {
          method: init?.method ?? 'GET',
          ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
          headers,
          ...(init?.signal ? { signal: init.signal } : {}),
        })
        if (lost.delete(url.pathname)) throw new TypeError('fetch failed')
        return response
      }) as typeof fetch,
    })
  const store = new MemorySecretStore()
  return {
    harness,
    store,
    accounts: connect(store),
    seen,
    loseNextAnswer: (path) => void lost.add(path),
    another: (other = new MemorySecretStore()) => connect(other),
  }
}

async function signIn(accounts: Accounts): Promise<void> {
  await (await accounts.beginSignIn()).result
}

async function failure(promise: Promise<unknown>): Promise<{ code: AccountsErrorCode; message: string; gatewayCode?: string; retryAfterMs?: number }> {
  try {
    await promise
  } catch (error) {
    assert.ok(isAccountsError(error), String(error))
    return error
  }
  assert.fail('expected a rejection')
}

/** A streamed chat request that is read to the end, so the gateway's background work can finish too. */
async function chatStatus(harness: Harness, token: string): Promise<number> {
  const response = await harness.chat(token, { stream: true })
  await response.text()
  await harness.idle()
  return response.status
}

function sessionIn(store: MemorySecretStore): { refreshToken: string; accessToken: string } {
  return JSON.parse(store.values.get(StoreKeys.session)!) as { refreshToken: string; accessToken: string }
}

describe('the app client against the gateway', () => {
  it('signs in through the device flow, and the token it keeps works for chat', async () => {
    const { harness, accounts, store } = await rig()
    harness.github.polls.push({ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 })
    const flow = await accounts.beginSignIn()
    assert.equal(flow.userCode, 'WDJB-MJHT')
    assert.equal(flow.verificationUri, 'https://github.com/login/device')
    const account = await flow.result
    assert.equal(account.login, 'octocat')
    assert.ok(store.values.has(StoreKeys.session))
    assert.deepEqual(harness.github.tokensSeen.length, 1, 'GitHub was asked about the user once, by the gateway')

    const response = await harness.chat(await accounts.accessToken(), { stream: true })
    assert.equal(response.status, 200)
    assert.equal(readSse(await response.text()).done, true)
    await harness.idle()
  })

  it('reads the quota and the status the gateway really sends', async () => {
    const { harness, accounts } = await rig()
    assert.equal((await accounts.status()).free_tier.available, true)
    await signIn(accounts)
    assert.equal(await chatStatus(harness, await accounts.accessToken()), 200)
    const me = await accounts.me()
    assert.equal(me.account.login, 'octocat')
    assert.equal(me.quota.requests.used, 1)
    assert.equal(me.quota.requests.remaining, harness.config.user.requestsPerDay - 1)
    assert.equal(me.quota.reset_at, Date.UTC(2026, 9, 22))

    await harness.fetch('/admin/kill-switch', { method: 'PUT', token: ADMIN_TOKEN, json: { on: true, message: 'Upgrading.' } })
    const status = await accounts.status()
    assert.equal(status.free_tier.available, false)
    assert.equal(status.free_tier.message, 'Upgrading.')
  })

  it('refreshes before the access token expires, with one request however many callers ask', async () => {
    const { harness, accounts, seen } = await rig()
    await signIn(accounts)
    const first = await accounts.accessToken()
    harness.advance(HOUR - 60_000)
    const tokens = await Promise.all(Array.from({ length: 12 }, () => accounts.accessToken()))
    assert.equal(new Set(tokens).size, 1)
    assert.notEqual(tokens[0], first)
    assert.equal(seen.filter((path) => path === GatewayPaths.refresh).length, 1)
    assert.equal(await chatStatus(harness, tokens[0]), 200)
  })

  it('asks again when the gateway says a token expired that the local clock still trusted', async () => {
    const { harness, accounts } = await rig()
    await signIn(accounts)
    const token = await accounts.accessToken()
    harness.advance(HOUR + 1000)
    assert.equal(await chatStatus(harness, token), 401)
    const next = await accounts.accessToken({ rejected: token })
    assert.notEqual(next, token)
    assert.equal(await chatStatus(harness, next), 200)
  })

  it('recovers when the answer to a refresh was lost on the way, inside the grace window', async () => {
    const { harness, accounts, loseNextAnswer, seen } = await rig()
    await signIn(accounts)
    harness.advance(HOUR)
    loseNextAnswer(GatewayPaths.refresh)
    assert.equal((await failure(accounts.accessToken())).code, 'network')
    assert.equal(accounts.state.status, 'signed_in', 'a lost answer does not sign anyone out')
    harness.advance(5_000)
    const token = await accounts.accessToken()
    assert.equal(await chatStatus(harness, token), 200)
    assert.equal(seen.filter((path) => path === GatewayPaths.refresh).length, 2)
  })

  it('is signed out for good when the lost answer is retried after the grace window', async () => {
    const { harness, accounts, loseNextAnswer } = await rig()
    await signIn(accounts)
    harness.advance(HOUR)
    loseNextAnswer(GatewayPaths.refresh)
    await failure(accounts.accessToken())
    harness.advance((harness.config.tokens.refreshGraceSeconds + 5) * 1000)
    const error = await failure(accounts.accessToken())
    assert.equal(error.code, 'session_ended')
    assert.equal(accounts.state.status, 'signed_out')
  })

  it('loses the session on every device when an old refresh token is replayed after the grace window', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    const stolen = sessionIn(store).refreshToken
    harness.advance(HOUR)
    await accounts.accessToken()
    harness.advance((harness.config.tokens.refreshGraceSeconds + 5) * 1000)

    const deviceId = store.values.get(StoreKeys.device)!
    const replay = await harness.fetch(GatewayPaths.refresh, { json: { refresh_token: stolen, device_id: deviceId } })
    assert.equal(replay.status, 401)

    harness.advance(HOUR)
    assert.equal((await failure(accounts.accessToken())).code, 'session_ended')
    assert.equal(store.values.has(StoreKeys.session), false)
  })

  it('does not let a refresh token work from another device', async () => {
    const { harness, accounts, store, another } = await rig()
    await signIn(accounts)
    const copied = new MemorySecretStore()
    copied.values.set(StoreKeys.session, store.values.get(StoreKeys.session)!)
    const thief = another(copied)
    harness.advance(HOUR)
    assert.equal((await failure(thief.accessToken())).code, 'session_ended')
    assert.equal(copied.values.has(StoreKeys.session), false)
    // The gateway ends the whole session when a token turns up on a device it was not issued to.
    assert.equal((await failure(accounts.accessToken())).code, 'session_ended')
  })

  it('signs out on the gateway too, so the old tokens stop working at once', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    const { refreshToken, accessToken } = sessionIn(store)
    const deviceId = store.values.get(StoreKeys.device)!
    await accounts.signOut()
    assert.equal(store.values.has(StoreKeys.session), false)
    assert.equal(await chatStatus(harness, accessToken), 401)
    assert.equal((await harness.fetch(GatewayPaths.refresh, { json: { refresh_token: refreshToken, device_id: deviceId } })).status, 401)
  })

  it('finds out about a session signed out elsewhere on its next request', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    const { refreshToken } = sessionIn(store)
    const gone = await harness.fetch(GatewayPaths.logout, { json: { refresh_token: refreshToken, device_id: store.values.get(StoreKeys.device)! } })
    assert.equal(gone.status, 204)
    const error = await failure(accounts.me())
    assert.equal(error.code, 'session_ended')
    const state = accounts.state
    assert.equal(state.status === 'signed_out' && state.ended?.code, 'session_ended')
    assert.equal(store.values.has(StoreKeys.session), false)
  })

  it('tells a suspended person why, the first time they ask', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    await harness.fetch('/admin/accounts/octocat/suspend', { method: 'POST', token: ADMIN_TOKEN, json: { reason: 'scripted abuse' } })
    const error = await failure(accounts.me())
    assert.equal(error.code, 'refused')
    assert.equal(error.gatewayCode, 'account_suspended')
    const state = accounts.state
    assert.equal(state.status === 'signed_out' && state.ended?.code, 'refused')
    assert.equal(store.values.has(StoreKeys.session), false)
  })

  it('shows a suspended person the gateway message when they try to sign in again', async () => {
    const { harness, accounts } = await rig()
    await signIn(accounts)
    await harness.fetch('/admin/accounts/octocat/suspend', { method: 'POST', token: ADMIN_TOKEN, json: { reason: 'scripted abuse' } })
    const error = await failure((await accounts.beginSignIn()).result)
    assert.equal(error.code, 'refused')
    assert.equal(error.gatewayCode, 'account_suspended')
    assert.match(error.message, /cannot use the free tier/)
  })

  it('shows the invite-only message verbatim, and offers nothing else to do', async () => {
    const { accounts } = await rig({ env: { SIGNUP_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'someone-else' } })
    const error = await failure((await accounts.beginSignIn()).result)
    assert.equal(error.code, 'refused')
    assert.equal(error.gatewayCode, 'signup_closed')
    assert.equal(error.message, 'The eNCode free tier is invite-only for now. Your own keys still work.')
  })

  it('reports a rate limit with the wait the gateway asks for', async () => {
    const { accounts } = await rig({
      tweak: (config) => {
        config.signIn.startsPerIpPerHour = 2
      },
    })
    const flows = [await accounts.beginSignIn(), await accounts.beginSignIn()]
    for (const flow of flows) flow.cancel()
    const error = await failure(accounts.beginSignIn())
    assert.equal(error.code, 'rate_limited')
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 0 && error.retryAfterMs <= HOUR)
  })

  it('keeps one session per device: signing in again replaces and ends the first', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    const first = sessionIn(store)
    harness.advance(60_000)
    await signIn(accounts)
    await accounts.idle()
    assert.notEqual(sessionIn(store).refreshToken, first.refreshToken)
    assert.equal(await chatStatus(harness, first.accessToken), 401, 'the replaced session no longer works')
  })

  it('never leaves a token or the device id in the gateway log', async () => {
    const { harness, accounts, store } = await rig()
    await signIn(accounts)
    const secrets = new Set<string>([store.values.get(StoreKeys.device)!])
    const collect = () => {
      const { accessToken, refreshToken } = sessionIn(store)
      secrets.add(accessToken)
      secrets.add(refreshToken)
    }
    collect()
    harness.advance(HOUR)
    await accounts.accessToken()
    collect()
    await accounts.me()
    await accounts.signOut()
    const text = harness.log.text()
    assert.equal(secrets.size, 5)
    for (const secret of secrets) assert.ok(!text.includes(secret), 'a secret reached the log')
  })
})
