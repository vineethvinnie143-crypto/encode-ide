/**
 * Walks through what the desktop app does against a running gateway: status,
 * models, GitHub sign-in, a streamed chat, today's quota and sign-out. Run it
 * against a local `wrangler dev` (with the fake upstream the sign-in needs no
 * clicks), and again after a deploy, where it prints the code to approve on
 * GitHub.
 *
 *   node scripts/try-gateway.mjs <gateway-url> ["prompt"]
 *
 * It prints no token and writes nothing to disk. It sends the oldest client
 * version the gateway serves, so MIN_CLIENT_VERSION does not turn it away.
 */
import { randomBytes } from 'node:crypto'

const base = (process.argv[2] ?? '').replace(/\/+$/, '')
const prompt = process.argv[3] ?? 'Say hello in five words.'
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/try-gateway.mjs <gateway-url> ["prompt"]')
  process.exit(2)
}

const deviceId = randomBytes(32).toString('base64url')
let clientVersion = '0.1.0'

async function call(path, { method, token, json } = {}) {
  const headers = { 'x-encode-client': `try-gateway/${clientVersion}`, accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (json !== undefined) headers['content-type'] = 'application/json'
  try {
    return await fetch(`${base}${path}`, {
      method: method ?? (json !== undefined ? 'POST' : 'GET'),
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
  } catch (error) {
    throw new Error(`Could not reach ${base}${path}: ${error instanceof Error && error.cause ? String(error.cause.message ?? error.cause) : String(error)}`)
  }
}

async function expectJson(response, what) {
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const failure = body?.error
    const detail = failure ? `${failure.code}: ${failure.message}` : text.slice(0, 200)
    throw new Error(`${what} failed (${response.status}) ${detail} [${response.headers.get('x-encode-request-id') ?? 'no request id'}]`)
  }
  return body
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function signIn() {
  const start = await expectJson(await call('/v1/auth/device/start', { json: { device_id: deviceId } }), 'Starting sign-in')
  console.log(`Sign in: open ${start.verification_uri} and enter the code ${start.user_code}`)
  let interval = Math.max(1, start.interval)
  const deadline = Date.now() + start.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const poll = await expectJson(await call('/v1/auth/device/poll', { json: { device_code: start.device_code, device_id: deviceId } }), 'Polling sign-in')
    if (poll.status === 'complete') return poll
    if (poll.status === 'denied' || poll.status === 'expired') throw new Error(`Sign-in ${poll.status}.`)
    if (poll.status === 'slow_down') interval = Math.max(interval + 5, poll.interval ?? 0)
  }
  throw new Error('Sign-in timed out.')
}

async function chat(token) {
  const response = await call('/v1/chat/completions', {
    token,
    json: { model: 'encode/free-main', stream: true, messages: [{ role: 'user', content: prompt }] },
  })
  if (!response.ok) await expectJson(response, 'Chat')
  console.log(`Chat: ${response.status}, ${response.headers.get('x-encode-quota-remaining')} requests left today`)
  const decoder = new TextDecoder()
  let pending = ''
  let model = null
  let answer = ''
  let finished = false
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith(': encode-model ')) model = line.slice(15).trim()
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') {
        finished = true
        continue
      }
      const event = JSON.parse(data)
      if (event.error) throw new Error(`The stream failed: ${event.error.code}: ${event.error.message}`)
      answer += event.choices?.[0]?.delta?.content ?? ''
    }
  }
  if (!finished) throw new Error('The stream ended without [DONE].')
  console.log(`Answer from ${model ?? 'an unnamed model'}: ${answer.trim()}`)
}

async function main() {
  const status = await expectJson(await call('/v1/status'), 'Status')
  if (status.min_client_version) clientVersion = status.min_client_version
  console.log(`Status: free tier ${status.free_tier.available ? 'available' : 'unavailable'}${status.free_tier.message ? ` (${status.free_tier.message})` : ''}`)
  console.log(`Data policy: ${status.data_policy}`)

  const models = await expectJson(await call('/v1/models'), 'Models')
  for (const model of models.data) {
    console.log(`Model: ${model.id}, ${model.available ? `${model.context_length} tokens of context` : 'no model available yet'}`)
  }
  if (!models.data.some((model) => model.available)) {
    console.log('The free pool is empty. The cron job fills it within five minutes of a deploy, or POST /admin/pool/sync does.')
  }

  const session = await signIn()
  console.log(`Signed in as ${session.account.login}`)
  try {
    const me = await expectJson(await call('/v1/me', { token: session.access_token }), 'Account')
    console.log(`Quota: ${me.quota.requests.used} of ${me.quota.requests.limit} requests used today`)
    await chat(session.access_token)
  } finally {
    const logout = await call('/v1/auth/logout', { json: { refresh_token: session.refresh_token, device_id: deviceId } })
    console.log(`Signed out (${logout.status})`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
