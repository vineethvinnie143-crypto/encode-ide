import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, type Gen, type Random } from '@encode/testkit'
import {
  applyCompaction,
  contextOverflow,
  digest,
  elideOldOutputs,
  estimateTokens,
  isPaired,
  NOT_RUN,
  planCompaction,
  repairPairing,
  requestText,
  RECENT_STEPS,
} from './compaction'
import type { ChatMessage, ToolCallPayload } from './types'

const below = (random: Random, n: number) => Math.floor(random() * n)

function call(id: string, name: string, args: Record<string, unknown>): ToolCallPayload {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** A transcript the agent could have produced: turns of a request, steps with every call answered, maybe a reply. */
const conversation: Gen<ChatMessage[]> = (random, size) => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are eNCode.' }]
  let next = 0
  const turns = 1 + below(random, 2 + Math.floor(size / 6))
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: 'user', content: `request ${turn}: ${'x'.repeat(below(random, 300))}` })
    const steps = below(random, 5)
    for (let step = 0; step < steps; step++) {
      const calls = Array.from({ length: 1 + below(random, 3) }, () => {
        const id = `call_${next++}`
        if (random() < 0.15) {
          // Long arguments that are not one long string.
          const todos = Array.from({ length: below(random, 80) }, (_, index) => ({ content: `todo ${index}`, status: 'pending' }))
          return call(id, 'todo_write', { todos })
        }
        const name = ['read', 'write', 'pwsh', 'glob'][below(random, 4)]
        return call(id, name, { path: `src/file${next}.ts`, content: 'y'.repeat(below(random, 4000)), command: `echo ${next}` })
      })
      messages.push({ role: 'assistant', content: random() < 0.5 ? null : `step ${step}`, tool_calls: calls })
      const order = [...calls].sort(() => random() - 0.5)
      for (const answered of order) {
        messages.push({ role: 'tool', tool_call_id: answered.id, content: `output ${answered.id} ${'z'.repeat(below(random, 5000))}` })
      }
    }
    if (random() < 0.7) messages.push({ role: 'assistant', content: `reply ${turn}` })
  }
  return messages
}

/** The same, then damaged the ways a stop, a crash or an older build can damage it. */
const damaged: Gen<ChatMessage[]> = (random, size) => {
  const messages = conversation(random, size)
  const damage = 1 + below(random, 4)
  for (let round = 0; round < damage && messages.length > 1; round++) {
    const at = 1 + below(random, messages.length - 1)
    switch (below(random, 8)) {
      case 0:
        messages.splice(at, 1)
        break
      case 1:
        messages.splice(at, 0, structuredClone(messages[at]))
        break
      case 2: {
        const [moved] = messages.splice(at, 1)
        messages.splice(1 + below(random, messages.length), 0, moved)
        break
      }
      case 3:
        messages.length = at
        break
      case 4:
        messages.splice(at, 0, { role: 'tool', tool_call_id: 'ghost', content: 'orphan' })
        break
      case 5:
        messages.splice(at, 0, { role: 'assistant', content: null, tool_calls: [] })
        break
      case 6:
        messages.splice(at, 0, { role: 'system', content: 'misplaced' })
        break
      default:
        messages.splice(1, 0, { role: 'assistant', content: 'starts mid-conversation' })
    }
  }
  return messages
}

const userTexts = (messages: readonly ChatMessage[]) =>
  messages.filter((message) => message.role === 'user').map((message) => message.content)

describe('repairPairing', () => {
  it('leaves a valid transcript untouched', async () => {
    await check(conversation, (messages) => {
      assert.ok(isPaired(messages))
      assert.deepEqual(repairPairing(messages), messages)
    })
  })

  it('makes any damaged transcript valid, keeps every request, and is idempotent', async () => {
    await check(damaged, (messages) => {
      const repaired = repairPairing(messages)
      assert.ok(isPaired(repaired), 'not paired')
      assert.deepEqual(repairPairing(repaired), repaired, 'not idempotent')
      const kept = userTexts(repaired).filter((text) => !String(text).startsWith('(Earlier messages'))
      assert.deepEqual(kept, userTexts(messages), 'a user message was lost')
      const results = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.content))
      for (const message of repaired) {
        if (message.role === 'tool' && message.content !== NOT_RUN) assert.ok(results.has(message.content), 'invented a result')
      }
    }, { runs: 400 })
  })

  it('answers a call a stopped or finished run left open', () => {
    const repaired = repairPairing([
      { role: 'system', content: 's' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [call('a', 'attempt_completion', { result: 'done' })] },
      { role: 'user', content: 'and now?' },
    ])
    assert.deepEqual(repaired[3], { role: 'tool', tool_call_id: 'a', content: NOT_RUN })
    assert.equal(repaired[4].content, 'and now?')
  })
})

describe('elideOldOutputs', () => {
  it('shortens only outside the recent steps, keeps arguments valid JSON, and is idempotent', async () => {
    await check(conversation, (messages) => {
      const elided = elideOldOutputs(messages)
      assert.ok(isPaired(elided))
      assert.equal(elided.length, messages.length)
      assert.ok(estimateTokens(elided) <= estimateTokens(messages))
      assert.deepEqual(elideOldOutputs(elided), elided)

      const stepStarts = messages.flatMap((message, index) => (message.tool_calls?.length ? [index] : []))
      const recentFrom = stepStarts.length > RECENT_STEPS ? stepStarts[stepStarts.length - RECENT_STEPS] : 0
      assert.deepEqual(elided.slice(recentFrom), messages.slice(recentFrom), 'a recent step changed')
      elided.forEach((message, index) => {
        for (const payload of message.tool_calls ?? []) {
          JSON.parse(payload.function.arguments)
          if (index < recentFrom) assert.ok(payload.function.arguments.length <= 1500, 'old arguments stayed long')
        }
        if (index < recentFrom && message.role === 'tool') assert.ok((message.content ?? '').length <= 1500, 'an old output stayed long')
      })
    })
  })
})

