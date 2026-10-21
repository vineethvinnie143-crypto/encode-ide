/**
 * A tiny OpenAI-compatible streaming server used to test eNCode's real provider
 * path (SSE parsing, tool-call deltas, approval round-trips, command execution,
 * subagents) without an API key.
 *
 * Run standalone:  node scripts/fake-provider.mjs
 * Then add a profile in eNCode: base URL http://127.0.0.1:8787/v1, model mock-model
 *
 * Conversations follow a script. A `[scenario:<name>]` marker in the first user
 * message picks it; the step is the number of tool results so far.
 */
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT || 8787)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SCENARIOS = {
  default: [
    {
      text: 'I will create provider-check.txt so we can verify the real provider path.',
      call: { name: 'write_file', args: { path: 'provider-check.txt', content: 'hello from a real provider stream\n' } },
    },
    {
      text: 'File written. Running a command to verify the shell.',
      call: { name: 'run_command', args: { command: 'echo provider-command-ok' } },
    },
    {
      text: 'All verified.',
      call: {
        name: 'attempt_completion',
        args: { result: 'Provider path verified: streamed a tool call, wrote provider-check.txt, and ran a shell command.' },
      },
    },
  ],
  // The subagent's command must ask on the parent's card.
  'subagent-check': [
    {
      text: 'Delegating a shell check to a subagent.',
      call: { name: 'task', args: { prompt: '[scenario:subagent-command] Run echo subagent-command-ok and report back.' } },
    },
    { text: 'The subagent reported back.', call: { name: 'attempt_completion', args: { result: 'Delegation verified.' } } },
  ],
  'subagent-command': [
    { text: 'Running the check.', call: { name: 'pwsh', args: { command: 'echo subagent-command-ok' } } },
    { text: '', call: { name: 'attempt_completion', args: { result: 'Subagent ran the command.' } } },
  ],
  // Started in Plan mode: the subagent must not be able to write either.
  'plan-escalation': [
    {
      text: 'Delegating to a subagent.',
      call: { name: 'task', args: { prompt: '[scenario:subagent-write] Create escalation.txt.' } },
    },
    { text: 'Done.', call: { name: 'attempt_completion', args: { result: 'Plan mode delegation finished.' } } },
  ],
  'subagent-write': [
    { text: 'Creating the file.', call: { name: 'write', args: { path: 'escalation.txt', content: 'must not exist\n' } } },
    { text: '', call: { name: 'attempt_completion', args: { result: 'Subagent finished.' } } },
  ],
}

let requestCount = 0

// Deterministic usage so the smoke suite can assert totals and cache-hit %.
// The first request has no cache; later ones report a cached portion.
function fakeUsage() {
  requestCount += 1
  const promptTokens = 100 + requestCount * 10
  const completionTokens = 24 + requestCount
  const cachedTokens = requestCount > 1 ? Math.floor(promptTokens / 2) : 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function scenarioOf(messages) {
  const first = messages.find((message) => message.role === 'user')
  const match = /\[scenario:([a-z-]+)\]/.exec(typeof first?.content === 'string' ? first.content : '')
  return match && SCENARIOS[match[1]] ? match[1] : 'default'
}

function stepOf(messages) {
  const script = SCENARIOS[scenarioOf(messages)]
  const done = messages.filter((message) => message.role === 'tool').length
  return script[Math.min(done, script.length - 1)]
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.url?.endsWith('/models')) {
      sendJson(response, 200, { data: [{ id: 'mock-model', name: 'Mock model' }] })
      return
    }
    if (!request.url?.endsWith('/chat/completions') || request.method !== 'POST') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }

    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw || '{}')
    const messages = Array.isArray(body.messages) ? body.messages : []
    const step = stepOf(messages)
    const callId = `call_${requestCount}_${step.call.name}`
    const args = JSON.stringify(step.call.args)
    console.log(`[fake-provider] ${body.model ?? '?'} scenario=${scenarioOf(messages)} call=${step.call.name} stream=${Boolean(body.stream)}`)

    if (!body.stream) {
      sendJson(response, 200, {
        id: 'mock',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: step.text,
              tool_calls: [{ id: callId, type: 'function', function: { name: step.call.name, arguments: args } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: fakeUsage(),
      })
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (delta, finish = null) => response.write(chunk(delta, finish))

    for (const part of step.text.match(/\S+\s*/g) ?? []) {
      send({ content: part })
      await delay(20)
    }
    // Arguments arrive split across chunks, like a real SSE stream.
    const middle = Math.ceil(args.length / 2)
    send({
      tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: step.call.name, arguments: args.slice(0, middle) } }],
    })
    await delay(25)
    send({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] })
    send({}, 'tool_calls')

    // Final usage frame, like OpenAI's include_usage tail chunk.
    response.write(`data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      choices: [],
      usage: fakeUsage(),
    })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  } catch (error) {
    console.error('[fake-provider] error', error)
    try {
      sendJson(response, 500, { error: { message: String(error) } })
    } catch {
      /* response already gone */
    }
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-provider] listening on http://127.0.0.1:${port}`)
})
