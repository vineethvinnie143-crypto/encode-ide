/**
 * A benchmark report: every run of every task, written as JSON so that two of them, before and after a change, can
 * be compared. Reports hold no machine's paths and no keys: what the agent replied, the checks, the counts.
 */
import type { RunMetrics, TaskRun } from './run'
import { dropChance, meanInterval, ratioInterval, type Interval } from './stats'

export interface BenchReport {
  kind: 'encode-bench'
  version: 1
  /** What ran the tasks: a model reference, or `reference` for the tasks' own solutions. */
  model: string
  startedAt: string
  platform: string
  /** The context every run was held to, when the run squeezed it (`--window`): shortening and summaries run sooner. */
  window?: number
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
  /**
   * pass^k: for a task, 1 when every one of its measured runs passed and 0 otherwise; for `all`, the share of tasks
   * whose every run passed. What a person meets is one run, so a task that passes four times in five is not reliable.
   */
  passEvery: number
  /** The fewest measured runs of a task: the k of pass^k. */
  fewestRuns: number
  /** Of the runs measured, the share that passed with code a reviewer would not send back (quality.ts). */
  cleanRate: number
  /** Means over the runs measured. */
  mean: Pick<RunMetrics, 'requests' | 'inputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens' | 'rewrites' | 'summaries' | 'toolCalls' | 'toolFailures' | 'commandFailures' | 'editMisses' | 'readChars' | 'durationMs'>
  /** Dollars over all measured runs, when every call said what it cost; per task solved, when any was. */
  cost?: number
  costPerSolved?: number
}

/** What every report has; a report must hold them to be read. */
const MEAN_KEYS = ['requests', 'inputTokens', 'cachedTokens', 'outputTokens', 'toolCalls', 'toolFailures', 'commandFailures', 'editMisses', 'readChars', 'durationMs'] as const
/** Counted later than the first reports: 0 in a report written before them. */
const LATER_KEYS = ['cacheWriteTokens', 'reasoningTokens', 'rewrites', 'summaries'] as const

const isMeasured = (run: TaskRun) => run.outcome === 'passed' || run.outcome === 'failed'
/** Passed, and its code has nothing a reviewer would send back. */
const isClean = (run: TaskRun) => run.outcome === 'passed' && !run.quality?.issues.length

/** Every run of a task passed, of the tasks with a measured run: by task, 1 or 0. */
function everyPassed(runs: readonly TaskRun[]): number {
  const byTask = new Map<string, boolean>()
  for (const run of runs.filter(isMeasured)) byTask.set(run.task, (byTask.get(run.task) ?? true) && run.outcome === 'passed')
  return byTask.size ? [...byTask.values()].filter(Boolean).length / byTask.size : 0
}

function fewestRuns(runs: readonly TaskRun[]): number {
  const counts = new Map<string, number>()
  for (const run of runs.filter(isMeasured)) counts.set(run.task, (counts.get(run.task) ?? 0) + 1)
  return counts.size ? Math.min(...counts.values()) : 0
}

