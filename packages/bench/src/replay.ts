/**
 * A report of a request (ADR 0092) as a benchmark task: its files as the project, its request as the prompt, and the
 * model's steps to play again on this eNCode. Played, it shows call by call what the tools did then and do now. Kept,
 * it is a task like the others, whose replay.json says what each call should do, so a fix stays fixed: the tests play
 * every kept replay and fail when a call does something else.
 *
 * Commands are never run in a replay: the report comes from another computer, and what was run there is not run here.
 * The benchmark declines them like any command a task does not allow.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { THINK_FIRST, type TurnReport } from '@encode/core'
import { AS_WRITTEN, referenceClient } from './bench'
import { findPrograms } from './programs'
import { runTask, type TaskRun } from './run'
import { readTask, safeRelative, TASK_ID, type BenchTask, type ReplayResult } from './task'

/** Tools whose calls are commands: declined in a replay, so they are not compared. */
const COMMANDS: ReadonlySet<string> = new Set(['Bash', 'BashOutput', 'KillShell'])

/** git keeps no folder of this name, so a kept task holds it under another (task.json's rename). */
const KEPT_AS = { node_modules: '_node_modules' } as const

export interface ReplayRow {
  /** From 1, among the calls that are compared. */
  index: number
  tool: string
  then?: boolean
  now?: boolean | 'declined'
}

export interface ReplayComparison {
  rows: ReplayRow[]
  /** Calls that did something else now than then, or were made on one side only. */
  differs: number
}

export interface ReplayTaskFiles {
  /** Paths relative to the task's folder, with forward slashes. */
  files: Map<string, string>
  /** What a person keeping the task should know: files left out, line ends git would change. */
  notes: string[]
}

/**
 * The steps and results without the changes eNCode held until the model said what it would change (ADR 0100): they
 * never ran, and the model sent them again after saying it. A replay plays its steps as written, so it plays those.
 * A report with every word replaced keeps them, as its results no longer read as held.
 */
function withoutHeld(report: TurnReport): Pick<TurnReport, 'steps' | 'results'> {
  const held = new Set(report.results.flatMap((result, index) => (!result.ok && result.text.startsWith(THINK_FIRST) ? [index] : [])))
  if (!held.size) return report
  // Each call has its result, in order.
  let call = 0
  const steps = report.steps.flatMap((step) => {
    if (!step.calls) return [step]
    const calls = step.calls.filter(() => !held.has(call++))
    if (calls.length) return [{ ...step, calls }]
    // A step of held calls alone is left out: with nothing in it, it would end the request when played.
    return step.text ? [{ text: step.text }] : []
  })
  return { steps, results: report.results.filter((_, index) => !held.has(index)) }
}

/** The task a report makes: task.json, replay.json and the project's files. */
export function replayTaskFiles(report: TurnReport, id: string): ReplayTaskFiles {
  if (!TASK_ID.test(id)) throw new Error(`${id} is not a task name: lower-case letters, digits and dashes`)
  const notes: string[] = []
  const files = new Map<string, string>()
  const rename: Record<string, string> = {}
  for (const file of report.files) {
    const relative = safeRelative(file.path)
    if (!relative || relative.split('/').some((part) => part.toLowerCase() === '.git')) {
      notes.push(`${file.path} is left out: a task cannot hold a file there`)
      continue
    }
    const [top, ...rest] = relative.split('/')
    const kept = Object.hasOwn(KEPT_AS, top!) && rest.length ? KEPT_AS[top as keyof typeof KEPT_AS] : undefined
    if (kept) rename[kept] = top!
    files.set(`project/${kept ? [kept, ...rest].join('/') : relative}`, file.text)
    if (file.text.includes('\r\n')) notes.push(`${relative} ends its lines with CRLF; to keep them, add "packages/bench/tasks/${id}/project/${relative} text eol=crlf" to .gitattributes`)
  }
  const { steps, results } = withoutHeld(report)
  const first = report.description.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const task = {
    id,
    title: `Replay: ${first || 'a reported request'}`.slice(0, 120),
    prompt: report.prompt.trim() ? report.prompt : 'The reported request had no text.',
    tags: ['replay', ...(report.scrambled ? ['scrambled'] : [])],
    maxSteps: Math.min(200, steps.length + 1),
    ...(Object.keys(rename).length ? { rename } : {}),
    // A start: what was asked for is the person's to say, in checks like any task's.
    checks: [{ kind: 'tools', name: 'no tool call failed', failedAtMost: 0 }],
  }
  const expect: ReplayResult[] = results.filter((result) => !COMMANDS.has(result.tool)).map((result) => ({ tool: result.tool, ok: result.ok }))
  files.set('task.json', `${JSON.stringify(task, null, 2)}\n`)
  files.set('replay.json', `{\n  "steps": [\n${steps.map((step) => `    ${JSON.stringify(step)}`).join(',\n')}\n  ],\n  "expect": ${JSON.stringify(expect)}\n}\n`)
  return { files, notes }
}

