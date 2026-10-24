/**
 * Test this model (ADR 0101), as the window and the main process see it: what a test will run and may cost, how it is
 * going, and what it scored. The shapes are those of @encode/bench's quick test, written here so the renderer needs no
 * Node.js package.
 */
import type { ModelRole } from './types'

export type ModelSkill = 'writing' | 'exploring' | 'reviewing'

export const MODEL_SKILLS: readonly ModelSkill[] = ['writing', 'exploring', 'reviewing']

export const SKILL_INFO: Record<ModelSkill, { label: string; what: string }> = {
  writing: { label: 'Writing', what: 'four tasks that change code' },
  exploring: {
    label: 'Exploring',
    what: 'two questions about a project, answered without changing it',
  },
  reviewing: {
    label: 'Reviewing',
    what: 'two changes to review: one with a bug to find, one sound one to pass',
  },
}

/** The skill a role's model is scored on; the roles left out show no score. */
export const ROLE_SKILL: Partial<Record<ModelRole, ModelSkill>> = {
  main: 'writing',
  planner: 'writing',
  explore: 'exploring',
  reviewer: 'reviewing',
}

export interface ModelTestItemPlan {
  id: string
  title: string
  skill: ModelSkill
}

/** What a test of one model will do and may cost, for the person to read before it starts. */
export interface ModelTestPlan {
  ref: string
  model: string
  items: ModelTestItemPlan[]
  requests: [number, number]
  inputTokens: [number, number]
  outputTokens: [number, number]
  /** US dollars at the model's price; absent when its connection lists no price. [0, 0] for a free model. */
  cost?: [number, number]
  /** The run stops when it has spent more, US dollars; absent when the price is not known. */
  limit?: number
  /** Why this model cannot be tested now; nothing runs. */
  refused?: string
}

export type ModelTestOutcome = 'passed' | 'failed' | 'error' | 'skipped'

export interface ModelTestItem extends ModelTestItemPlan {
  outcome: ModelTestOutcome
  reason?: string
  requests: number
  cost: number
}

export interface ModelTestProgress {
  ref: string
  done: number
  total: number
  current?: ModelTestItemPlan
  last?: ModelTestItem
  cost: number
}

export interface ModelTestResult {
  ref: string
  model: string
  at: string
  skills: Partial<Record<ModelSkill, { passed: number; total: number }>>
  items: ModelTestItem[]
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number
  costKnown: boolean
  durationMs: number
  stopped?: 'cancelled' | 'limit'
}

/** "$0.07", "$1.20", "under $0.01". */
export function dollars(value: number): string {
  if (value > 0 && value < 0.01) return 'under $0.01'
  return `$${value.toFixed(2)}`
}

/** What a plan may cost, in words. */
export function planCost(plan: Pick<ModelTestPlan, 'cost'>): string {
  if (!plan.cost) return 'Its connection lists no price, so eNCode cannot say beforehand what it costs.'
  const [low, high] = plan.cost
  if (high === 0) return 'The model is free to call; on OpenRouter, a free model’s requests count against the day’s free requests.'
  return `At the model’s price that is about ${dollars(low)} to ${dollars(high)}.`
}

/** What a run cost, in words. */
export function resultCost(result: Pick<ModelTestResult, 'cost' | 'costKnown'>): string {
  if (!result.costKnown) return result.cost > 0 ? `at least ${dollars(result.cost)}` : 'cost not known'
  return result.cost === 0 ? 'free' : dollars(result.cost)
}

/** A role's score: "3/4", or null when the model was not tested on that role's skill. */
export function roleScore(result: Pick<ModelTestResult, 'skills'> | undefined, role: ModelRole): { skill: ModelSkill; passed: number; total: number } | null {
  const skill = ROLE_SKILL[role]
  const score = skill ? result?.skills[skill] : undefined
  return skill && score && score.total > 0 ? { skill, ...score } : null
}

/** Every task passed, at least half of them, or fewer. */
export function scoreGrade(score: { passed: number; total: number }): 'good' | 'fair' | 'poor' {
  return score.passed === score.total ? 'good' : score.passed * 2 >= score.total ? 'fair' : 'poor'
}

/** Every skill's score in a line: "Writing 3/4 · Exploring 2/2 · Reviewing 1/2". */
export function scoreLine(result: Pick<ModelTestResult, 'skills'>): string {
  return MODEL_SKILLS.flatMap((skill) => {
    const score = result.skills[skill]
    return score && score.total ? [`${SKILL_INFO[skill].label} ${score.passed}/${score.total}`] : []
  }).join(' · ')
}
