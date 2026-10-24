/**
 * Reasoning read from the chat-completions dialect and sent back as each family expects (ADR 0099): the <think>
 * block at the start of a reply, OpenRouter's details merged as they stream, and what goes back with each message.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAssembler, mergeDetail } from './assembler'
import type { TransportEvent, TransportTarget } from './contract'
import type { AssistantMessage } from './messages'
import { createThinkSplitter, NO_REASONING, replayFor, requestStart } from './reasoning'

/** The events a reply's text becomes, cut into the pieces given. */
function split(...pieces: string[]): TransportEvent[] {
  const splitter = createThinkSplitter()
  const out = pieces.flatMap((text) => splitter.through({ type: 'text', text }))
  return [...out, ...splitter.flush()]
}

/** Events joined by kind, in order, as the assembler would make blocks of them. */
function joined(events: TransportEvent[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const event of events) {
    if (event.type !== 'text' && event.type !== 'thinking') continue
    const tail = out[out.length - 1]
    if (tail?.[0] === event.type) tail[1] += event.text
    else out.push([event.type, event.text])
  }
  return out
}

const target = (overrides: Partial<TransportTarget> = {}): TransportTarget => ({
  key: 'p:m',
  provider: 'p',
  providerType: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  model: 'm',
  family: 'other',
  maxOutputTokens: 4096,
  capabilities: { tools: true, parallelTools: true, images: false, reasoning: true, promptCache: false },
  ...overrides,
})

