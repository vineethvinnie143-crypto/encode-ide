/**
 * One run of one task, on the agent host the desktop app uses: the same Workspaces scope (rules, checkpoints, the
 * code index), the same shells and the same tools, in a folder of its own with a home of its own, so the person's
 * ENCODE.md, skills and settings never take part. Nobody is there to answer: commands the task allows run, every
 * other approval is declined with a note, and a question gets told to choose.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentHost, DEFAULT_SETTINGS, type AgentEvent, type AgentSettings, type ConversationEntry, type ProblemCode } from '@encode/core'
import type { ModelClient } from '@encode/providers'
import type { Sandbox } from '@encode/sandbox'
import type { WebAccess } from '@encode/tools'
import { Workspaces } from '@encode/workspace'
import { benchEnvironment, runChecks, type CheckResult } from './checks'
import { meteredClient, type MeteredClient, type ModelCall } from './meter'
import { changesBetween, copyProject, snapshot, type FileChanges } from './project'
import type { ProgramEnv, Programs } from './programs'
import type { BenchTask, ReplayResult } from './task'

export type RunOutcome = 'passed' | 'failed' | 'error' | 'skipped'

export interface RunMetrics {
  /** Model calls, of every role. */
  requests: number
  byRole: Record<string, number>
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  /** US dollars, summed over the calls whose provider said; `costReported` of `requests` did. */
  cost: number
  costReported: number
  /** What answered, `provider:model`. */
  models: string[]
  toolCalls: number
  /** Calls that failed other than commands: a missing match, a bad input, a file not there. */
  toolFailures: number
  /** Commands that exited with an error, which includes a test run that fails before the fix. */
  commandFailures: number
  byTool: Record<string, { calls: number; failed: number }>
  /** Edit and MultiEdit calls that found nothing to change. */
  editMisses: number
  /** Characters of tool results the models were sent: Read's, and every tool's together. */
  readChars: number
  toolChars: number
  /** Approvals the benchmark declined: commands the task does not allow, writes outside the project. */
  declined: number
  questions: number
  durationMs: number
}

export interface TaskRun {
  task: string
  attempt: number
  outcome: RunOutcome
  /** Why the run could not be measured, or why it was skipped. */
  reason?: string
  /** The turn was cut short. */
  stopped?: 'timeout' | 'cancelled'
  checks: CheckResult[]
  changes: FileChanges
  reply: string
  metrics: RunMetrics
  /** The calls one by one, for a closer look at a run that went wrong. */
  calls: ModelCall[]
  /** Each tool call in order and whether it did its job; `declined` when the benchmark said no to it. */
  tools: (ReplayResult & { declined?: true })[]
}

export interface RunOptions {
  client: ModelClient
  programs: Programs
  programEnv?: ProgramEnv
  attempt?: number
  /** Where the run's folders go. Default: the system's temporary folder. */
  workDir?: string
  /** Leaves the run's folders in place, to look at what the agent did. */
  keep?: boolean
  /** The operating-system sandbox for the agent's commands, as in the app. */
  sandbox?: Sandbox
  settings?: Partial<AgentSettings>
  /** How long the turn may take, over the task's own limit. */
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?(event: AgentEvent): void
  /** Where a kept run's folder is said. */
  onKept?(dir: string): void
}

const DECLINED =
  'No one is watching this benchmark run, and it allows only the commands the task names. Do the task without this call, or with one of those commands.'
const NO_ONE = 'No one can answer during this benchmark run. Choose what fits the request best, say what you chose, and go on.'
/** Problems that say the model could not be reached, not that it did the task badly. */
const NOT_MEASURED: ReadonlySet<ProblemCode> = new Set(['rate-limit', 'quota', 'payment', 'auth', 'network', 'unavailable', 'no-model', 'refused', 'host', 'internal'])

/** The benchmark has no web: a task must not depend on what a site says today. */
const OFFLINE: WebAccess = {
  fetch: async () => {
    throw new Error('The benchmark runs without the web.')
  },
  search: async () => {
    throw new Error('The benchmark runs without the web.')
  },
}

