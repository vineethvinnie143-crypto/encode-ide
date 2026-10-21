import type { GatewayErrorCode } from '@encode/gateway-protocol'
import { errorBody } from './errors'

/**
 * Server-sent events, the way OpenAI-compatible streams use them: one
 * `data: <json>` line per event, a blank line after each, `: comment` lines
 * for keepalives, and `data: [DONE]` at the end.
 */

const encoder = new TextEncoder()

export function sseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text.replace(/[\r\n]+/g, ' ')}\n\n`)
}

export function sseData(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
}

/** The in-band chunk that ends a stream the gateway could not finish. */
export function sseError(code: GatewayErrorCode, message: string, retryAfterMs?: number): Uint8Array {
  return sseData(errorBody(code, message, retryAfterMs))
}

/** Splits a byte stream into lines, across chunk boundaries and with either line ending. */
export class LineDecoder {
  private readonly decoder = new TextDecoder()
  private pending = ''

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true })
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }

  end(): string[] {
    const rest = this.pending + this.decoder.decode()
    this.pending = ''
    return rest ? [rest.endsWith('\r') ? rest.slice(0, -1) : rest] : []
  }
}

export type DataLine = { kind: 'json'; value: Record<string, unknown> } | { kind: 'done' } | { kind: 'other' }

/** Reads one SSE line: a JSON data event, the end marker, or anything else (comments, blank lines, junk). */
export function readDataLine(line: string): DataLine {
  if (!line.startsWith('data:')) return { kind: 'other' }
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') return { kind: 'done' }
  if (!payload.startsWith('{')) return { kind: 'other' }
  try {
    const value = JSON.parse(payload)
    return value && typeof value === 'object' && !Array.isArray(value) ? { kind: 'json', value } : { kind: 'other' }
  } catch {
    return { kind: 'other' }
  }
}

function firstChoice(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = event.choices
  return Array.isArray(choices) && choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined
}

/**
 * True once an event carries something the client will keep: text, reasoning
 * or a tool call, or a finish reason. Role-only and empty deltas, which
 * providers send before they know they can answer, do not count, so a
 * failure right after them can still fail over unseen.
 */
export function hasContent(event: Record<string, unknown>): boolean {
  const choice = firstChoice(event)
  if (!choice) return false
  if (typeof choice.finish_reason === 'string' && choice.finish_reason !== 'error') return true
  const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
  if (!delta || typeof delta !== 'object') return false
  const text = delta.content
  if (typeof text === 'string' && text.length > 0) return true
  if (Array.isArray(text) && text.length > 0) return true
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return true
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
}

export interface UpstreamError {
  code?: number | string
  message?: string
}

/** An upstream error carried in a stream event (`error`, or a choice that finished with `error`). */
export function eventError(event: Record<string, unknown>): UpstreamError | undefined {
  const error = event.error ?? firstChoice(event)?.error
  if (error && typeof error === 'object') {
    const { code, message } = error as Record<string, unknown>
    return {
      ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    }
  }
  if (firstChoice(event)?.finish_reason === 'error') return {}
  return undefined
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export function readUsage(event: Record<string, unknown>): Usage | undefined {
  const usage = event.usage
  if (!usage || typeof usage !== 'object') return undefined
  const { prompt_tokens: input, completion_tokens: output } = usage as Record<string, unknown>
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  return { inputTokens: Number(input) || 0, outputTokens: Number(output) || 0 }
}

export interface TailSummary {
  usage?: Usage
  finishReason?: string
  error?: UpstreamError
  /** True when any event in the tail carried content. */
  content: boolean
  /** True when the end marker was in the tail. */
  done: boolean
}

/**
 * The last bytes of a relayed stream. The relay passes upstream bytes through
 * untouched; only this tail is parsed, after the stream ends, for the usage
 * and finish reason OpenRouter sends in its final events. That keeps the
 * per-chunk work, which counts against the Worker's CPU time, to a copy.
 */
export class StreamTail {
  private chunks: Uint8Array[] = []
  private size = 0

  constructor(private readonly limit = 32 * 1024) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.size += chunk.byteLength
    while (this.chunks.length > 1 && this.size - this.chunks[0].byteLength >= this.limit) {
      this.size -= this.chunks[0].byteLength
      this.chunks.shift()
    }
  }

  summary(): TailSummary {
    const decoder = new LineDecoder()
    const lines = [...this.chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()]
    const out: TailSummary = { content: false, done: false }
    for (const line of lines) {
      const data = readDataLine(line)
      if (data.kind === 'done') out.done = true
      if (data.kind !== 'json') continue
      const usage = readUsage(data.value)
      if (usage) out.usage = usage
      const finish = firstChoice(data.value)?.finish_reason
      if (typeof finish === 'string') out.finishReason = finish
      const error = eventError(data.value)
      if (error) out.error = error
      if (hasContent(data.value)) out.content = true
    }
    return out
  }
}

interface ToolCallSlot {
  id?: string
  name: string
  arguments: string
}

/** Builds one chat.completion object from stream events, for clients that asked not to stream. */
export class CompletionAssembler {
  private id = ''
  private model = ''
  private created = 0
  private content = ''
  private reasoning = ''
  private readonly toolCalls = new Map<number, ToolCallSlot>()
  private finishReason: string | null = null
  private usage: Record<string, unknown> | undefined

  push(event: Record<string, unknown>): void {
    if (typeof event.id === 'string' && !this.id) this.id = event.id
    if (typeof event.model === 'string') this.model = event.model
    if (typeof event.created === 'number' && !this.created) this.created = event.created
    if (event.usage && typeof event.usage === 'object') this.usage = event.usage as Record<string, unknown>
    const choice = firstChoice(event)
    if (!choice) return
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason
    const delta = choice.delta as Record<string, unknown> | undefined
    if (!delta || typeof delta !== 'object') return
    if (typeof delta.content === 'string') this.content += delta.content
    if (typeof delta.reasoning === 'string') this.reasoning += delta.reasoning
    if (!Array.isArray(delta.tool_calls)) return
    for (const raw of delta.tool_calls) {
      if (!raw || typeof raw !== 'object') continue
      const call = raw as Record<string, unknown>
      const index = typeof call.index === 'number' ? call.index : this.toolCalls.size
      const slot = this.toolCalls.get(index) ?? { name: '', arguments: '' }
      if (typeof call.id === 'string') slot.id = call.id
      const fn = call.function as Record<string, unknown> | undefined
      if (fn && typeof fn.name === 'string') slot.name += fn.name
      if (fn && typeof fn.arguments === 'string') slot.arguments += fn.arguments
      this.toolCalls.set(index, slot)
    }
  }

  get servedBy(): string {
    return this.model
  }

  /** True once a finish reason arrived, so the answer is whole. */
  get finished(): boolean {
    return this.finishReason !== null
  }

  result(): Record<string, unknown> {
    const calls = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, slot]) => ({ id: slot.id ?? `call_${index}`, type: 'function', function: { name: slot.name, arguments: slot.arguments } }))
    return {
      id: this.id || 'chatcmpl-encode',
      object: 'chat.completion',
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.content || (calls.length ? null : ''),
            ...(calls.length ? { tool_calls: calls } : {}),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
          },
          finish_reason: this.finishReason ?? 'stop',
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    }
  }
}
