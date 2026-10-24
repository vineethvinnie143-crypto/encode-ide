import type { ModelTestItem, ModelTestProgress, ModelTestResult } from '@shared/model-tests'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { create } from '../store'

/** The test that runs now, as far as it has gone. */
export interface RunningTest {
  ref: string
  label: string
  /** What runs now; null between items and before the first. */
  current: ModelTestProgress['current'] | null
  /** The items that ended, in order. */
  done: ModelTestItem[]
  total: number
  cost: number
  stopping: boolean
}

interface ModelTestsStore {
  /** Each tested model's latest result, by "<profile id>:<model id>". */
  results: Record<string, ModelTestResult>
  loaded: boolean
  running: RunningTest | null
  /** The last run's result, or why it could not run; kept until the next run starts. */
  last: { ref: string; result?: ModelTestResult; error?: string } | null
  load(): Promise<void>
  /** Tests a model (ADR 0101); one at a time. Answers with its result, or null when it failed to run. */
  run(target: { ref: string; profileId: string; model: string; label: string }): Promise<ModelTestResult | null>
  stop(): Promise<void>
}

let listening = false

export const useModelTests = create<ModelTestsStore>((set, get) => {
  const listen = () => {
    if (listening) return
    listening = true
    api.models.onTestProgress((progress) => {
      const running = get().running
      if (!running || running.ref !== progress.ref) return
      set({
        running: {
          ...running,
          total: progress.total,
          cost: progress.cost,
          current: progress.current ?? null,
          done: progress.last ? [...running.done, progress.last] : running.done,
        },
      })
    })
  }

  return {
    results: {},
    loaded: false,
    running: null,
    last: null,

    load: async () => {
      listen()
      try {
        set({ results: await api.models.testResults(), loaded: true })
      } catch {
        set({ loaded: true })
      }
    },

    run: async ({ ref, profileId, model, label }) => {
      if (get().running) return null
      listen()
      set({ running: { ref, label, current: null, done: [], total: 0, cost: 0, stopping: false }, last: null })
      try {
        const { result, results } = await api.models.runTest(profileId, model)
        set({ results, running: null, last: { ref, result } })
        return result
      } catch (error) {
        set({ running: null, last: { ref, error: errorText(error) } })
        return null
      }
    },

    stop: async () => {
      const running = get().running
      if (!running || running.stopping) return
      set({ running: { ...running, stopping: true } })
      await api.models.stopTest().catch(() => undefined)
    },
  }
})
