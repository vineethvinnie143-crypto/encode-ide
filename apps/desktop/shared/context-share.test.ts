import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONTEXT_MIN_SIGNS, contextOver, contextVerdict } from './context-share'
import type { ContextSignals, DayUsage, SessionUsage } from './types'

const signals = (patch: Partial<ContextSignals>): ContextSignals => ({ rewrites: 0, summaries: 0, readBacks: 0, editMisses: 0, checkBounces: 0, claimBounces: 0, ...patch })
const day = (requests: number, context?: ContextSignals): DayUsage => ({ calls: requests, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, unpriced: 0, requests, models: {}, ...(context ? { context } : {}) })

describe('what compaction did over a week (ADR 0132)', () => {
  it('sums the days in the range over every session, and counts the requests that had none', () => {
    const sessions: SessionUsage[] = [
      { id: 'a', title: 'A', projectRoot: null, days: { '2026-10-18': day(9, signals({ rewrites: 50 })), '2026-10-20': day(4, signals({ rewrites: 6, readBacks: 1 })), '2026-10-25': day(2) } },
      { id: 'b', title: 'B', projectRoot: null, days: { '2026-10-24': day(5, signals({ rewrites: 4, summaries: 1, editMisses: 1, checkBounces: 2, claimBounces: 1 })) } },
    ]
    const week = contextOver(sessions, { today: new Date(2026, 9, 25, 12), days: 7 })
    assert.deepEqual(week, { requests: 11, rewrites: 10, summaries: 1, readBacks: 1, editMisses: 1, checkBounces: 2, claimBounces: 1, verdict: 'ok' })
  })

  it('calls it high only past a few signs and a fifth of the rewrites', () => {
    assert.equal(contextVerdict({ rewrites: 0, readBacks: 0, editMisses: 0 }), 'none')
    assert.equal(contextVerdict({ rewrites: 4, readBacks: CONTEXT_MIN_SIGNS - 1, editMisses: 0 }), 'ok')
    assert.equal(contextVerdict({ rewrites: 10, readBacks: 2, editMisses: 1 }), 'high')
    assert.equal(contextVerdict({ rewrites: 100, readBacks: 2, editMisses: 1 }), 'ok')
  })
})
