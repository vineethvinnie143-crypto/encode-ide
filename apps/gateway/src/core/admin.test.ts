import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GatewayPaths, readGatewayError, VirtualModels } from '@encode/gateway-protocol'
import { ADMIN_TOKEN, CATALOG, catalogJson, Harness, OPENROUTER_KEY } from '../testing/harness'

function admin(harness: Harness, path: string, options: { method?: string; json?: unknown; token?: string } = {}) {
  return harness.fetch(`/admin${path}`, { ...options, token: options.token ?? ADMIN_TOKEN })
}

async function errorOf(response: Response) {
  const error = readGatewayError(await response.json())
  assert.ok(error)
  return error
}

describe('the admin API', () => {
  it('does not exist without ADMIN_TOKEN, and looks the same to a wrong token', async () => {
    const off = await Harness.create({ env: { ADMIN_TOKEN: '' } })
    assert.equal((await admin(off, '/status')).status, 404)
    const on = await Harness.create()
    for (const token of ['wrong-token-0123456789abcdef0123456789', `${ADMIN_TOKEN}x`, ADMIN_TOKEN.slice(0, -1)]) {
      const response = await admin(on, '/status', { token })
      assert.equal(response.status, 404)
      assert.equal((await errorOf(response)).code, 'not_found')
    }
    assert.equal((await on.fetch('/admin/status')).status, 404)
    assert.ok(on.log.events.some((event) => event.name === 'admin_refused'))
  })

  it('shows the control plane, the kill switch and the pool', async () => {
    const harness = await Harness.create()
    const body = (await (await admin(harness, '/status')).json()) as { control: { available: boolean }; kill_switch: { on: boolean }; pool: { models: number; pools: Record<string, string[]> } }
    assert.equal(body.control.available, true)
    assert.equal(body.kill_switch.on, false)
    assert.equal(body.pool.models, CATALOG.length)
    assert.deepEqual(body.pool.pools[VirtualModels.main], ['acme/big:free', 'acme/medium:free', 'beta/vision:free'])
  })

  it('flips the kill switch', async () => {
    const harness = await Harness.create()
    const { access_token: token } = await harness.signIn()
    const on = await admin(harness, '/kill-switch', { method: 'PUT', json: { on: true, message: 'Upgrading.' } })
    assert.equal(on.status, 200)
    assert.deepEqual(await errorOf(await harness.chat(token, {})), { code: 'service_disabled', message: 'Upgrading.', type: 'service_unavailable_error', retry_after: 900 })
    await admin(harness, '/kill-switch', { method: 'PUT', json: { on: false } })
    assert.equal((await harness.chat(token, {})).status, 200)
    assert.equal((await admin(harness, '/kill-switch', { method: 'PUT', json: { on: 'yes' } })).status, 400)
  })

  it('suspends an account at once, signing out every session, and lets it back', async () => {
    const harness = await Harness.create()
    const session = await harness.signIn()
    const suspended = await admin(harness, '/accounts/octocat/suspend', { method: 'POST', json: { reason: 'scripted abuse' } })
    assert.deepEqual(await suspended.json(), { login: 'octocat', status: 'suspended', sessions_revoked: 1 })
    assert.equal((await harness.chat(session.access_token, {})).status, 401)
    const refreshed = await harness.fetch(GatewayPaths.refresh, { json: { refresh_token: session.refresh_token, device_id: 'device_0123456789abcdefghijklmnopqrstuv' } })
    assert.equal(refreshed.status, 401)
    await assert.rejects(harness.signIn(), /account_suspended/)

    const shown = (await (await admin(harness, '/accounts/OctoCat')).json()) as { account: { status: string; statusReason: string; log_id: string }; live_sessions: number }
    assert.equal(shown.account.status, 'suspended')
    assert.equal(shown.account.statusReason, 'scripted abuse')
    assert.match(shown.account.log_id, /^[0-9a-f]{16}$/)
    assert.equal(shown.live_sessions, 0)

    await admin(harness, '/accounts/octocat/unsuspend', { method: 'POST' })
    const back = await harness.signIn()
    assert.equal((await harness.chat(back.access_token, {})).status, 200)
  })

  it('signs an account out everywhere and clears flags', async () => {
    const harness = await Harness.create()
    const session = await harness.signIn()
    const out = (await (await admin(harness, '/accounts/octocat/sign-out', { method: 'POST' })).json()) as { sessions_revoked: number; status: string }
    assert.deepEqual(out, { login: 'octocat', status: 'active', sessions_revoked: 1 })
    assert.equal((await harness.chat(session.access_token, {})).status, 401)
    assert.equal((await admin(harness, '/accounts/octocat/clear-flag', { method: 'POST' })).status, 200)
    assert.equal((await admin(harness, '/accounts/nobody-here')).status, 404)
    assert.equal((await admin(harness, '/accounts/not_a_login!')).status, 400)
  })

  it('manages the allowlist', async () => {
    const harness = await Harness.create({ env: { SIGNUP_MODE: 'allowlist' } })
    await assert.rejects(harness.signIn(), /signup_closed/)
    assert.equal((await admin(harness, '/allowlist', { method: 'POST', json: { login: 'OctoCat' } })).status, 200)
    assert.deepEqual(await (await admin(harness, '/allowlist')).json(), { logins: ['octocat'] })
    assert.ok(await harness.signIn())
    await admin(harness, '/allowlist/octocat', { method: 'DELETE' })
    assert.deepEqual(await (await admin(harness, '/allowlist')).json(), { logins: [] })
    assert.equal((await admin(harness, '/allowlist', { method: 'POST', json: { login: '../etc' } })).status, 400)
  })

  it('accepts pool overrides of :free ids only, and rebuilds the pool at once', async () => {
    const harness = await Harness.create()
    const paid = await admin(harness, '/pool/overrides', { method: 'PUT', json: { pin: { [VirtualModels.main]: ['openai/gpt-5'] } } })
    assert.equal(paid.status, 400)
    assert.equal((await admin(harness, '/pool/overrides', { method: 'PUT', json: { pin: { 'encode/other': [] } } })).status, 400)
    const blocked = await admin(harness, '/pool/overrides', { method: 'PUT', json: { block: ['acme/big:free'], pin: { [VirtualModels.main]: ['beta/vision:free'] } } })
    assert.equal(blocked.status, 200)
    assert.deepEqual(harness.store.doc?.pools[VirtualModels.main], ['beta/vision:free', 'acme/medium:free'])
  })

  it('syncs the pool from the catalog on demand and shows metrics', async () => {
    const harness = await Harness.create({ pool: null })
    harness.openrouter.catalog = catalogJson(CATALOG.slice(0, 2))
    assert.deepEqual(await (await admin(harness, '/pool/sync', { method: 'POST' })).json(), { models: 2 })
    assert.deepEqual(harness.store.doc?.pools[VirtualModels.main], ['acme/big:free', 'acme/medium:free'])
    const metrics = (await (await admin(harness, '/metrics?days=3')).json()) as { days: Array<{ day: string }> }
    assert.equal(metrics.days[0].day, '2026-10-21')
    const actions = harness.log.events.filter((event) => event.name === 'admin').map((event) => event.fields.action)
    assert.deepEqual(actions, ['pool_sync'])
    assert.ok(!harness.log.text().includes(ADMIN_TOKEN))
    assert.ok(!harness.log.text().includes(OPENROUTER_KEY))
  })

  it('answers 404 for routes it does not have', async () => {
    const harness = await Harness.create()
    assert.equal((await admin(harness, '/nothing')).status, 404)
    assert.equal((await admin(harness, '/status', { method: 'DELETE' })).status, 404)
  })
})
