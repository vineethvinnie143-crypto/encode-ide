/**
 * A tiny OpenAI-compatible streaming server used to test eNCode's real provider
 * path (SSE parsing, tool-call deltas, approval round-trips, command execution)
 * without an API key.
 *
 * Run standalone:  node scripts/fake-provider.mjs
 * Then add a profile in eNCode: base URL http://127.0.0.1:8787/v1, model mock-model
 */
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT || 8787)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function decideStep(toolMessages) {
  if (!toolMessages.length) return 'write'
  const last = String(toolMessages[toolMessages.length - 1]?.content ?? '')
  return last.includes('exit code') ? 'complete' : 'command'
}

function nonStreamMessage(step) {
  if (step === 'write') {
    return {
      role: 'assistant',
      content: 'Creating provider-check.txt.',
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'provider-check.txt', content: 'hello from a real provider stream\n' }),
          },
        },
      ],
    }
  }
  if (step === 'command') {
    return {
      role: 'assistant',
      content: 'Running a command.',
      tool_calls: [
        {
          id: 'call_cmd',
          type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo provider-command-ok' }) },
        },
      ],
    }
  }
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_done',
        type: 'function',
        function: {
          name: 'attempt_completion',
          arguments: JSON.stringify({
            result: 'Provider path verified: streamed a tool call, wrote provider-check.txt, and ran a shell command.',
          }),
        },
      },
    ],
  }
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
    const step = decideStep(messages.filter((message) => message.role === 'tool'))
    console.log(`[fake-provider] ${body.model ?? '?'} step=${step} stream=${Boolean(body.stream)}`)

    if (!body.stream) {
      sendJson(response, 200, {
        id: 'mock',
        choices: [{ index: 0, message: nonStreamMessage(step), finish_reason: 'tool_calls' }],
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

    if (step === 'write') {
      for (const part of ['I will create ', 'provider-check.txt ', 'so we can verify the real provider path.']) {
        send({ content: part })
        await delay(35)
      }
      // Arguments arrive split across chunks, like a real SSE stream.
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call_write',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"provider-check.txt","content":"hello from a re' },
          },
        ],
      })
      await delay(25)
      send({ tool_calls: [{ index: 0, function: { arguments: 'al provider stream\\n"}' } }] })
      send({}, 'tool_calls')
    } else if (step === 'command') {
      send({ content: 'File written. Running a command to verify the shell.' })
      await delay(25)
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call_cmd',
            type: 'function',
            function: { name: 'run_command', arguments: '{"command":"echo provider-command-ok"}' },
          },
        ],
      })
      send({}, 'tool_calls')
    } else {
      send({ content: 'All verified.' })
      await delay(25)
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call_done',
            type: 'function',
            function: {
              name: 'attempt_completion',
              arguments: JSON.stringify({
                result: 'Provider path verified: streamed a tool call, wrote provider-check.txt, and ran a shell command.',
              }),
            },
          },
        ],
      })
      send({}, 'tool_calls')
    }

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
