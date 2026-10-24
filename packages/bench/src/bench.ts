/**
 * Runs tasks one after another, each as often as asked, into one report. One at a time: runs side by side would
 * share the machine and the provider's rate limits, and measure each other.
 */
import { createScriptedClient } from '@encode/core'
import type { ModelClient } from '@encode/providers'
import { findPrograms } from './programs'
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

/**
 * The scripted model that plays a task's reference run, or the steps of a kept report; the last step is a plain reply,
 * so the turn ends there.
 */
export function referenceClient(task: BenchTask): ModelClient | undefined {
  const steps = task.solution ?? task.replay?.steps
  if (!steps) return undefined
  return createScriptedClient(steps.at(-1)?.calls?.length || task.solution ? [...steps, { text: 'Done.' }] : steps)
}

export async function runBench(tasks: readonly BenchTask[], options: BenchOptions): Promise<BenchReport> {
  const programs = await findPrograms(tasks.flatMap((task) => task.requires))
  const report: BenchReport = { kind: 'encode-bench', version: 1, model: options.model, startedAt: (options.now?.() ?? new Date()).toISOString(), platform: process.platform, runs: [] }
  const repeat = Math.max(1, Math.min(options.repeat ?? 1, 20))
  for (const task of tasks) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      if (options.signal?.aborted) return report
      const client = options.client === 'reference' ? referenceClient(task) : options.client
      // A script cannot answer the checks or the Reviewer before it finishes (ADR 0095, 0096): its steps are played as written.
      const settings = options.client === 'reference' ? { ...options.settings, checkGate: 'off' as const, review: 'off' as const } : options.settings
      const run = client ? await runTask(task, { ...options, ...(settings ? { settings } : {}), client, programs, attempt }) : skippedRun(task, 'it has no reference solution', attempt)
      report.runs.push(run)
      options.onRun?.(run, task)
    }
  }
  return report
}
