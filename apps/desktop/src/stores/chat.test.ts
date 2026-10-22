import '../testing/bridge'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentEventBody } from '@shared/types'
import { setActiveSessionId } from './active'
import { useChat } from './chat'

setActiveSessionId('session-1')
const apply = (event: AgentEventBody, sessionId = 'session-1') => useChat.getState().applyEvent({ ...event, sessionId })
const usage = () => useChat.getState().usageTotals

describe('the tokens of the open conversation', () => {
  it('add up what each request used, and start again from nothing when the conversation is reset', () => {
    apply({ type: 'usage', promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 })
    apply({ type: 'usage', promptTokens: 150, completionTokens: 30, totalTokens: 180 })
    assert.deepEqual(usage(), { total: 300, cached: 40, prompt: 250, completion: 50 })

    apply({ type: 'session-reset' })
    assert.deepEqual(usage(), { total: 0, cached: 0, prompt: 0, completion: 0 })
    assert.deepEqual(useChat.getState().entries, [])
  })

  it('leave out what another session used', () => {
    apply({ type: 'usage', promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'session-2')
    assert.deepEqual(usage(), { total: 0, cached: 0, prompt: 0, completion: 0 })
  })
})
