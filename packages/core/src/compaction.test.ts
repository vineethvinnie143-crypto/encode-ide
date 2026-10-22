import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AssistantBlock, AssistantMessage, Message, ToolResultBlock, ToolUseBlock, UserMessage } from '@encode/providers'
import { textBlock, userText } from '@encode/providers'
import {
  applyCompaction,
  ContextMeter,
  digest,
  dropThinkingFrom,
  EARLIER_UNAVAILABLE,
  elideOldOutputs,
  estimateTokens,
  isPaired,
  NOT_RUN,
  planCompaction,
  repairPairing,
  requestText,
  shorten,
  summaryRequest,
} from './compaction'

const call = (id: string, name = 'Read', input: Record<string, unknown> = { file_path: '/a' }) => ({ type: 'tool-use' as const, id, name, input })
const assistant = (...content: (AssistantBlock | string)[]): AssistantMessage => ({
  role: 'assistant',
  content: content.map((block) => (typeof block === 'string' ? textBlock(block) : block)),
})
const result = (id: string, text: string, isError = false): ToolResultBlock => ({ type: 'tool-result', toolUseId: id, content: [textBlock(text)], ...(isError ? { isError } : {}) })
const results = (...blocks: ToolResultBlock[]): UserMessage => ({ role: 'user', content: blocks })

/** A step: an assistant message with one call, and its result. */
function step(id: string, output = 'ok', name = 'Read', input: Record<string, unknown> = { file_path: `/${id}` }): Message[] {
  return [assistant(`looking at ${id}`, call(id, name, input)), results(result(id, output))]
}

describe('repairPairing', () => {
  it('leaves a paired conversation alone', () => {
    const messages = [userText('go'), ...step('a'), assistant('done')]
    assert.ok(isPaired(messages))
    const repaired = repairPairing(messages)
    assert.equal(repaired.length, messages.length)
    assert.deepEqual(repaired, messages)
  })

  it('answers a call that has no result, and drops results nobody asked for', () => {
    const messages: Message[] = [
      userText('go'),
      assistant(call('a'), call('b')),
      results(result('b', 'B'), result('ghost', 'G'), result('b', 'again')),
    ]
    assert.ok(!isPaired(messages))
    const repaired = repairPairing(messages)
    assert.ok(isPaired(repaired))
    const answers = (repaired[2] as UserMessage).content as ToolResultBlock[]
    assert.deepEqual(answers.map((block) => block.toolUseId), ['a', 'b'])
    assert.equal(answers[0].content[0].type === 'text' && answers[0].content[0].text, NOT_RUN)
    assert.equal(answers[0].isError, true)
  })

  it('answers a call at the end of a stopped run, and keeps a prompt that followed it after the results', () => {
    const stopped: Message[] = [userText('go'), assistant(call('a'))]
    assert.ok(isPaired(repairPairing(stopped)))
    const followed = repairPairing([...stopped, userText('and then?')])
    assert.ok(isPaired(followed))
    const last = followed.at(-1) as UserMessage
    assert.deepEqual(last.content.map((block) => block.type), ['tool-result', 'text'])
  })

  it('drops duplicate calls, empty replies and thinking-only messages, and merges neighbours', () => {
    const messages: Message[] = [
      userText('one'),
      userText('two'),
      assistant({ type: 'thinking', text: 'hm' }),
      assistant(call('a'), call('a')),
      results(result('a', 'A')),
      assistant('  '),
      assistant('fine'),
    ]
    const repaired = repairPairing(messages)
    assert.ok(isPaired(repaired))
    assert.deepEqual(repaired.map((message) => message.role), ['user', 'assistant', 'user', 'assistant'])
    assert.equal(repaired[0].content.length, 2)
    assert.equal((repaired[1] as AssistantMessage).content.filter((block) => block.type === 'tool-use').length, 1)
  })

  it('opens with a note when the conversation starts with the assistant', () => {
    const repaired = repairPairing([assistant('hello'), userText('hi')])
    assert.ok(isPaired(repaired))
    assert.equal(requestText(repaired[0]), EARLIER_UNAVAILABLE)
  })

  it('rejects results that do not lead the user message', () => {
    const bad: Message[] = [userText('go'), assistant(call('a')), { role: 'user', content: [textBlock('first'), result('a', 'A')] }]
    assert.ok(!isPaired(bad))
  })
})

