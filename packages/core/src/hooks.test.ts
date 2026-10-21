import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { combineHooks, type ToolEvent } from './hooks'

const base = { sessionId: 's', agentId: 'main', root: '/w', mode: 'code' as const }
const call: ToolEvent = { ...base, tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } }

describe('combineHooks', () => {
  it('lets a deny win, and passes rewritten input down the chain', async () => {
    const seen: unknown[] = []
    const hooks = combineHooks(
      { preToolUse: async () => ({ decision: 'allow', input: { command: 'ls -la' } }) },
      { preToolUse: async (event) => void seen.push(event.input) },
      { preToolUse: async () => ({ decision: 'deny', reason: 'No listing today.' }) },
    )
    assert.deepEqual(await hooks.preToolUse!(call), { decision: 'deny', reason: 'No listing today.' })
    assert.deepEqual(seen, [{ command: 'ls -la' }])
  })

  it('keeps ask over allow, and reports the rewritten input', async () => {
    const hooks = combineHooks(
      { preToolUse: async () => ({ decision: 'ask', reason: 'Network command.' }) },
      { preToolUse: async () => ({ decision: 'allow', input: { command: 'pwd' } }) },
    )
    assert.deepEqual(await hooks.preToolUse!(call), { decision: 'ask', reason: 'Network command.', input: { command: 'pwd' } })
  })

  it('joins context, stops at the first block, and joins compaction instructions', async () => {
    const hooks = combineHooks(
      { userPromptSubmit: async () => ({ context: 'Branch: main' }), preCompact: async () => ({ instructions: 'Keep the test names.' }) },
      undefined,
      { userPromptSubmit: async () => ({ context: ' Node 22 ' }), preCompact: async () => ({ instructions: 'Keep the paths.' }) },
    )
    assert.deepEqual(await hooks.userPromptSubmit!({ ...base, messageId: 'm', prompt: 'hi' }), { context: 'Branch: main\n\nNode 22' })
    assert.deepEqual(await hooks.preCompact!({ ...base, trigger: 'auto' }), { instructions: 'Keep the test names.\n\nKeep the paths.' })
    const blocking = combineHooks({ userPromptSubmit: async () => ({ block: 'Not now.' }) }, { userPromptSubmit: async () => assert.fail('ran after a block') })
    assert.deepEqual(await blocking.userPromptSubmit!({ ...base, messageId: 'm', prompt: 'hi' }), { block: 'Not now.' })
  })

  it('sends the agent back when any stop hook says so', async () => {
    const hooks = combineHooks({ beforeStop: async () => undefined }, { beforeStop: async () => ({ continue: 'Run the tests first.' }) })
    assert.deepEqual(await hooks.beforeStop!({ ...base, lastMessage: 'Done.', continued: false }), { continue: 'Run the tests first.' })
    assert.deepEqual(await combineHooks().beforeStop!({ ...base, lastMessage: 'Done.', continued: false }), {})
  })
})
