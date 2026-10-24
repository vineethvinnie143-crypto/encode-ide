/**
 * Test this model (ADR 0101): a short run of the benchmark on one model, started from Settings > Roles, scored by the
 * skill each role needs, with what it may cost before it starts and what it cost after.
 *
 * - Writing, for Main and Plan: four tasks that change code.
 * - Exploring, for Explore: two questions about a project, answered without changing it.
 * - Reviewing, for Review: two changes to review, one with a bug that must be found and one sound one that must not
 *   be sent back.
 *
 * Each task runs in a temporary folder of its own on the benchmark's own project, so none of the person's code is sent.
 * The client is pinned to the model, so nothing fails over to another, and a run stops when it spends more than its
 * limit.
 */
import { changeInput, reviewChanges, type AgentSettings, type CodeReviewInput, type CodeReviewResult } from '@encode/core'
import type { CompletionOutcome, CompletionRequest, ModelBudget, ModelClient } from '@encode/providers'
import type { Sandbox } from '@encode/sandbox'
import type { CheckResult } from './checks'
import type { ProgramEnv, Programs } from './programs'
import { runTask, type RunOutcome } from './run'
import type { BenchTask } from './task'

export type Skill = 'writing' | 'exploring' | 'reviewing'

export const SKILLS: readonly Skill[] = ['writing', 'exploring', 'reviewing']

export const SKILL_LABEL: Record<Skill, string> = {
  writing: 'Writing',
  exploring: 'Exploring',
  reviewing: 'Reviewing',
}

/** The benchmark's tasks each skill is scored on: ones that need no program but eNCode's own Node.js to check. */
export const SKILL_TASKS: Record<Exclude<Skill, 'reviewing'>, readonly string[]> = {
  writing: ['fix-failing-test', 'json-config-edit', 'rename-across-files', 'crlf-preserve'],
  exploring: ['question-no-change', 'trace-event-handler'],
}

/** The skill a role's model is scored on; the roles left out show no score. */
export const ROLE_SKILL: Readonly<Record<string, Skill>> = {
  main: 'writing',
  planner: 'writing',
  explore: 'exploring',
  reviewer: 'reviewing',
}

/** A change to review, and what a good review of it does. */
export interface ReviewProbe {
  id: string
  title: string
  input: CodeReviewInput
  passes(result: CodeReviewResult): boolean
}

const serious = (result: CodeReviewResult) => result.findings.filter((finding) => finding.priority === 'P0' || finding.priority === 'P1')

const REFUNDS_BEFORE = `const { db } = require('./db')

async function orderTotal(orderId) {
  const row = await db.get('SELECT total FROM orders WHERE id = ?', [orderId])
  return row ? row.total : 0
}

module.exports = { orderTotal }
`

const REFUNDS_AFTER = `const { db } = require('./db')

async function orderTotal(orderId) {
  const row = await db.get('SELECT total FROM orders WHERE id = ?', [orderId])
  return row ? row.total : 0
}

async function refund(orderId, amount, reason) {
  const total = await orderTotal(orderId)
  if (amount > total) throw new RangeError('refund above the order total')
  await db.run(\`INSERT INTO refunds (order_id, amount, reason) VALUES (\${orderId}, \${amount}, '\${reason}')\`)
  return { orderId, amount }
}

module.exports = { orderTotal, refund }
`

const PAGES_BEFORE = `function pageOf(items, page, size) {
  const start = page * size
  return items.slice(start, start + size)
}

module.exports = { pageOf }
`

const PAGES_AFTER = `const MAX_PAGE_SIZE = 100

function pageOf(items, page, size) {
  const limit = Math.min(Math.max(1, size), MAX_PAGE_SIZE)
  const start = Math.max(0, page) * limit
  return items.slice(start, start + limit)
}

module.exports = { pageOf, MAX_PAGE_SIZE }
`

export const REVIEW_PROBES: readonly ReviewProbe[] = [
  {
    id: 'review-finds-injection',
    title: 'Find the bug in a change',
    input: changeInput([{ path: 'src/refunds.js', before: REFUNDS_BEFORE, after: REFUNDS_AFTER }]),
    // The query built from the reason (line 11) is an injection; a negative amount passing the check (line 10) is a
    // bug as real. Either, found as serious, is the review that was needed.
    passes: (result) => serious(result).some((finding) => finding.path === 'src/refunds.js' && finding.line >= 10 && finding.line <= 11),
  },
  {
    id: 'review-sound-change',
    title: 'Pass a sound change',
    input: changeInput([{ path: 'src/pagination.js', before: PAGES_BEFORE, after: PAGES_AFTER }]),
    passes: (result) => serious(result).length === 0,
  },
]

