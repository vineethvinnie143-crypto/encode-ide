/**
 * Conversations the loop extends. A subagent's lives in memory; a session's is
 * stored in its log (see session.ts).
 */
import type { Message, SystemPart, ToolDefinition } from '@encode/providers'
import { pruneScreens } from './screens'
import type { Conversation } from './types'

export interface MemoryConversation extends Conversation {
  /** The system prompt and tools last noted, if any. */
  readonly noted: { system: SystemPart[]; tools: ToolDefinition[] } | undefined
}

/**
 * A conversation kept in memory. `messages()` returns a fresh array after
 * every change, so a caller holding one sees the conversation as it was. Only
 * the newest screenshot a tool returned is kept (screens.ts).
 */
export function memoryConversation(initial: readonly Message[] = []): MemoryConversation {
  let messages: Message[] = [...initial]
  let noted: MemoryConversation['noted']
  return {
    get noted() {
      return noted
    },
    messages: () => messages,
    async add(message) {
      messages = [...pruneScreens([...messages, message])]
    },
    async replace(next) {
      messages = [...next]
    },
    async context(system, tools) {
      const changed = noted !== undefined && JSON.stringify(noted) !== JSON.stringify({ system, tools })
      noted = { system, tools }
      return changed
    },
  }
}
