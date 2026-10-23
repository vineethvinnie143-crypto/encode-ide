/**
 * Problems in the chat as the app tells them: the words for the agent process stopping (the main process sees that,
 * not a session), what each action under a problem is called, and a stand-in entry for a problem no session could
 * record.
 */
import type { ConversationEntry, EntryProblem, ProblemAction } from './types'

export const HOST_STOPPED_MESSAGE = "eNCode's agent process stopped unexpectedly. The conversation is saved, so you can try again."

export const ACTION_LABELS: Record<ProblemAction, string> = {
  retry: 'Retry',
  'switch-model': 'Switch model',
  settings: 'Open Settings',
  diagnostics: 'Save diagnostics',
}

/** An entry for a problem only the app knows about: shown in the chat, never stored. */
export function localProblemEntry(text: string, problem: EntryProblem, now = Date.now()): ConversationEntry {
  return { id: `problem-${now}`, kind: 'error', text, problem, createdAt: now }
}