function summaryOf(task: string, runs: readonly TaskRun[]): Summary {
  const measured = runs.filter(isMeasured)
  const passed = measured.filter((run) => run.outcome === 'passed').length
  const meanOf = (key: keyof Summary['mean']) => (measured.length ? measured.reduce((all, run) => all + (run.metrics[key] ?? 0), 0) / measured.length : 0)
  const mean = Object.fromEntries([...MEAN_KEYS, ...LATER_KEYS].map((key) => [key, meanOf(key)])) as Summary['mean']
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
    passEvery: everyPassed(runs),
    fewestRuns: fewestRuns(runs),
    cleanRate: measured.length ? measured.filter(isClean).length / measured.length : 0,
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
const tenths = (value: number) => (Math.round(value * 10) / 10).toString()
/** The model, and the window when the run squeezed it. */
const nameOf = (report: BenchReport) => (report.window ? `${report.model} in a ${Math.round(report.window / 1000)}k window` : report.model)
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
    measured ? `${Math.round(summary.cleanRate * measured)}/${measured}` : '-',
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

const HEADER = ['task', 'passed', 'clean', 'calls', 'input', 'cached', 'output', 'tool fails', 'edit misses', 'read chars', 'cost', 'time']

/** The report as a table, a task a row and the means per run, then why each run that did not pass did not. */
export function formatReport(report: BenchReport): string {
  const { tasks, all } = summarize(report)
  const lines = [`${nameOf(report)}, ${report.startedAt}, ${report.platform}`, '', table([HEADER, ...tasks.map(row), row(all)])]
  const measuredTasks = tasks.filter((summary) => summary.passed + summary.failed > 0).length
  lines.push('', `Every run passed: ${Math.round(all.passEvery * measuredTasks)} of ${measuredTasks} tasks (pass^${all.fewestRuns})`)
  if (all.fewestRuns < MIN_RUNS) lines.push(`Too few runs to tell a change from noise: run each task ${MIN_RUNS} times or more (--repeat 5).`)
  const { mean } = all
  lines.push(
    `Tokens per run: ${whole(mean.inputTokens)} read, ${whole(mean.inputTokens - mean.cachedTokens)} of them not from the cache, ${whole(mean.cacheWriteTokens)} written to it; ${whole(mean.outputTokens)} written, ${whole(mean.reasoningTokens)} of them reasoning`,
  )
  lines.push(`Context per run: ${tenths(mean.rewrites)} rewrites (old results shortened or steps summarized), ${tenths(mean.summaries)} summaries`)
  if (all.costPerSolved !== undefined) lines.push(`Cost per task solved: ${dollars(all.costPerSolved)}`)
  const notes = report.runs.filter((run) => run.outcome !== 'passed' || run.quality?.issues.length)
  if (notes.length) lines.push('')
  for (const run of notes) {
    const failed = run.checks.filter((check) => !check.passed)
    if (run.outcome === 'passed') {
      lines.push(`${run.task} #${run.attempt} passed, but its code ${run.quality!.issues.join('; ')}`)
      continue
    }
    const why = run.outcome === 'failed' ? failed.map((check) => `${check.name}${check.detail ? `: ${check.detail.split('\n')[0]}` : ''}`).join('; ') : (run.reason ?? run.outcome)
    lines.push(`${run.task} #${run.attempt} ${run.outcome}${run.stopped ? ` (${run.stopped})` : ''}: ${why}`)
  }
  return lines.join('\n')
}

/** The fewest runs of every task, on both sides, for a comparison to tell a change from noise. */
export const MIN_RUNS = 3
/** A task's drop counts when it would happen by chance less often than this. */
export const DROP_CHANCE = 0.05

export interface Comparison {
  text: string
  /**
   * What passed less often after than before. With MIN_RUNS runs of every task on both sides: each task whose drop is
   * beyond chance (Fisher's exact test), and `all` when the whole pass rate fell beyond its 95% interval. With fewer,
   * noise cannot be told apart, so every task that passed less often, and `all` when the whole did.
   */
  regressions: string[]
  /** Every task both reports ran was run at least MIN_RUNS times in each. */
  enoughRuns: boolean
  /** The change in each task's pass rate, after less before, with its 95% interval: in points of 1. */
  passChange?: Interval
  /** The change in pass^k: tasks whose every run passed, after less before. */
  passEveryChange?: Interval
  /** The change in the share of runs that passed with clean code, after less before. */
  cleanChange?: Interval
  /** Each task's cost per run, after over before, as a geometric mean with its 95% interval. */
  costRatio?: Interval
  costPerSolved: { before?: number; after?: number }
}

const change = (before: number, after: number): string => {
  if (before === after) return '='
  if (!before) return `+${whole(after)}`
  const ratio = (after - before) / before
  return `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`
}

const points = (value: number) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}`
const interval = (value: Interval) => `${points(value.mean)} points (95% interval ${points(value.low)} to ${points(value.high)}, ${value.n} tasks)`
const signed = (value: number) => {
  const rounded = Math.round((value - 1) * 100)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}
const ratio = (value: Interval) => `${signed(value.mean)} (95% interval ${signed(value.low)} to ${signed(value.high)}, ${value.n} tasks)`

/** Before and after, task by task: the pass rate, how the means moved, and whether what moved is more than noise. */
export function compareReports(before: BenchReport, after: BenchReport): Comparison {
  const a = summarize(before)
  const b = summarize(after)
  const earlier = new Map(a.tasks.map((summary) => [summary.task, summary]))
  const measured = (summary: Summary) => summary.passed + summary.failed
  const pairs = b.tasks.flatMap((summary) => {
    const was = earlier.get(summary.task)
    return was && measured(was) && measured(summary) ? [[was, summary] as const] : []
  })
  const enoughRuns = pairs.length > 0 && pairs.every(([x, y]) => measured(x) >= MIN_RUNS && measured(y) >= MIN_RUNS)
  const passChange = meanInterval(pairs.map(([x, y]) => y.passRate - x.passRate))
  const passEveryChange = meanInterval(pairs.map(([x, y]) => y.passEvery - x.passEvery))
  const cleanChange = meanInterval(pairs.map(([x, y]) => y.cleanRate - x.cleanRate))
  const costRatio = ratioInterval(pairs.flatMap(([x, y]) => (x.cost !== undefined && y.cost !== undefined && x.cost > 0 ? [y.cost / measured(y) / (x.cost / measured(x))] : [])))

  const regressions: string[] = []
  for (const [x, y] of pairs) {
    const dropped = y.passRate < x.passRate
    if (dropped && (!enoughRuns || dropChance(x.passed, measured(x), y.passed, measured(y)) < DROP_CHANCE)) regressions.push(y.task)
  }
  const wholeDropped = measured(a.all) > 0 && measured(b.all) > 0 && b.all.passRate < a.all.passRate
  if (enoughRuns ? passChange !== undefined && passChange.high < 0 : wholeDropped) regressions.push('all')

  const rows = [['task', 'passed', 'every run', 'calls', 'input', 'output', 'tool fails', 'edit misses', 'read chars', 'cost']]
  const line = (x: Summary, y: Summary) => {
    rows.push([
      y.task,
      `${measured(x) ? percent(x.passRate) : '-'} → ${measured(y) ? percent(y.passRate) : '-'}`,
      y.task === 'all' ? `${percent(x.passEvery)} → ${percent(y.passEvery)}` : `${x.passEvery ? 'yes' : 'no'} → ${y.passEvery ? 'yes' : 'no'}`,
      change(x.mean.requests, y.mean.requests),
      change(x.mean.inputTokens, y.mean.inputTokens),
      change(x.mean.outputTokens, y.mean.outputTokens),
      change(x.mean.toolFailures, y.mean.toolFailures),
      change(x.mean.editMisses, y.mean.editMisses),
      change(x.mean.readChars, y.mean.readChars),
      x.cost !== undefined && y.cost !== undefined ? change(x.cost, y.cost) : '-',
    ])
  }
  for (const [x, y] of pairs) line(x, y)
  line(a.all, b.all)
  const only = (left: Summary[], right: Summary[]) => left.filter((summary) => !right.some((other) => other.task === summary.task)).map((summary) => summary.task)
  const lines = [`${nameOf(before)} (${before.startedAt}) → ${nameOf(after)} (${after.startedAt})`, '', table(rows), '']
  if (enoughRuns) {
    if (passChange) lines.push(`Pass rate: ${interval(passChange)}`)
    if (passEveryChange) lines.push(`Every run passed: ${interval(passEveryChange)}`)
    if (cleanChange) lines.push(`Passed with clean code: ${interval(cleanChange)}`)
    if (costRatio) lines.push(`Cost per run: ${ratio(costRatio)}`)
  }
  lines.push(`Context per run: ${tenths(a.all.mean.rewrites)} → ${tenths(b.all.mean.rewrites)} rewrites, ${tenths(a.all.mean.summaries)} → ${tenths(b.all.mean.summaries)} summaries`)
  const costPerSolved = { ...(a.all.costPerSolved !== undefined ? { before: a.all.costPerSolved } : {}), ...(b.all.costPerSolved !== undefined ? { after: b.all.costPerSolved } : {}) }
  if (costPerSolved.before !== undefined && costPerSolved.after !== undefined) lines.push(`Cost per task solved: ${dollars(costPerSolved.before)} → ${dollars(costPerSolved.after)} (${change(costPerSolved.before, costPerSolved.after)})`)
  if (!enoughRuns) lines.push(`Too few runs to tell a change from noise: every drop counts. Run each task ${MIN_RUNS} times or more (--repeat 5).`)
  const gone = only(a.tasks, b.tasks)
  const added = only(b.tasks, a.tasks)
  if (gone.length) lines.push('', `Only before: ${gone.join(', ')}`)
  if (added.length) lines.push('', `Only after: ${added.join(', ')}`)
  if (regressions.length) lines.push('', `${enoughRuns ? 'Passed less often, beyond chance' : 'Passed less often'}: ${regressions.join(', ')}`)
  return { text: lines.join('\n'), regressions, enoughRuns, ...(passChange ? { passChange } : {}), ...(passEveryChange ? { passEveryChange } : {}), ...(cleanChange ? { cleanChange } : {}), ...(costRatio ? { costRatio } : {}), costPerSolved }
}

export interface GateVerdict {
  passed: boolean
  /** Why it did not pass, a sentence each; empty when it did. */
  reasons: string[]
}

/**
 * The gate of the cost and accuracy plan: a change is kept for a model when it cuts the cost per task solved by
 * `cut` (0.25 for 25%) and costs nothing in accuracy, beyond the noise of the runs.
 */
export function gate(comparison: Comparison, cut: number): GateVerdict {
  const reasons: string[] = []
  if (!comparison.enoughRuns) reasons.push(`Each task needs ${MIN_RUNS} runs or more in both reports.`)
  if (comparison.regressions.length) reasons.push(`Passed less often: ${comparison.regressions.join(', ')}.`)
  if (comparison.passEveryChange && comparison.passEveryChange.high < 0) reasons.push('Fewer tasks passed on every run, beyond chance.')
  if (comparison.cleanChange && comparison.cleanChange.high < 0) reasons.push('Fewer runs passed with clean code, beyond chance.')
  const { before, after } = comparison.costPerSolved
  if (before === undefined || after === undefined) reasons.push('Both reports need what every call cost.')
  else if (after > before * (1 - cut)) reasons.push(`The cost per task solved fell ${Math.round((1 - after / before) * 100)}%, short of ${Math.round(cut * 100)}%.`)
  if (comparison.costRatio && comparison.costRatio.high >= 1) reasons.push('The cost per run did not fall beyond chance.')
  return { passed: reasons.length === 0, reasons }
}
