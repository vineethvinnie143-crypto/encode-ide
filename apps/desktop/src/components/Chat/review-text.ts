import type { ToolReview } from '@shared/types'

/** What Auto review made of a step, as the one line shown under it and on the approval card. */
export interface ReviewNote {
  by: ToolReview['by']
  /** Absent on an approval card: a card exists because the person is being asked. */
  verdict?: ToolReview['verdict']
  risk?: ToolReview['risk']
  reason: string
}

const WHO: Record<ToolReview['by'], string> = { reviewer: 'the Reviewer', floor: 'Auto review' }

/** "Approved by the Reviewer (low risk): it only runs the project's tests." */
export function reviewLine(note: ReviewNote): string {
  const reason = note.reason.trim()
  const verdict = note.verdict ?? 'asked'
  const head =
    verdict === 'approved'
      ? `Approved by ${WHO[note.by]}${note.risk ? ` (${note.risk} risk)` : ''}`
      : verdict === 'declined'
        ? `Declined by ${WHO[note.by]}${note.risk ? ` (${note.risk} risk)` : ''}`
        : `${note.by === 'reviewer' ? 'The Reviewer' : 'Auto review'} leaves this to you`
  return reason ? `${head}: ${reason}` : head
}