/** Writes the task into a folder of tasks; never over one that is there. */
export async function writeReplayTask(report: TurnReport, id: string, tasksDir: string): Promise<{ dir: string; notes: string[] }> {
  const dir = path.join(tasksDir, id)
  if (await fs.lstat(dir).catch(() => undefined)) throw new Error(`${dir} is there already; choose another name`)
  const { files, notes } = replayTaskFiles(report, id)
  await fs.mkdir(path.join(dir, 'project'), { recursive: true })
  for (const [relative, text] of files) {
    const target = path.join(dir, ...relative.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, text, { flag: 'wx' })
  }
  return { dir, notes }
}

/** What each compared call did then and does now, in order. Commands, and calls the benchmark declined, are not compared. */
export function compareReplay(then: readonly ReplayResult[], now: TaskRun['tools']): ReplayComparison {
  const played = now.filter((call) => !COMMANDS.has(call.tool))
  const rows: ReplayRow[] = []
  let differs = 0
  for (let index = 0; index < Math.max(then.length, played.length); index++) {
    const before = then[index]
    const after = played[index]
    const row: ReplayRow = { index: index + 1, tool: before?.tool ?? after!.tool }
    if (before) row.then = before.ok
    if (after) row.now = after.declined ? 'declined' : after.ok
    if (!before || !after || before.tool !== after.tool || (row.now !== 'declined' && row.now !== row.then)) differs++
    rows.push(row)
  }
  return { rows, differs }
}

const said = (value: boolean | 'declined' | undefined) => (value === undefined ? '-' : value === 'declined' ? 'declined' : value ? 'ok' : 'failed')

/** The comparison as a table and a verdict. */
export function formatReplay(comparison: ReplayComparison): string {
  const { rows, differs } = comparison
  if (!rows.length) return 'The request made no tool calls but commands, which a replay does not run.'
  const cells = [['#', 'tool', 'then', 'now'], ...rows.map((row) => [String(row.index), row.tool, said(row.then), said(row.now)])]
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map((line) => line[column]!.length)))
  const table = cells.map((line) => line.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n')
  const verdict = differs ? `${differs} ${differs === 1 ? 'call does' : 'calls do'} something else now.` : 'Every call does what it did then.'
  const declined = rows.some((row) => row.now === 'declined') ? ' Declined calls ask for an approval no one gives in a replay, and are not compared.' : ''
  return `${table}\n\n${verdict}${declined}`
}

export interface ReplayOutcome {
  task: BenchTask
  run: TaskRun
  comparison: ReplayComparison
}

/** Plays a task's replay on this eNCode and compares each call with what replay.json expects. */
export async function playReplay(task: BenchTask, options: { workDir?: string; signal?: AbortSignal } = {}): Promise<ReplayOutcome> {
  if (!task.replay) throw new Error(`${task.id} has no replay.json`)
  const run = await runTask(task, { client: referenceClient(task)!, programs: await findPrograms([]), settings: { ...AS_WRITTEN }, ...options })
  return { task, run, comparison: compareReplay(task.replay.expect, run.tools) }
}

/** Plays a report as it is, from a task made in a temporary folder that is removed after. */
export async function replayReport(report: TurnReport, options: { workDir?: string; signal?: AbortSignal } = {}): Promise<ReplayOutcome> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(options.workDir ?? os.tmpdir(), 'encode-replay-')))
  try {
    const { dir } = await writeReplayTask(report, 'replay', base)
    return await playReplay(await readTask(dir), options)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}
