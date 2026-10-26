/**
 * Runs tasks one after another, each as often as asked, into one report. One at a time: runs side by side would
 * share the machine and the provider's rate limits, and measure each other. Runs go in rounds, every task once a round,
 * so a bench that stops early (a spending cap, ADR 0137) has measured every task about as often.
 */
import { createScriptedClient, type AgentSettings } from '@encode/core'
import type { ModelClient, SpendingCap } from '@encode/providers'
import { findPrograms, type Programs } from './programs'
import type { QualityFacts } from './quality'
import type { BenchReport } from './report'
import { runTask, skippedRun, type RunOptions, type TaskRun } from './run'
import type { BenchTask } from './task'

export interface BenchOptions extends Omit<RunOptions, 'client' | 'programs' | 'attempt'> {
  /** The model for every task; or, for `reference`, each task's own solution played by a scripted model. */
  client: ModelClient | 'reference'
  /** What the report names as the model. */
  model: string
  repeat?: number
  /** A hard stop on what the runs spend, every run of every setup together (ADR 0137). */
  cap?: SpendingCap
  /** `setup`: which of runPair's two setups ran it; 0 for runBench. */
  onRun?(run: TaskRun, task: BenchTask, setup: number): void
  /** A round starts: 1 for the first. */
  onRound?(round: number): void
  /** After each run, the reports so far in hand: a reason to end the bench there, or undefined to go on. */
  stopIf?(reports: readonly BenchReport[], round: number, roundDone: boolean): string | undefined
  /**
   * After each run, the reports so far, marked partial and with what was spent, to be saved: a bench cut off by a
   * restart keeps the runs it made (ADR 0139). The bench waits for it before the next run.
   */
  onProgress?(reports: readonly BenchReport[]): Promise<void> | void
  now?: () => Date
}

/** A script plays its steps as written: no change held until it says what it changes, no stronger model offered (ADR 0100). */
export const AS_WRITTEN = { smallerHelp: 'off', offerStronger: 'off' } as const satisfies Partial<AgentSettings>

/**
 * A reference run, besides: a script cannot answer the checks, the Reviewer, the second look or the conventions offer
 * (ADRs 0095 to 0097).
 */
export const REFERENCE_SETTINGS = { ...AS_WRITTEN, checkGate: 'off', review: 'off', askAgain: 'off', learnConventions: 'off' } as const satisfies Partial<AgentSettings>

/**
 * The scripted model that plays a task's reference run, or the steps of a kept report; the last step is a plain reply,
 * so the turn ends there.
 */
export function referenceClient(task: BenchTask): ModelClient | undefined {
  const written = task.solution ?? task.replay?.steps
  if (!written) return undefined
  const steps = written.at(-1)?.calls?.length || task.solution ? [...written, { text: 'Done.' }] : written
  // A summary asked for in a squeezed window (`--window`) is answered apart, so the solution's steps stay in order.
  let next = 0
  return createScriptedClient((request) => (request.role === 'summarizer' ? { text: REFERENCE_SUMMARY } : steps[Math.min(next++, steps.length - 1)]!))
}

/** What a reference run's summaries say: the solution carries on from its own steps, not from what a summary says. */
export const REFERENCE_SUMMARY = 'The reference solution has been carrying out its steps; it goes on with the next one.'

/** What the task's reference solution changes, when it has one and it passes here. */
async function referenceFacts(task: BenchTask, options: BenchOptions, programs: Programs): Promise<QualityFacts | undefined> {
  const client = task.solution ? referenceClient(task) : undefined
  if (!client) return undefined
  const { onEvent: _events, keep: _keep, onKept: _kept, ...rest } = options
  const run = await runTask(task, { ...rest, settings: { ...options.settings, ...REFERENCE_SETTINGS }, client, programs, attempt: 0 })
  return run.outcome === 'passed' ? run.quality?.facts : undefined
}

export async function runBench(tasks: readonly BenchTask[], options: BenchOptions): Promise<BenchReport> {
  return (await runSetups(tasks, options, [options.settings]))[0]!
}

/**
 * Every task run two ways, side by side: as `options.settings` say, and with `second` on top (ADR 0137). Each round
 * runs a task both ways, one right after the other, so the two meet the same provider, the same hour and the same
 * load; they take turns going first, since the second meets a provider cache the first may have warmed.
 */
