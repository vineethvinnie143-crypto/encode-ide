/**
 * A tiny OpenAI-compatible streaming server used to test eNCode's real provider
 * path (SSE parsing, tool-call deltas, approval round-trips, command execution,
 * subagents) without an API key.
 *
 * Run standalone:  node scripts/fake-provider.mjs
 * Then add a profile in eNCode: base URL http://127.0.0.1:8787/v1, model mock-model
 *
 * Conversations follow a script. A `[scenario:<name>]` marker in the latest
 * user message picks it; the step is the number of tool results since then.
 * Like OpenAI, it refuses a transcript whose tool calls and results do not
 * pair up, and a request without tools is answered as a summary request.
 */
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT || 8787)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A step is the model's next message: some text, and a tool call when it has not finished yet.
// The calls use the tool names and inputs of the agent engine (Claude Code's contracts).
const SCENARIOS = {
  default: [
    {
      text: 'I will create provider-check.txt so we can verify the real provider path.',
      call: { name: 'Write', args: { file_path: 'provider-check.txt', content: 'hello from a real provider stream\n' } },
    },
    {
      text: 'File written. Running a command to verify the shell.',
      call: { name: 'Bash', args: { command: 'echo provider-command-ok' } },
    },
    {
      text: 'Provider path verified: streamed a tool call, wrote provider-check.txt, and ran a shell command.',
    },
  ],
  // The subagent's command must ask on the parent's card.
  'subagent-check': [
    {
      text: 'Delegating a shell check to a subagent.',
      call: {
        name: 'Task',
        args: {
          description: 'Shell check',
          prompt: '[scenario:subagent-command] Run echo subagent-command-ok and report back.',
          subagent_type: 'general-purpose',
        },
      },
    },
    { text: 'Delegation verified.' },
  ],
  'subagent-command': [
    { text: 'Running the check.', call: { name: 'Bash', args: { command: 'echo subagent-command-ok' } } },
    { text: 'Subagent ran the command.' },
  ],
  // Started in Plan mode: the subagent must not be able to write either.
  'plan-escalation': [
    {
      text: 'Delegating to a subagent.',
      call: {
        name: 'Task',
        args: { description: 'Create a file', prompt: '[scenario:subagent-write] Create escalation.txt.', subagent_type: 'general-purpose' },
      },
    },
    { text: 'Plan mode delegation finished.' },
  ],
  // WebFetch asks once for a new site, then refuses it because localhost is a private address.
  'web-check': [
    {
      text: 'Fetching a page.',
      call: { name: 'WebFetch', args: { url: `http://localhost:${port}/health`, prompt: 'What does the page say?' } },
    },
    {
      text: 'Fetching another page on the same site.',
      call: { name: 'WebFetch', args: { url: `http://localhost:${port}/v1/models`, prompt: 'Which models are listed?' } },
    },
    { text: 'Web check finished.' },
  ],
  'subagent-write': [
    { text: 'Creating the file.', call: { name: 'Write', args: { file_path: 'escalation.txt', content: 'must not exist\n' } } },
    { text: 'Subagent finished.' },
  ],
  // A second request in a session that already finished a task or was stopped.
  'follow-up': [{ text: 'Follow-up handled.' }],
  // The second request is refused as too long until the transcript carries a summary. Each step
  // reads a file, so there are older steps to summarize by the time the conversation is compacted.
  overflow: [
    { text: 'Looking around first.', call: { name: 'Glob', args: { pattern: '**/*' } } },
    { text: 'Reading the readme.', call: { name: 'Read', args: { file_path: 'README.md' } } },
    { text: 'Compaction verified.', overflowUntilCompacted: true },
  ],
}

let requestCount = 0
/** The Authorization header of the latest chat request, so the smoke can check keys reach the provider. */
let lastAuthorization = null
/** The tools offered and the messages sent in the latest request that offered tools, so the smoke can check the contract. */
let lastRequest = null
const stats = { summaryRequests: 0, overflowRefusals: 0, invalidTranscripts: 0 }

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