const EMPTY_CHANGES: FileChanges = { added: [], changed: [], removed: [] }

/** The tools whose failure is a command's exit code. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'BashOutput'])

function metricsOf(entries: Iterable<ConversationEntry>, client: Pick<MeteredClient, 'calls' | 'resultChars'>, declined: number, questions: number, durationMs: number): RunMetrics {
  const calls = client.calls
  const metrics: RunMetrics = {
    requests: calls.length,
    byRole: {},
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    costReported: 0,
    models: [],
    toolCalls: 0,
    toolFailures: 0,
    commandFailures: 0,
    byTool: {},
    editMisses: 0,
    readChars: client.resultChars.Read ?? 0,
    toolChars: Object.values(client.resultChars).reduce((all, chars) => all + chars, 0),
    declined,
    questions,
    durationMs,
  }
  const models = new Set<string>()
  for (const call of calls) {
    metrics.byRole[call.role] = (metrics.byRole[call.role] ?? 0) + 1
    metrics.inputTokens += call.inputTokens
    metrics.cachedTokens += call.cachedTokens
    metrics.outputTokens += call.outputTokens
    metrics.reasoningTokens += call.reasoningTokens
    if (call.cost !== undefined) {
      metrics.cost += call.cost
      metrics.costReported++
    }
    if (call.model) models.add(call.model)
  }
  metrics.models = [...models].sort()
  for (const entry of entries) {
    const tool = entry.tool
    if (entry.kind !== 'tool' || !tool) continue
    const counts = (metrics.byTool[tool.name] ??= { calls: 0, failed: 0 })
    counts.calls++
    metrics.toolCalls++
    // Declined calls are counted where they are declined; the rest failed on their own.
    const failed = tool.ok === false && tool.state !== 'rejected'
    if (!failed) continue
    counts.failed++
    if (COMMAND_TOOLS.has(tool.name)) {
      metrics.commandFailures++
      continue
    }
    metrics.toolFailures++
    if (tool.name === 'Edit' || tool.name === 'MultiEdit') metrics.editMisses++
  }
  return metrics
}

export function emptyMetrics(): RunMetrics {
  return metricsOf([], { calls: [], resultChars: {} }, 0, 0, 0)
}

/** The run of a task that cannot run here, such as one whose checks need a program this machine lacks. */
export function skippedRun(task: BenchTask, reason: string, attempt = 1): TaskRun {
  return { task: task.id, attempt, outcome: 'skipped', reason, checks: [], changes: EMPTY_CHANGES, reply: '', metrics: emptyMetrics(), calls: [], tools: [] }
}

