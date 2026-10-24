import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DayUsage, SessionUsage, UsageTally } from '@shared/types'
import { daysOf, formatCost, formatTokens, usageView } from './usage-model'

const tally = (calls: number, cost: number, unpriced = 0, tokens = 1_000): UsageTally => ({ calls, inputTokens: tokens, cachedTokens: tokens / 2, outputTokens: tokens / 10, cost, unpriced })
const day = (requests: number, models: Record<string, UsageTally>): DayUsage => {
  const sum = Object.values(models).reduce((all, model) => ({ calls: all.calls + model.calls, inputTokens: all.inputTokens + model.inputTokens, cachedTokens: all.cachedTokens + model.cachedTokens, outputTokens: all.outputTokens + model.outputTokens, cost: all.cost + model.cost, unpriced: all.unpriced + model.unpriced }), tally(0, 0, 0, 0))
  return { ...sum, requests, models }
}

const sessions: SessionUsage[] = [
  {
    id: 's1',
    title: 'Fix the shop',
    projectRoot: 'C:\\work\\shop',
    days: {
      '2026-10-24': day(2, { 'deepseek-chat': tally(4, 0.02) }),
      '2026-10-20': day(1, { 'deepseek-chat': tally(2, 0.01), 'qwen/qwen3-coder:free': tally(1, 0) }),
      // Before the range: left out.
      '2026-09-01': day(5, { 'deepseek-chat': tally(9, 5) }),
    },
  },
  { id: 's2', title: 'A question', projectRoot: 'C:\\Users\\me\\Documents\\eNCode', days: { '2026-10-23': day(1, { 'local-llama': tally(3, 0, 3), '': tally(1, 0.5) }) } },
  { id: 's3', title: 'Elsewhere', projectRoot: 'C:\\work\\api', days: { '2026-10-24': day(1, { 'deepseek-chat': tally(1, 0.005) }) } },
]

describe('the Usage page', () => {
  const today = new Date(2026, 9, 24, 15, 0)

  it('lists every day of the range, oldest first, ending today', () => {
    assert.deepEqual(daysOf(today, 3), ['2026-10-22', '2026-10-23', '2026-10-24'])
    // Across the end of a month.
    assert.deepEqual(daysOf(new Date(2026, 10, 1), 2), ['2026-10-31', '2026-11-01'])
  })

  it('sums the days of the range, by day, by model and by project, chats together', () => {
    const view = usageView(sessions, { today, range: 7, chatsFolder: 'C:\\Users\\me\\Documents\\eNCode' })
    assert.equal(view.days.length, 7)
    assert.equal(view.days.at(-1)!.day, '2026-10-24')
    assert.equal(view.days.at(-1)!.tally.requests, 3)
    assert.equal(view.days.find((entry) => entry.day === '2026-10-22')!.tally.calls, 0, 'a day without requests keeps its place')
    assert.equal(view.total.requests, 5)
    assert.equal(view.total.calls, 12)
    assert.ok(Math.abs(view.total.cost - 0.535) < 1e-9)
    assert.equal(view.total.unpriced, 3, 'the calls that reported no cost are counted, not priced')

    assert.deepEqual(
      view.models.map((model) => [model.label, model.tally.calls]),
      [
        ['Before models were kept', 1],
        ['deepseek-chat', 7],
        ['local-llama', 3],
        ['qwen/qwen3-coder:free', 1],
      ],
      'the most costly first, then the most tokens, then by name',
    )
    assert.deepEqual(
      view.projects.map((project) => [project.label, project.tally.requests]),
      [
        ['Chats', 1],
        ['shop', 3],
        ['api', 1],
      ],
    )
  })

  it('leaves out what is older than the range', () => {
    const view = usageView(sessions, { today, range: 30, chatsFolder: null })
    assert.equal(view.total.requests, 5)
    assert.equal(usageView(sessions, { today, range: 90, chatsFolder: null }).total.requests, 10)
  })

  it('writes costs and tokens short', () => {
    assert.deepEqual([0, 0.00421, 0.314, 12.4].map(formatCost), ['$0', '$0.0042', '$0.31', '$12.40'])
    assert.deepEqual([980, 18_440, 1_234_567].map(formatTokens), ['980', '18.4k', '1.2M'])
  })
})
