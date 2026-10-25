/**
 * The model transport contract shared by core, the router and the adapters.
 *
 *   core ──complete()──▶ ModelClient (the router, or DirectClient) ──stream()──▶ ProviderAdapter ──▶ HTTP
 *
 * Core builds a provider-neutral ModelRequest and asks a ModelClient for a
 * role. The client picks a target, streams one attempt at a time through the
 * adapter for its provider type, assembles the events, and hands back a
 * finished message or an outcome core can act on. Nothing reaches history
 * until an attempt finishes cleanly, so a dead stream is dropped, never
 * half-committed.
 *
 * complete() rejects only when the caller aborts (with signal.reason).
 * Every other failure ends as an outcome: `compact` when the prompt does not
 * fit, `paused` when no model can run now.
 */
import type { AssistantMessage, ModelFamily, ModelRequest } from './messages'
import type { CacheTerms } from './cache-terms'

export type ProviderType = 'openai-compatible' | 'openrouter' | 'anthropic'

export interface ModelCapabilities {
  tools: boolean
  parallelTools: boolean
  images: boolean
  /** Emits reasoning, and takes an effort setting where the provider has one. */
  reasoning: boolean
  /** Takes explicit prompt-cache breakpoints (Anthropic's cache_control, also through OpenRouter). */
  promptCache: boolean
  /** Reads PDFs as documents, the pages as they look and not only their text. Absent means no. */
  documents?: boolean
}

/** One concrete model on one provider: what an adapter needs to make a call. */
export interface TransportTarget {
  /** Stable id of this candidate, `${provider}:${model}`. Health and cooldowns are keyed on it. */
  key: string
  /** The configured provider id ('openrouter', 'anthropic', a custom profile). A key is bound to it. */
  provider: string
  providerType: ProviderType
  /** Origin and path prefix, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string
  model: string
  family: ModelFamily
  apiKey?: string
  maxOutputTokens: number
  capabilities: ModelCapabilities
  /** OpenRouter's `models`: fallbacks the server tries before the first byte. */
  serverFallbacks?: string[]
  /** OpenRouter's provider.data_collection. */
  dataCollection?: 'allow' | 'deny'
}

export type FinishReason = 'stop' | 'tool_use' | 'length' | 'content_filter' | 'other'

export interface Usage {
  /** Every prompt token the model read, cached or not. */
  inputTokens: number
  outputTokens: number
  /** Of inputTokens, served from the provider's prompt cache. */
  cacheReadTokens: number
  /** Of inputTokens, written to the prompt cache. */
  cacheWriteTokens: number
  /** Of outputTokens, spent on reasoning, when the provider says. */
  reasoningTokens?: number
  /** Cost in US dollars, when the provider reports it (OpenRouter does). */
  cost?: number
}

/**
 * What an adapter yields while one attempt streams. Events arrive in content
 * order: consecutive `text` events extend one text block, consecutive
 * `thinking` events extend one thinking block until a signature closes it, and
 * `tool-call` events with the same index extend one call.
 */
export type TransportEvent =
  /** The model actually answering (OpenRouter may serve one of its fallbacks). */
  | { type: 'model'; model: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted-thinking'; data: string }
  /** One piece of OpenRouter's `reasoning_details`; pieces with the same index make one detail (ADR 0099). */
  | { type: 'reasoning-detail'; detail: Record<string, unknown> }
  /**
   * A slice of a tool call: id and name arrive once, the JSON arguments in pieces. `extra` is what the provider
   * attached to the call to have it sent back (Gemini's `extra_content`).
   */
  | { type: 'tool-call'; index: number; id?: string; name?: string; arguments: string; extra?: Record<string, unknown> }
  /** Cumulative counts; later events overwrite the fields they carry. */
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'finish'; reason: FinishReason; detail?: string }
  /** The server is alive with nothing to say yet (an SSE comment). */
  | { type: 'keepalive' }

export interface StreamInput {
  target: TransportTarget
  request: ModelRequest
  signal: AbortSignal
}

/**
 * Speaks one provider type's wire format. An adapter is stateless: it
 * translates the request, streams the reply as TransportEvents, and fails
 * with a TransportError (see errors.ts), or with signal.reason once aborted.
 * It does not retry, fail over or repair; the client above it does.
 */
