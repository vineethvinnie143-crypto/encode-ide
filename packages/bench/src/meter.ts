/**
 * What a run spent, counted where it is spent: every model call goes through this client on its way to the real one,
 * the main agent's, its subagents', the Reviewer's and the summaries' alike.
 */
import type { CompletionOutcome, CompletionRequest, ModelClient } from '@encode/providers'

export interface ModelCall {
  role: string
  /** `provider:model` that answered; absent when nothing did. */
  model?: string
  outcome: CompletionOutcome['kind'] | 'failed'
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  cost?: number
  ms: number
}

export interface MeteredClient extends ModelClient {
  readonly calls: ModelCall[]
  /** Characters of tool results the models were sent, by tool, each result counted once: what reading cost. */
  readonly resultChars: Record<string, number>
}

export function meteredClient(inner: ModelClient, now: () => number = Date.now): MeteredClient {
  const calls: ModelCall[] = []
  const resultChars: Record<string, number> = {}
  const names = new Map<string, string>()
  const counted = new Set<string>()
  // A request carries the whole conversation; a result is counted the first time it is sent.
  const countResults = (request: CompletionRequest) => {
    for (const message of request.payload.messages) {
      for (const block of message.content) {
        if (block.type === 'tool-use') names.set(block.id, block.name)
        else if (block.type === 'tool-result' && !counted.has(block.toolUseId)) {
          counted.add(block.toolUseId)
          const name = names.get(block.toolUseId) ?? 'unknown'
          const chars = block.content.reduce((all, part) => all + (part.type === 'text' || part.type === 'document' ? part.text.length : 0), 0)
          resultChars[name] = (resultChars[name] ?? 0) + chars
        }
      }
    }
  }
  return {
    calls,
    resultChars,
    budget: (role, query) => inner.budget(role, query),
    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      countResults(request)
      const started = now()
      try {
        const outcome = await inner.complete(request)
        const usage = outcome.kind === 'done' ? outcome.usage : undefined
        const origin = outcome.kind === 'done' ? outcome.message.origin : undefined
        calls.push({
          role: request.role,
          ...(origin ? { model: `${origin.provider}:${origin.model}` } : {}),
          outcome: outcome.kind,
          inputTokens: usage?.inputTokens ?? 0,
          cachedTokens: usage?.cacheReadTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          ...(usage?.cost !== undefined ? { cost: usage.cost } : {}),
          ms: now() - started,
        })
        return outcome
      } catch (error) {
        calls.push({ role: request.role, outcome: 'failed', inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: now() - started })
        throw error
      }
    },
  }
}
