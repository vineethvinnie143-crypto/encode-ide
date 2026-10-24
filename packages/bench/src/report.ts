/**
 * A benchmark report: every run of every task, written as JSON so that two of them, before and after a change, can
 * be compared. Reports hold no machine's paths and no keys: what the agent replied, the checks, the counts.
 */
import type { RunMetrics, TaskRun } from './run'

export interface BenchReport {
  kind: 'encode-bench'
  version: 1
  /** What ran the tasks: a model reference, or `reference` for the tasks' own solutions. */
  model: string
  startedAt: string
  platform: string
  runs: TaskRun[]
}

export interface Summary {
  /** A task's id, or `all`. */
  task: string
  runs: number
  passed: number
  failed: number
  /** Runs that could not be measured (the model could not be reached) and runs skipped here. */
  errors: number
  skipped: number
  /** Of the runs measured. */
  passRate: number
  /** Means over the runs measured. */
  mean: Pick<RunMetrics, 'requests' | 'inputTokens' | 'cachedTokens' | 'outputTokens' | 'toolCalls' | 'toolFailures' | 'commandFailures' | 'editMisses' | 'readChars' | 'durationMs'>
  /** Dollars over all measured runs, when every call said what it cost; per task solved, when any was. */
  cost?: number
  costPerSolved?: number
}

const MEAN_KEYS = ['requests', 'inputTokens', 'cachedTokens', 'outputTokens', 'toolCalls', 'toolFailures', 'commandFailures', 'editMisses', 'readChars', 'durationMs'] as const

function summaryOf(task: string, runs: readonly TaskRun[]): Summary {
  const measured = runs.filter((run) => run.outcome === 'passed' || run.outcome === 'failed')
  const passed = measured.filter((run) => run.outcome === 'passed').length
  const mean = Object.fromEntries(MEAN_KEYS.map((key) => [key, measured.length ? measured.reduce((all, run) => all + run.metrics[key], 0) / measured.length : 0])) as Summary['mean']
  const priced = measured.length > 0 && measured.every((run) => run.metrics.costReported === run.metrics.requests)
  const cost = priced ? measured.reduce((all, run) => all + run.metrics.cost, 0) : undefined
  return {
    task,
    runs: runs.length,
    passed,
    failed: measured.length - passed,
    errors: runs.filter((run) => run.outcome === 'error').length,
    skipped: runs.filter((run) => run.outcome === 'skipped').length,
    passRate: measured.length ? passed / measured.length : 0,
    mean,
    ...(cost !== undefined ? { cost } : {}),
    ...(cost !== undefined && passed ? { costPerSolved: cost / passed } : {}),
  }
}

/** Each task's summary, in the order the runs came, and one for every run together. */
export function summarize(report: BenchReport): { tasks: Summary[]; all: Summary } {
  const byTask = new Map<string, TaskRun[]>()
  for (const run of report.runs) byTask.set(run.task, [...(byTask.get(run.task) ?? []), run])
  return { tasks: [...byTask].map(([task, runs]) => summaryOf(task, runs)), all: summaryOf('all', report.runs) }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A report read back from a file: one that is not a benchmark report is refused, not half read. */
export function parseReport(json: unknown): BenchReport {
  if (!isObject(json) || json.kind !== 'encode-bench') throw new Error('This is not a benchmark report.')
  if (json.version !== 1) throw new Error(`This report is version ${String(json.version)}; this eNCode reads version 1.`)
  if (typeof json.model !== 'string' || typeof json.startedAt !== 'string' || !Array.isArray(json.runs)) throw new Error('The report is missing its model, its time or its runs.')
  for (const [index, run] of json.runs.entries()) {
    if (!isObject(run) || typeof run.task !== 'string' || typeof run.outcome !== 'string' || !isObject(run.metrics)) throw new Error(`Run ${index + 1} of the report is not a run.`)
    for (const key of MEAN_KEYS) if (typeof run.metrics[key] !== 'number') throw new Error(`Run ${index + 1} of the report has no ${key}.`)
  }
  return json as unknown as BenchReport
}

const whole = (value: number) => Math.round(value).toLocaleString('en-US')
const percent = (value: number) => `${Math.round(value * 100)}%`
const dollars = (value: number | undefined) => (value === undefined ? '-' : `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`)
const cachedShare = (summary: Summary) => (summary.mean.inputTokens ? percent(summary.mean.cachedTokens / summary.mean.inputTokens) : '-')

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ').trimEnd()).join('\n')
}