/** One task or review of a test, as it went. */
export interface TestItem {
  id: string
  skill: Skill
  title: string
  outcome: RunOutcome
  /** Why it could not be measured, or what the review got wrong. */
  reason?: string
  requests: number
  cost: number
}

export interface ModelTestResult {
  /** "<profile id>:<model id>" as the settings name it. */
  ref: string
  model: string
  at: string
  skills: Partial<Record<Skill, { passed: number; total: number }>>
  items: TestItem[]
  requests: number
  inputTokens: number
  outputTokens: number
  /** US dollars: what the provider said, else tokens at the catalog's price; `costKnown` false when neither was there. */
  cost: number
  costKnown: boolean
  durationMs: number
  /** The run ended before every item: the person stopped it, or it spent its limit. */
  stopped?: 'cancelled' | 'limit'
}

export interface TestProgress {
  done: number
  total: number
  /** What runs now. */
  current?: { id: string; title: string; skill: Skill }
  /** What just ended. */
  last?: TestItem
  cost: number
}

/** The items of a test, in the order they run. */
export function testPlan(tasks: readonly BenchTask[]): {
  id: string
  title: string
  skill: Skill
  task?: BenchTask
  probe?: ReviewProbe
}[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const plan: ReturnType<typeof testPlan> = []
  for (const skill of ['writing', 'exploring'] as const) {
    for (const id of SKILL_TASKS[skill]) {
      const task = byId.get(id)
      if (task) plan.push({ id, title: task.title, skill, task })
    }
  }
  for (const probe of REVIEW_PROBES) plan.push({ id: probe.id, title: probe.title, skill: 'reviewing', probe })
  return plan
}

/**
 * What a test is likely to take, from the sizes of its tasks: each runs some 3 to 15 model calls, reading the
 * instructions and the tools again at each (prompt caches make most of that cheap where the provider has them).
 */
const PER_TASK = {
  requests: [3, 15],
  input: [40_000, 200_000],
  output: [1_500, 10_000],
} as const
const PER_PROBE = {
  requests: [1, 1],
  input: [2_500, 4_000],
  output: [300, 4_000],
} as const

export interface TestEstimate {
  requests: [number, number]
  inputTokens: [number, number]
  outputTokens: [number, number]
  /** US dollars at the catalog's price; absent when the catalog gave none. 0 for a free model. */
  cost?: [number, number]
}

export function estimateTest(tasks: number, probes: number, budget: Pick<ModelBudget, 'price' | 'free'>): TestEstimate {
  const sum = (key: 'requests' | 'input' | 'output', at: 0 | 1) => tasks * PER_TASK[key][at] + probes * PER_PROBE[key][at]
  const inputTokens: [number, number] = [sum('input', 0), sum('input', 1)]
  const outputTokens: [number, number] = [sum('output', 0), sum('output', 1)]
  const priced = (at: 0 | 1) => (budget.price ? (inputTokens[at] * budget.price.input + outputTokens[at] * budget.price.output) / 1_000_000 : 0)
  return {
    requests: [sum('requests', 0), sum('requests', 1)],
    inputTokens,
    outputTokens,
    ...(budget.free ? { cost: [0, 0] as [number, number] } : budget.price ? { cost: [priced(0), priced(1)] as [number, number] } : {}),
  }
}

/** A test stops past this many model calls, whatever they cost: a model in a loop is not scored for longer. */
export const MAX_TEST_REQUESTS = 300

export interface ModelTestOptions {
  /** The model alone: a pinned client. */
  client: ModelClient
  ref: string
  model: string
  /** The benchmark's tasks, read; those the test needs are taken from them. */
  tasks: readonly BenchTask[]
  programs: Programs
  programEnv?: ProgramEnv
  /** The model's prices and whether it is free, for the cost where the provider does not say it. */
  budget: Pick<ModelBudget, 'price' | 'free'>
  /** Stops the run once it has spent more, US dollars. */
  limit?: number
  /** As the person has them; the test turns off what only a person can answer. */
  settings?: Partial<AgentSettings>
  sandbox?: Sandbox
  workDir?: string
  signal?: AbortSignal
  onProgress?(progress: TestProgress): void
  now?: () => Date
}

/** Nobody answers during a test, and the model is the only one: what would wait for a person or another model is off. */
const UNATTENDED: Partial<AgentSettings> = {
  askAgain: 'off',
  learnConventions: 'off',
  offerStronger: 'off',
  computer: false,
}

