/**
 * A model's reasoning, read from the chat-completions dialect and sent back the way its family expects (ADR 0099).
 *
 * Reasoning models write their reasoning beside the reply (`reasoning_content`, `reasoning`, OpenRouter's
 * `reasoning_details`), or in the reply between <think> tags. Several will not go on with a tool-call loop unless
 * they get it back:
 *   - DeepSeek in thinking mode answers 400 when an earlier assistant message of a request with tools lacks its
 *     `reasoning_content`, every turn, not only the current one;
 *   - Kimi and GLM want theirs back in the tool-call loop, and across turns when the provider preserves thinking;
 *   - MiniMax's M2 reads its <think> block back from the content, as it wrote it;
 *   - Gemini checks the thought signature on the first call of every step of the current turn, which its OpenAI
 *     endpoint puts in the call's `extra_content`, and through OpenRouter in `reasoning_details`;
 *   - Claude through OpenRouter needs its signed thinking with the tool results that follow it.
 * Only the model that wrote reasoning is sent it; another model's is never shown to it.
 */
import type { TransportEvent, TransportTarget } from './contract'
import type { AssistantMessage, Message, MessageOrigin, ThinkingBlock, ToolUseBlock } from './messages'

const OPEN = '<think>'
const CLOSE = '</think>'

/** The longest end of `text` that could be the start of `tag`, to hold back until the next piece says. */
function partialTail(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

export interface ThinkSplitter {
  /** Passes an event through: text is split at the <think> block; any other event first lets out what was held. */
  through(event: TransportEvent): TransportEvent[]
  /** What is still held, at the end of the reply. */
  flush(): TransportEvent[]
}

/**
 * Takes a <think> block at the very start of a reply's text out as thinking. Tags can be cut across pieces, so a
 * piece that could be the start of one is held until the next. Text that does not start with the tag is the reply.
 */
export function createThinkSplitter(): ThinkSplitter {
  let state: 'start' | 'thinking' | 'after' | 'text' = 'start'
  let held = ''

  const split = (text: string): TransportEvent[] => {
    const out: TransportEvent[] = []
    let rest = held + text
    held = ''
    for (;;) {
      if (state === 'text') {
        if (rest) out.push({ type: 'text', text: rest })
        return out
      }
      if (state === 'start') {
        const trimmed = rest.trimStart()
        if (trimmed.startsWith(OPEN)) {
          state = 'thinking'
          rest = trimmed.slice(OPEN.length)
          continue
        }
        if (!trimmed || OPEN.startsWith(trimmed)) {
          held = rest
          return out
        }
        state = 'text'
        continue
      }
      if (state === 'thinking') {
        const at = rest.indexOf(CLOSE)
        if (at >= 0) {
          if (at > 0) out.push({ type: 'thinking', text: rest.slice(0, at) })
          rest = rest.slice(at + CLOSE.length)
          state = 'after'
          continue
        }
        const keep = partialTail(rest, CLOSE)
        if (rest.length > keep) out.push({ type: 'thinking', text: rest.slice(0, rest.length - keep) })
        held = rest.slice(rest.length - keep)
        return out
      }
      // After the block: the blank lines before the reply are not part of it.
      rest = rest.replace(/^\s+/, '')
      if (!rest) return out
      state = 'text'
    }
  }

  const flush = (): TransportEvent[] => {
    const text = held
    held = ''
    if (!text) return []
    if (state === 'thinking') return [{ type: 'thinking', text }]
    if (state === 'after') return []
    // A reply that was only ever the start of a tag, or blank, is what it is.
    state = 'text'
    return text.trim() ? [{ type: 'text', text }] : []
  }

  return {
    through: (event) => (event.type === 'text' ? split(event.text) : [...flush(), event]),
    flush,
  }
}

/** The readable text of a reasoning detail, for reasoning that came only as details. */
export function detailText(detail: Record<string, unknown>): string {
  if (detail.type === 'reasoning.text' && typeof detail.text === 'string') return detail.text
  if (detail.type === 'reasoning.summary' && typeof detail.summary === 'string') return detail.summary
  return ''
}

/** What DeepSeek is sent for an assistant message whose reasoning it never saw: it refuses a message without one. */
export const NO_REASONING = '(This step was taken without reasoning that can be shown.)'
/** Gemini's own value for a call it did not sign (another model's, or one whose signature was dropped). */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** A model id as it is matched: lowercased, without OpenRouter's variant (`:free`) or Google's `models/`. */
function bare(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, '').split(':')[0]
}

/** Whether the message was written by the target's model, on the target's provider. */
export function sameModel(origin: MessageOrigin | undefined, target: Pick<TransportTarget, 'provider' | 'model'>): boolean {
  return !!origin && origin.provider === target.provider && bare(origin.model) === bare(target.model)
}

/** Where the current request begins: after the last message the person (or eNCode) wrote that is not tool results. */
export function requestStart(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !message.content.some((block) => block.type === 'tool-result')) return index
  }
  return 0
}

/** Families whose reasoning goes back on every turn, not only in the tool-call loop of the current request. */
const EVERY_TURN = new Set(['deepseek', 'moonshot', 'zhipu', 'minimax'])

/** What goes back with one assistant message. */
export interface Replay {
  /** `reasoning_content` on the message (DeepSeek, Kimi, GLM). */
  reasoningContent?: string
  /** OpenRouter's `reasoning_details`, unchanged. */
  reasoningDetails?: Record<string, unknown>[]
  /** OpenRouter's plain `reasoning`, when there are no details. */
  reasoning?: string
  /** A <think> block before the content (MiniMax). */
  think?: string
  /** The calls' `extra_content`, as the model sent them. */
  extras: boolean
  /** Gemini's skip value on the first call when that call has no signature. */
  skipSignature: boolean
}

/**
 * What goes back with `message` to `target`. `current`: the message is part of the request being worked on.
 * Through OpenRouter, the reasoning goes back as OpenRouter took it; to a provider directly, in its family's field.
 */
export function replayFor(target: TransportTarget, openRouter: boolean, message: AssistantMessage, current: boolean): Replay {
  const own = sameModel(message.origin, target)
  const thinking = own ? message.content.filter((block): block is ThinkingBlock => block.type === 'thinking') : []
  const text = thinking.map((block) => block.text).join('')
  const details = thinking.flatMap((block) => block.details ?? [])
  const replay: Replay = { extras: own, skipSignature: false }
  const family = target.family
  if (!current && !EVERY_TURN.has(family)) return replay
  if (openRouter) {
    if (details.length) replay.reasoningDetails = details
    else if (text) replay.reasoning = text
    else if (family === 'deepseek') replay.reasoning = NO_REASONING
    return replay
  }
  switch (family) {
    case 'deepseek':
      replay.reasoningContent = text || NO_REASONING
      break
    case 'moonshot':
    case 'zhipu':
      if (text) replay.reasoningContent = text
      break
    case 'minimax':
      if (text) replay.think = text
      break
    case 'google':
      replay.skipSignature = current && /gemini/i.test(target.model)
      break
  }
  return replay
}

/** Whether Gemini can read a signature on this call. */
export function signed(call: ToolUseBlock | undefined, own: boolean): boolean {
  const google = own && call?.extra?.google
  return !!google && typeof google === 'object' && typeof (google as Record<string, unknown>).thought_signature === 'string'
}
