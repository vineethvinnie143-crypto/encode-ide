/**
 * Test this model (ADR 0101), in the agent host: the benchmark's short run on one model, pinned in the router so
 * nothing fails over, each task in a temporary folder of its own on the benchmark's own project. None of the person's
 * code, keys of other connections or folders take part. One test runs at a time, and it stops when it has spent twice
 * what it was expected to at most.
 */
import { estimateTest, readTasks, REVIEW_PROBES, runModelTest, testPlan, type BenchTask } from '@encode/bench'
import type { AgentSettings } from '@encode/core'
import type { ModelBudget, ModelClient } from '@encode/providers'
import type { ModelRouter } from '@encode/router'
import type { Sandbox } from '@encode/sandbox'
import type { ModelTestPlan, ModelTestProgress, ModelTestResult } from '../../shared/model-tests'
import type { HostConfig } from './api'

export interface ModelTesterOptions {
  /** The benchmark's tasks; absent in a build without them. */
  tasksDir?: string
  router(): ModelRouter | undefined
  config(): HostConfig | undefined
  sandbox(): Sandbox | undefined
  /** Where each task's temporary folder goes. Default: the system's. */
  workDir?: string
  /** eNCode's own Node.js runs the tasks' checks, so Node.js need not be installed. */
  node?: { file: string; env?: Record<string, string> }
}

export interface ModelTester {
  plan(profileId: string, model: string): Promise<ModelTestPlan>
  run(profileId: string, model: string, onProgress: (progress: ModelTestProgress) => void): Promise<ModelTestResult>
  stop(): void
}

type Target = { ref: string; refused: string } | { ref: string; refused?: undefined; client: ModelClient; budget: ModelBudget; config: HostConfig }

/** The run stops past twice the most it was expected to cost, and never below this, US dollars. */
const MIN_LIMIT = 0.5

/** The gates as the person has them, so the score is what eNCode does with the model; never the approval policy. */
function gatesOf(config: HostConfig): Partial<AgentSettings> {
  return { errorGate: config.errorGate, guide: config.guide, checkGate: config.checkGate, review: config.reviewWork, smallerHelp: config.helpSmaller }
}

export function createModelTester(options: ModelTesterOptions): ModelTester {
  let tasks: Promise<BenchTask[]> | undefined
  let running: AbortController | undefined
  const readAll = () => (tasks ??= readTasks(options.tasksDir!).then(({ tasks: read }) => read))

  /** The router's name for the connection, and why the model cannot be tested, if it cannot. */
  const target = async (profileId: string, model: string): Promise<Target> => {
    const ref = `${profileId}:${model}`
    const config = options.config()
    const router = options.router()
    const provider = Object.entries(config?.providers ?? {}).find(([, entry]) => entry.profile === profileId)?.[0]
    if (!config || !router || !provider || !model.trim()) return { ref, refused: 'This connection is not set up yet.' }
    if (!options.tasksDir) return { ref, refused: 'This build of eNCode has no benchmark tasks to test with.' }
    const client = router.pinned(`${provider}:${model}`)
    const budget = await client.budget('main')
    if (config.router.freeOnly && !budget.free) return { ref, refused: 'Only free models may run now. Turn off Only use free models to test a model that costs money.' }
    return { ref, client, budget, config }
  }

  const plan = async (profileId: string, model: string): Promise<ModelTestPlan> => {
    const found = await target(profileId, model)
    const items = found.refused !== undefined ? [] : testPlan(await readAll()).map(({ id, title, skill }) => ({ id, title, skill }))
    const probes = REVIEW_PROBES.length
    const estimate = estimateTest(Math.max(0, items.length - probes), items.length ? probes : 0, found.refused === undefined ? found.budget : {})
    const high = estimate.cost?.[1] ?? 0
    return {
      ref: found.ref,
      model,
      items,
      requests: estimate.requests,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      ...(estimate.cost ? { cost: estimate.cost } : {}),
      ...(high > 0 ? { limit: Math.max(MIN_LIMIT, 2 * high) } : {}),
      ...(found.refused !== undefined ? { refused: found.refused } : running ? { refused: 'A test runs already. Wait for it to end, or stop it.' } : {}),
    }
  }

  return {
    plan,

    async run(profileId, model, onProgress) {
      if (running) throw new Error('A test runs already. Wait for it to end, or stop it.')
      const found = await target(profileId, model)
      if (found.refused !== undefined) throw new Error(found.refused)
      const planned = await plan(profileId, model)
      const controller = new AbortController()
      running = controller
      try {
        const sandbox = options.sandbox()
        return await runModelTest({
          client: found.client,
          ref: found.ref,
          model,
          tasks: await readAll(),
          programs: { node: [options.node?.file ?? process.execPath] },
          ...(options.node?.env ? { programEnv: { node: options.node.env } } : {}),
          budget: found.budget,
          ...(planned.limit !== undefined ? { limit: planned.limit } : {}),
          settings: gatesOf(found.config),
          ...(sandbox ? { sandbox } : {}),
          ...(options.workDir ? { workDir: options.workDir } : {}),
          signal: controller.signal,
          onProgress: (progress) => onProgress({ ref: found.ref, ...progress }),
        })
      } finally {
        running = undefined
      }
    },

    stop() {
      running?.abort()
    },
  }
}
