/**
 * Runs tasks one after another, each as often as asked, into one report. One at a time: runs side by side would
 * share the machine and the provider's rate limits, and measure each other.
 */
import { createScriptedClient, type AgentSettings } from '@encode/core'
import type { ModelClient } from '@encode/providers'
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
  onRun?(run: TaskRun, task: BenchTask): void
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
  const programs = await findPrograms(tasks.flatMap((task) => task.requires))
  const window = options.settings?.contextCap
  const report: BenchReport = { kind: 'encode-bench', version: 1, model: options.model, startedAt: (options.now?.() ?? new Date()).toISOString(), platform: process.platform, ...(window ? { window } : {}), runs: [] }
  const repeat = Math.max(1, Math.min(options.repeat ?? 1, 20))
  for (const task of tasks) {
    // A model's code is judged against what the task's own solution changes; that solution plays in a moment.
    const reference = options.client === 'reference' ? undefined : await referenceFacts(task, options, programs)
    for (let attempt = 1; attempt <= repeat; attempt++) {
      if (options.signal?.aborted) return report
      const client = options.client === 'reference' ? referenceClient(task) : options.client
      const settings = options.client === 'reference' ? { ...options.settings, ...REFERENCE_SETTINGS } : options.settings
      const run = client ? await runTask(task, { ...options, ...(settings ? { settings } : {}), client, programs, attempt, ...(reference ? { reference } : {}) }) : skippedRun(task, 'it has no reference solution', attempt)
      report.runs.push(run)
      options.onRun?.(run, task)
    }
  }
  return report
}
