/**
 * What a run spent, counted where it is spent: every model call goes through this client on its way to the real one,
 * the main agent's, its subagents', the Reviewer's and the summaries' alike.
 */
import type { CompletionOutcome, CompletionRequest, Message, ModelClient } from '@encode/providers'

export interface ModelCall {
  role: string
  /** `provider:model` that answered; absent when nothing did. */
  model?: string
  outcome: CompletionOutcome['kind'] | 'failed'
  inputTokens: number
  cachedTokens: number
  /** Written to the provider's cache, which some providers charge more for than a token read. */
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  cost?: number
  ms: number
  /**
   * The agent's conversation was rewritten before this call: its history is not the last call's with more added, so
   * old results were shortened or a summary took the place of old steps, and the provider's cache was given up from
   * there. Counted for calls that offer tools, which are the agents' own; a summary or a title is a request of its own.
   */
  rewrote?: true
}

export interface MeteredClient extends ModelClient {
  readonly calls: ModelCall[]
  /** Characters of tool results the models were sent, by tool, each result counted once: what reading cost. */
  readonly resultChars: Record<string, number>
}

const sameMessage = (a: Message, b: Message | undefined) => a === b || (b !== undefined && JSON.stringify(a) === JSON.stringify(b))

/** `after` is `before` with messages added at the end, and nothing before them changed. */
const extendsHistory = (before: readonly Message[], after: readonly Message[]) => after.length >= before.length && before.every((message, index) => sameMessage(message, after[index]))

export function meteredClient(inner: ModelClient, now: () => number = Date.now): MeteredClient {
  const calls: ModelCall[] = []
  /** The history each agent sent last, by role and agent. */
  const lastSent = new Map<string, readonly Message[]>()
  const rewrites = (request: CompletionRequest): boolean => {
    if (!request.payload.tools.length) return false
    const key = `${request.role}\0${request.agent ?? ''}`
    const before = lastSent.get(key)
    lastSent.set(key, request.payload.messages)
    return before !== undefined && !extendsHistory(before, request.payload.messages)
  }
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
      const rewrote = rewrites(request)
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
          cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          ...(usage?.cost !== undefined ? { cost: usage.cost } : {}),
          ms: now() - started,
          ...(rewrote ? { rewrote: true as const } : {}),
        })
        return outcome
      } catch (error) {
        calls.push({ role: request.role, outcome: 'failed', inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: now() - started, ...(rewrote ? { rewrote: true as const } : {}) })
        throw error
      }
    },
  }
}
