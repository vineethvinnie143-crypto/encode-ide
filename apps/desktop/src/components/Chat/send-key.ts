/**
 * Which keys send a message from the message box, by the person's choice (Settings > General). Pure, for tests.
 */
import type { SendKey } from '@shared/types'

export interface EnterLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * What a key does in the message box: `send` (while the agent works, what the follow-up setting says), `other` (the
 * other follow-up), or null, which leaves it to the field: a new line, or not Enter at all.
 */
export function sendAction(event: EnterLike, sendKey: SendKey): 'send' | 'other' | null {
  if (event.key !== 'Enter' || event.altKey) return null
  const ctrl = event.ctrlKey || event.metaKey
  if (sendKey === 'enter') {
    if (event.shiftKey) return null
    return ctrl ? 'other' : 'send'
  }
  if (!ctrl) return null
  return event.shiftKey ? 'other' : 'send'
}

/** The keys as shown on buttons and in hints: the one that sends, and the one for the other follow-up. */
export function sendKeys(sendKey: SendKey): { send: string; other: string } {
  return sendKey === 'ctrl-enter' ? { send: 'Ctrl+Enter', other: 'Ctrl+Shift+Enter' } : { send: 'Enter', other: 'Ctrl+Enter' }
}
