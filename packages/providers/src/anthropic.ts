/**
 * The adapter for Anthropic's Messages API.
 *
 * It keeps what makes Claude fast and consistent in long sessions: thinking
 * blocks go back exactly as they came (other families' are dropped), prompt
 * caching marks the stable prefix and the two latest turns, and each Claude
 * generation gets only the parameters it accepts (adaptive thinking and effort
 * on the new ones, a thinking budget on the old, no sampling parameters where
 * they return a 400).
 */
import { createHash } from 'node:crypto'
import type { FinishReason, ProviderAdapter, StreamInput, TransportEvent, TransportTarget, Usage } from './contract'
import { classifyStreamError, isTransportError, TransportError } from './errors'
import { describeEndpoint, guardStream, isJsonResponse, postJson, readJson, type FetchLike } from './http'
import type { ModelRequest, ReasoningEffort, ToolResultContent } from './messages'
import { anthropicTraits, type AnthropicTraits } from './models'
import { readSse } from './sse'
import { acceptingToolNames } from './tool-names'

export interface AnthropicOptions {
  fetch?: FetchLike
}

export const ANTHROPIC_VERSION = '2023-06-01'
/** Output budget when a request names none. */
const DEFAULT_MAX_TOKENS = 32_000

type CacheControl = { type: 'ephemeral' }
type WireBlock = Record<string, unknown> & { type: string; cache_control?: CacheControl }
type WireMessage = { role: 'user' | 'assistant'; content: WireBlock[] }
type WireTool = Record<string, unknown> & { cache_control?: CacheControl }