/** A plain text answer, streamed or not, with no tool calls. */
async function sendText(response, body, text) {
  if (!body.stream) {
    sendJson(response, 200, {
      id: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: fakeUsage(),
    })
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const part of text.match(/\S+\s*/g) ?? []) response.write(chunk({ content: part }))
  response.write(chunk({}, 'stop'))
  response.write('data: [DONE]\n\n')
  response.end()
}

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function lastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') return index
  return -1
}

function scenarioOf(messages) {
  const content = messages[lastUserIndex(messages)]?.content
  const match = /\[scenario:([a-z-]+)\]/.exec(typeof content === 'string' ? content : '')
  return match && SCENARIOS[match[1]] ? match[1] : 'default'
}

function stepOf(messages) {
  const script = SCENARIOS[scenarioOf(messages)]
  const done = messages.slice(lastUserIndex(messages) + 1).filter((message) => message.role === 'tool').length
  return script[Math.min(done, script.length - 1)]
}

/** What OpenAI would refuse in a transcript, or null. */
function pairingProblem(messages) {
  let index = 0
  while (index < messages.length && messages[index].role === 'system') index++
  if (index < messages.length && messages[index].role !== 'user') return 'the first message after the system prompt must be the user\'s'
  for (; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'system') return `a system message at position ${index}`
    if (message.role === 'tool') {
      return `messages with role 'tool' must be a response to a preceeding message with 'tool_calls' (position ${index})`
    }
    if (message.role !== 'assistant') continue
    if (Array.isArray(message.tool_calls) && !message.tool_calls.length) return `empty tool_calls at position ${index}`
    const ids = (message.tool_calls ?? []).map((call) => call.id)
    const answered = new Set()
    while (messages[index + 1]?.role === 'tool') {
      const id = messages[++index].tool_call_id
      if (!ids.includes(id) || answered.has(id)) return `an unexpected tool result for ${id}`
      answered.add(id)
    }
    const missing = ids.filter((id) => !answered.has(id))
    if (missing.length) {
      return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${missing.join(', ')}`
    }
  }
  return null
}

/** True once eNCode has put a summary in the conversation (the system prompt only mentions the tag). */
const compacted = (messages) =>
  messages.some(
    (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<conversation_summary>'),
  )

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.url === '/__last-authorization') {
      sendJson(response, 200, { authorization: lastAuthorization })
      return
    }
    if (request.url === '/__last-request') {
      sendJson(response, 200, lastRequest)
      return
    }
    if (request.url === '/__stats') {
      sendJson(response, 200, stats)
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

    lastAuthorization = request.headers.authorization ?? null
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw || '{}')
    const messages = Array.isArray(body.messages) ? body.messages : []

    const problem = pairingProblem(messages)
    if (problem) {
      stats.invalidTranscripts += 1
      console.log(`[fake-provider] refused an invalid transcript: ${problem}`)
      sendJson(response, 400, { error: { message: `Invalid parameter: ${problem}`, type: 'invalid_request_error' } })
      return
    }

    if (!Array.isArray(body.tools) || !body.tools.length) {
      stats.summaryRequests += 1
      await sendText(response, body, 'SUMMARY: the agent listed the workspace while working on the overflow scenario.')
      return
    }

    lastRequest = { tools: body.tools.map((tool) => tool.function?.name ?? tool.name), messages }
    const step = stepOf(messages)
    if (step.overflowUntilCompacted && !compacted(messages)) {
      stats.overflowRefusals += 1
      const used = Math.ceil(raw.length / 3.5)
      const window = Math.floor(used * 0.8)
      sendJson(response, 400, {
        error: {
          message: `This model's maximum context length is ${window} tokens. However, your messages resulted in ${used} tokens. Please reduce the length of the messages.`,
          type: 'invalid_request_error',
          param: 'messages',
          code: 'context_length_exceeded',
        },
      })
      return
    }
    console.log(`[fake-provider] ${body.model ?? '?'} scenario=${scenarioOf(messages)} call=${step.call?.name ?? 'none'} stream=${Boolean(body.stream)}`)
    if (!step.call) {
      await sendText(response, body, step.text)
      return
    }
    const callId = `call_${requestCount}_${step.call.name}`
    const args = JSON.stringify(step.call.args)

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
