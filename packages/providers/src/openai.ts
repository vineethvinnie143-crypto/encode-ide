/**
 * The adapter for OpenAI's chat-completions dialect, spoken by OpenAI,
 * OpenRouter, DeepSeek, Ollama, LM Studio, vLLM and most gateways.
 *
 * Servers differ in what they accept, so the adapter negotiates the wire
 * format before the first byte: a server that rejects streaming is asked
 * again without it, and an optional parameter it names as unknown is
 * dropped. Nothing is retried once a reply has started.
 */
import { createHash } from 'node:crypto'
import type { FinishReason, ProviderAdapter, StreamInput, TransportEvent, TransportTarget, Usage } from './contract'
import { classifyStreamError, isTransportError, TransportError } from './errors'
import { describeEndpoint, guardStream, isJsonResponse, postJson, readJson, type FetchLike } from './http'
import type { AssistantMessage, ImageBlock, ModelRequest, ReasoningEffort, ToolUseBlock, UserMessage } from './messages'
import { readSse } from './sse'

export interface OpenAICompatibleOptions {
  fetch?: FetchLike
  /** Sent to OpenRouter as HTTP-Referer and X-Title, which name the app in its dashboards. */
  appUrl?: string
  appTitle?: string
}

type ChatPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } } | { type: 'image_url'; image_url: { url: string } }

type ChatMessage =
  | { role: 'system'; content: string | ChatPart[] }
  | { role: 'user'; content: string | ChatPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string | ChatPart[] }

/**
 * Parameters the adapter adds that a server may not know; each is dropped when
 * a server names it as unknown. OpenRouter's own (models, provider, usage) are
 * never dropped: provider carries the data policy.
 */
const OPTIONAL_PARAMETERS = ['stream_options', 'parallel_tool_calls', 'reasoning_effort', 'reasoning', 'temperature']
const REJECTS_PARAMETER = /unrecognized|unknown|unsupported|unexpected|extra (?:fields|inputs)|not (?:supported|allowed|permitted)|invalid/i

function unknownParameter(message: string, body: Record<string, unknown>): string | undefined {
  if (!REJECTS_PARAMETER.test(message)) return undefined
  return OPTIONAL_PARAMETERS.find((name) => name in body && new RegExp(`(?:^|[^A-Za-z_])${name}(?:$|[^A-Za-z_])`).test(message))
}

const MAX_TOKENS_UNSUPPORTED = /max_tokens[^.]{0,80}(?:not supported|unsupported|use 'max_completion_tokens')|use max_completion_tokens/i
const MAX_TOKENS_TOO_LARGE = /max_(?:completion_)?tokens[\s\S]{0,160}?(?:at most|maximum(?: value)?(?: is| of)?|less than or equal to|<=|up to|limit(?: is)?)\s*([\d,]+)/i

/** Mistral accepts only nine alphanumeric characters as a tool-call id. The mapping is stable, so calls and results still pair. */
function mistralId(id: string): string {
  const digest = createHash('sha256').update(id).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let index = 0; index < 9; index++) out += alphabet[digest[index] % alphabet.length]
  return out
}

function idMapper(target: TransportTarget): (id: string) => string {
  return target.family === 'mistral' ? mistralId : (id) => id
}

function effortFor(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort
}