const said = (model: string, provider = 'p', extra?: Partial<AssistantMessage>): AssistantMessage => ({
  role: 'assistant',
  origin: { provider, model, family: 'other' },
  content: [
    { type: 'thinking', text: 'I should read it.', details: [{ type: 'reasoning.text', text: 'I should read it.', signature: 'sig', format: 'anthropic-claude-v1', index: 0 }] },
    { type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
  ],
  ...extra,
})

describe('the <think> block at the start of a reply', () => {
  it('becomes thinking, however the tags are cut, and the reply after it is text', () => {
    const expected = [
      ['thinking', 'Plan: read a.ts.'],
      ['text', 'Done.'],
    ]
    assert.deepEqual(joined(split('<think>Plan: read a.ts.</think>\n\nDone.')), expected)
    assert.deepEqual(joined(split('\n<th', 'ink>Plan: read', ' a.ts.</thi', 'nk>', '\n\n', 'Done.')), expected)
    assert.deepEqual(joined(split('<think>', 'Plan: read a.ts.<', '/think>Done.')), expected)
  })

  it('is only a block at the very start: anywhere else, and unclosed tags at the end, stay as they are', () => {
    assert.deepEqual(joined(split('Use a <think> tag here.')), [['text', 'Use a <think> tag here.']])
    assert.deepEqual(joined(split('<thin')), [['text', '<thin']])
    assert.deepEqual(joined(split('<think>still going</thi')), [['thinking', 'still going</thi']])
    assert.deepEqual(joined(split('  ')), [])
  })

  it('lets out what it held before a tool call, so the call stays in place', () => {
    const splitter = createThinkSplitter()
    const events = [
      ...splitter.through({ type: 'text', text: '<think>Read it first</th' }),
      ...splitter.through({ type: 'tool-call', index: 0, name: 'Read', arguments: '{}' }),
      ...splitter.flush(),
    ]
    assert.deepEqual(
      events.map((event) => event.type),
      ['thinking', 'thinking', 'tool-call'],
    )
  })
})

describe("OpenRouter's reasoning details", () => {
  it('are merged as they stream: a piece with the same index and type continues the detail, the signature comes whole', () => {
    const details: Record<string, unknown>[] = []
    mergeDetail(details, { type: 'reasoning.text', text: 'I should ', index: 0, format: 'anthropic-claude-v1' })
    mergeDetail(details, { type: 'reasoning.text', text: 'read it.', index: 0 })
    mergeDetail(details, { type: 'reasoning.text', signature: 'sig', index: 0 })
    mergeDetail(details, { type: 'reasoning.encrypted', data: 'abc', index: 1 })
    assert.deepEqual(details, [
      { type: 'reasoning.text', text: 'I should read it.', index: 0, format: 'anthropic-claude-v1', signature: 'sig' },
      { type: 'reasoning.encrypted', data: 'abc', index: 1 },
    ])
  })

  it('go on the thinking block they stream beside, or on a block of their own, and calls keep what came with them', () => {
    const assembler = createAssembler({ origin: { provider: 'p', model: 'm', family: 'google' } })
    assembler.push({ type: 'thinking', text: 'Hmm.' })
    assembler.push({ type: 'reasoning-detail', detail: { type: 'reasoning.text', text: 'Hmm.', index: 0 } })
    assembler.push({ type: 'tool-call', index: 0, id: 'call_1', name: 'Read', arguments: '{"file_path":"a"}', extra: { google: { thought_signature: 'S1' } } })
    assembler.push({ type: 'reasoning-detail', detail: { type: 'reasoning.encrypted', data: 'xyz', index: 1 } })
    assembler.push({ type: 'finish', reason: 'tool_use' })
    assert.deepEqual(assembler.finish().message.content, [
      { type: 'thinking', text: 'Hmm.', details: [{ type: 'reasoning.text', text: 'Hmm.', index: 0 }] },
      { type: 'tool-use', id: 'call_1', name: 'Read', input: { file_path: 'a' }, extra: { google: { thought_signature: 'S1' } } },
      { type: 'thinking', text: '', details: [{ type: 'reasoning.encrypted', data: 'xyz', index: 1 }] },
    ])
  })
})

describe('what goes back with a message', () => {
  it('the current request starts after the last message that is not tool results', () => {
    const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })
    const results = { role: 'user' as const, content: [{ type: 'tool-result' as const, toolUseId: 'call_1', content: [] }] }
    assert.equal(requestStart([user('a'), said('m'), results, user('b'), said('m'), results]), 3)
  })

  it('through OpenRouter: the details, to the model that wrote them, in the current request; DeepSeek on every turn', () => {
    const t = target({ providerType: 'openrouter', family: 'anthropic', model: 'anthropic/claude-x' })
    assert.deepEqual(replayFor(t, true, said('anthropic/claude-x'), true).reasoningDetails?.length, 1)
    assert.deepEqual(replayFor(t, true, said('anthropic/claude-x'), false), { extras: true, skipSignature: false }, 'an earlier turn')
    assert.deepEqual(replayFor(t, true, said('openai/gpt-x'), true), { extras: false, skipSignature: false }, 'another model')
    const deepseek = target({ providerType: 'openrouter', family: 'deepseek', model: 'deepseek/deepseek-v4' })
    assert.equal(replayFor(deepseek, true, said('openai/gpt-x'), false).reasoning, NO_REASONING)
  })

  it("directly: DeepSeek's on every message, Kimi's and GLM's own, MiniMax's in <think>, Gemini's signatures", () => {
    const deepseek = target({ family: 'deepseek', model: 'deepseek-v4-pro' })
    assert.equal(replayFor(deepseek, false, said('deepseek-v4-pro'), false).reasoningContent, 'I should read it.')
    assert.equal(replayFor(deepseek, false, said('claude-x', 'other'), false).reasoningContent, NO_REASONING)
    assert.equal(replayFor(target({ family: 'moonshot', model: 'kimi-k3' }), false, said('kimi-k3'), false).reasoningContent, 'I should read it.')
    assert.equal(replayFor(target({ family: 'zhipu', model: 'glm-5' }), false, said('glm-5:free'), true).reasoningContent, 'I should read it.')
    assert.equal(replayFor(target({ family: 'zhipu', model: 'glm-5' }), false, said('qwen3'), true).reasoningContent, undefined)
    assert.equal(replayFor(target({ family: 'minimax', model: 'MiniMax-M2' }), false, said('minimax-m2'), false).think, 'I should read it.')
    const gemini = target({ family: 'google', model: 'gemini-3-pro' })
    assert.deepEqual(replayFor(gemini, false, said('gpt-x'), true), { extras: false, skipSignature: true })
    assert.deepEqual(replayFor(gemini, false, said('gpt-x'), false), { extras: false, skipSignature: false })
    assert.deepEqual(replayFor(target({ family: 'openai', model: 'gpt-x' }), false, said('gpt-x'), true), { extras: true, skipSignature: false }, 'OpenAI is sent nothing new')
  })
})
