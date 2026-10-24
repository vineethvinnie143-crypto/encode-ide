/**
 * eNCode's canonical conversation: the one format core stores, sessions
 * persist and every adapter translates to its provider's wire format.
 *
 * Blocks follow Anthropic's model because it is the richest: thinking keeps
 * its signature, and tool calls and results are blocks paired by id. Every
 * assistant message records who wrote it, so an adapter can drop what the next
 * model cannot read (another family's thinking) without editing history.
 *
 * History is append-only. Changing an earlier message, the system prompt or
 * the tool list invalidates prompt caches and, on Anthropic's newest models,
 * the thinking blocks minted after the change. Compaction is the only
 * sanctioned rewrite.
 */

/** Model families, for what a model can read back (thinking) and per-family quirks. */
export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'mistral'
  | 'meta'
  | 'xai'
  | 'minimax'
  | 'other'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  mediaType: ImageMediaType
  /** Base64, without a data: prefix. */
  data: string
  /**
   * Shows something that keeps changing, such as a screen: only the newest few are worth sending,
   * and none is worth keeping in a stored log. Providers ignore the flag.
   */
  transient?: true
}

/**
 * A document the model reads as it is, pages and all: a PDF of the pages Read chose for what they show (a
 * figure, a chart, a scan). Only tool results carry one. A model that cannot read documents is sent `text`
 * instead, and the stored log keeps only `text`.
 */
export interface DocumentBlock {
  type: 'document'
  mediaType: 'application/pdf'
  /** Base64, without a data: prefix. */
  data: string
  /** A file name for providers that want one. */
  name: string
  /** How many pages it holds, for estimating its size in tokens. */
  pages: number
  /** What the document says, as text: what a model that cannot read the document gets. */
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  /** Anthropic's signature. It must come back byte for byte, or the block is rejected. */
  signature?: string
  /**
   * OpenRouter's `reasoning_details` for this reasoning, merged as they streamed: signed, summarized or encrypted
   * reasoning that goes back unchanged to the model that wrote it (ADR 0099). Opaque to eNCode.
   */
  details?: Record<string, unknown>[]
}

/** Reasoning the provider encrypted. Only the model family that wrote it can read it. */
export interface RedactedThinkingBlock {
  type: 'redacted-thinking'
  data: string
}

/** Why a tool call's input could not be used. Core answers it with an error result. */
export interface InvalidToolInput {
  /** The arguments exactly as the model sent them. */
  raw: string
  error: string
}

export interface ToolUseBlock {
  type: 'tool-use'
  id: string
  name: string
  /** Parsed arguments; `{}` when `invalid` is set. */
  input: Record<string, unknown>
  invalid?: InvalidToolInput
  /**
   * What the provider attached to the call to have it sent back with it: Gemini's `extra_content`, which holds its
   * thought signature (ADR 0099). Opaque to eNCode; only the model that wrote the call is sent it.
   */
  extra?: Record<string, unknown>
}

export type ToolResultContent = TextBlock | ImageBlock | DocumentBlock

export interface ToolResultBlock {
  type: 'tool-result'
  toolUseId: string
  content: ToolResultContent[]
  isError?: boolean
}

export type UserBlock = TextBlock | ImageBlock | ToolResultBlock
export type AssistantBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock

/** Who wrote an assistant message: the model that actually answered, not the one requested. */
export interface MessageOrigin {
  provider: string
  model: string
  family: ModelFamily
}

export interface UserMessage {
  role: 'user'
  content: UserBlock[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantBlock[]
  origin?: MessageOrigin
}

export type Message = UserMessage | AssistantMessage

/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

/** One part of the system prompt. `cache` marks the end of a stable prefix worth caching. */
export interface SystemPart {
  text: string
  cache?: boolean
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * One model call, provider-neutral. Adapters translate it; nothing here is
 * specific to a wire format except hints an adapter may ignore.
 */
export interface ModelRequest {
  system: SystemPart[]
  messages: Message[]
  tools: ToolDefinition[]
  /** The output budget. Adapters clamp it to the target's limit. */
  maxOutputTokens?: number
  /** 'none' keeps the tools listed (a stable prefix) but forbids calling them. Default 'auto'. */
  toolChoice?: 'auto' | 'none'
  /** How hard a reasoning model should think. Adapters map it, or drop it for models without a dial. */
  reasoning?: ReasoningEffort
  /** Ignored by models that reject sampling parameters. */
  temperature?: number
}

export function textBlock(text: string): TextBlock {
  return { type: 'text', text }
}

export function userText(text: string): UserMessage {
  return { role: 'user', content: [textBlock(text)] }
}

/** The text of a message's text blocks, joined. Thinking and tool blocks are left out. */
export function messageText(message: Message): string {
  let text = ''
  for (const block of message.content) if (block.type === 'text') text += text ? `\n${block.text}` : block.text
  return text
}

export function toolUses(message: AssistantMessage): ToolUseBlock[] {
  return message.content.filter((block): block is ToolUseBlock => block.type === 'tool-use')
}

/** A reply with nothing to act on: no text and no tool call (reasoning alone does not count). */
export function isEmptyReply(message: AssistantMessage): boolean {
  return !message.content.some((block) => (block.type === 'text' && block.text.trim()) || block.type === 'tool-use')
}