function row(summary: Summary): string[] {
  const measured = summary.passed + summary.failed
  const pass = measured ? `${summary.passed}/${measured}` : summary.skipped ? 'skipped' : 'error'
  return [
    summary.task,
    pass,
    whole(summary.mean.requests),
    whole(summary.mean.inputTokens),
    cachedShare(summary),
    whole(summary.mean.outputTokens),
    whole(summary.mean.toolFailures),
    whole(summary.mean.editMisses),
    whole(summary.mean.readChars),
    dollars(summary.cost),
    `${(summary.mean.durationMs / 1000).toFixed(1)} s`,
  ]
}

const HEADER = ['task', 'passed', 'calls', 'input', 'cached', 'output', 'tool fails', 'edit misses', 'read chars', 'cost', 'time']

/** The report as a table, a task a row and the means per run, then why each run that did not pass did not. */
export function formatReport(report: BenchReport): string {
  const { tasks, all } = summarize(report)
  const lines = [`${report.model}, ${report.startedAt}, ${report.platform}`, '', table([HEADER, ...tasks.map(row), row(all)])]
  if (all.costPerSolved !== undefined) lines.push('', `Cost per task solved: ${dollars(all.costPerSolved)}`)
  const notes = report.runs.filter((run) => run.outcome !== 'passed')
  if (notes.length) lines.push('')
  for (const run of notes) {
    const failed = run.checks.filter((check) => !check.passed)
    const why = run.outcome === 'failed' ? failed.map((check) => `${check.name}${check.detail ? `: ${check.detail.split('\n')[0]}` : ''}`).join('; ') : (run.reason ?? run.outcome)
    lines.push(`${run.task} #${run.attempt} ${run.outcome}${run.stopped ? ` (${run.stopped})` : ''}: ${why}`)
  }
  return lines.join('\n')
}

export interface Comparison {
  text: string
  /** Tasks that passed less often after than before, and the whole if it did. */
  regressions: string[]
}

const change = (before: number, after: number): string => {
  if (before === after) return '='
  if (!before) return `+${whole(after)}`
  const ratio = (after - before) / before
  return `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`
}

/** Before and after, task by task: the pass rate, and how the means moved. */
export function compareReports(before: BenchReport, after: BenchReport): Comparison {
  const a = summarize(before)
  const b = summarize(after)
  const earlier = new Map(a.tasks.map((summary) => [summary.task, summary]))
  const regressions: string[] = []
  const rows = [['task', 'passed', 'calls', 'input', 'output', 'tool fails', 'edit misses', 'read chars', 'cost']]
  const line = (x: Summary, y: Summary) => {
    const measured = (summary: Summary) => summary.passed + summary.failed
    if (measured(x) && measured(y) && y.passRate < x.passRate) regressions.push(y.task)
    rows.push([
      y.task,
      `${measured(x) ? percent(x.passRate) : '-'} → ${measured(y) ? percent(y.passRate) : '-'}`,
      change(x.mean.requests, y.mean.requests),
      change(x.mean.inputTokens, y.mean.inputTokens),
      change(x.mean.outputTokens, y.mean.outputTokens),
      change(x.mean.toolFailures, y.mean.toolFailures),
      change(x.mean.editMisses, y.mean.editMisses),
      change(x.mean.readChars, y.mean.readChars),
      x.cost !== undefined && y.cost !== undefined ? change(x.cost, y.cost) : '-',
    ])
  }
  for (const summary of b.tasks) {
    const was = earlier.get(summary.task)
    if (was) line(was, summary)
  }
  line(a.all, b.all)
  const only = (left: Summary[], right: Summary[]) => left.filter((summary) => !right.some((other) => other.task === summary.task)).map((summary) => summary.task)
  const lines = [`${before.model} (${before.startedAt}) → ${after.model} (${after.startedAt})`, '', table(rows)]
  const gone = only(a.tasks, b.tasks)
  const added = only(b.tasks, a.tasks)
  if (gone.length) lines.push('', `Only before: ${gone.join(', ')}`)
  if (added.length) lines.push('', `Only after: ${added.join(', ')}`)
  if (regressions.length) lines.push('', `Passed less often: ${regressions.join(', ')}`)
  return { text: lines.join('\n'), regressions }
}
