/**
 * Screenshots. The Computer tool marks the images it returns `transient`: each shows the screen at one
 * moment and is stale after the next input, so only the newest is worth sending, and none is worth
 * keeping in a stored log (a session of a hundred inputs would hold a hundred megabytes of base64).
 * The text of every result already says what its screenshot showed.
 *
 *  - The log keeps each message without its screenshots (`withoutScreens`).
 *  - The conversation in memory keeps the newest `KEEP_SCREENS` and drops thinking from the first message
 *    it changed on, the way any rewrite does: thinking minted after a changed message no longer matches
 *    the prompt it was written under (see compaction.ts).
 *  - A model that cannot read images is sent none (`withoutScreensFrom`).
 */
import { textBlock, type Message, type ToolResultContent, type UserBlock } from '@encode/providers'
import { dropThinkingFrom } from './compaction'

/** Screenshots a conversation keeps. One: coordinates belong to the newest capture, and an older one can be taken again. */
export const KEEP_SCREENS = 1
export const SCREEN_REMOVED = '[screenshot removed to save context]'

const isScreen = (block: { type: string; transient?: true }): boolean => block.type === 'image' && block.transient === true

function countIn(message: Message): number {
  if (message.role !== 'user') return 0
  let count = 0
  for (const block of message.content) {
    if (block.type === 'tool-result') count += block.content.filter(isScreen).length
    else if (isScreen(block)) count++
  }
  return count
}

/** The message with the screenshots chosen by `drop` (called newest first) replaced by a note; the message itself when none is. */
function replaceScreens(message: Message, drop: () => boolean): Message {
  if (message.role !== 'user') return message
  // Newest first within the message too, so the later screenshot of two in one message is the one kept.
  const dropped = new Set<ToolResultContent | UserBlock>()
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i]
    if (block.type === 'tool-result') {
      for (let j = block.content.length - 1; j >= 0; j--) if (isScreen(block.content[j]) && drop()) dropped.add(block.content[j])
    } else if (isScreen(block) && drop()) dropped.add(block)
  }
  if (!dropped.size) return message
  const note = () => textBlock(SCREEN_REMOVED)
  const content = message.content.map((block): UserBlock => {
    if (dropped.has(block)) return note()
    if (block.type !== 'tool-result' || !block.content.some((part) => dropped.has(part))) return block
    return { ...block, content: block.content.map((part) => (dropped.has(part) ? note() : part)) }
  })
  return { role: 'user', content }
}

/** What the log stores: the message without its screenshots. The message itself when it has none. */
export function withoutScreens(message: Message): Message {
  return countIn(message) ? replaceScreens(message, () => true) : message
}

/** The messages without any screenshot; the same array when there was none. */
export function withoutScreensFrom(messages: readonly Message[]): readonly Message[] {
  if (!messages.some((message) => countIn(message))) return messages
  return messages.map(withoutScreens)
}

/**
 * The messages with only the newest `keep` screenshots left; the same array when there were no more than
 * that. The count and order of the messages do not change. Thinking is dropped from the first changed
 * message on.
 */
export function pruneScreens(messages: readonly Message[], keep = KEEP_SCREENS): readonly Message[] {
  let total = 0
  for (const message of messages) total += countIn(message)
  if (total <= keep) return messages

  let left = keep
  let first = -1
  const out = messages.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    if (!countIn(out[i])) continue
    const next = replaceScreens(out[i], () => (left > 0 ? (left--, false) : true))
    if (next !== out[i]) {
      out[i] = next
      first = i
    }
  }
  return first < 0 ? messages : dropThinkingFrom(out, first)
}
