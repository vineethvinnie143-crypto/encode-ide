import type { ToolReview } from '@shared/types'

/** What Auto review made of a step, as the one line shown under it and on the approval card. */
export interface ReviewNote {
  by: ToolReview['by']
  /** Absent on an approval card: a card exists because the person is being asked. */
  verdict?: ToolReview['verdict']
  risk?: ToolReview['risk']
  reason: string
}

const WHO: Record<ToolReview['by'], string> = { reviewer: 'the Reviewer', floor: 'Auto review', 'second-look': "the agent's model" }

/** "Approved by the Reviewer (low risk): it only runs the project's tests." */
export function reviewLine(note: ReviewNote): string {
  const reason = note.reason.trim()
  const verdict = note.verdict ?? 'asked'
  // A command that is hard to undo, put to the agent's model once more before it ran (ADR 0097).
  if (note.by === 'second-look') {
    const head = verdict === 'approved' ? 'Checked again before it ran' : 'Asked again before it ran, the model did not confirm it'
    return reason ? `${head}: ${reason}` : head
  }
  const head =
    verdict === 'approved'
      ? `Approved by ${WHO[note.by]}${note.risk ? ` (${note.risk} risk)` : ''}`
      : verdict === 'declined'
        ? `Declined by ${WHO[note.by]}${note.risk ? ` (${note.risk} risk)` : ''}`
        : `${note.by === 'reviewer' ? 'The Reviewer' : 'Auto review'} leaves this to you`
  return reason ? `${head}: ${reason}` : head
}