export interface ProviderAdapter {
  readonly type: ProviderType
  stream(input: StreamInput): AsyncIterable<TransportEvent>
}

/** The roles of the plan (`inline`: the editor's suggestions as you type). Users can add their own. */
export type ModelRole = 'main' | 'explore' | 'planner' | 'reviewer' | 'summarizer' | 'utility' | 'inline' | (string & {})

/** What a candidate must offer to take this call. */
export interface Requirements {
  /** Estimated prompt size, calibrated against reported usage. */
  promptTokens: number
  maxOutputTokens: number
  tools: boolean
  images: boolean
}

/** Returns an error when a finished tool call's input breaks its tool's schema, else undefined. */
export type ToolCallValidator = (name: string, input: Record<string, unknown>) => string | undefined

/** Progress for a UI. Text, thinking and tool calls belong to the current attempt until it finishes. */
export type ClientEvent =
  | { type: 'attempt'; attempt: number; key: string; provider: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; index: number; id?: string; name?: string; arguments: string }
  /** The current attempt failed: forget what it streamed. Another attempt may follow. */
  | { type: 'discard'; reason: string }
  /** `reason` is one plain sentence on why `from` was left; `detail` the longer account, with the provider's own words. */
  | { type: 'switch'; from: string; to: string; reason: string; detail?: string }
  /** Nothing can run before `until` (epoch ms). `reason` is one plain sentence; `detail` the longer account. */
  | { type: 'wait'; until: number; reason: string; detail?: string }

export interface CompletionRequest {
  role: ModelRole
  /** The tool this call serves, for per-tool overrides (a WebFetch summary). */
  tool?: string
  /** The subagent this call serves, for per-agent overrides. */
  agent?: string
  payload: ModelRequest
  requirements: Requirements
  /** A session key: prefer the model this session already uses, so caches stay warm. */
  sticky?: string
  signal: AbortSignal
  onEvent?: (event: ClientEvent) => void
  validateToolCall?: ToolCallValidator
  /** A step that only reads what the last one found: its low effort stands over the role's (ADR 0135). */
  light?: true
}

export type PauseReason =
  | 'rate-limit'
  | 'quota'
  | 'payment'
  | 'auth'
  | 'network'
  | 'unavailable'
  | 'no-model'
  | 'refused'

export type CompletionOutcome =
  | {
      kind: 'done'
      /** Content in stream order; origin names the model that answered. */
      message: AssistantMessage
      usage: Usage
      finish: FinishReason
    }
  /** The prompt does not fit: compact to below `window` and call again. */
  | { kind: 'compact'; window: number; used?: number }
  /**
   * Nothing can run now. `message` says why in plain words, for the person; `detail` is the longer account, with what
   * the provider wrote (keys removed), for a Details fold and a report. `retryAt` (epoch ms) when a wait would help.
   */
  | { kind: 'paused'; reason: PauseReason; message: string; detail?: string; retryAt?: number }

/** The numbers of the model a call would run on now, for compacting before sending. */
export interface ModelBudget {
  model: string
  contextWindow: number
  maxOutputTokens: number
  /** Whether the model reads images. Absent when the client cannot tell. */
  images?: boolean
  /** Whether the model reads PDFs as documents. Absent when the client cannot tell. */
  documents?: boolean
  /** What it costs, in US dollars per million tokens; absent when the client does not know. */
  price?: { input: number; output: number }
  /** Free to call. */
  free?: boolean
  /** What its prompt cache charges, for compaction to tell when a rewrite pays (ADR 0130); absent when the client cannot tell. */
  cache?: CacheTerms
  /** A step may think at low effort without costing the prompt cache (ADR 0135); absent when it may not. */
  effortPerStep?: true
}

export interface BudgetQuery {
  sticky?: string
  tool?: string
  agent?: string
  /** The request carries pictures: the budget is of a model that reads them, where one is ready (ADR 0113). */
  images?: boolean
}

export interface ModelClient {
  complete(request: CompletionRequest): Promise<CompletionOutcome>
  budget(role: ModelRole, query?: BudgetQuery): Promise<ModelBudget>
}