export async function runTask(task: BenchTask, options: RunOptions): Promise<TaskRun> {
  const attempt = options.attempt ?? 1
  const missing = task.requires.filter((program) => !options.programs[program])
  if (missing.length) return skippedRun(task, `needs ${missing.join(' and ')}, which this machine does not have`, attempt)

  // By its real path, the one the agent host works in: Windows can name the temporary folder in its short form.
  const base = await fs.realpath(await fs.mkdtemp(path.join(options.workDir ?? os.tmpdir(), `encode-bench-${task.id}-`)))
  try {
    return await runIn(base, task, options, attempt)
  } finally {
    if (options.keep) options.onKept?.(base)
    else await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}

function toolsOf(entries: Iterable<ConversationEntry>): TaskRun['tools'] {
  const out: TaskRun['tools'] = []
  for (const entry of entries) {
    const tool = entry.tool
    if (entry.kind !== 'tool' || !tool) continue
    out.push({ tool: tool.name, ok: tool.ok !== false, ...(tool.state === 'rejected' ? { declined: true as const } : {}) })
  }
  return out
}

async function runIn(base: string, task: BenchTask, options: RunOptions, attempt: number): Promise<TaskRun> {
  // The folder is named after the task: the agent sees its name, and a temporary folder's name says nothing.
  const root = path.join(base, task.id)
  const home = path.join(base, 'home')
  const dir = path.join(base, 'sessions')
  await copyProject(task, root)
  await fs.mkdir(path.join(home, '.encode'), { recursive: true })
  await fs.mkdir(dir, { recursive: true })
  // The commands the task allows are the person's own rules, so they are judged as a person's rules are.
  await fs.writeFile(path.join(home, '.encode', 'settings.json'), `${JSON.stringify({ permissions: { allow: task.allow } }, null, 2)}\n`)
  const before = await snapshot(root)

  const client = meteredClient(options.client)
  const entries = new Map<string, ConversationEntry>()
  let declined = 0
  let questions = 0
  let problem: { message: string; code?: ProblemCode } | undefined
  let host: AgentHost | undefined
  let workspaces: Workspaces | undefined
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, policy: 'workspace-write', computer: false, ...options.settings, maxSteps: task.maxSteps }
  const started = Date.now()
  let stopped: TaskRun['stopped']
  try {
    workspaces = new Workspaces({ home, checkpoints: { dir: path.join(base, 'checkpoints') }, ...(options.sandbox ? { sandbox: options.sandbox } : {}), transcriptPath: (id) => path.join(dir, `${id}.jsonl`) })
    const created: AgentHost = new AgentHost({
      dir,
      home,
      workspace: root,
      client,
      settings: () => settings,
      emit: (event) => {
        options.onEvent?.(event)
        if (event.type === 'entry') entries.set(event.entry.id, event.entry)
        else if (event.type === 'approval-request') {
          declined++
          setImmediate(() => created.approve(event.request.id, { approved: false, note: DECLINED }))
        } else if (event.type === 'ask') {
          questions++
          setImmediate(() => created.answer(event.id, NO_ONE))
        } else if (event.type === 'error') problem ??= { message: event.message, ...(event.problem ? { code: event.problem.code } : {}) }
      },
      scope: workspaces.scope,
      web: OFFLINE,
      shell: { baseEnv: benchEnvironment() },
      nameSessions: false,
    })
    host = created
    const session = await created.create({ projectRoot: root })
    const timer = setTimeout(() => {
      stopped = 'timeout'
      created.cancel(session.id)
    }, options.timeoutMs ?? task.timeoutMs)
    const cancel = () => {
      stopped ??= 'cancelled'
      created.cancel(session.id)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      await created.start(session.id, { text: task.prompt, mode: 'code' })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
  } finally {
    // Background commands end with the host, and files are closed, before anything is checked.
    await host?.dispose().catch(() => undefined)
    await workspaces?.close().catch(() => undefined)
  }
  const durationMs = Date.now() - started

  const reply = [...entries.values()].filter((entry) => entry.kind === 'assistant' && entry.text?.trim()).at(-1)?.text ?? ''
  const after = await snapshot(root)
  const metrics = metricsOf(entries.values(), client, declined, questions, durationMs)
  const checks =
    stopped === 'cancelled'
      ? []
      : await runChecks(task, {
          root,
          checksDir: path.join(task.dir, 'checks'),
          programs: options.programs,
          before,
          reply,
          toolFailures: metrics.toolFailures,
          ...(options.programEnv ? { programEnv: options.programEnv } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
  const notMeasured = problem?.code !== undefined && NOT_MEASURED.has(problem.code)
  // A check that could not start says nothing about the model.
  const unrun = checks.find((check) => check.unrun)
  const outcome: RunOutcome = notMeasured || stopped === 'cancelled' || unrun ? 'error' : checks.every((check) => check.passed) ? 'passed' : 'failed'
  return {
    task: task.id,
    attempt,
    outcome,
    ...(notMeasured
      ? { reason: problem!.message }
      : stopped === 'cancelled'
        ? { reason: 'The run was stopped.' }
        : unrun
          ? { reason: `A check could not run (${unrun.name}): ${unrun.detail}` }
          : problem
            ? { reason: problem.message }
            : {}),
    ...(stopped ? { stopped } : {}),
    checks,
    changes: changesBetween(before, after),
    reply: reply.length > 4_000 ? `${reply.slice(0, 4_000)}…` : reply,
    metrics,
    calls: client.calls,
    tools: toolsOf(entries.values()),
  }
}