export async function runModelTest(options: ModelTestOptions): Promise<ModelTestResult> {
  const started = Date.now()
  const plan = testPlan(options.tasks)
  const stop = new AbortController()
  let stopped: ModelTestResult['stopped']
  const onAbort = () => {
    stopped ??= 'cancelled'
    stop.abort()
  }
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  const spent = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    costKnown: true,
  }
  const charge = (outcome: CompletionOutcome) => {
    spent.requests++
    if (outcome.kind !== 'done') return
    const { usage } = outcome
    spent.inputTokens += usage.inputTokens
    spent.outputTokens += usage.outputTokens
    if (usage.cost !== undefined) spent.cost += usage.cost
    else if (options.budget.free) spent.cost += 0
    else if (options.budget.price) spent.cost += (usage.inputTokens * options.budget.price.input + usage.outputTokens * options.budget.price.output) / 1_000_000
    else spent.costKnown = false
    if ((options.limit !== undefined && spent.cost > options.limit) || spent.requests >= MAX_TEST_REQUESTS) {
      stopped ??= 'limit'
      stop.abort()
    }
  }
  const client: ModelClient = {
    budget: (role, query) => options.client.budget(role, query),
    async complete(request: CompletionRequest) {
      const outcome = await options.client.complete(request)
      charge(outcome)
      return outcome
    },
  }

  const items: TestItem[] = []
  const settings = { ...options.settings, ...UNATTENDED }
  try {
    for (const [index, step] of plan.entries()) {
      if (stop.signal.aborted) break
      options.onProgress?.({
        done: index,
        total: plan.length,
        current: { id: step.id, title: step.title, skill: step.skill },
        cost: spent.cost,
      })
      const before = { requests: spent.requests, cost: spent.cost }
      let item: TestItem
      if (step.task) {
        const run = await runTask(step.task, {
          client,
          programs: options.programs,
          ...(options.programEnv ? { programEnv: options.programEnv } : {}),
          settings,
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.workDir ? { workDir: options.workDir } : {}),
          signal: stop.signal,
        })
        item = {
          id: step.id,
          skill: step.skill,
          title: step.title,
          outcome: run.outcome,
          ...(run.reason ? { reason: run.reason } : run.outcome === 'failed' ? { reason: notMet(run.checks) } : {}),
          requests: 0,
          cost: 0,
        }
      } else {
        item = await reviewItem(step.probe!, step, client, stop.signal)
      }
      item.requests = spent.requests - before.requests
      item.cost = spent.cost - before.cost
      // A run cut short by the stop is not the model's failure: it was not measured.
      if (stop.signal.aborted && item.outcome === 'failed') item.outcome = 'error'
      items.push(item)
      options.onProgress?.({
        done: index + 1,
        total: plan.length,
        last: item,
        cost: spent.cost,
      })
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }

  const skills: ModelTestResult['skills'] = {}
  for (const item of items) {
    if (item.outcome !== 'passed' && item.outcome !== 'failed') continue
    const score = (skills[item.skill] ??= { passed: 0, total: 0 })
    score.total++
    if (item.outcome === 'passed') score.passed++
  }
  return {
    ref: options.ref,
    model: options.model,
    at: (options.now?.() ?? new Date()).toISOString(),
    skills,
    items,
    requests: spent.requests,
    inputTokens: spent.inputTokens,
    outputTokens: spent.outputTokens,
    cost: spent.cost,
    costKnown: spent.costKnown,
    durationMs: Date.now() - started,
    ...(stopped ? { stopped } : {}),
  }
}

/** What a failed task missed, in the words of its checks: "Not met: the project's tests pass, the tests are left alone." */
function notMet(checks: readonly CheckResult[]): string {
  const missed = checks.filter((check) => !check.passed).map((check) => check.name)
  return missed.length ? `Not met: ${missed.join(', ')}.` : 'Not met.'
}

async function reviewItem(probe: ReviewProbe, step: { id: string; title: string; skill: Skill }, client: ModelClient, signal: AbortSignal): Promise<TestItem> {
  const base = {
    id: step.id,
    skill: step.skill,
    title: step.title,
    requests: 0,
    cost: 0,
  }
  try {
    const result = await reviewChanges(client, probe.input, signal)
    if (probe.passes(result)) return { ...base, outcome: 'passed' }
    return {
      ...base,
      outcome: 'failed',
      reason: probe.id === 'review-sound-change' ? 'It sent a sound change back as broken.' : 'It did not find the bug as serious.',
    }
  } catch (error) {
    if (signal.aborted) return { ...base, outcome: 'error', reason: 'The test was stopped.' }
    const message = error instanceof Error ? error.message : String(error)
    // An answer eNCode cannot read is the model's failure; a model that could not be reached says nothing of it.
    const unread = /did not answer in the form eNCode reads/.test(message)
    return { ...base, outcome: unread ? 'failed' : 'error', reason: message }
  }
}