describe('elideOldOutputs', () => {
  const long = 'x'.repeat(5000)
  const conversation = (): Message[] => [
    userText('go'),
    ...step('s1', long, 'Bash', { command: 'a'.repeat(900) + 'b'.repeat(900) }),
    ...step('s2', long),
    ...step('s3', long),
    ...step('s4', long),
    ...step('s5', long),
    assistant('done'),
  ]

  it('shortens old outputs and long inputs, and keeps the recent steps whole', () => {
    const before = conversation()
    const after = elideOldOutputs(before, 4)
    const oldResult = (after[2] as UserMessage).content[0] as ToolResultBlock
    const oldText = oldResult.content[0].type === 'text' ? oldResult.content[0].text : ''
    assert.match(oldText, /characters removed to save context/)
    assert.ok(oldText.length < 1700)
    const oldInput = ((after[1] as AssistantMessage).content[1] as ToolUseBlock).input
    assert.match(String(oldInput.command), /^a{200}… \[1600 characters removed to save context\]$/)
    const huge = elideOldOutputs([userText('go'), ...step('h', 'ok', 'Write', { file_path: '/f', a: 'x'.repeat(2000), b: 'y'.repeat(2000), c: 'z'.repeat(2000), d: 'w'.repeat(2000), e: 'v'.repeat(2000), f: 'u'.repeat(2000), g: 't'.repeat(2000), h: 's'.repeat(2000) }), ...step('i')], 1)
    assert.deepEqual(Object.keys(((huge[1] as AssistantMessage).content[1] as ToolUseBlock).input), ['note'])
    assert.equal(after[4], before[4])
    assert.equal(after[10], before[10])
    assert.equal(before[2].content.length, 1)
    assert.ok(isPaired(after))
  })

  it('returns the same messages when nothing is old or long enough', () => {
    const messages = [userText('go'), ...step('a', long), assistant('done')]
    const after = elideOldOutputs(messages)
    assert.ok(after.every((message, i) => message === messages[i]))
  })

  it('drops images from old results', () => {
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' }
    const messages: Message[] = [
      userText('go'),
      assistant(call('a')),
      { role: 'user', content: [{ type: 'tool-result', toolUseId: 'a', content: [image, textBlock('shot')] }] },
      ...step('b'),
      ...step('c'),
    ]
    const after = elideOldOutputs(messages, 2)
    const parts = ((after[2] as UserMessage).content[0] as ToolResultBlock).content
    assert.deepEqual(parts.map((part) => part.type), ['text', 'text'])
    assert.equal(parts[0].type === 'text' && parts[0].text, '[image removed to save context]')
  })

  it('drops thinking from every message after the first one it changed, and keeps earlier thinking', () => {
    const thought: AssistantBlock = { type: 'thinking', text: 'because', signature: 'sig' }
    const messages: Message[] = [
      userText('go'),
      assistant(thought, call('s1')),
      results(result('s1', long)),
      assistant(thought, call('s2')),
      results(result('s2', long)),
      assistant(thought, call('s3')),
      results(result('s3', 'short')),
    ]
    const after = elideOldOutputs(messages, 1)
    assert.ok((after[1] as AssistantMessage).content.some((block) => block.type === 'thinking'), 'before the change')
    assert.ok(!(after[3] as AssistantMessage).content.some((block) => block.type === 'thinking'), 'after the change')
    assert.ok(!(after[5] as AssistantMessage).content.some((block) => block.type === 'thinking'), 'after the change')
    assert.ok(messages[3].content.some((block) => block.type === 'thinking'), 'the input is untouched')
  })
})

