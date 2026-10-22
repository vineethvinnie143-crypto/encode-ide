/**
 * What the Rewind dialog says and offers, as data and pure functions so the wording and the rules about which choices to
 * show are unit tested. The component in components/Chat/RewindDialog.tsx draws it.
 */
import type { RewindFile, RewindOutcome, RewindPlan, RewindRequest } from '@shared/types'

/** What a rewind puts back: the files and the conversation, the files only, or the conversation only. */
export type RewindChoice = 'both' | 'code' | 'conversation'

export const CHOICE_TEXT: Record<RewindChoice, { title: string; help: string }> = {
  both: { title: 'Code and conversation', help: 'Put the files back, and go back in the conversation to before this request.' },
  code: { title: 'Code only', help: 'Put the files back and keep the conversation as it is.' },
  conversation: { title: 'Conversation only', help: 'Go back in the conversation to before this request. The files stay as they are.' },
}

/** Said under the list, always: what a rewind cannot see. */
export const NOT_RECORDED_NOTE = 'Changes made by commands the agent ran (installs, builds, git) are not recorded, so they are not put back.'

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The files a rewind would change. */
export function changes(plan: RewindPlan | null): RewindFile[] {
  return plan ? plan.files.filter((file) => file.action === 'restore' || file.action === 'delete') : []
}

/** Changed files that are not what the agent last left: putting them back would overwrite someone else's work. */
export function conflicts(plan: RewindPlan | null): RewindFile[] {
  return changes(plan).filter((file) => file.conflict)
}

/** Files that cannot be put back, with the reason on each. */
export function leftAlone(plan: RewindPlan | null): RewindFile[] {
  return plan ? plan.files.filter((file) => file.action === 'skip') : []
}

/** The choices worth offering: with no file to put back, only the conversation can go back. */
export function choicesFor(plan: RewindPlan | null): RewindChoice[] {
  return changes(plan).length ? ['both', 'code', 'conversation'] : ['conversation']
}

export function defaultChoice(plan: RewindPlan | null): RewindChoice {
  return choicesFor(plan)[0]
}

/**
 * What to ask the host for. The conversation alone needs no plan, so it is `null`: that goes through the request that
 * only goes back in the conversation.
 */
export function requestFor(plan: RewindPlan, choice: RewindChoice, overwrite: boolean): RewindRequest | null {
  if (choice === 'conversation') return null
  return {
    kind: plan.kind,
    turn: plan.turn,
    fingerprint: plan.fingerprint,
    ...(overwrite ? { force: true } : {}),
    ...(choice === 'both' && plan.kind === 'rewind' ? { conversation: true } : {}),
  }
}

/** One line for a file in the list. */
export function actionLabel(file: RewindFile): string {
  switch (file.action) {
    case 'restore':
      return 'Put back'
    case 'delete':
      return 'Delete'
    case 'unchanged':
      return 'Already as it was'
    case 'skip':
      return file.reason ? `Left alone: ${file.reason}` : 'Left alone'
  }
}

/** The heading over the list. */
export function summaryOf(plan: RewindPlan | null): string {
  if (!plan) return ''
  if (!plan.known) return 'Nothing was recorded for this request.'
  const put = plan.files.filter((file) => file.action === 'restore').length
  const gone = plan.files.filter((file) => file.action === 'delete').length
  const redo = plan.kind === 'redo'
  const parts: string[] = []
  if (put) parts.push(`${redo ? 'bring back' : 'put back'} ${plural(put, 'file')}`)
  if (gone) parts.push(`delete ${plural(gone, 'file')}${redo ? '' : ' the agent created'}`)
  if (!parts.length) return plan.files.length ? 'Every file is already as it was.' : 'This request changed no files.'
  return `Will ${parts.join(' and ')}.`
}

export interface OutcomeNote {
  tone: 'success' | 'error' | 'info'
  text: string
}

/** What to tell the person once a rewind (or the undoing of one) is over. */
export function outcomeNote(outcome: RewindOutcome, kind: RewindPlan['kind']): OutcomeNote {
  if (!outcome.ok) return { tone: 'error', text: outcome.message }
  const done: string[] = []
  if (outcome.restored) done.push(`${kind === 'redo' ? 'Brought back' : 'Put back'} ${plural(outcome.restored, 'file')}`)
  if (outcome.deleted) done.push(`${done.length ? 'deleted' : 'Deleted'} ${plural(outcome.deleted, 'file')}`)
  const lead = done.length ? `${done.join(' and ')}.` : outcome.text !== undefined ? 'Went back in the conversation.' : 'No file needed to change.'
  const text = done.length && outcome.text !== undefined ? `${lead} Went back in the conversation.` : lead
  const rest: string[] = []
  if (outcome.skipped.length) {
    const first = outcome.skipped[0]
    const more = outcome.skipped.length > 1 ? `, and ${outcome.skipped.length - 1} more` : ''
    rest.push(`${plural(outcome.skipped.length, 'file')} left alone (${first.path}: ${first.reason}${more}).`)
  }
  if (outcome.failed.length) {
    const first = outcome.failed[0]
    const more = outcome.failed.length > 1 ? `, and ${outcome.failed.length - 1} more` : ''
    rest.push(`Could not change ${plural(outcome.failed.length, 'file')} (${first.path}: ${first.error}${more}).`)
  }
  return { tone: outcome.failed.length ? 'error' : 'success', text: [text, ...rest].join(' ') }
}

/** The first lines of the request being rewound to, for the dialog's heading. */
export function requestPreview(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
