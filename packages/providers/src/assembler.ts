/**
 * Turns one attempt's TransportEvents into an assistant message. It is
 * incremental, so a client can watch an attempt while it streams (and drop
 * it mid-way), then finish it into blocks in stream order, with tool-call
 * arguments parsed, repaired or marked invalid.
 */
import type { FinishReason, ToolCallValidator, TransportEvent, Usage } from './contract'
import type { AssistantBlock, AssistantMessage, MessageOrigin, RedactedThinkingBlock, TextBlock, ThinkingBlock } from './messages'

/** A tool call while it streams: its arguments are still raw JSON text. */
export interface DraftToolCall {
  type: 'tool-call'
  index: number
  id?: string
  name?: string
  arguments: string
}

export type DraftBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | DraftToolCall

export interface AttemptSnapshot {
  blocks: readonly DraftBlock[]
  model: string
  usage: Partial<Usage>
  finish?: FinishReason
  /** Content events seen so far (text, thinking, tool calls); 0 means the first token has not arrived. */
  received: number
}

export interface AssembledReply {
  message: AssistantMessage
  usage: Usage
  finish: FinishReason
}

export interface AssemblerOptions {
  origin: MessageOrigin
  validateToolCall?: ToolCallValidator
  /** Best-effort repair of malformed tool JSON; returns undefined when it cannot. */
  repairJson?: (raw: string) => unknown
  /** Makes an id for a call the provider sent without one. */
  newId?: () => string
}

export interface Assembler {
  push(event: TransportEvent): void
  snapshot(): AttemptSnapshot
  finish(): AssembledReply
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

function randomId(): string {
  return `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses tool arguments: '' is {}, a JSON string holding an object is unwrapped once. */
function parseArguments(raw: string): { input?: Record<string, unknown>; error?: string } {
  const text = raw.trim()
  if (!text) return { input: {} }
  try {
    let value: unknown = JSON.parse(text)
    if (typeof value === 'string') value = JSON.parse(value)
    if (isPlainObject(value)) return { input: value }
    return { error: 'The arguments must be a JSON object.' }
  } catch (error) {
    return { error: `The arguments are not valid JSON (${(error as Error).message}).` }
  }
}

const TRUNCATED_CALL =
  'The reply reached the output limit while writing this call, so it was not run. Do the work in smaller steps (write a large file in parts, for example).'
const FILTERED_CALL = "The provider's safety system stopped this reply, so its tool calls were not run."

/**
 * A call cut off by the output limit can still parse (as a shorter object),
 * and a reply stopped by a safety filter may hold half a call: neither runs.
 */
function refuseUnsafeCalls(content: AssistantBlock[], finish: FinishReason): void {
  const refuse = (index: number, error: string) => {
    const block = content[index]
    if (block.type !== 'tool-use' || block.invalid) return
    content[index] = { type: 'tool-use', id: block.id, name: block.name, input: {}, invalid: { raw: JSON.stringify(block.input), error } }
  }
  if (finish === 'length' && content.length) refuse(content.length - 1, TRUNCATED_CALL)
  if (finish === 'content_filter') content.forEach((_, index) => refuse(index, FILTERED_CALL))
}

export function createAssembler(options: AssemblerOptions): Assembler {
  const blocks: DraftBlock[] = []
  const calls = new Map<number, DraftToolCall>()
  let model = options.origin.model
  let usage: Partial<Usage> = {}
  let finish: FinishReason | undefined
  let received = 0
  let finished = false

  const last = () => blocks[blocks.length - 1]

  const push = (event: TransportEvent) => {
    if (finished) throw new Error('This attempt was already finished.')
    switch (event.type) {
      case 'model':
        if (event.model) model = event.model
        return
      case 'text': {
        if (!event.text) return
        received++
        const tail = last()
        if (tail?.type === 'text') tail.text += event.text
        else blocks.push({ type: 'text', text: event.text })
        return
      }
      case 'thinking': {
        if (!event.text && !event.signature) return
        received++
        const tail = last()
        if (tail?.type === 'thinking' && tail.signature === undefined) {
          tail.text += event.text
          if (event.signature) tail.signature = event.signature
        } else {
          blocks.push(event.signature ? { type: 'thinking', text: event.text, signature: event.signature } : { type: 'thinking', text: event.text })
        }
        return
      }
      case 'redacted-thinking':
        received++
        blocks.push({ type: 'redacted-thinking', data: event.data })
        return
      case 'tool-call': {
        received++
        let call = calls.get(event.index)
        if (!call) {
          call = { type: 'tool-call', index: event.index, arguments: '' }
          calls.set(event.index, call)
          blocks.push(call)
        }
        if (event.id && !call.id) call.id = event.id
        if (event.name && !call.name) call.name = event.name
        call.arguments += event.arguments
        return
      }
      case 'usage':
        usage = { ...usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => value !== undefined)) }
        return
      case 'finish':
        finish = event.reason
        return
      case 'keepalive':
        return
    }
  }

  const snapshot = (): AttemptSnapshot => ({ blocks: blocks.map((block) => ({ ...block })), model, usage: { ...usage }, finish, received })

  const finishReply = (): AssembledReply => {
    finished = true
    const content: AssistantBlock[] = []
    const ids = new Set<string>()
    let hasCalls = false
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type !== 'tool-call') {
        content.push(block)
        continue
      }
      // A call without a name cannot be run or answered meaningfully: drop it.
      if (!block.name) continue
      hasCalls = true
      let id = block.id && SAFE_ID.test(block.id) ? block.id : (options.newId ?? randomId)()
      while (ids.has(id)) id = (options.newId ?? randomId)()
      ids.add(id)
      const parsed = parseArguments(block.arguments)
      let input = parsed.input
      let error = parsed.error
      if (!input && options.repairJson) {
        const repaired = options.repairJson(block.arguments)
        if (isPlainObject(repaired)) {
          input = repaired
          error = undefined
        }
      }
      if (input) error = options.validateToolCall?.(block.name, input)
      content.push(
        input && !error
          ? { type: 'tool-use', id, name: block.name, input }
          : { type: 'tool-use', id, name: block.name, input: {}, invalid: { raw: block.arguments, error: error ?? 'Invalid arguments.' } },
      )
    }
    let reason: FinishReason = finish ?? (hasCalls ? 'tool_use' : 'stop')
    // Some servers report 'stop' while returning tool calls; the calls are what matter.
    if (reason === 'stop' && hasCalls) reason = 'tool_use'
    if (reason === 'tool_use' && !hasCalls) reason = 'stop'
    refuseUnsafeCalls(content, reason)
    return {
      message: { role: 'assistant', content, origin: { ...options.origin, model } },
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
      },
      finish: reason,
    }
  }

  return { push, snapshot, finish: finishReply }
}
