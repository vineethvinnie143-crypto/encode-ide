import { roleScore, scoreGrade, scoreLine, type ModelTestResult } from '@shared/model-tests'
import type { ModelRole } from '@shared/types'
import { Chip } from '../../ui/Pill'
import { contextLabel, type PickerItem } from './model-list'

const GRADE_TONE = { good: 'success', fair: 'neutral', poor: 'warning' } as const

/** A tested model's score on the role's skill, "3/4" (ADR 0101); nothing when it was not tested on it. */
export function ScoreChip({ result, role, className }: { result: ModelTestResult | undefined; role: ModelRole; className?: string }) {
  const score = roleScore(result, role)
  if (!result || !score) return null
  const when = new Date(result.at).toLocaleDateString([], { day: 'numeric', month: 'short' })
  return (
    <Chip tone={GRADE_TONE[scoreGrade(score)]} className={className} data-score={`${score.passed}/${score.total}`} title={`Tested ${when}: ${scoreLine(result)}`}>
      {score.passed}/{score.total}
    </Chip>
  )
}

/**
 * What is worth knowing about a model before choosing it: free or billed, whether the agent can use it, how much it
 * holds, and how it scored on the role's skill when it was tested (ADR 0101).
 */
export function ModelBadges({ item, tested, role = 'main' }: { item: PickerItem; tested?: ModelTestResult; role?: ModelRole }) {
  return (
    <span className="model-badges">
      <ScoreChip result={tested} role={role} className="model-score" />
      {item.noTools && (
        <Chip tone="warning" title="The provider says this model cannot call tools, which the agent needs.">
          No tools
        </Chip>
      )}
      {item.kind === 'model' && item.free && <Chip tone="success">Free</Chip>}
      {item.kind === 'model' && !item.free && item.price && <span className="model-price">{item.price}</span>}
      {item.contextLength ? <span className="model-context">{contextLabel(item.contextLength)}</span> : null}
    </span>
  )
}
