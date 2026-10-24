/**
 * What Settings > Usage shows, worked out from what each session's requests used by day and by model. Pure, so the
 * sums, the days and the groups are unit tested.
 */
import type { DayUsage, SessionUsage, UsageTally } from '@shared/types'
import { isChat, projectName } from '../../stores/sidebar-model'

export type UsageRange = 7 | 30 | 90
export type UsageMetric = 'cost' | 'tokens' | 'requests'

export interface Tally extends UsageTally {
  requests: number
}

export interface UsageDay {
  /** "2026-10-24", this computer's clock. */
  day: string
  tally: Tally
}

export interface UsageGroup {
  key: string
  label: string
  tally: Tally
}

export interface UsageView {
  /** Every day of the range, oldest first, with nothing on the days without a request. */
  days: UsageDay[]
  total: Tally
  /** By the model that answered, the most costly first; "" is the requests stored before the model was kept. */
  models: UsageGroup[]
  /** By project folder, the most costly first; chats and sessions without a folder go together. */
  projects: UsageGroup[]
}

export const empty = (): Tally => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, unpriced: 0, requests: 0 })

function add(into: Tally, used: UsageTally, requests = 0): void {
  into.calls += used.calls
  into.inputTokens += used.inputTokens
  into.cachedTokens += used.cachedTokens
  into.outputTokens += used.outputTokens
  into.cost += used.cost
  into.unpriced += used.unpriced
  into.requests += requests
}

/** "2026-10-24" for a local date. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The `range` days that end with `today`, oldest first. */
export function daysOf(today: Date, range: number): string[] {
  return Array.from({ length: range }, (_, index) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - 1 - index))))
}

const byWeight = (a: UsageGroup, b: UsageGroup) => b.tally.cost - a.tally.cost || b.tally.inputTokens + b.tally.outputTokens - (a.tally.inputTokens + a.tally.outputTokens) || a.label.localeCompare(b.label)

/** The name the page gives a model: its own, or what requests stored before models were kept come under. */
export const modelLabel = (name: string): string => (name ? name : 'Before models were kept')

export function usageView(sessions: readonly SessionUsage[], options: { today: Date; range: number; chatsFolder: string | null }): UsageView {
  const keys = daysOf(options.today, options.range)
  const inRange = new Set(keys)
  const days = new Map(keys.map((day) => [day, empty()]))
  const total = empty()
  const models = new Map<string, UsageGroup>()
  const projects = new Map<string, UsageGroup>()
  for (const session of sessions) {
    const chat = isChat(session, options.chatsFolder)
    const projectKey = chat || !session.projectRoot ? '' : session.projectRoot
    for (const [day, used] of Object.entries(session.days) as [string, DayUsage][]) {
      if (!inRange.has(day)) continue
      add(days.get(day)!, used, used.requests)
      add(total, used, used.requests)
      const project = projects.get(projectKey) ?? { key: projectKey, label: projectKey ? projectName(projectKey) : 'Chats', tally: empty() }
      add(project.tally, used, used.requests)
      projects.set(projectKey, project)
      for (const [name, tally] of Object.entries(used.models)) {
        const model = models.get(name) ?? { key: name, label: modelLabel(name), tally: empty() }
        add(model.tally, tally)
        models.set(name, model)
      }
    }
  }
  return {
    days: keys.map((day) => ({ day, tally: days.get(day)! })),
    total,
    models: [...models.values()].sort(byWeight),
    projects: [...projects.values()].sort(byWeight),
  }
}

/** What a bar of the chart measures. */
export function metricOf(tally: Tally, metric: UsageMetric): number {
  return metric === 'cost' ? tally.cost : metric === 'tokens' ? tally.inputTokens + tally.outputTokens : tally.requests
}

/** "$0", "$0.0042", "$0.31", "$12.40". */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

/** "980", "18.4k", "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`
  return `${Math.round(tokens / 100_000) / 10}M`
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatCost(value) : metric === 'tokens' ? formatTokens(value) : value.toLocaleString()
}

/** "Oct 24", for the chart's axis and its bars' titles. */
export function dayLabel(day: string, style: 'short' | 'long' = 'short'): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date).toLocaleDateString(undefined, style === 'short' ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' })
}