export async function runPair(tasks: readonly BenchTask[], options: BenchOptions, second: Partial<AgentSettings>): Promise<[BenchReport, BenchReport]> {
  const [first, other] = await runSetups(tasks, options, [options.settings, { ...options.settings, ...second }])
  return [first!, other!]
}

const dollars = (value: number) => `$${value.toFixed(2)}`

function emptyReport(options: BenchOptions, settings: Partial<AgentSettings> | undefined): BenchReport {
  const window = settings?.contextCap
  const effort = settings?.reasoning
  return {
    kind: 'encode-bench',
    version: 1,
    model: options.model,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    platform: process.platform,
    ...(window ? { window } : {}),
    ...(effort ? { effort } : {}),
    ...(settings?.lightSteps ? { lightSteps: true as const } : {}),
    runs: [],
  }
}

async function runSetups(tasks: readonly BenchTask[], options: BenchOptions, setups: readonly (Partial<AgentSettings> | undefined)[]): Promise<BenchReport[]> {
  const programs = await findPrograms(tasks.flatMap((task) => task.requires))
  const reports = setups.map((settings) => emptyReport(options, settings))
  const { cap } = options
  const live = options.client === 'reference' ? 'reference' : cap ? cap.wrap(options.client) : options.client
  const signal = cap ? (options.signal ? AbortSignal.any([options.signal, cap.signal]) : cap.signal) : options.signal
  const repeat = Math.max(1, Math.min(options.repeat ?? 1, 20))
  // A model's code is judged against what the task's own solution changes; that solution plays before the task's first run.
  const references = new Map<string, QualityFacts | undefined>()
  let ended: string | undefined
  let lastRound = 0
  rounds: for (let attempt = 1; attempt <= repeat; attempt++) {
    // A round starts only when what is left pays for one like the last: a round cut short measures some tasks less.
    if (cap && attempt > 1 && cap.spent() + lastRound > cap.limit) {
      cap.stop(`round ${attempt} would cost about ${dollars(lastRound)}, and ${dollars(Math.max(0, cap.limit - cap.spent()))} of the spending cap is left`)
    }
    if (signal?.aborted) break
    options.onRound?.(attempt)
    const before = cap?.spent() ?? 0
    for (const [taskIndex, task] of tasks.entries()) {
      if (live !== 'reference' && !references.has(task.id)) references.set(task.id, await referenceFacts(task, options, programs))
      const reference = references.get(task.id)
      const order = setups.map((_, index) => (attempt % 2 ? index : setups.length - 1 - index))
      for (const [step, index] of order.entries()) {
        if (signal?.aborted) break rounds
        const client = live === 'reference' ? referenceClient(task) : live
        const settings = live === 'reference' ? { ...setups[index], ...REFERENCE_SETTINGS } : setups[index]
        const run = client
          ? await runTask(task, { ...options, ...(settings ? { settings } : {}), ...(signal ? { signal } : {}), client, programs, attempt, ...(reference ? { reference } : {}) })
          : skippedRun(task, 'it has no reference solution', attempt)
        if (run.stopped === 'cancelled' && cap?.stopped() && !options.signal?.aborted) run.reason = `The benchmark stopped: ${cap.stopped()}.`
        reports[index]!.runs.push(run)
        options.onRun?.(run, task, index)
        ended = options.stopIf?.(reports, attempt, taskIndex === tasks.length - 1 && step === order.length - 1)
        if (ended) break rounds
        await options.onProgress?.(reports.map((report) => ({ ...withSpending(report, cap, cap?.stopped()), partial: true as const, runs: [...report.runs] })))
      }
    }
    lastRound = (cap?.spent() ?? 0) - before
  }
  const why = ended ?? cap?.stopped()
  return reports.map((report) => withSpending(report, cap, why))
}

function withSpending(report: BenchReport, cap: SpendingCap | undefined, why: string | undefined): BenchReport {
  return { ...report, ...(cap ? { spending: { limit: cap.limit, spent: cap.spent() } } : {}), ...(why ? { endedEarly: why } : {}) }
}
