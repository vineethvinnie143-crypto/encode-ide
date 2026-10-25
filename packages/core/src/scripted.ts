/**
 * A ModelClient that plays a script instead of calling a model: the offline
 * demo agent, and the model in tests. It streams text the way a provider
 * does, so the UI behaves as it would with a real one.
 */
import type {
  AssistantBlock,
  CacheTerms,
  CompletionOutcome,
  CompletionRequest,
  FinishReason,
  ModelBudget,
  ModelClient,
  ModelRole,
} from '@encode/providers'
import { familyOf } from '@encode/providers'
import { estimateTokens } from './compaction'

export interface ScriptedCall {
  name: string
  input: Record<string, unknown>
  /** Default: call_<step>_<index>. */
  id?: string
  /** The call arrives unusable, as if its arguments were not valid JSON. */
  invalid?: { raw: string; error: string }
}

export interface ScriptedStep {
  /** Streamed as thinking before the text, in pieces. */
  thinking?: string
  text?: string
  calls?: ScriptedCall[]
  finish?: FinishReason
  /** Answers with this outcome instead of a message (a compact request, a pause). */
  outcome?: Exclude<CompletionOutcome, { kind: 'done' }>
}

export interface ScriptedOptions {
  /** The model the client says it would call. Default: scripted. */
  model?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Whether the model reads images. Absent: the client cannot tell. */
  images?: boolean
  /** Whether it reads PDFs as documents. */
  documents?: boolean
  /** Pause between streamed chunks, ms. */
  delayMs?: number
  /** What each call says it cost, in US dollars, as OpenRouter does. */
  costPerCall?: number
  /** What the model's prompt cache charges (ADR 0130). Absent: the client cannot tell. */
  cache?: CacheTerms
}

export type Script = readonly ScriptedStep[] | ((request: CompletionRequest, step: number) => ScriptedStep)

export interface ScriptedClient extends ModelClient {
  /** Every request received, in order. */
  readonly requests: CompletionRequest[]
}

function chunks(text: string): string[] {
  const parts = text.match(/\S+\s*/g) ?? [text]
  const out: string[] = []
  for (let i = 0; i < parts.length; i += 3) out.push(parts.slice(i, i + 3).join(''))
  return out
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `script` is a list (the last step repeats) or a function of the request
 * and the step number.
 */
export function createScriptedClient(script: Script, options: ScriptedOptions = {}): ScriptedClient {
  const requests: CompletionRequest[] = []
  let step = 0
  return {
    requests,
    async budget(_role: ModelRole): Promise<ModelBudget> {
      return {
        model: options.model ?? 'scripted',
        contextWindow: options.contextWindow ?? 200_000,
        maxOutputTokens: options.maxOutputTokens ?? 8_192,
        ...(options.images !== undefined ? { images: options.images } : {}),
        ...(options.documents !== undefined ? { documents: options.documents } : {}),
        ...(options.cache ? { cache: options.cache } : {}),
      }
    },
    async complete(request): Promise<CompletionOutcome> {
      requests.push(request)
      if (request.signal.aborted) throw request.signal.reason
      const index = step++
      const current = typeof script === 'function' ? script(request, index) : script[Math.min(index, script.length - 1)]
      if (current.outcome) return current.outcome

      if (current.thinking) {
        for (const chunk of chunks(current.thinking)) {
          request.onEvent?.({ type: 'thinking', text: chunk })
          if (options.delayMs) await pause(options.delayMs, request.signal)
        }
      }
      if (current.text) {
        for (const chunk of chunks(current.text)) {
          request.onEvent?.({ type: 'text', text: chunk })
          if (options.delayMs) await pause(options.delayMs, request.signal)
        }
      }
      const content: AssistantBlock[] = []
      // Kept as an assembler keeps it, so what becomes of thinking in the conversation can be tested.
      if (current.thinking) content.push({ type: 'thinking', text: current.thinking })
      if (current.text) content.push({ type: 'text', text: current.text })
      for (const [i, call] of (current.calls ?? []).entries()) {
        content.push({
          type: 'tool-use',
          id: call.id ?? `call_${index}_${i}`,
          name: call.name,
          input: call.invalid ? {} : call.input,
          ...(call.invalid ? { invalid: call.invalid } : {}),
        })
      }
      const message = { role: 'assistant' as const, content, origin: { provider: 'scripted', model: options.model ?? 'scripted', family: familyOf(options.model ?? 'scripted') } }
      const inputTokens = estimateTokens(request.payload.messages) + Math.ceil(JSON.stringify(request.payload.tools).length / 3.5)
      return {
        kind: 'done',
        message,
        usage: { inputTokens, outputTokens: estimateTokens([message]), cacheReadTokens: 0, cacheWriteTokens: 0, ...(options.costPerCall !== undefined ? { cost: options.costPerCall } : {}) },
        finish: current.finish ?? (current.calls?.length ? 'tool_use' : 'stop'),
      }
    },
  }
}
