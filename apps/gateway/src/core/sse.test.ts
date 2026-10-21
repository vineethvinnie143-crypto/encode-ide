import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { chunk, sseBody } from '../testing/harness'
import { CompletionAssembler, eventError, hasContent, LineDecoder, readDataLine, sseComment, sseError, StreamTail } from './sse'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('SSE lines', () => {
  it('split the same way however the bytes are chunked, with either line ending and multi-byte text', async () => {
    const text = 'data: {"a":"héllo ✓ 𝄞"}\r\n\r\n: keepalive\n\ndata: [DONE]\n\n'
    const bytes = encoder.encode(text)
    const expected = text.replace(/\r/g, '').split('\n').slice(0, -1)
    await check(gen.array(gen.int(1, 7), 1, 40), (sizes) => {
      const lines = new LineDecoder()
      const out: string[] = []
      let offset = 0
      let index = 0
      while (offset < bytes.length) {
        const size = sizes[index++ % sizes.length]
        out.push(...lines.push(bytes.slice(offset, offset + size)))
        offset += size
      }
      out.push(...lines.end())
      assert.deepEqual(out, expected)
    })
  })

  it('read data events, the end marker and everything else', () => {
    assert.deepEqual(readDataLine('data: {"x":1}'), { kind: 'json', value: { x: 1 } })
    assert.deepEqual(readDataLine('data:{"x":1}'), { kind: 'json', value: { x: 1 } })
    assert.deepEqual(readDataLine('data: [DONE]'), { kind: 'done' })
    for (const line of ['', ': comment', 'event: x', 'data: [1]', 'data: nope', 'data: {broken', 'data: null']) {
      assert.deepEqual(readDataLine(line), { kind: 'other' }, line)
    }
  })

  it('keep comments on one line and end failed streams with a gateway error', () => {
    assert.equal(decoder.decode(sseComment('a\nb\r\nc')), ': a b c\n\n')
    assert.deepEqual(JSON.parse(decoder.decode(sseError('upstream_timeout', 'Slow.', 1500)).slice(6)), {
      error: { message: 'Slow.', type: 'upstream_error', code: 'upstream_timeout', retry_after: 2 },
    })
  })
})

describe('stream events', () => {
  it('count text, reasoning, tool calls and finishes as content, and not role-only deltas', () => {
    assert.equal(hasContent(chunk('m', { role: 'assistant', content: '' })), false)
    assert.equal(hasContent(chunk('m', {})), false)
    assert.equal(hasContent({ choices: [] }), false)
    assert.equal(hasContent(chunk('m', { content: 'a' })), true)
    assert.equal(hasContent(chunk('m', { reasoning: 'thinking' })), true)
    assert.equal(hasContent(chunk('m', { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '' } }] })), true)
    assert.equal(hasContent(chunk('m', {}, 'stop')), true)
    assert.equal(hasContent(chunk('m', {}, 'error')), false)
  })

  it('find errors at the top level and inside a choice', () => {
    assert.deepEqual(eventError({ error: { code: 429, message: 'busy' } }), { code: 429, message: 'busy' })
    assert.deepEqual(eventError({ choices: [{ error: { code: 'server_error' } }] }), { code: 'server_error' })
    assert.deepEqual(eventError(chunk('m', {}, 'error')), {})
    assert.equal(eventError(chunk('m', { content: 'x' })), undefined)
  })

  it('keep a tail big enough for the final usage and finish reason', () => {
    const tail = new StreamTail(1024)
    for (let index = 0; index < 500; index++) tail.push(encoder.encode(sseBody([chunk('m', { content: `part ${index} ` })], false)))
    tail.push(encoder.encode(sseBody([chunk('m', {}, 'stop'), { choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } }])))
    assert.deepEqual(tail.summary(), { content: true, done: true, finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 22 } })
  })

  it('assemble a non-streamed answer with text, reasoning and tool calls', () => {
    const assembler = new CompletionAssembler()
    const events = [
      chunk('acme/big:free', { role: 'assistant', content: '' }),
      chunk('acme/big:free', { reasoning: 'Let me ' }),
      chunk('acme/big:free', { reasoning: 'look.' }),
      chunk('acme/big:free', { content: 'Reading ' }),
      chunk('acme/big:free', { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
      chunk('acme/big:free', { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
      chunk('acme/big:free', { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list', arguments: '{}' } }] }),
      chunk('acme/big:free', {}, 'tool_calls'),
      { id: 'gen-test', choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } },
    ]
    for (const event of events) assembler.push(event)
    assert.equal(assembler.servedBy, 'acme/big:free')
    assert.deepEqual(assembler.result(), {
      id: 'gen-test',
      object: 'chat.completion',
      created: 1_760_000_000,
      model: 'acme/big:free',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Reading ',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
              { id: 'call_b', type: 'function', function: { name: 'list', arguments: '{}' } },
            ],
            reasoning: 'Let me look.',
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    })
  })
})
