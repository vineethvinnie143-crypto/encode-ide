/**
 * The benchmark from a terminal (scripts/bench.mjs):
 *
 *   bench list                                   the tasks, and what this machine can run
 *   bench run --reference                        each task's reference run: proves the tasks, needs no model
 *   bench run --model openrouter:qwen/qwen3-coder [--repeat 3] [--only a,b] [--tag python] [--out file.json]
 *   bench run --model @free                      OpenRouter's free models, as eNCode's free tier picks them
 *   bench run --model anthropic:<id> | openai:<id>
 *   bench run --base-url http://localhost:11434/v1 --model qwen2.5-coder   any OpenAI-compatible server
 *   bench show report.json
 *   bench compare before.json after.json [--fail-on-regression] [--gate 25]
 *                                                with 3 runs a task or more, only a drop beyond chance counts; --gate
 *                                                passes a change that is 25% cheaper per task solved at equal accuracy
 *   bench replay report.json [--save <name>]    a report of a request (ADR 0092), played again on this eNCode; with
 *                                                --save, kept as the task replay-<name> (also: pnpm turn-report)
 *
 * Run options: --tasks <folder> (default: the built-in tasks), --keep (leave each run's folder, to look at what the
 * agent did), --sandbox (commands in the operating-system sandbox), --timeout <seconds> per run, --window <tokens> (every
 * run held to that much context: with 16000, shortening and summaries run in every task, so a run compared with a
 * normal one shows what compaction costs in accuracy), --effort <low|medium|high|xhigh|max> (the reasoning effort every
 * step asks for), --light-steps (steps that read results think at low effort, ADR 0135: compared with a run at the same
 * --effort without it, it shows what that saves and whether the pass rate holds), --max-cost <dollars> (a hard stop on
 * what the bench spends, ADR 0137: it adds up what the provider billed for every call and stops at the cap; a round
 * starts only when what is left pays for one like the last), --pair light-steps (every task run with and without light
 * steps, side by side, into two reports and their comparison; with --gate, it ends once the result is clear).
 *
 * Keys are read from the environment only: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, and
 * ENCODE_BENCH_API_KEY for --base-url. They are never printed, never given to the agent's commands, and taken out of
 * anything written to a report.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readTurnReport, type TurnReport } from '@encode/core'
import type { ModelClient, ReasoningEffort } from '@encode/providers'
import { createAnthropicAdapter, createOpenAICompatibleAdapter, createOpenRouterAdapter, redactSecrets, spendingCap, type SpendingCap } from '@encode/providers'
import { createRouter, parseRouterConfig, staticKeys } from '@encode/router'
import { Sandbox } from '@encode/sandbox'
import { runBench, runPair } from './bench'
import { findPrograms } from './programs'
import { formatReplay, replayReport, writeReplayTask } from './replay'
import { compareReports, formatReport, gate, MIN_RUNS, parseReport, type BenchReport } from './report'
import type { TaskRun } from './run'
import { readTasks, type BenchTask } from './task'

export interface CliContext {
  /** The repository: where the built-in tasks are. */
  root: string
  env: NodeJS.ProcessEnv
  print(text: string): void
  /** Whatever the bench should stop on, such as Ctrl+C. */
  signal?: AbortSignal
  /** For tests: the model client a run uses instead of one made from --model. */
  client?: ModelClient
  now?: () => Date
}

class UsageError extends Error {}

/** Text from a run as plain lines: a control or direction character in a reply or a test's output would change the terminal. */
export const plain = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, '?')

interface Flags {
  positional: string[]
  values: Map<string, string>
  switches: Set<string>
}

