/**
 * Runs the gateway in the real Workers runtime (`wrangler dev`: workerd with
 * local Durable Objects, D1 and KV) against fake OpenRouter and GitHub
 * endpoints, and walks through what the desktop app does: sign in, stream,
 * fail over, refresh, sign out, and what the operator does: the cron job,
 * the kill switch, a suspension. It also checks every request the fake
 * OpenRouter received against the cost firewall's promises.
 *
 *   pnpm --filter @encode/gateway test:workers
 *
 * Needs no account, secret or network. State lives in a temporary folder
 * that is deleted afterwards. ENCODE_E2E_VERBOSE=1 prints wrangler's output.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeUpstream } from './fake-upstream.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const OPENROUTER_KEY = 'sk-or-e2e-placeholder-key'
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef0123'
const DEVICE_ID = 'e2e-device-0123456789abcdefghijklmnopqrs'
const ALLOWED_KEYS = new Set(['model', 'models', 'messages', 'max_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'seed', 'response_format', 'reasoning', 'stream', 'stream_options', 'user'])

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function wranglerProcess(args, log) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (data) => log.push(String(data)))
  child.stderr.on('data', (data) => log.push(String(data)))
  return child
}

function finished(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

/** Stops wrangler and the workerd it started; on Windows only taskkill reaches the whole tree. */
async function stop(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    await finished(spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }))
  } else {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await finished(child)
    clearTimeout(timer)
  }
}

const steps = []
async function step(name, run) {
  const started = Date.now()
  await run()
  steps.push(name)
  console.log(`  ok  ${name} (${Date.now() - started} ms)`)
}

