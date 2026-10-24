/**
 * What Test this model scored (ADR 0101), kept in the profile so the scores show in Settings > Roles and the model
 * lists after a restart: the latest result for each model, for the most recently tested models. A file that cannot be
 * read is started afresh; a result that is not of the shape below is left out.
 */
import fs from 'node:fs'
import { MODEL_SKILLS, type ModelSkill, type ModelTestItem, type ModelTestOutcome, type ModelTestResult } from '../../shared/model-tests'
import { writePrivateFile } from './private-file'

/** Models whose latest result is kept. */
export const MAX_KEPT = 100

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

const OUTCOMES: readonly ModelTestOutcome[] = ['passed', 'failed', 'error', 'skipped']

/** One task's ending as read back, or nothing when it is not of that shape. */
function itemOf(value: unknown, number: (field: unknown) => number): ModelTestItem[] {
  if (!value || typeof value !== 'object') return []
  const raw = value as Partial<ModelTestItem>
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || !MODEL_SKILLS.includes(raw.skill as ModelSkill) || !OUTCOMES.includes(raw.outcome as ModelTestOutcome)) return []
  return [
    {
      id: raw.id,
      title: raw.title,
      skill: raw.skill as ModelSkill,
      outcome: raw.outcome as ModelTestOutcome,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 500) } : {}),
      requests: number(raw.requests),
      cost: number(raw.cost),
    },
  ]
}

/** A result as read back from the file: its scores, and enough of the rest to show; anything else is not taken. */
export function resultOf(value: unknown): ModelTestResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ModelTestResult>
  if (typeof raw.ref !== 'string' || typeof raw.model !== 'string' || typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return undefined
  if (!raw.skills || typeof raw.skills !== 'object' || !Array.isArray(raw.items)) return undefined
  const skills: ModelTestResult['skills'] = {}
  for (const skill of MODEL_SKILLS) {
    const score = raw.skills[skill]
    if (score && isCount(score.passed) && isCount(score.total) && score.passed <= score.total) skills[skill] = { passed: score.passed, total: score.total }
  }
  const number = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : 0)
  return {
    ref: raw.ref,
    model: raw.model,
    at: raw.at,
    skills,
    items: raw.items.flatMap((item) => itemOf(item, number)).slice(0, 20),
    requests: number(raw.requests),
    inputTokens: number(raw.inputTokens),
    outputTokens: number(raw.outputTokens),
    cost: number(raw.cost),
    costKnown: raw.costKnown === true,
    durationMs: number(raw.durationMs),
    ...(raw.stopped === 'cancelled' || raw.stopped === 'limit' ? { stopped: raw.stopped } : {}),
  }
}

export class ModelTestStore {
  private results: Record<string, ModelTestResult> | undefined

  constructor(private readonly file: string) {}

  /** The latest result of each model, by its "<profile id>:<model id>". */
  all(): Record<string, ModelTestResult> {
    if (this.results) return this.results
    const results: Record<string, ModelTestResult> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { results?: unknown }
      for (const value of Array.isArray(parsed.results) ? parsed.results : []) {
        const result = resultOf(value)
        if (result) results[result.ref] = result
      }
    } catch {
      // Missing or unreadable: no model has been tested.
    }
    this.results = results
    return results
  }

  /** Keeps a result, the model's latest; a run stopped before it scored anything replaces nothing. */
  save(result: ModelTestResult): Record<string, ModelTestResult> {
    const all = { ...this.all() }
    if (!Object.keys(result.skills).length) return all
    all[result.ref] = result
    const kept = Object.values(all)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_KEPT)
    this.results = Object.fromEntries(kept.map((entry) => [entry.ref, entry]))
    writePrivateFile(this.file, `${JSON.stringify({ version: 1, results: kept }, null, 2)}\n`)
    return this.results
  }
}