const VALUED = new Set(['--model', '--base-url', '--tasks', '--only', '--tag', '--repeat', '--out', '--timeout', '--save', '--gate', '--window', '--effort', '--max-cost', '--pair'])
const SWITCHES = new Set(['--reference', '--keep', '--sandbox', '--fail-on-regression', '--light-steps', '--help', '-h'])
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { positional: [], values: new Map(), switches: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (VALUED.has(arg)) {
      const value = argv[++index]
      if (value === undefined || !value.trim() || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      flags.values.set(arg, value)
    } else if (SWITCHES.has(arg)) flags.switches.add(arg)
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`)
    else flags.positional.push(arg)
  }
  return flags
}

const KEY_NAMES: Record<string, string> = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }

/** The router eNCode itself uses, for one model on every role, with the key from the environment. */
async function liveClient(model: string, baseUrl: string | undefined, env: NodeJS.ProcessEnv): Promise<{ client: ModelClient; secrets: string[] }> {
  let providers: Record<string, unknown>
  let provider: string
  let ref: string
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new UsageError(`--base-url ${baseUrl} is not an address`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base-url must be an http or https address')
    provider = 'bench'
    providers = { bench: { type: 'openai-compatible', baseUrl: baseUrl.replace(/\/+$/, '') } }
    ref = `bench:${model}`
  } else if (model === '@free') {
    provider = 'openrouter'
    providers = { openrouter: { type: 'openrouter' } }
    ref = '@free'
  } else {
    const at = model.indexOf(':')
    provider = at > 0 ? model.slice(0, at) : ''
    if (!KEY_NAMES[provider] || at === model.length - 1) throw new UsageError(`--model is openrouter:<id>, anthropic:<id>, openai:<id> or @free, or a model of --base-url; not ${model}`)
    providers = { [provider]: provider === 'openai' ? { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' } : { type: provider } }
    ref = model
  }
  const keyName = provider === 'bench' ? 'ENCODE_BENCH_API_KEY' : KEY_NAMES[provider]!
  const key = env[keyName] ?? ''
  if (!key && provider !== 'bench') throw new UsageError(`Set ${keyName} to run ${model}. It is read from the environment only, and never written anywhere.`)
  const { config, problems } = parseRouterConfig({ providers, roles: { main: [ref] }, freeOnly: ref === '@free' })
  if (problems.length) throw new UsageError(problems.map((problem) => `${problem.path}: ${problem.message}`).join('; '))
  const router = createRouter({
    config,
    adapters: [createOpenRouterAdapter(), createOpenAICompatibleAdapter(), createAnthropicAdapter()],
    keys: staticKeys(key ? { [provider]: key } : {}),
  })
  await router.refresh()
  return { client: router, secrets: key ? [key] : [] }
}

function selectTasks(tasks: BenchTask[], flags: Flags): BenchTask[] {
  const only = flags.values.get('--only')?.split(',').map((id) => id.trim()).filter(Boolean)
  const tag = flags.values.get('--tag')
  const unknown = only?.filter((id) => !tasks.some((task) => task.id === id)) ?? []
  if (unknown.length) throw new UsageError(`no task ${unknown.join(', ')}`)
  const chosen = tasks.filter((task) => (!only || only.includes(task.id)) && (!tag || task.tags.includes(tag)))
  if (!chosen.length) throw new UsageError('no task matches')
  return chosen
}

function count(flags: Flags, name: string, min: number, max: number): number | undefined {
  const value = flags.values.get(name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`${name} is a whole number from ${min} to ${max}`)
  return number
}

/** Dollars, for --max-cost: above 0 and at most 1,000. */
function money(flags: Flags, name: string): number | undefined {
  const value = flags.values.get(name)
  if (value === undefined) return undefined
  const number = Number(value.replace(/^\$/, ''))
  if (!Number.isFinite(number) || number <= 0 || number > 1_000) throw new UsageError(`${name} is a number of dollars above 0, such as 2.90`)
  return number
}

/** What a pair of runs compares (--pair): the setting the second run adds. */
const PAIRS = { 'light-steps': { settings: { lightSteps: true }, names: ['light-off', 'light-on'] } } as const

const NEVER_LIGHT =
  'no step was light in the runs with light steps: the model cannot change its effort between steps without losing its cache, or it does not reason (ADR 0135)'

/**
 * When a pair has its answer: light steps that never happen leave nothing to compare, so after two runs that had a step
 * to make light; and from MIN_RUNS rounds on, a pass rate that fell beyond chance, or, with --gate, a gate passed.
 */
function pairDecided(cut: number | undefined) {
  return (reports: readonly BenchReport[], round: number, roundDone: boolean): string | undefined => {
    const [before, after] = reports as [BenchReport, BenchReport]
    if (round === 1 && !after.runs.some((run) => run.calls.some((call) => call.light)) && after.runs.filter((run) => run.metrics.requests > 2).length >= 2) return NEVER_LIGHT
    if (!roundDone || round < MIN_RUNS) return undefined
    const comparison = compareReports(before, after)
    if (comparison.regressions.length) return `with light steps, tasks passed less often beyond chance (${comparison.regressions.join(', ')})`
    if (cut !== undefined && gate(comparison, cut / 100).passed) return `light steps passed the gate: at least ${cut}% cheaper per task solved, at equal accuracy`
    return undefined
  }
}

const slugOf = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model'

function runLine(run: TaskRun, label = '', cap?: SpendingCap): string {
  const mark = run.outcome === 'passed' ? '✓' : run.outcome === 'failed' ? '✗' : run.outcome === 'skipped' ? '–' : '!'
  const cost = run.metrics.costReported ? `, $${run.metrics.cost.toFixed(4)}` : ''
  const facts = run.outcome === 'skipped' ? (run.reason ?? '') : `${run.metrics.requests} calls, ${Math.round(run.metrics.inputTokens / 1000)}k in, ${Math.round(run.metrics.outputTokens / 1000)}k out${cost}, ${(run.metrics.durationMs / 1000).toFixed(1)} s`
  const why = run.outcome === 'failed' ? `: ${run.checks.filter((check) => !check.passed).map((check) => check.name).join('; ')}` : run.outcome === 'error' ? `: ${run.reason ?? 'error'}` : ''
  const spent = cap ? `  [$${cap.spent().toFixed(2)} of $${cap.limit.toFixed(2)}]` : ''
  return plain(`${mark} ${run.task} #${run.attempt}${label}  ${facts}${why}${spent}`)
}

async function readReport(file: string): Promise<BenchReport> {
  const text = await fs.readFile(path.resolve(file), 'utf8').catch((error: Error) => {
    throw new UsageError(`cannot read ${file}: ${error.message}`)
  })
  try {
    return parseReport(JSON.parse(text))
  } catch (error) {
    throw new UsageError(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function run(flags: Flags, context: CliContext): Promise<number> {
  const reference = flags.switches.has('--reference')
  const model = flags.values.get('--model')
  if (reference === Boolean(model)) throw new UsageError('give --model <model> or --reference')
  const repeat = count(flags, '--repeat', 1, 20) ?? 1
  const timeout = count(flags, '--timeout', 10, 3_600)
  const window = count(flags, '--window', 12_000, 1_000_000)
  const effort = flags.values.get('--effort') as ReasoningEffort | undefined
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new UsageError(`--effort is one of ${EFFORTS.join(', ')}`)
  const light = flags.switches.has('--light-steps')
  const maxCost = money(flags, '--max-cost')
  const pairName = flags.values.get('--pair')
  if (pairName !== undefined && !Object.hasOwn(PAIRS, pairName)) throw new UsageError(`--pair is one of ${Object.keys(PAIRS).join(', ')}`)
  const pair = pairName === undefined ? undefined : PAIRS[pairName as keyof typeof PAIRS]
  if (pair && light) throw new UsageError('--pair light-steps runs every task with and without light steps: leave out --light-steps')
  const cut = count(flags, '--gate', 1, 90)
  if (cut !== undefined && !pair) throw new UsageError('--gate goes with compare, or with run --pair')
  const settings = { ...(window ? { contextCap: window } : {}), ...(effort ? { reasoning: effort } : {}), ...(light ? { lightSteps: true } : {}) }
  const dir = path.resolve(flags.values.get('--tasks') ?? path.join(context.root, 'packages', 'bench', 'tasks'))
  const { tasks, broken } = await readTasks(dir)
  for (const error of broken) context.print(plain(`skipping ${error.message}`))
  const chosen = selectTasks(tasks, flags)

  const live = reference ? undefined : context.client ? { client: context.client, secrets: [] } : await liveClient(model!, flags.values.get('--base-url'), context.env)
  let sandbox: Sandbox | undefined
  if (flags.switches.has('--sandbox')) {
    sandbox = new Sandbox({ dir: path.join(os.tmpdir(), 'encode-bench-sandbox') })
    const status = await sandbox.start()
    if (status.state !== 'active') throw new UsageError(`there is no working sandbox here: ${status.reason ?? status.state}`)
  }
  const name = reference ? 'reference' : flags.values.get('--base-url') ? `${model} at ${flags.values.get('--base-url')}` : model!
  const how = `${window ? `, in a ${Math.round(window / 1000)}k window` : ''}${effort ? `, at ${effort} effort` : ''}${light ? ', with light steps' : ''}${pair ? `, with and without ${pairName}` : ''}`
  const cap = maxCost === undefined ? undefined : spendingCap(maxCost)
  context.print(`${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'}${repeat > 1 ? `, ${repeat} runs each` : ''}, on ${name}${how}${cap ? `, stopping at $${cap.limit.toFixed(2)}` : ''}`)
  const options = {
    client: live?.client ?? ('reference' as const),
    model: name,
    repeat,
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
    ...(flags.switches.has('--keep') ? { keep: true, onKept: (kept: string) => context.print(`  kept in ${kept}`) } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.now ? { now: context.now } : {}),
    ...(cap ? { cap } : {}),
    ...(repeat > 1 ? { onRound: (round: number) => context.print(`Round ${round} of ${repeat}`) } : {}),
    onRun: (done: TaskRun, _task: BenchTask, setup: number) => context.print(runLine(done, pair ? ` ${pair.names[setup]}` : '', cap)),
  }
  const reports = pair ? await runPair(chosen, { ...options, stopIf: pairDecided(cut) }, pair.settings) : [await runBench(chosen, options)]
  const stamp = reports[0]!.startedAt.replace(/[:.]/g, '-')
  const given = flags.values.get('--out')
  const base = path.resolve(given ?? path.join('bench-results', `${slugOf(reference ? 'reference' : model!)}-${stamp}.json`))
  const outs = pair ? pair.names.map((suffix) => base.replace(/(\.json)?$/i, `-${suffix}.json`)) : [base]
  await fs.mkdir(path.dirname(base), { recursive: true })
  for (const [index, report] of reports.entries()) {
    // A key can reach a report only by being echoed, by a provider or a model; it is taken out either way.
    await fs.writeFile(outs[index]!, `${redactSecrets(JSON.stringify(report, null, 2), live?.secrets ?? [])}\n`)
  }
  context.print('')
  if (pair) {
    const comparison = compareReports(reports[0]!, reports[1]!)
    context.print(plain(comparison.text))
    const { spending, endedEarly } = reports[0]!
    if (spending) context.print(`Spent $${spending.spent.toFixed(2)} of the $${spending.limit.toFixed(2)} cap`)
    if (endedEarly) context.print(plain(`Ended early: ${endedEarly}`))
    const verdict = cut === undefined ? undefined : gate(comparison, cut / 100)
    if (verdict) {
      context.print('')
      context.print(verdict.passed ? `Gate passed: at least ${cut}% cheaper per task solved, at equal accuracy.` : plain(`Gate not passed:\n${verdict.reasons.map((reason) => `- ${reason}`).join('\n')}`))
    }
    context.print('')
    context.print(`Reports: ${outs.join(', ')}`)
    return comparison.regressions.length || verdict?.passed === false ? 1 : 0
  }
  context.print(plain(formatReport(reports[0]!)))
  context.print('')
  context.print(`Report: ${outs[0]}`)
  return reports[0]!.runs.some((done) => done.outcome === 'failed' || done.outcome === 'error') ? 1 : 0
}

/** The largest report read: its files are at most 4 MB, and its steps carry what the model sent. */
const MAX_TURN_REPORT_BYTES = 64 * 1024 * 1024

async function readTurnReportFile(file: string): Promise<TurnReport> {
  const resolved = path.resolve(file)
  const stat = await fs.stat(resolved).catch((error: Error) => {
    throw new UsageError(`cannot read ${file}: ${error.message}`)
  })
  if (stat.size > MAX_TURN_REPORT_BYTES) throw new UsageError(`${file} is larger than a report can be`)
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(resolved, 'utf8'))
  } catch (error) {
    throw new UsageError(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const report = readTurnReport(value)
  if (typeof report === 'string') throw new UsageError(`${file}: ${report}`)
  return report
}

const firstLine = (text: string) => {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

async function replay(flags: Flags, context: CliContext): Promise<number> {
  if (flags.positional.length !== 1) throw new UsageError('replay takes one report of a request')
  const save = flags.values.get('--save')
  if (save !== undefined && !/^[a-z0-9][a-z0-9-]{0,51}$/.test(save)) throw new UsageError('--save takes a short name of lower-case letters, digits and dashes')
  const report = await readTurnReportFile(flags.positional[0]!)
  const failed = report.results.filter((result) => !result.ok).length
  const { usage } = report
  context.print(plain(`Report of a request, made ${report.createdAt} on ${report.build} (${report.system})`))
  if (report.description.trim()) context.print(plain(`What went wrong: ${firstLine(report.description)}`))
  context.print(plain(`Request${report.scrambled ? ' (words replaced)' : ''}: ${firstLine(report.prompt)}`))
  context.print(plain(`${report.models.join(', ') || 'no model named'}: ${usage.requests} calls, ${Math.round(usage.inputTokens / 1000)}k in, ${Math.round(usage.outputTokens / 1000)}k out`))
  const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  context.print(plain(`${counted(report.steps.length, 'step', 'steps')}, ${counted(report.results.length, 'tool call', 'tool calls')} (${failed} failed), ${counted(report.files.length, 'file', 'files')}${report.left.length ? `; left out: ${report.left.join('; ')}` : ''}`))
  context.print('')
  const outcome = await replayReport(report, context.signal ? { signal: context.signal } : {})
  context.print(plain(formatReplay(outcome.comparison)))
  if (save) {
    const tasksDir = path.resolve(flags.values.get('--tasks') ?? path.join(context.root, 'packages', 'bench', 'tasks'))
    const kept = await writeReplayTask(report, `replay-${save}`, tasksDir).catch((error: Error) => {
      throw new UsageError(error.message)
    })
    context.print('')
    context.print(plain(`Kept as ${path.relative(process.cwd(), kept.dir) || kept.dir}. Its task.json checks only that no tool call failed: add the checks that say what the request asked for.`))
    for (const note of kept.notes) context.print(plain(`  ${note}`))
  }
  return 0
}

async function list(flags: Flags, context: CliContext): Promise<number> {
  const { tasks, broken } = await readTasks(path.resolve(flags.values.get('--tasks') ?? path.join(context.root, 'packages', 'bench', 'tasks')))
  const programs = await findPrograms(tasks.flatMap((task) => task.requires))
  const width = Math.max(...tasks.map((task) => task.id.length))
  for (const task of tasks) {
    const missing = task.requires.filter((program) => !programs[program])
    context.print(plain(`${task.id.padEnd(width)}  ${task.title}  [${task.tags.join(', ')}]${missing.length ? `  (needs ${missing.join(', ')})` : ''}`))
  }
  for (const error of broken) context.print(plain(`cannot read ${error.message}`))
  return broken.length ? 1 : 0
}

export async function main(argv: readonly string[], context: CliContext): Promise<number> {
  try {
    const [command, ...rest] = argv
    const flags = parseFlags(rest)
    if (!command || command === '--help' || command === '-h' || flags.switches.has('--help') || flags.switches.has('-h')) {
      context.print('Usage: bench list | run (--reference | --model <model>) [options] | show <report> | compare <before> <after> [--fail-on-regression] [--gate <percent>] | replay <request report> [--save <name>]. See packages/bench/src/cli.ts.')
      return command ? 0 : 2
    }
    switch (command) {
      case 'list':
        return await list(flags, context)
      case 'run':
        return await run(flags, context)
      case 'show': {
        if (flags.positional.length !== 1) throw new UsageError('show takes one report')
        context.print(plain(formatReport(await readReport(flags.positional[0]!))))
        return 0
      }
      case 'compare': {
        if (flags.positional.length !== 2) throw new UsageError('compare takes two reports, before and after')
        const cut = count(flags, '--gate', 1, 90)
        const comparison = compareReports(await readReport(flags.positional[0]!), await readReport(flags.positional[1]!))
        context.print(plain(comparison.text))
        if (cut !== undefined) {
          const verdict = gate(comparison, cut / 100)
          context.print('')
          context.print(verdict.passed ? `Gate passed: at least ${cut}% cheaper per task solved, at equal accuracy.` : plain(`Gate not passed:\n${verdict.reasons.map((reason) => `- ${reason}`).join('\n')}`))
          if (!verdict.passed) return 1
        }
        return flags.switches.has('--fail-on-regression') && comparison.regressions.length ? 1 : 0
      }
      case 'replay':
        return await replay(flags, context)
      default:
        throw new UsageError(`unknown command ${command}`)
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    context.print(plain(`bench: ${error.message}`))
    return 2
  }
}
