/**
 * PDF pages Read attaches for the model to see (document blocks). Like screenshots they are worth sending and not
 * worth storing: a page or ten of PDF is megabytes of base64. The stored log keeps each one's text, which says
 * which pages it held, and Read attaches them again when they are needed.
 */
import { textBlock, type Message } from '@encode/providers'

const hasDocument = (message: Message): boolean =>
  message.role === 'user' && message.content.some((block) => block.type === 'tool-result' && block.content.some((part) => part.type === 'document'))

/** The message with each document replaced by its text; the message itself when it has none. */
export function withoutDocuments(message: Message): Message {
  if (message.role !== 'user' || !hasDocument(message)) return message
  return {
    role: 'user',
    content: message.content.map((block) =>
      block.type === 'tool-result' && block.content.some((part) => part.type === 'document')
        ? { ...block, content: block.content.map((part) => (part.type === 'document' ? textBlock(part.text) : part)) }
        : block,
    ),
  }
}
