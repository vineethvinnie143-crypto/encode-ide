/**
 * Fake OpenRouter and GitHub endpoints on one local port, for running the
 * gateway with `wrangler dev` without any account or network:
 *
 *   node scripts/fake-upstream.mjs [port]      (default 8790)
 *
 * OpenRouter: GET /api/v1/models, GET /api/v1/key, POST /api/v1/chat/completions
 * GitHub:     POST /login/device/code, POST /login/oauth/access_token, GET /user
 *
 * Test hooks: GET /__requests lists the chat requests received (bodies and
 * the authorization header), POST /__script queues how the next chat
 * requests fail ({"next": ["rate_limited", "error", ...]}), and POST /__reset
 * clears both. The device flow approves at once as user `octocat`.
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const MODELS = [
  { id: 'acme/coder:free', context: 131072, tools: true, images: false, created: 1760000300 },
  { id: 'acme/vision:free', context: 65536, tools: true, images: true, created: 1760000200 },
  { id: 'acme/quick:free', context: 32768, tools: false, images: false, created: 1760000400 },
]

function catalog() {
  return {
    data: [
      ...MODELS.map((model) => ({
        id: model.id,
        name: model.id,
        created: model.created,
        context_length: model.context,
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        architecture: { input_modalities: model.images ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
        top_provider: { context_length: model.context, max_completion_tokens: 8192 },
        supported_parameters: model.tools ? ['tools', 'tool_choice', 'max_tokens'] : ['max_tokens'],
      })),
      // A paid model in the catalog, which the gateway must never pick.
      {
        id: 'acme/premium',
        name: 'Premium',
        created: 1760000500,
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        architecture: { input_modalities: ['text'] },
        top_provider: { max_completion_tokens: 8192 },
        supported_parameters: ['tools'],
      },
    ],
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function chunk(model, delta, finish = null) {
  return { id: 'gen-fake', object: 'chat.completion.chunk', created: 1760000000, model, choices: [{ index: 0, delta, finish_reason: finish }] }
}

async function streamAnswer(response, model, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const write = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.write(': OPENROUTER PROCESSING\n\n')
  write(chunk(model, { role: 'assistant', content: '' }))
  for (const word of text.split(/(?<= )/)) {
    write(chunk(model, { content: word }))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  write(chunk(model, {}, 'stop'))
  write({ ...chunk(model, {}), choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } })
  response.end('data: [DONE]\n\n')
}

export function startFakeUpstream(port = 8790) {
  const state = { requests: [], script: [] }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = `${request.method} ${url.pathname}`
    try {
      switch (route) {
        case 'GET /__requests':
          return send(response, 200, state.requests)
        case 'POST /__script':
          state.script.push(...(JSON.parse(await readBody(request)).next ?? []))
          return send(response, 200, { queued: state.script.length })
        case 'POST /__reset':
          state.requests.length = 0
          state.script.length = 0
          return send(response, 200, {})
        case 'GET /api/v1/models':
          return send(response, 200, catalog())
        case 'GET /api/v1/key':
          return send(response, 200, {
            data: { label: 'fake', usage_daily: 0, limit: null, limit_remaining: null, free_model_daily_requests: { limit: 1000, used: state.requests.length, remaining: 1000 - state.requests.length } },
          })
        case 'POST /api/v1/chat/completions': {
          const body = JSON.parse(await readBody(request))
          state.requests.push({ body, authorization: request.headers.authorization ?? null, title: request.headers['x-title'] ?? null })
          const next = state.script.shift()
          if (next === 'rate_limited') return send(response, 429, { error: { code: 429, message: 'Provider is rate limited' } }, { 'retry-after': '20' })
          if (next === 'error') return send(response, 502, { error: { code: 502, message: 'Provider returned error' } })
          return streamAnswer(response, body.model, `Hello from ${body.model} at your service`)
        }
        case 'POST /login/device/code':
          return send(response, 200, { device_code: 'fake-device-code-0001', user_code: 'FAKE-0001', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 })
        case 'POST /login/oauth/access_token':
          return send(response, 200, { access_token: 'gho_fake_token_never_returned', token_type: 'bearer', scope: '' })
        case 'GET /user':
          return send(response, 200, { id: 583231, login: 'octocat', type: 'User', created_at: '2011-01-25T18:44:36Z', avatar_url: 'https://avatars.githubusercontent.com/u/583231' })
        default:
          return send(response, 404, { error: { message: `no fake for ${route}` } })
      }
    } catch (error) {
      send(response, 500, { error: { message: String(error) } })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ url: `http://127.0.0.1:${address.port}`, state, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8790)
  const fake = await startFakeUpstream(port)
  console.log(`Fake OpenRouter and GitHub on ${fake.url}`)
}