function dataUrl(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`
}

function argumentsOf(block: ToolUseBlock): string {
  if (!block.invalid) return JSON.stringify(block.input)
  try {
    JSON.parse(block.invalid.raw)
    return block.invalid.raw
  } catch {
    // Some servers validate the history's arguments; the error result tells the model what went wrong.
    return '{}'
  }
}

function assistantMessage(message: AssistantMessage, mapId: (id: string) => string): ChatMessage | undefined {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
  const calls = message.content
    .filter((block): block is ToolUseBlock => block.type === 'tool-use')
    .map((block) => ({ id: mapId(block.id), type: 'function' as const, function: { name: block.name, arguments: argumentsOf(block) } }))
  if (!text && !calls.length) return undefined
  return calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text }
}

/** Tool results become tool messages, first; the rest of the turn (text, images) follows as one user message. */
function userMessages(message: UserMessage, target: TransportTarget, mapId: (id: string) => string): ChatMessage[] {
  const out: ChatMessage[] = []
  const parts: ChatPart[] = []
  const image = (block: ImageBlock): ChatPart =>
    target.capabilities.images ? { type: 'image_url', image_url: { url: dataUrl(block) } } : { type: 'text', text: '[An image was attached here; this model cannot read images.]' }
  for (const block of message.content) {
    if (block.type !== 'tool-result') continue
    const text = block.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const images = block.content.filter((part): part is ImageBlock => part.type === 'image')
    out.push({ role: 'tool', tool_call_id: mapId(block.toolUseId), content: text || (images.length ? '(The result is the image below.)' : '(no output)') })
    // Tool messages carry text only, so a result's images travel in the user message after them.
    for (const part of images) parts.push(image(part))
  }
  for (const block of message.content) {
    if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') parts.push(image(block))
  }
  if (parts.length) {
    const onlyText = parts.every((part) => part.type === 'text')
    out.push({ role: 'user', content: onlyText ? parts.map((part) => (part as { text: string }).text).join('\n\n') : parts })
  }
  return out
}

/**
 * Marks prompt-cache breakpoints for providers that take them through this
 * dialect (OpenRouter in front of Anthropic or Gemini): the system parts that
 * ask for one, then the last two conversational messages, four at most.
 */
function addCacheBreakpoints(messages: ChatMessage[], systemParts: ChatPart[] | undefined, request: ModelRequest): void {
  let budget = 4
  if (systemParts) {
    const marked = request.system.map((part, index) => (part.cache ? index : -1)).filter((index) => index >= 0)
    for (const index of marked.slice(-2)) {
      const part = systemParts[index]
      if (part?.type === 'text') {
        part.cache_control = { type: 'ephemeral' }
        budget--
      }
    }
  }
  let marked = 0
  for (let index = messages.length - 1; index >= 0 && marked < Math.min(2, budget); index--) {
    const message = messages[index]
    if (message.role !== 'user' && message.role !== 'tool') continue
    if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
    const last = message.content[message.content.length - 1]
    if (last?.type !== 'text') continue
    last.cache_control = { type: 'ephemeral' }
    marked++
  }
}

export function buildChatBody(target: TransportTarget, request: ModelRequest, openRouter: boolean): Record<string, unknown> {
  const mapId = idMapper(target)
  const caching = openRouter && target.capabilities.promptCache
  const messages: ChatMessage[] = []
  const system = request.system.filter((part) => part.text)
  let systemParts: ChatPart[] | undefined
  if (system.length) {
    if (caching) {
      systemParts = request.system.map((part) => ({ type: 'text', text: part.text }))
      messages.push({ role: 'system', content: systemParts })
    } else {
      messages.push({ role: 'system', content: system.map((part) => part.text).join('\n\n') })
    }
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const converted = assistantMessage(message, mapId)
      if (converted) messages.push(converted)
    } else {
      messages.push(...userMessages(message, target, mapId))
    }
  }
  if (caching) addCacheBreakpoints(messages, systemParts, request)

  const body: Record<string, unknown> = { model: target.model, messages, stream: true, stream_options: { include_usage: true } }
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
    body.tool_choice = request.toolChoice ?? 'auto'
  }
  if (request.maxOutputTokens) {
    const limit = Math.max(1, Math.min(request.maxOutputTokens, target.maxOutputTokens))
    // OpenAI's reasoning models take only max_completion_tokens; everyone else knows max_tokens.
    if (target.family === 'openai' && !openRouter && /(?:^|\.)openai\.com$/.test(hostOf(target.baseUrl))) body.max_completion_tokens = limit
    else body.max_tokens = limit
  }
  if (request.temperature !== undefined && !target.capabilities.reasoning) body.temperature = request.temperature
  if (request.reasoning && target.capabilities.reasoning) {
    if (openRouter) body.reasoning = { effort: effortFor(request.reasoning) }
    else if (target.family === 'openai') body.reasoning_effort = effortFor(request.reasoning)
  }
  if (openRouter) {
    const fallbacks = (target.serverFallbacks ?? []).filter((model) => model && model !== target.model)
    if (fallbacks.length) body.models = [target.model, ...new Set(fallbacks)]
    if (target.dataCollection === 'deny') body.provider = { data_collection: 'deny' }
    body.usage = { include: true }
  }
  return body
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function chatEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new TransportError('invalid-request', 'This provider has no base URL. Set one in Settings.')
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function chatUsage(raw: unknown): Partial<Usage> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, any>
  const input = num(usage.prompt_tokens)
  const output = num(usage.completion_tokens)
  if (input === undefined && output === undefined) return undefined
  const result: Partial<Usage> = {}
  if (input !== undefined) result.inputTokens = input
  if (output !== undefined) result.outputTokens = output
  const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? num(usage.prompt_cache_hit_tokens) ?? num(usage.cached_tokens)
  if (cached !== undefined) result.cacheReadTokens = cached
  const written = num(usage.prompt_tokens_details?.cache_write_tokens) ?? num(usage.cache_creation_input_tokens)
  if (written !== undefined) result.cacheWriteTokens = written
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens)
  if (reasoning !== undefined) result.reasoningTokens = reasoning
  const cost = num(usage.cost)
  if (cost !== undefined) result.cost = cost
  return result
}

export function chatFinish(reason: string): FinishReason {
  switch (reason.toLowerCase()) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_use'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'content_filter':
    case 'safety':
    case 'refusal':
      return 'content_filter'
    default:
      return 'other'
  }
}

/** Text in a content field: a string, or an array of parts some servers send. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (typeof part === 'string') text += part
    else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') text += (part as { text: string }).text
  }
  return text
}

/** JSON text of tool arguments; some servers send an object instead of a string. */
function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

function streamErrorOf(error: unknown): TransportError {
  const record = (error && typeof error === 'object' ? error : { message: String(error) }) as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : JSON.stringify(error)
  const metadata = record.metadata as Record<string, unknown> | undefined
  const raw = typeof metadata?.raw === 'string' && !message.includes(metadata.raw) ? ` (${metadata.raw})` : ''
  // A string code (the gateway's) names the error more precisely than its type; a numeric one is an HTTP status.
  const code = typeof record.code === 'number' ? record.code : typeof record.status === 'number' ? record.status : undefined
  const type = typeof record.code === 'string' ? record.code : typeof record.type === 'string' ? record.type : undefined
  const retryAfterSeconds = typeof record.retry_after === 'number' ? record.retry_after : undefined
  return classifyStreamError(type, message + raw, code, { retryAfterSeconds })
}

/** Assigns stable slots to streamed tool calls, whether the server sends an index, an id, or neither. */
function toolSlots() {
  const byId = new Map<string, number>()
  const byIndex = new Map<number, number>()
  let next = 0
  let last: number | undefined
  return (entry: Record<string, unknown>): number => {
    const id = typeof entry.id === 'string' && entry.id ? entry.id : undefined
    const index = typeof entry.index === 'number' ? entry.index : undefined
    let slot: number | undefined
    if (id) {
      slot = byId.get(id)
      if (slot === undefined) {
        slot = next++
        byId.set(id, slot)
      }
      if (index !== undefined) byIndex.set(index, slot)
    } else if (index !== undefined) {
      slot = byIndex.get(index)
      if (slot === undefined) {
        slot = next++
        byIndex.set(index, slot)
      }
    } else {
      slot = last ?? next++
    }
    last = slot
    return slot
  }
}

/** Events for one choice delta (streamed) or message (whole). */
function* choiceEvents(source: Record<string, unknown>, slotOf: (entry: Record<string, unknown>) => number): Generator<TransportEvent> {
  const reasoning = source.reasoning_content ?? source.reasoning
  if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', text: reasoning }
  const text = contentText(source.content)
  if (text) yield { type: 'text', text }
  const calls = source.tool_calls
  if (Array.isArray(calls)) {
    for (const entry of calls as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== 'object') continue
      const fn = (entry.function ?? {}) as { name?: unknown; arguments?: unknown }
      yield {
        type: 'tool-call',
        index: slotOf(entry),
        ...(typeof entry.id === 'string' && entry.id ? { id: entry.id } : {}),
        ...(typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
        arguments: argumentsText(fn.arguments),
      }
    }
  }
}

/** Events for a reply that arrived as one JSON body. */
function* wholeReplyEvents(json: unknown): Generator<TransportEvent> {
  const payload = (json ?? {}) as Record<string, unknown>
  if (payload.error) throw streamErrorOf(payload.error)
  const choices = payload.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  if (!choice) throw new TransportError('protocol', 'The provider returned no choices.')
  if (typeof payload.model === 'string' && payload.model) yield { type: 'model', model: payload.model }
  yield* choiceEvents((choice.message ?? {}) as Record<string, unknown>, toolSlots())
  const usage = chatUsage(payload.usage)
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: typeof choice.finish_reason === 'string' ? chatFinish(choice.finish_reason) : 'stop' }
}

async function* streamedReplyEvents(response: Response, signal: AbortSignal, where: string): AsyncGenerator<TransportEvent> {
  if (!response.body) throw new TransportError('protocol', `${where} returned an empty stream.`)
  const slotOf = toolSlots()
  let model: string | undefined
  let finished = false
  let done = false
  for await (const item of guardStream(readSse(response.body, signal), signal, where)) {
    if (item.kind === 'comment') {
      yield { type: 'keepalive' }
      continue
    }
    const data = item.data.trim()
    if (data === '[DONE]') {
      done = true
      break
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue // Some servers interleave non-JSON keepalive data; it carries nothing.
    }
    if (chunk.error) throw streamErrorOf(chunk.error)
    if (typeof chunk.model === 'string' && chunk.model && chunk.model !== model) {
      model = chunk.model
      yield { type: 'model', model }
    }
    const usage = chatUsage(chunk.usage)
    if (usage) yield { type: 'usage', usage }
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
    if (!choice) continue
    if (choice.error) throw streamErrorOf(choice.error)
    yield* choiceEvents((choice.delta ?? choice.message ?? {}) as Record<string, unknown>, slotOf)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      if (choice.finish_reason === 'error') throw new TransportError('server', `${where} ended the reply with an error.`)
      finished = true
      yield { type: 'finish', reason: chatFinish(choice.finish_reason) }
    }
  }
  if (!finished && !done) throw new TransportError('protocol', `The stream from ${where} ended before the reply was complete.`)
}

/** Adjusts the body for a server that rejected it, or returns false when nothing would help. */
function negotiate(body: Record<string, unknown>, error: TransportError): boolean {
  if (error.kind === 'unsupported' && error.feature === 'stream' && body.stream) {
    body.stream = false
    delete body.stream_options
    return true
  }
  if (error.kind !== 'invalid-request' && error.kind !== 'unsupported') return false
  const message = error.message
  if (body.max_tokens !== undefined && MAX_TOKENS_UNSUPPORTED.test(message)) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
    return true
  }
  const tooLarge = MAX_TOKENS_TOO_LARGE.exec(message)
  if (tooLarge) {
    const limit = Number(tooLarge[1].replace(/,/g, ''))
    const key = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'
    const current = body[key]
    if (limit > 0 && typeof current === 'number' && limit < current) {
      body[key] = limit
      return true
    }
  }
  const name = unknownParameter(message, body)
  if (name) {
    delete body[name]
    return true
  }
  // An endpoint that refuses streaming with a plain 4xx and no reason gets one try without it.
  if (body.stream && (error.status === 404 || error.status === 405 || error.status === 415)) {
    body.stream = false
    delete body.stream_options
    return true
  }
  return false
}

function createChatAdapter(type: 'openai-compatible' | 'openrouter', options: OpenAICompatibleOptions): ProviderAdapter {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const openRouter = type === 'openrouter'

  async function* stream({ target, request, signal }: StreamInput): AsyncGenerator<TransportEvent> {
    if (signal.aborted) throw signal.reason
    const url = chatEndpoint(target.baseUrl)
    const where = describeEndpoint(url)
    const headers: Record<string, string> = { accept: 'text/event-stream, application/json' }
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`
    if (openRouter) {
      headers['HTTP-Referer'] = options.appUrl ?? 'https://encode.local'
      headers['X-Title'] = options.appTitle ?? 'eNCode IDE'
    }
    const body = buildChatBody(target, request, openRouter)
    let response: Response | undefined
    for (let tries = 0; !response; tries++) {
      try {
        response = await postJson(fetchImpl, url, headers, body, signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (!isTransportError(error) || tries >= 3 || !negotiate(body, error)) throw error
      }
    }
    if (!body.stream || isJsonResponse(response)) {
      // Asked not to stream, or the server ignored stream: true and sent one JSON body.
      yield* wholeReplyEvents(await readJson(response, signal, where))
      return
    }
    yield* streamedReplyEvents(response, signal, where)
  }

  return { type, stream }
}

export function createOpenAICompatibleAdapter(options: OpenAICompatibleOptions = {}): ProviderAdapter {
  return createChatAdapter('openai-compatible', options)
}

export function createOpenRouterAdapter(options: OpenAICompatibleOptions = {}): ProviderAdapter {
  return createChatAdapter('openrouter', options)
}