describe('compaction', () => {
  const body = 'y'.repeat(2000)
  const long = (): Message[] => [
    userText('first request'),
    ...step('a', body),
    assistant('answered the first'),
    userText('second request'),
    ...step('b', body),
    ...step('c', body),
    assistant('answered the second'),
    userText('third request'),
    ...step('d', body),
  ]

  it('cuts between units and keeps a tail of about the asked size', () => {
    const messages = long()
    const plan = planCompaction(messages, 1500)!
    assert.ok(plan)
    assert.ok(plan.dropped.length > 0 && plan.kept.length > 0)
    assert.equal(plan.dropped.length + plan.kept.length, messages.length)
    assert.ok(isPaired(repairPairing(plan.kept)) || plan.kept[0].role === 'assistant')
    assert.equal(planCompaction(messages, 1_000_000), null)
    assert.ok(planCompaction(messages, 1_000_000, true))
  })

  it('puts the summary in the first user message of the tail, after the preface', () => {
    const messages = long()
    const plan = planCompaction(messages, 100)!
    const compacted = applyCompaction(plan, 'They asked for three things.', ['<system-reminder>memory</system-reminder>'])
    assert.ok(isPaired(compacted))
    assert.equal(compacted[0].role, 'user')
    const opening = compacted[0].content.map((block) => (block.type === 'text' ? block.text : ''))
    assert.equal(opening[0], '<system-reminder>memory</system-reminder>')
    assert.match(opening[1], /<conversation_summary>[\s\S]*They asked for three things\.[\s\S]*<\/conversation_summary>/)
    assert.ok(compacted.length < messages.length)
  })

  it('carries the request a cut inside a turn answers', () => {
    const messages = long()
    const plan = planCompaction(messages, 100)!
    assert.equal(plan.openRequest, 'third request')
    const compacted = applyCompaction(plan, 'summary')
    const text = compacted[0].content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    assert.match(text, /<current_request>\nthird request\n<\/current_request>/)
  })

  it('does not carry a request when the tail opens with the user', () => {
    const messages: Message[] = [userText('old'), assistant('reply'), userText('new'), assistant('reply two')]
    const plan = planCompaction(messages, estimateTokens(messages.slice(2)) + 2)!
    assert.equal(plan.openRequest, null)
    assert.equal(plan.kept[0].role, 'user')
    const compacted = applyCompaction(plan, 'S')
    assert.ok(isPaired(compacted))
    assert.equal(compacted[0].content.length, 2)
  })

  it('drops all thinking: the prefix it was minted under is gone', () => {
    const thought: AssistantBlock = { type: 'thinking', text: 't', signature: 's' }
    const messages: Message[] = [userText('a'), assistant('b'), userText('c'), assistant(thought, call('x')), results(result('x', 'X'))]
    const plan = planCompaction(messages, 1, true)!
    const compacted = applyCompaction(plan, 'S')
    assert.ok(compacted.every((message) => message.content.every((block) => block.type !== 'thinking')))
    assert.ok(dropThinkingFrom(messages, 99).every((message, i) => message === messages[i]), 'nothing before the index changes')
  })

  it('builds the summary request from what the plan drops, with the user\'s instructions', () => {
    const plan = planCompaction(long(), 100)!
    const request = summaryRequest(plan, 100_000, 'keep the file names')
    assert.equal(request.tools.length, 0)
    const text = (request.messages[0].content[0] as { text: string }).text
    assert.match(text, /\[user\]\nfirst request/)
    assert.match(text, /\[call Read\] \{"file_path":"\/a"\}/)
    assert.match(text, /keep the file names/)
    assert.ok(!text.includes('third request') || plan.dropped.some((message) => requestText(message) === 'third request'))
  })

  it('cuts a long transcript in the middle', () => {
    const plan = planCompaction(long(), 100)!
    const text = (summaryRequest(plan, 300).messages[0].content[0] as { text: string }).text
    assert.match(text, /characters of the transcript omitted/)
  })
})

describe('digest', () => {
  it('lists requests, changed files, commands, failures and the last reply without a model', () => {
    const messages: Message[] = [
      userText('add a login page'),
      assistant(call('w', 'Write', { file_path: '/app/login.ts', content: 'x' }), call('b', 'Bash', { command: 'npm test' })),
      results(result('w', 'wrote it'), result('b', 'Error: 2 tests failed', true)),
      assistant('Tests fail; fixing next.'),
    ]
    const text = digest(messages)
    assert.match(text, /- add a login page/)
    assert.match(text, /Files created or changed: \/app\/login\.ts/)
    assert.match(text, /- npm test/)
    assert.match(text, /Bash: Error: 2 tests failed/)
    assert.match(text, /Tests fail; fixing next\./)
    assert.equal(digest([]), 'Nothing of note happened in the compacted messages.')
  })

  it('carries a summary from an earlier compaction forward', () => {
    const plan = planCompaction([userText('a'), assistant('b'), userText('c'), assistant('d')], 1, true)!
    const compacted = applyCompaction(plan, 'Earlier work: the parser.')
    assert.match(digest(compacted), /Earlier work: the parser\./)
  })
})

describe('requestText', () => {
  it('reads the user\'s own text, not reminders, attachments or a summary', () => {
    const message: Message = {
      role: 'user',
      content: [
        textBlock('<system-reminder>\nenvironment\n</system-reminder>'),
        textBlock('<conversation_summary>\nold\n</conversation_summary>'),
        textBlock('fix the build'),
        textBlock('<attached_files>\n--- a.ts ---\nx\n</attached_files>'),
      ],
    }
    assert.equal(requestText(message), 'fix the build')
  })
})

describe('sizes', () => {
  it('estimates text, calls and images', () => {
    assert.ok(estimateTokens([userText('x'.repeat(350))]) >= 100)
    const withImage: Message = { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AA' }] }
    assert.ok(estimateTokens([withImage]) >= 1600)
    assert.equal(shorten('short', 10), 'short')
  })

  it('anchors on the provider\'s count and estimates only what came after', () => {
    const meter = new ContextMeter()
    const sent = [userText('x'.repeat(3500))]
    const fixed = 500
    assert.equal(meter.estimate(sent, fixed), Math.ceil((estimateTokens(sent) + fixed) * 1))
    meter.record(sent, fixed, { inputTokens: 2000, outputTokens: 100 })
    const grown = [...sent, assistant('reply'), userText('y'.repeat(700))]
    const expected = 2100 + Math.ceil(estimateTokens(grown.slice(2)) * meter.scale)
    assert.equal(meter.estimate(grown, fixed), expected)
    meter.reset()
    assert.equal(meter.estimate(grown, fixed), Math.ceil((estimateTokens(grown) + fixed) * meter.scale))
  })
})