describe('planCompaction and applyCompaction', () => {
  it('cuts between units and yields a valid transcript that opens with the user', async () => {
    const cases: Gen<[ChatMessage[], number, boolean]> = (random, size) => [conversation(random, size), below(random, 6000), random() < 0.5]
    await check(cases, ([messages, keep, force]) => {
      const plan = planCompaction(messages, keep, force)
      if (!plan) return
      assert.deepEqual([...plan.system, ...plan.dropped, ...plan.kept], messages, 'not a partition')
      assert.ok(plan.dropped.length > 0)
      assert.notEqual(plan.kept[0].role, 'tool')
      if (!force && plan.kept.length) assert.ok(estimateTokens(plan.kept) <= keep || isLastUnit(plan.kept))

      const compacted = applyCompaction(plan, 'SUMMARY-TEXT')
      assert.ok(isPaired(compacted), 'compaction broke pairing')
      const opening = compacted[plan.system.length]
      assert.equal(opening.role, 'user')
      assert.match(opening.content ?? '', /SUMMARY-TEXT/)
      if (plan.kept[0].role === 'user') {
        assert.equal(compacted.length, plan.system.length + plan.kept.length)
      } else {
        assert.ok(plan.openRequest, 'a cut inside a turn must carry the request')
        assert.ok((opening.content ?? '').includes(plan.openRequest))
        assert.deepEqual(compacted.slice(plan.system.length + 1), plan.kept)
      }
    }, { runs: 400 })
  })

  it('keeps the request in progress word for word when it cuts inside a turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'Rename every Forge reference to eNCode.' },
      { role: 'assistant', content: null, tool_calls: [call('a', 'grep', { pattern: 'Forge' })] },
      { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(4000) },
      { role: 'assistant', content: null, tool_calls: [call('b', 'edit', { path: 'a.ts' })] },
      { role: 'tool', tool_call_id: 'b', content: 'ok' },
    ]
    const plan = planCompaction(messages, 50)
    assert.ok(plan)
    assert.equal(plan.openRequest, 'Rename every Forge reference to eNCode.')
    const compacted = applyCompaction(plan, 'Searched for Forge.')
    assert.equal(requestText(compacted[1].content ?? ''), 'Rename every Forge reference to eNCode.')

    // Compacting again carries the request and the earlier summary forward.
    const again = planCompaction([...compacted, { role: 'assistant', content: 'Done.' }], 5, true)
    assert.ok(again)
    assert.equal(again.openRequest, 'Rename every Forge reference to eNCode.')
    assert.match(digest(again.dropped), /Searched for Forge/)
  })

  it('leaves a short conversation alone unless forced', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    assert.equal(planCompaction(messages, 10_000), null)
    assert.deepEqual(planCompaction(messages, 10_000, true)?.dropped, [messages[1]])
    assert.equal(planCompaction(messages.slice(0, 2), 0, true), null, 'one unit cannot be split')
  })
})

/** True when `kept` is a single unit: a message, or one step with its results. */
function isLastUnit(kept: readonly ChatMessage[]): boolean {
  return kept.length === 1 || (kept[0].role === 'assistant' && kept.slice(1).every((message) => message.role === 'tool'))
}

describe('digest', () => {
  it('lists requests, changed files, commands and failures without a model', () => {
    const text = digest([
      { role: 'user', content: 'Add a login page' },
      {
        role: 'assistant',
        content: 'Writing it.',
        tool_calls: [call('a', 'write', { path: 'src/login.tsx', content: '…' }), call('b', 'pwsh', { command: 'pnpm test' })],
      },
      { role: 'tool', tool_call_id: 'a', content: 'Wrote src/login.tsx' },
      { role: 'tool', tool_call_id: 'b', content: 'Error: 2 tests failed' },
      { role: 'assistant', content: 'Two tests fail; fixing next.' },
    ])
    assert.match(text, /Add a login page/)
    assert.match(text, /src\/login\.tsx/)
    assert.match(text, /pnpm test/)
    assert.match(text, /pwsh: Error: 2 tests failed/)
    assert.match(text, /fixing next/)
  })
})

describe('contextOverflow', () => {
  it('reads the window and the prompt size from providers’ errors', () => {
    const cases: Array<[string, { window?: number; used?: number }]> = [
      [
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130532 tokens. Please reduce the length of the messages.",
        { window: 128000, used: 130532 },
      ],
      [
        "This endpoint's maximum context length is 65536 tokens. However, you requested about 70123 tokens (66123 of text input, 4000 in the output).",
        { window: 65536, used: 70123 },
      ],
      ['prompt is too long: 210000 tokens > 200000 maximum', { window: 200000, used: 210000 }],
      ['The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', { window: 1048576, used: 1200000 }],
      ['Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length', { window: 32768, used: 40000 }],
      ['The number of tokens to keep from the initial prompt is greater than the context length.', {}],
      ['the request exceeds the available context size, try increasing it', {}],
    ]
    for (const [message, expected] of cases) {
      const found = contextOverflow(`Model request failed with HTTP 400: {"error":{"message":"${message}"}}`)
      assert.ok(found, message)
      assert.deepEqual({ ...found }, { window: expected.window, used: expected.used }, message)
    }
  })

  it('ignores other errors', () => {
    for (const message of [
      'Model request failed with HTTP 401: invalid api key',
      'max_tokens is too large: 50000. This model supports at most 16384 completion tokens',
      'Rate limit reached for requests',
    ]) {
      assert.equal(contextOverflow(message), null, message)
    }
  })
})
