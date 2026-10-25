/**
 * What compaction did over the last days, and how often it cut what the model still needed (ADR 0132). Rewrites save
 * tokens; a read-back of a shortened output, or an edit that missed its text after a rewrite, is the model paying for
 * one. The diagnostics report says both, so a report from a tester shows whether shortening holds in real use.
 */
import { firstDay } from './cache-share'
import type { ContextSignals, SessionUsage } from './types'

/** Read-backs and edit misses per rewrite above which shortening is cutting too much. */
export const CONTEXT_HIGH = 0.2
/** Of them, at least this many before the share says anything. */
export const CONTEXT_MIN_SIGNS = 3

export type ContextVerdict = 'none' | 'ok' | 'high'

export interface ContextWeek extends Required<ContextSignals> {
  /** The requests in the range, rewritten or not. */
  requests: number
  verdict: ContextVerdict
}

const KEYS = ['rewrites', 'summaries', 'readBacks', 'editMisses', 'checkBounces', 'claimBounces', 'digests', 'digestReadBacks'] as const

/** The signals of the `days` days that end with `today` (this computer's clock), summed over every session. */
export function contextOver(sessions: readonly SessionUsage[], range: { today: Date; days: number }): ContextWeek {
  const since = firstDay(range.today, range.days)
  const sum: Required<ContextSignals> & { requests: number } = { requests: 0, rewrites: 0, summaries: 0, readBacks: 0, editMisses: 0, checkBounces: 0, claimBounces: 0, digests: 0, digestReadBacks: 0 }
  for (const session of sessions) {
    for (const [day, used] of Object.entries(session.days)) {
      if (day < since) continue
      sum.requests += used.requests
      const context = used.context
      if (!context) continue
      for (const key of KEYS) {
        const value = context[key]
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) sum[key] += value
      }
    }
  }
  return { ...sum, verdict: contextVerdict(sum) }
}

export function contextVerdict(signals: Pick<ContextSignals, 'rewrites' | 'readBacks' | 'editMisses'>): ContextVerdict {
  if (!signals.rewrites) return 'none'
  const signs = signals.readBacks + signals.editMisses
  return signs >= CONTEXT_MIN_SIGNS && signs / signals.rewrites >= CONTEXT_HIGH ? 'high' : 'ok'
}

const times = (count: number, one: string, many: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/** The lines of the diagnostics report's section. */
export function contextLines(week: ContextWeek): string[] {
  const lines = [`  ${times(week.requests, 'request', 'requests')}, ${times(week.rewrites, 'rewrite', 'rewrites')} (${times(week.summaries, 'summary', 'summaries')})`]
  if (week.rewrites) {
    const high = week.verdict === 'high' ? ' (HIGH): shortening cut what the model needed again. A session keeps more after three read-backs; a report of such a request helps tune it.' : ''
    lines.push(`  a shortened output read back ${times(week.readBacks, 'time', 'times')}, ${times(week.editMisses, 'edit', 'edits')} missing its text after a rewrite${high}`)
  }
  if (week.digests) {
    lines.push(`  ${times(week.digests, 'command output', 'command outputs')} went in as a digest, ${times(week.digestReadBacks, 'read', 'read')} back whole`)
  }
  if (week.checkBounces || week.claimBounces) {
    lines.push(`  the project's checks sent the agent back ${times(week.checkBounces, 'time', 'times')}, the check of its claims ${times(week.claimBounces, 'time', 'times')}`)
  }
  return lines
}