function isAnthropicApi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Anthropic takes tool ids of letters, digits, _ and - only. Others are rewritten, the same way every time. */
export function anthropicToolId(id: string): string {
  if (SAFE_ID.test(id) && id.length <= 200) return id
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8)
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}_${hash}`
}

function resultContent(content: ToolResultContent[]): WireBlock[] {
  const out: WireBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text })
    } else {
      out.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } })
    }
  }
  return out
}

/** Canonical messages in Anthropic's shape: tool results lead each user turn, other families' thinking is dropped. */
export function toAnthropicMessages(request: ModelRequest): WireMessage[] {
  const out: WireMessage[] = []
  for (const message of request.messages) {
    const content: WireBlock[] = []
    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        const parts = resultContent(block.content)
        content.push({
          type: 'tool_result',
          tool_use_id: anthropicToolId(block.toolUseId),
          ...(parts.length ? { content: parts } : {}),
          ...(block.isError ? { is_error: true } : {}),
        })
      }
      for (const block of message.content) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
        else if (block.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } })
      }
    } else {
      // Thinking is readable only by Claude, and goes back byte for byte with its signature.
      const ours = message.origin?.family === 'anthropic'
      for (const block of message.content) {
        if (block.type === 'thinking') {
          if (ours && block.signature) content.push({ type: 'thinking', thinking: block.text, signature: block.signature })
        } else if (block.type === 'redacted-thinking') {
          if (ours) content.push({ type: 'redacted_thinking', data: block.data })
        } else if (block.type === 'text') {
          if (block.text) content.push({ type: 'text', text: block.text })
        } else {
          content.push({ type: 'tool_use', id: anthropicToolId(block.id), name: block.name, input: block.invalid ? {} : block.input })
        }
      }
    }
    if (!content.length) continue
    const previous = out[out.length - 1]
    if (previous?.role === message.role) {
      // Two turns of one role in a row (an empty turn between them was skipped): one message, results first.
      const merged = [...previous.content, ...content]
      previous.content = [...merged.filter((block) => block.type === 'tool_result'), ...merged.filter((block) => block.type !== 'tool_result')]
    } else {
      out.push({ role: message.role, content })
    }
  }
  return out
}

/** Old Claude generations require the turn that called tools to start with thinking when thinking is on. */
function lastToolTurnStartsWithThinking(messages: WireMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (!message.content.some((block) => block.type === 'tool_use')) return true
    const first = message.content[0]?.type
    return first === 'thinking' || first === 'redacted_thinking'
  }
  return true
}

function budgetFor(effort: ReasoningEffort, maxTokens: number): number {
  const wanted = { low: 2_048, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_000 }[effort]
  return Math.min(wanted, maxTokens - 1)
}

function effortFor(effort: ReasoningEffort, traits: AnthropicTraits): ReasoningEffort {
  if (traits.extendedEffort) return effort
  return effort === 'xhigh' ? 'high' : effort
}

/**
 * Prompt-cache breakpoints, four at most: the system parts that ask for one
 * (the end of the system prompt if none does, which also caches the tools),
 * then the last two user turns, so each request reads what the previous one
 * wrote even when a step adds many blocks.
 */
function markCache(body: { system?: WireBlock[]; tools?: WireTool[]; messages: WireMessage[] }, request: ModelRequest): void {
  let left = 4
  const system = body.system ?? []
  const wanted = request.system
    .map((part, index) => (part.cache && part.text ? index : -1))
    .filter((index) => index >= 0)
  // body.system skips empty parts; map canonical indexes onto it.
  const positions = new Map<number, number>()
  let position = 0
  request.system.forEach((part, index) => {
    if (part.text) positions.set(index, position++)
  })
  const marks = wanted.length ? wanted.slice(-2).map((index) => positions.get(index)!) : system.length ? [system.length - 1] : []
  for (const mark of marks) {
    system[mark].cache_control = { type: 'ephemeral' }
    left--
  }
  if (!marks.length && body.tools?.length) {
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' }
    left--
  }
  let marked = 0
  for (let index = body.messages.length - 1; index >= 0 && marked < Math.min(2, left); index--) {
    const message = body.messages[index]
    if (message.role !== 'user') continue
    const last = message.content[message.content.length - 1]
    if (!last) continue
    last.cache_control = { type: 'ephemeral' }
    marked++
  }
}

export function buildAnthropicBody(target: TransportTarget, request: ModelRequest): Record<string, unknown> {
  const traits = anthropicTraits(target.model)
  const maxTokens = Math.max(1, Math.min(request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, target.maxOutputTokens))
  const messages = toAnthropicMessages(request)
  const system: WireBlock[] = request.system.filter((part) => part.text).map((part) => ({ type: 'text', text: part.text }))
  // Without eager streaming the API buffers each input parameter, so a long file body is minutes of silence.
  // Proxies may reject the field, so it goes only to Anthropic's own endpoint. The assembler parses strictly and core validates.
  const eager = isAnthropicApi(target.baseUrl)
  const tools: WireTool[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(eager ? { eager_input_streaming: true } : {}),
  }))
  const body: Record<string, unknown> & { system?: WireBlock[]; tools?: WireTool[]; messages: WireMessage[] } = {
    model: target.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  }
  if (system.length) body.system = system
  if (tools.length) {
    body.tools = tools
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' }
  }

  let thinking = false
  if (traits.adaptiveThinking) {
    body.thinking = traits.thinkingDisplay ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' }
    thinking = true
  } else if (traits.budgetThinking && request.reasoning && maxTokens > 2_048 && lastToolTurnStartsWithThinking(messages)) {
    body.thinking = { type: 'enabled', budget_tokens: budgetFor(request.reasoning, maxTokens) }
    thinking = true
  }
  if (request.reasoning && traits.effort) body.output_config = { effort: effortFor(request.reasoning, traits) }
  if (request.temperature !== undefined && traits.samplingParameters && !thinking) body.temperature = request.temperature
  if (target.capabilities.promptCache) markCache(body, request)
  return body
}

function messagesEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new TransportError('invalid-request', 'This provider has no base URL. Set one in Settings.')
  if (/\/v1\/messages$/.test(base)) return base
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

export function anthropicFinish(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'content_filter'
    default:
      return 'other'
  }
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Usage from message_start or message_delta. Anthropic counts cached tokens apart from input_tokens; eNCode adds them up. */
function usageReader() {
  let read = 0
  let written = 0
  return (raw: unknown): Partial<Usage> | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const usage = raw as Record<string, unknown>
    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    read = num(usage.cache_read_input_tokens) ?? read
    written = num(usage.cache_creation_input_tokens) ?? written
    const result: Partial<Usage> = {}
    if (input !== undefined) Object.assign(result, { inputTokens: input + read + written, cacheReadTokens: read, cacheWriteTokens: written })
    if (output !== undefined) result.outputTokens = output
    return Object.keys(result).length ? result : undefined
  }
}

function errorOf(payload: Record<string, unknown>): TransportError {
  const error = (payload.error ?? {}) as Record<string, unknown>
  return classifyStreamError(typeof error.type === 'string' ? error.type : undefined, typeof error.message === 'string' ? error.message : JSON.stringify(payload))
}

/** Events for a reply that arrived as one JSON body (a proxy that ignored stream: true). */
function* wholeReplyEvents(json: unknown): Generator<TransportEvent> {
  const payload = (json ?? {}) as Record<string, unknown>
  if (payload.type === 'error') throw errorOf(payload)
  if (!Array.isArray(payload.content)) throw new TransportError('protocol', 'The reply has no content.')
  if (typeof payload.model === 'string') yield { type: 'model', model: payload.model }
  let slot = 0
  for (const block of payload.content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') yield { type: 'text', text: block.text }
    else if (block.type === 'thinking') yield { type: 'thinking', text: String(block.thinking ?? ''), ...(typeof block.signature === 'string' ? { signature: block.signature } : {}) }
    else if (block.type === 'redacted_thinking' && typeof block.data === 'string') yield { type: 'redacted-thinking', data: block.data }
    else if (block.type === 'tool_use') yield { type: 'tool-call', index: slot++, id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) }
  }
  const usage = usageReader()(payload.usage)
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: typeof payload.stop_reason === 'string' ? anthropicFinish(payload.stop_reason) : 'stop' }
}

async function* streamedReplyEvents(response: Response, signal: AbortSignal, where: string): AsyncGenerator<TransportEvent> {
  if (!response.body) throw new TransportError('protocol', `${where} returned an empty stream.`)
  const usage = usageReader()
  const slots = new Map<number, number>()
  const wholeInput = new Set<number>()
  let nextSlot = 0
  let stopped = false
  for await (const item of guardStream(readSse(response.body, signal), signal, where)) {
    if (item.kind === 'comment') {
      yield { type: 'keepalive' }
      continue
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(item.data) as Record<string, unknown>
    } catch {
      throw new TransportError('protocol', `${where} sent a malformed stream event.`)
    }
    switch (data.type) {
      case 'message_start': {
        const message = (data.message ?? {}) as Record<string, unknown>
        if (typeof message.model === 'string') yield { type: 'model', model: message.model }
        const counts = usage(message.usage)
        if (counts) yield { type: 'usage', usage: counts }
        break
      }
      case 'content_block_start': {
        const index = num(data.index) ?? 0
        const block = (data.content_block ?? {}) as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string' && block.text) yield { type: 'text', text: block.text }
        else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) yield { type: 'thinking', text: block.thinking }
        else if (block.type === 'redacted_thinking' && typeof block.data === 'string') yield { type: 'redacted-thinking', data: block.data }
        else if (block.type === 'tool_use') {
          const slot = nextSlot++
          slots.set(index, slot)
          const input = block.input && typeof block.input === 'object' && Object.keys(block.input).length ? JSON.stringify(block.input) : ''
          if (input) wholeInput.add(index)
          yield { type: 'tool-call', index: slot, id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: input }
        }
        break
      }
      case 'content_block_delta': {
        const index = num(data.index) ?? 0
        const delta = (data.delta ?? {}) as Record<string, unknown>
        if (delta.type === 'text_delta' && typeof delta.text === 'string') yield { type: 'text', text: delta.text }
        else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') yield { type: 'thinking', text: delta.thinking }
        else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') yield { type: 'thinking', text: '', signature: delta.signature }
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const slot = slots.get(index)
          if (slot !== undefined && !wholeInput.has(index)) yield { type: 'tool-call', index: slot, arguments: delta.partial_json }
        }
        break
      }
      case 'message_delta': {
        const counts = usage(data.usage)
        if (counts) yield { type: 'usage', usage: counts }
        const delta = (data.delta ?? {}) as Record<string, unknown>
        if (typeof delta.stop_reason === 'string') yield { type: 'finish', reason: anthropicFinish(delta.stop_reason), detail: delta.stop_reason }
        break
      }
      case 'message_stop':
        stopped = true
        break
      case 'ping':
        yield { type: 'keepalive' }
        break
      case 'error':
        throw errorOf(data)
      default:
        break // content_block_stop, and event types added later
    }
    if (stopped) break
  }
  if (!stopped) throw new TransportError('protocol', `The stream from ${where} ended before the reply was complete.`)
}

const BOUND_ELSEWHERE = /messages\.(\d+)\.content\.\d+: Invalid `?signature`? in `?thinking`? block[^.]*\. The block is bound to a different conversation/i

/**
 * A thinking block whose conversation prefix changed is refused once with a
 * 400. The documented recovery is to drop that block and every thinking block
 * after it, and ask again.
 */
function dropRebound(body: Record<string, unknown>, error: TransportError): boolean {
  const match = BOUND_ELSEWHERE.exec(error.message)
  if (!match) return false
  const messages = body.messages as WireMessage[]
  const from = Number(match[1])
  let changed = false
  for (let index = from; index < messages.length; index++) {
    const kept = messages[index].content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking')
    if (kept.length !== messages[index].content.length) {
      messages[index].content = kept.length ? kept : [{ type: 'text', text: '(reasoning omitted)' }]
      changed = true
    }
  }
  return changed
}

export function createAnthropicAdapter(options: AnthropicOptions = {}): ProviderAdapter {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))

  async function* stream({ target, request, signal }: StreamInput): AsyncGenerator<TransportEvent> {
    if (signal.aborted) throw signal.reason
    const url = messagesEndpoint(target.baseUrl)
    const where = describeEndpoint(url)
    const headers: Record<string, string> = { accept: 'text/event-stream', 'anthropic-version': ANTHROPIC_VERSION }
    if (target.apiKey) headers['x-api-key'] = target.apiKey
    const body = buildAnthropicBody(target, request)
    let response: Response | undefined
    for (let tries = 0; !response; tries++) {
      try {
        response = await postJson(fetchImpl, url, headers, body, signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (!isTransportError(error) || tries >= 1 || !dropRebound(body, error)) throw error
      }
    }
    if (isJsonResponse(response)) {
      yield* wholeReplyEvents(await readJson(response, signal, where))
      return
    }
    yield* streamedReplyEvents(response, signal, where)
  }

  return acceptingToolNames({ type: 'anthropic', stream })
}
