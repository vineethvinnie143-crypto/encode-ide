import type { ModelProfile } from '../../shared/types'
import type { ChatMessage, ToolSchema } from './types'

export class AgentAbortedError extends Error {
  constructor() {
    super('Agent request aborted')
    this.name = 'AgentAbortedError'
  }
}

export class ProviderError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
}

export interface ChatResult {
  content: string
  toolCalls: { id: string; name: string; arguments: string }[]
  finishReason?: string
  usage?: ChatUsage
}

function readUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, any>
  const promptTokens = Number(usage.prompt_tokens ?? 0)
  const completionTokens = Number(usage.completion_tokens ?? 0)
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens)
  const cachedTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0,
  )
  if (!promptTokens && !completionTokens && !totalTokens) return undefined
  return { promptTokens, completionTokens, totalTokens, cachedTokens }
}

export interface ChatOptions {
  profile: ModelProfile
  apiKey: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  signal: AbortSignal
  onDelta?: (text: string) => void
  temperature?: number
  maxTokens?: number
}

function snippet(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function deltaText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function linkAbort(outer: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  outer.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      outer.removeEventListener('abort', onAbort)
    },
    timedOut: () => timedOut,
  }
}

function parseJsonResponse(json: unknown): ChatResult {
  const payload = json as {
    error?: { message?: string } | string
    choices?: Array<{
      message?: {
        content?: unknown
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
      finish_reason?: string
    }>
  }

  if (payload.error) {
    const message = typeof payload.error === 'string' ? payload.error : payload.error.message ?? 'Unknown provider error'
    throw new ProviderError(message)
  }

  const choice = payload.choices?.[0]
  if (!choice) throw new ProviderError('The provider returned no choices.')
  const message = choice.message ?? {}
  const toolCalls = (message.tool_calls ?? [])
    .map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    }))
    .filter((call) => Boolean(call.name))

  return {
    content: deltaText(message.content),
    toolCalls,
    finishReason: choice.finish_reason,
    usage: readUsage((payload as { usage?: unknown }).usage),
  }
}

async function requestChat(options: ChatOptions & { stream: boolean }): Promise<ChatResult> {
  const base = options.profile.baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new ProviderError('This model profile has no base URL. Open Settings and set one.')
  const endpoint = `${base}/chat/completions`

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
  if (options.profile.kind === 'openrouter') {
    headers['HTTP-Referer'] = 'https://eNCode.local'
    headers['X-Title'] = 'eNCode IDE'
  }

  const body: Record<string, unknown> = {
    model: options.profile.model,
    messages: options.messages,
    stream: options.stream,
  }
  if (options.stream) body.stream_options = { include_usage: true }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens) body.max_tokens = options.maxTokens

  const linked = linkAbort(options.signal, 300_000)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: linked.signal,
    })
  } catch (error) {
    linked.dispose()
    if (options.signal.aborted) throw new AgentAbortedError()
    if (linked.timedOut()) throw new ProviderError('The model request timed out after 5 minutes.')
    throw new ProviderError(`Could not reach ${endpoint}. Check the base URL and your connection. (${(error as Error).message})`)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    linked.dispose()
    const message = `Model request failed with HTTP ${response.status}${text ? `: ${snippet(text)}` : ''}`
    if (options.signal.aborted) throw new AgentAbortedError()
    throw new ProviderError(message, response.status)
  }

  if (!options.stream) {
    linked.dispose()
    const json = await response.json().catch(() => null)
    if (!json) throw new ProviderError('The provider returned an invalid JSON response.')
    return parseJsonResponse(json)
  }

  try {
    return await readStream(response, options, linked)
  } finally {
    linked.dispose()
  }
}

async function readStream(
  response: Response,
  options: ChatOptions,
  linked: { timedOut: () => boolean },
): Promise<ChatResult> {
  if (!response.body) throw new ProviderError('The provider returned an empty streaming response.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason: string | undefined
  let usage: ChatUsage | undefined
  const accumulators = new Map<number, { id?: string; name?: string; args: string }>()

  const handleLine = (line: string) => {
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return

    let json: Record<string, unknown>
    try {
      json = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }

    if (json.error) {
      const err = json.error as { message?: string }
      throw new ProviderError(err.message ?? 'The provider reported an error mid-stream.')
    }

    const streamUsage = readUsage((json as { usage?: unknown }).usage)
    if (streamUsage) usage = streamUsage

    const choices = json.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) return
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

    const delta = (choice.delta ?? {}) as Record<string, unknown>
    const text = deltaText(delta.content)
    if (text) {
      content += text
      options.onDelta?.(text)
    }

    const deltaTools = delta.tool_calls
    if (Array.isArray(deltaTools)) {
      for (const entry of deltaTools as Array<Record<string, unknown>>) {
        const index = typeof entry.index === 'number' ? entry.index : 0
        const slot = accumulators.get(index) ?? { args: '' }
        if (typeof entry.id === 'string') slot.id = entry.id
        const fn = entry.function as { name?: string; arguments?: string } | undefined
        if (fn?.name) slot.name = fn.name
        if (typeof fn?.arguments === 'string') slot.args += fn.arguments
        accumulators.set(index, slot)
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        handleLine(line)
        newline = buffer.indexOf('\n')
      }
    }
  } catch (error) {
    if (options.signal.aborted) throw new AgentAbortedError()
    if (linked.timedOut()) throw new ProviderError('The model request timed out after 5 minutes.')
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }

  const toolCalls = [...accumulators.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, slot], position) => ({
      id: slot.id || `call_${index}_${position}`,
      name: slot.name ?? '',
      arguments: slot.args,
    }))
    .filter((call) => Boolean(call.name))

  return { content, toolCalls, finishReason, usage }
}

/**
 * Streams a chat completion. Falls back to a non-streaming request once when a
 * provider rejects streaming (some free/self-hosted endpoints do).
 */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  try {
    return await requestChat({ ...options, stream: true })
  } catch (error) {
    if (error instanceof AgentAbortedError) throw error
    const status = error instanceof ProviderError ? error.status : undefined
    const retryable = status === undefined || [400, 404, 405, 415, 422].includes(status)
    if (!retryable) throw error
    return await requestChat({ ...options, stream: false })
  }
}
