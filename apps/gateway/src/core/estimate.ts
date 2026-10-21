import type { Content, UpstreamFields } from './firewall'

/**
 * A deliberately high estimate of prompt tokens, used before a request is
 * sent: to pick models whose window fits it and to hold the account's token
 * budget. The real count from the upstream replaces it afterwards.
 */

const CHARS_PER_TOKEN = 3.5
const PER_MESSAGE = 4
const PER_IMAGE = 1_500

function contentChars(content: Content | null): { chars: number; images: number } {
  if (content === null) return { chars: 0, images: 0 }
  if (typeof content === 'string') return { chars: content.length, images: 0 }
  let chars = 0
  let images = 0
  for (const part of content) {
    if (part.type === 'text') chars += part.text.length
    else images += 1
  }
  return { chars, images }
}

export function estimateInputTokens(fields: UpstreamFields): number {
  let chars = 0
  let images = 0
  for (const message of fields.messages) {
    const counted = contentChars(message.content)
    chars += counted.chars
    images += counted.images
    if (message.role === 'assistant') {
      chars += message.reasoning?.length ?? 0
      for (const call of message.tool_calls ?? []) chars += call.function.name.length + call.function.arguments.length + call.id.length
    }
  }
  if (fields.tools) chars += JSON.stringify(fields.tools).length
  if (fields.response_format) chars += JSON.stringify(fields.response_format).length
  return Math.ceil(chars / CHARS_PER_TOKEN) + fields.messages.length * PER_MESSAGE + images * PER_IMAGE
}
