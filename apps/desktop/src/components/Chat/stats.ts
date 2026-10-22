/**
 * The conversation's numbers as the line under the message box and /status show them. Pure, for unit tests.
 */
import type { ConversationEntry } from '@shared/types'

/** The window the context meter measures against. */
export const CONTEXT_WINDOW = 128_000

export interface ConversationStats {
  turns: number
  steps: number
  /** Tokens the provider counted, or an estimate from the text while it has not said. */
  totalTokens: number
  /** Percent of the tokens the provider read from its cache. */
  cacheHit: number
  /** Percent of the context window. */
  context: number
}

export function conversationStats(entries: readonly ConversationEntry[], usage: { total: number; cached: number }): ConversationStats {
  const turns = entries.filter((entry) => entry.kind === 'user').length
  const steps = entries.filter((entry) => entry.kind === 'tool').length
  const chars = entries.reduce((total, entry) => total + (entry.text?.length ?? 0), 0)
  const totalTokens = usage.total || Math.round(chars / 4)
  const cacheHit = usage.total > 0 ? Math.round((usage.cached / usage.total) * 100) : 0
  const context = Math.min(100, Math.round((totalTokens / CONTEXT_WINDOW) * 100))
  return { turns, steps, totalTokens, cacheHit, context }
}