async function main() {
  const fake = await startFakeUpstream(0)
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-gateway-e2e-'))
  const log = []
  let dev = null
  try {
    const vars = {
      ENVIRONMENT: 'development',
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      GATEWAY_SECRET: 'e2e-gateway-secret-0123456789abcdefghij',
      ADMIN_TOKEN,
      GITHUB_CLIENT_ID: 'Iv1.e2eclient000',
      SIGNUP_MODE: 'allowlist',
      ALLOWED_GITHUB_LOGINS: 'octocat',
      MIN_GITHUB_ACCOUNT_AGE_DAYS: '30',
      // One model per attempt, so a failure moves to the next model on the gateway's side, where this test can see it.
      UPSTREAM_FALLBACK_MODELS: '1',
      OPENROUTER_BASE_URL: `${fake.url}/api/v1`,
      GITHUB_BASE_URL: fake.url,
      GITHUB_API_BASE_URL: fake.url,
    }
    const varArgs = Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`])

    const migrate = wranglerProcess(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], log)
    if ((await finished(migrate)) !== 0) throw new Error('applying the D1 migrations failed')

    const port = await freePort()
    const inspector = await freePort()
    dev = wranglerProcess(
      ['dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', state, '--test-scheduled', '--show-interactive-dev-session=false', ...varArgs],
      log,
    )
    const base = `http://127.0.0.1:${port}`
    const call = (pathname, init = {}) => {
      const headers = new Headers(init.headers)
      if (init.json !== undefined) headers.set('content-type', 'application/json')
      if (init.token) headers.set('authorization', `Bearer ${init.token}`)
      headers.set('x-encode-client', 'desktop/0.1.0')
      return fetch(`${base}${pathname}`, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      })
    }

    await step('the Worker starts in workerd', async () => {
      const deadline = Date.now() + 90_000
      for (;;) {
        if (dev.exitCode !== null) throw new Error('wrangler dev exited')
        try {
          if ((await fetch(`${base}/v1/status`)).ok) return
        } catch {
          /* not listening yet */
        }
        if (Date.now() > deadline) throw new Error('wrangler dev did not start in 90 s')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    })

    await step('the cron job fills the free pool from the catalog, skipping the paid model', async () => {
      assert.equal(((await (await call('/v1/models')).json()).data[0].available), false)
      const ran = await fetch(`${base}/__scheduled?cron=${encodeURIComponent('*/5 * * * *')}`)
      assert.equal(ran.status, 200)
      const deadline = Date.now() + 15_000
      for (;;) {
        const models = await (await call('/v1/models')).json()
        if (models.data[0].available) {
          assert.equal(models.data[0].id, 'encode/free-main')
          assert.equal(models.data[0].supports_images, true)
          break
        }
        if (Date.now() > deadline) throw new Error('the pool never filled')
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const pool = await (await call('/admin/pool', { token: ADMIN_TOKEN })).json()
      assert.deepEqual(pool.pool.pools['encode/free-main'], ['acme/coder:free', 'acme/vision:free'])
      assert.ok(!JSON.stringify(pool).includes('acme/premium'))
    })

    let session
    await step('GitHub sign-in through the device flow', async () => {
      const start = await call('/v1/auth/device/start', { json: { device_id: DEVICE_ID } })
      assert.equal(start.status, 200)
      const { device_code: deviceCode, user_code: userCode } = await start.json()
      assert.equal(userCode, 'FAKE-0001')
      const poll = await call('/v1/auth/device/poll', { json: { device_code: deviceCode, device_id: DEVICE_ID } })
      const text = await poll.text()
      assert.equal(poll.status, 200, text)
      assert.ok(!text.includes('gho_'), 'the GitHub token stays in the gateway')
      session = JSON.parse(text)
      assert.equal(session.status, 'complete')
      assert.equal(session.account.login, 'octocat')
      const me = await (await call('/v1/me', { token: session.access_token })).json()
      assert.equal(me.quota.requests.used, 0)
    })

    await step('a streamed answer with keepalive, model name and quota headers', async () => {
      const response = await call('/v1/chat/completions', {
        token: session.access_token,
        json: { model: 'encode/free-main', stream: true, messages: [{ role: 'user', content: 'Say hello' }] },
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      assert.equal(response.headers.get('x-encode-quota-remaining'), '149')
      const text = await response.text()
      assert.ok(text.startsWith(': keepalive\n\n'), text.slice(0, 80))
      assert.ok(text.includes(': encode-model acme/coder:free'))
      const content = text
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? '')
        .join('')
      assert.equal(content, 'Hello from acme/coder:free at your service')
      assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    })

    await step('a non-streamed answer after the first model fails, unseen by the client', async () => {
      await fetch(`${fake.url}/__script`, { method: 'POST', body: JSON.stringify({ next: ['rate_limited'] }) })
      const response = await call('/v1/chat/completions', {
        token: session.access_token,
        json: { model: 'encode/free-main', messages: [{ role: 'user', content: 'Again' }], max_tokens: 64 },
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.object, 'chat.completion')
      assert.match(body.choices[0].message.content, /^Hello from acme\/vision:free/)
      assert.equal(response.headers.get('x-encode-model'), 'acme/vision:free')
    })

    await step('the cost firewall drops routing fields and real model ids', async () => {
      const refused = await call('/v1/chat/completions', { token: session.access_token, json: { model: 'acme/premium', messages: [{ role: 'user', content: 'x' }] } })
      assert.equal(refused.status, 400)
      assert.equal((await refused.json()).error.code, 'model_not_found')
      const sneaky = await call('/v1/chat/completions', {
        token: session.access_token,
        json: {
          model: 'encode/free-fast',
          messages: [{ role: 'user', content: 'x' }],
          models: ['acme/premium'],
          provider: { order: ['Premium'] },
          plugins: [{ id: 'web' }],
          user: 'not-me',
        },
      })
      assert.equal(sneaky.status, 200)
      await sneaky.json()
      const received = await (await fetch(`${fake.url}/__requests`)).json()
      assert.ok(received.length >= 4)
      for (const { body, authorization, title } of received) {
        for (const key of Object.keys(body)) assert.ok(ALLOWED_KEYS.has(key), `upstream got ${key}`)
        assert.ok(body.model.endsWith(':free'), body.model)
        assert.ok(body.models.length >= 1 && body.models.length <= 3)
        assert.ok(body.models.every((id) => id.endsWith(':free')), JSON.stringify(body.models))
        assert.equal(body.models[0], body.model)
        assert.match(body.user, /^[0-9a-f]{16}$/)
        assert.equal(body.stream, true)
        assert.equal(authorization, `Bearer ${OPENROUTER_KEY}`)
        assert.equal(title, 'eNCode')
      }
      assert.ok(!JSON.stringify(received).includes('acme/premium'))
    })

    await step('refresh rotates the session and logout ends it', async () => {
      const rotated = await call('/v1/auth/refresh', { json: { refresh_token: session.refresh_token, device_id: DEVICE_ID } })
      assert.equal(rotated.status, 200)
      const next = await rotated.json()
      assert.notEqual(next.refresh_token, session.refresh_token)
      assert.equal((await call('/v1/me', { token: next.access_token })).status, 200)
      const elsewhere = await call('/v1/auth/refresh', { json: { refresh_token: next.refresh_token, device_id: 'another-device-0123456789abcdefghijklmn' } })
      assert.equal(elsewhere.status, 401, 'a token presented by another device is refused')
      assert.equal((await call('/v1/me', { token: next.access_token })).status, 401, 'and the session it belonged to is over')
      const again = await call('/v1/auth/device/poll', { json: { device_code: 'fake-device-code-0001', device_id: DEVICE_ID } })
      session = await again.json()
      const out = await call('/v1/auth/logout', { json: { refresh_token: session.refresh_token, device_id: DEVICE_ID } })
      assert.equal(out.status, 204)
      assert.equal((await call('/v1/me', { token: session.access_token })).status, 401)
      const back = await call('/v1/auth/device/poll', { json: { device_code: 'fake-device-code-0001', device_id: DEVICE_ID } })
      session = await back.json()
    })

    await step('the kill switch and a suspension take effect at once', async () => {
      const on = await call('/admin/kill-switch', { method: 'PUT', token: ADMIN_TOKEN, json: { on: true, message: 'Paused for the test.' } })
      assert.equal(on.status, 200)
      const paused = await call('/v1/chat/completions', { token: session.access_token, json: { model: 'encode/free-main', messages: [{ role: 'user', content: 'x' }] } })
      assert.equal(paused.status, 503)
      assert.equal((await paused.json()).error.code, 'service_disabled')
      await call('/admin/kill-switch', { method: 'PUT', token: ADMIN_TOKEN, json: { on: false } })

      const suspended = await (await call('/admin/accounts/octocat/suspend', { method: 'POST', token: ADMIN_TOKEN, json: { reason: 'e2e' } })).json()
      assert.equal(suspended.status, 'suspended')
      const refused = await call('/v1/chat/completions', { token: session.access_token, json: { model: 'encode/free-main', messages: [{ role: 'user', content: 'x' }] } })
      assert.equal(refused.status, 401)
      const poll = await call('/v1/auth/device/poll', { json: { device_code: 'fake-device-code-0001', device_id: DEVICE_ID } })
      assert.equal((await poll.json()).error.code, 'account_suspended')
      await call('/admin/accounts/octocat/unsuspend', { method: 'POST', token: ADMIN_TOKEN })
      assert.equal((await call('/admin/status', { token: 'wrong-token-0123456789abcdef0123456' })).status, 404)
    })

    await step('the metrics count requests without content', async () => {
      const { days } = await (await call('/admin/metrics', { token: ADMIN_TOKEN })).json()
      assert.ok(days[0].requests >= 3)
      assert.ok(days[0].models['acme/coder:free'].rateLimited >= 1)
      assert.ok(!JSON.stringify(days).includes('Say hello'))
    })

    console.log(`Workers runtime end-to-end: ${steps.length} steps passed.`)
    if (process.env.ENCODE_E2E_VERBOSE) console.log(log.join(''))
  } catch (error) {
    console.error(`Workers runtime end-to-end failed after ${steps.length} steps:`, error)
    console.error('--- wrangler output ---')
    console.error(log.join('').slice(-8_000))
    process.exitCode = 1
  } finally {
    if (dev) await stop(dev)
    await fake.close()
    await fs.rm(state, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
