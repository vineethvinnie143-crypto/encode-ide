/**
 * Messages sent while the agent is working wait in a queue and go out one by one
 * when it finishes. Plain functions, so the rules are unit tested.
 */

import type { ComposerAttachment } from './attachments'

export interface Queued {
  id: string
  text: string
  /** Pictures and files that go with it (ADR 0113): a queued message keeps them until it is sent. */
  attachments?: ComposerAttachment[]
}

/** Adds a message at the end. Blank text is not queued. */
export function enqueue(queue: readonly Queued[], text: string, id: string, attachments: readonly ComposerAttachment[] = []): Queued[] {
  const trimmed = text.trim()
  return trimmed ? [...queue, { id, text: trimmed, ...(attachments.length ? { attachments: [...attachments] } : {}) }] : [...queue]
}

/** The message to send next, and what stays queued. */
export function dequeue(queue: readonly Queued[]): { next: Queued | undefined; rest: Queued[] } {
  return { next: queue[0], rest: queue.slice(1) }
}

export function removeQueued(queue: readonly Queued[], id: string): Queued[] {
  return queue.filter((item) => item.id !== id)
}

/** Takes a message out so it can be edited, keeping the rest in order. */
export function takeQueued(queue: readonly Queued[], id: string): { taken: Queued | undefined; rest: Queued[] } {
  return { taken: queue.find((item) => item.id === id), rest: removeQueued(queue, id) }
}

/** Puts a message back into the composer: after what is already typed, on its own line. */
export function mergeDraft(draft: string, queued: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, '')}\n${queued}` : queued
}

/** Moves a message one place earlier or later. */
export function moveQueued(queue: readonly Queued[], id: string, direction: -1 | 1): Queued[] {
  const index = queue.findIndex((item) => item.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= queue.length) return [...queue]
  const next = [...queue]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
