import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { ModelProfile } from '../../shared/types'
import { chat, ProviderError } from './provider'

type Reply = (response: http.ServerResponse) => void

let server: http.Server
let baseUrl = ''
let replies: Reply[] = []
/** The bodies of the requests the server received since the last ask(). */
let seen: Array<Record<string, unknown>> = []

before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    seen.push(JSON.parse(raw) as Record<string, unknown>)
    const reply = replies.shift()
    if (reply) reply(response)
    else response.writeHead(500).end('no reply queued')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

after(() => new Promise<void>((resolve) => server.close(() => resolve())))

function ask(...queued: Reply[]) {
  replies = queued
  seen = []
  const profile: ModelProfile = { id: 'p', name: 'P', kind: 'custom', baseUrl, model: 'm' }
  return chat({ profile, apiKey: 'sk-test', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal })
}

const json =
  (status: number, payload: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  }

const events =
  (...chunks: unknown[]): Reply =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.end('data: [DONE]\n\n')
  }

const toolDelta = (call: Record<string, unknown>, finish?: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: finish ?? null }],
})

describe('chat', () => {
  it('assembles a tool call streamed in pieces', async () => {
    const result = await ask(
      events(
        toolDelta({ id: 'c1', function: { name: 'read', arguments: '{"pa' } }),
        toolDelta({ function: { arguments: 'th":"a.ts"}' } }, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ),
    )
    assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }])
    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(result.usage?.promptTokens, 12)
  })

  it('reads a single JSON reply from a server that ignores streaming, with arguments sent as an object', async () => {
    const result = await ask(
      json(200, {
        choices: [
          {
            message: { content: 'Reading it.', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: { path: 'a.ts' } } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].stream, true)
    assert.equal(result.content, 'Reading it.')
    assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }])
  })

  it('asks once more without streaming when a server refuses to stream', async () => {
    const result = await ask(
      json(400, { error: { message: 'stream is not supported' } }),
      json(200, { choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }] }),
    )
    assert.deepEqual(
      seen.map((body) => body.stream),
      [true, false],
    )
    assert.equal(result.content, 'Hello.')
  })

  it('does not send a prompt that is too long a second time', async () => {
    const refusal = json(400, {
      error: { message: "This model's maximum context length is 1000 tokens. However, your messages resulted in 2000 tokens." },
    })
    await assert.rejects(ask(refusal, refusal), (error) => error instanceof ProviderError && error.status === 400)
    assert.equal(seen.length, 1)
  })
})
