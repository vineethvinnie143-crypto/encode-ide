/**
 * A benchmark task: a small project, a request, and checks that say whether the agent did what was asked. Read from
 * a folder of its own:
 *
 *   <id>/task.json       the request, the commands the agent may run unasked, the checks
 *   <id>/project/        the project the agent works in, copied fresh for every run
 *   <id>/checks/         what the checks use and the agent never sees, such as hidden tests
 *   <id>/solution.json   a reference run: the steps of a model that solves it, which the tests play to prove the checks
 *   <id>/replay.json     instead, for a task kept from a report of a request (ADR 0092): the steps as the model sent
 *                        them, and what each call should do when they are played again
 *
 * task.json is read as untrusted, entry by entry: every problem is reported, and a task with one is not run.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ScriptedCall, ScriptedStep } from '@encode/core'
import { parseRule } from '@encode/permissions'

/** What a check may run, besides eNCode's own Node.js. */
export type Program = 'node' | 'python' | 'lua'

export const PROGRAMS: readonly Program[] = ['node', 'python', 'lua']

export type Check =
  /** Passes when the program exits with 0, such as a test run. */
  | { kind: 'command'; name: string; run: string[]; timeoutMs: number }
  /** What a file of the project must hold, or that it must not be there. */
  | { kind: 'file'; name: string; path: string; exists: boolean; includes: string[]; excludes: string[]; eol?: 'lf' | 'crlf'; json?: boolean }
  /** A pattern found, or not found, in the files of some folders. */
  | { kind: 'search'; name: string; paths: string[]; pattern: string; flags: string; expect: 'some' | 'none' }
  /** Files left as they were; every file of the project when no paths are named. */
  | { kind: 'unchanged'; name: string; paths: string[] }
  /** What the agent's last reply says, for a question that changes nothing. */
  | { kind: 'reply'; name: string; matches?: string; excludes?: string; flags: string }
  /** How the agent's tools fared: no more than so many calls failed (commands that exit with an error aside). */
  | { kind: 'tools'; name: string; failedAtMost: number }
  /** Tools the agent used to do the task, such as Debug when the request asks for the debugger: each did its job at least once. */
  | { kind: 'used'; name: string; tools: string[] }

/** One tool call of a replay, and whether it did its job. */
export interface ReplayResult {
  tool: string
  ok: boolean
}

/** The steps of a reported request, to play again on this eNCode, and what each call should do then. */
export interface Replay {
  steps: ScriptedStep[]
  /** One for each call, in order. Commands are not run in a replay and are not listed. */
  expect: ReplayResult[]
}

export interface BenchTask {
  id: string
  title: string
  prompt: string
  tags: string[]
  /** The programs the checks need; without one of them the task is skipped. */
  requires: Program[]
  maxSteps: number
  timeoutMs: number
  /** Bash rules, as a person would allow commands in their settings: what the agent may run without being asked. */
  allow: string[]
  /** Folders kept in the task under another name, because git would not keep them (`_node_modules`: `node_modules`). */
  rename: Record<string, string>
  checks: Check[]
  /**
   * The agent gets the folder's debugger (ADR 0146): the folder is trusted, as a person who debugs has trusted it, and
   * the agent's debug starts are approved, as the person would approve them. Default false.
   */
  debug: boolean
  /** The folder it was read from. */
  dir: string
  solution?: ScriptedStep[]
  replay?: Replay
}

export class TaskError extends Error {
  constructor(
    readonly dir: string,
    readonly problems: string[],
  ) {
    super(`${path.basename(dir)}: ${problems.join('; ')}`)
    this.name = 'TaskError'
  }
}

export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,59}$/
const TAG = /^[a-z0-9][a-z0-9-]{0,29}$/
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/** How a command check names its program: never a path, so a task runs the same on every machine. */
const PROGRAM_WORD: Record<string, Program> = { '{{node}}': 'node', '{{python}}': 'python', '{{lua}}': 'lua' }
const MAX_FILE_BYTES = 1024 * 1024
/** A replay carries the inputs the model sent, a whole file in a Write among them. */
const MAX_REPLAY_BYTES = 16 * 1024 * 1024

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A path inside the project, written with `/`: no `..`, no root, no drive, nothing a shell or Windows reads otherwise. */
export function safeRelative(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 300) return undefined
  if (/[\\:*?"<>|\u0000-\u001f]/.test(value) || value.startsWith('/')) return undefined
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.'))) return undefined
  return value
}

/** Reads task.json's object, collecting a problem for each entry that is not as it must be. */
export function parseTask(json: unknown, dir: string): BenchTask {
  const problems: string[] = []
  const problem = (text: string) => {
    problems.push(text)
    return undefined
  }
  if (!isObject(json)) throw new TaskError(dir, ['task.json is not an object'])

  const text = (key: string, max: number, required = true): string | undefined => {
    const value = json[key]
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string' || !value.trim()) return problem(`${key} must be text`)
    if (value.length > max) return problem(`${key} is longer than ${max} characters`)
    return value
  }
  const count = (key: string, min: number, max: number, fallback: number): number => {
    const value = json[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return problem(`${key} must be a whole number from ${min} to ${max}`) ?? fallback
    return value
  }
  const list = (key: string, max: number): unknown[] => {
    const value = json[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) return problem(`${key} must be a list`) ?? []
    if (value.length > max) return problem(`${key} has more than ${max} entries`) ?? []
    return value
  }

  const id = text('id', 60)
  if (id && !TASK_ID.test(id)) problem('id must be lower-case letters, digits and dashes')
  if (id && id !== path.basename(dir)) problem(`id ${id} is not the name of its folder`)
  const title = text('title', 120)
  const prompt = text('prompt', 20_000)

  const tags = list('tags', 12).filter((tag): tag is string => (typeof tag === 'string' && TAG.test(tag)) || (problem(`tag ${JSON.stringify(tag)} is not a short lower-case word`) ?? false))
  const requires = new Set<Program>()
  for (const entry of list('requires', PROGRAMS.length)) {
    if (PROGRAMS.includes(entry as Program)) requires.add(entry as Program)
    else problem(`requires names ${JSON.stringify(entry)}, which is none of ${PROGRAMS.join(', ')}`)
  }

  const allow: string[] = []
  for (const entry of list('allow', 20)) {
    const parsed = typeof entry === 'string' ? parseRule(entry, 'allow', 'user') : undefined
    // A rule for one program and what follows it; never every command, which would make the run a person's full access.
    if (!parsed?.ok || parsed.rule.tool !== 'Bash' || !parsed.rule.specifier || !/^[A-Za-z0-9_.-]/.test(parsed.rule.specifier)) {
      problem(`allow entry ${JSON.stringify(entry)} is not a Bash rule for one program, such as Bash(node --test:*)`)
      continue
    }
    allow.push(parsed.rule.text)
  }

  const rename: Record<string, string> = {}
  const renames = json.rename
  if (renames !== undefined) {
    if (!isObject(renames) || Object.keys(renames).length > 10) problem('rename must be an object of at most 10 paths')
    else
      for (const [from, to] of Object.entries(renames)) {
        if (!safeRelative(from) || !safeRelative(to)) problem(`rename ${JSON.stringify(from)} to ${JSON.stringify(to)} is not between two paths of the project`)
        else rename[from] = to as string
      }
  }

  const checks: Check[] = []
  list('checks', 30).forEach((entry, index) => {
    const check = parseCheck(entry, index, problem)
    if (!check) return
    if (check.kind === 'command') requires.add(PROGRAM_WORD[check.run[0]!]!)
    checks.push(check)
  })
  if (!checks.length) problem('a task needs at least one check')
  requires.delete('node')
  const debug = json.debug ?? false
  if (typeof debug !== 'boolean') problem('debug must be true or false')

  const task: BenchTask = {
    id: id ?? '',
    title: title ?? '',
    prompt: prompt ?? '',
    tags,
    requires: [...requires],
    maxSteps: count('maxSteps', 1, 200, 30),
    timeoutMs: count('timeoutMs', 10_000, 30 * 60_000, 10 * 60_000),
    allow,
    rename,
    checks,
    debug: debug === true,
    dir,
  }
  if (problems.length) throw new TaskError(dir, problems)
  return task
}

function parseCheck(entry: unknown, index: number, problem: (text: string) => undefined): Check | undefined {
  const where = `checks[${index}]`
  if (!isObject(entry)) return problem(`${where} is not an object`)
  const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 120 ? entry.name : undefined
  if (entry.name !== undefined && !name) return problem(`${where}.name must be short text`)
  const strings = (key: string, max: number): string[] | undefined => {
    const value = entry[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item || item.length > 2_000)) return problem(`${where}.${key} must be a list of at most ${max} texts`)
    return value as string[]
  }
  const flags = (): string | undefined => {
    const value = entry.flags ?? ''
    if (typeof value !== 'string' || !/^[imsu]{0,4}$/.test(value) || new Set(value).size !== value.length) return problem(`${where}.flags may hold only i, m, s and u`)
    return value
  }
  const pattern = (key: string, written: string | undefined): string | undefined => {
    const value = entry[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value || value.length > 500) return problem(`${where}.${key} must be a pattern of at most 500 characters`)
    try {
      new RegExp(value, written)
    } catch (error) {
      return problem(`${where}.${key} is not a pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
    return value
  }
  const paths = (key: string, max: number): string[] | undefined => {
    const value = strings(key, max)
    if (!value) return undefined
    const bad = value.find((item) => !safeRelative(item))
    if (bad !== undefined) return problem(`${where}.${key} names ${JSON.stringify(bad)}, which is not a path inside the project`)
    return value
  }

  switch (entry.kind) {
    case 'command': {
      const run = strings('run', 40)
      if (!run?.length) return problem(`${where}.run must name a program and its arguments`)
      if (!Object.hasOwn(PROGRAM_WORD, run[0]!)) return problem(`${where}.run must start with ${Object.keys(PROGRAM_WORD).join(', ')}`)
      const timeoutMs = entry.timeoutMs ?? 120_000
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) return problem(`${where}.timeoutMs must be from 1,000 to 600,000`)
      return { kind: 'command', name: name ?? run.join(' '), run, timeoutMs }
    }
    case 'file': {
      const file = safeRelative(entry.path)
      if (!file) return problem(`${where}.path must be a path inside the project`)
      const exists = entry.exists ?? true
      if (typeof exists !== 'boolean') return problem(`${where}.exists must be true or false`)
      const includes = strings('includes', 20)
      const excludes = strings('excludes', 20)
      if (!includes || !excludes) return undefined
      if (entry.eol !== undefined && entry.eol !== 'lf' && entry.eol !== 'crlf') return problem(`${where}.eol must be lf or crlf`)
      if (entry.json !== undefined && typeof entry.json !== 'boolean') return problem(`${where}.json must be true or false`)
      return {
        kind: 'file',
        name: name ?? `${file} ${exists ? 'as asked' : 'is gone'}`,
        path: file,
        exists,
        includes,
        excludes,
        ...(entry.eol ? { eol: entry.eol } : {}),
        ...(entry.json ? { json: true } : {}),
      }
    }
    case 'search': {
      const folders = paths('paths', 20)
      const written = flags()
      if (!folders || written === undefined) return undefined
      if (!folders.length) return problem(`${where}.paths must name a folder or a file`)
      if (entry.pattern === undefined) return problem(`${where}.pattern is missing`)
      const found = pattern('pattern', written)
      if (!found) return undefined
      if (entry.expect !== 'some' && entry.expect !== 'none') return problem(`${where}.expect must be some or none`)
      return { kind: 'search', name: name ?? `${entry.expect === 'none' ? 'no' : 'a'} /${found}/ in ${folders.join(', ')}`, paths: folders, pattern: found, flags: written, expect: entry.expect }
    }
    case 'unchanged': {
      const kept = paths('paths', 50)
      if (!kept) return undefined
      return { kind: 'unchanged', name: name ?? (kept.length ? `${kept.join(', ')} unchanged` : 'nothing changed'), paths: kept }
    }
    case 'reply': {
      const written = flags()
      if (written === undefined) return undefined
      const matches = pattern('matches', written)
      const excludes = pattern('excludes', written)
      if (!matches && !excludes) return problem(`${where} needs matches or excludes`)
      return { kind: 'reply', name: name ?? 'the reply', ...(matches ? { matches } : {}), ...(excludes ? { excludes } : {}), flags: written }
    }
    case 'tools': {
      const failedAtMost = entry.failedAtMost ?? 0
      if (typeof failedAtMost !== 'number' || !Number.isInteger(failedAtMost) || failedAtMost < 0 || failedAtMost > 1_000) return problem(`${where}.failedAtMost must be a whole number from 0 to 1,000`)
      return { kind: 'tools', name: name ?? (failedAtMost ? `at most ${failedAtMost} tool calls failed` : 'no tool call failed'), failedAtMost }
    }
    case 'used': {
      const tools = strings('tools', 5)
      if (!tools) return undefined
      if (!tools.length || tools.some((tool) => !TOOL_NAME.test(tool))) return problem(`${where}.tools must name 1 to 5 tools, such as Debug`)
      return { kind: 'used', name: name ?? `used ${tools.join(', ')}`, tools }
    }
    default:
      return problem(`${where}.kind must be command, file, search, unchanged, reply, tools or used`)
  }
}

/** The steps of solution.json: text and tool calls, nothing else a model could not send. */
export function parseSolution(json: unknown, dir: string): ScriptedStep[] {
  const steps = isObject(json) ? json.steps : undefined
  if (!Array.isArray(steps) || !steps.length || steps.length > 200) throw new TaskError(dir, ['solution.json must hold steps, a list of 1 to 200'])
  const problems: string[] = []
  const out = parseSteps(steps, problems, false)
  if (problems.length) throw new TaskError(dir, problems)
  return out
}

/** replay.json: the reported steps, which may hold calls that arrived unusable, and what each call should do. */
export function parseReplay(json: unknown, dir: string): Replay {
  const steps = isObject(json) ? json.steps : undefined
  if (!Array.isArray(steps) || !steps.length || steps.length > 200) throw new TaskError(dir, ['replay.json must hold steps, a list of 1 to 200'])
  const problems: string[] = []
  const out = parseSteps(steps, problems, true)
  const expect = isObject(json) ? json.expect : undefined
  const results: ReplayResult[] = []
  if (!Array.isArray(expect) || expect.length > 4_000) problems.push('replay.json must hold expect, a list of what each call does')
  else
    expect.forEach((entry, index) => {
      if (!isObject(entry) || typeof entry.tool !== 'string' || !/^[A-Za-z][\w-]{0,63}$/.test(entry.tool) || typeof entry.ok !== 'boolean') problems.push(`expect[${index}] must be a tool and whether it did its job`)
      else results.push({ tool: entry.tool, ok: entry.ok })
    })
  if (problems.length) throw new TaskError(dir, problems)
  return { steps: out, expect: results }
}

function parseSteps(steps: unknown[], problems: string[], invalid: boolean): ScriptedStep[] {
  return steps.map((step, index): ScriptedStep => {
    if (!isObject(step) || Object.keys(step).some((key) => key !== 'text' && key !== 'calls')) {
      problems.push(`steps[${index}] may hold only text and calls`)
      return {}
    }
    if (step.text !== undefined && typeof step.text !== 'string') problems.push(`steps[${index}].text must be text`)
    const calls: ScriptedCall[] = []
    if (step.calls !== undefined) {
      if (!Array.isArray(step.calls) || step.calls.length > 20) problems.push(`steps[${index}].calls must be a list of at most 20`)
      else
        step.calls.forEach((call, at) => {
          const known = invalid ? ['name', 'input', 'invalid'] : ['name', 'input']
          if (!isObject(call) || Object.keys(call).some((key) => !known.includes(key)) || typeof call.name !== 'string' || !/^[A-Za-z][\w-]{0,63}$/.test(call.name) || !isObject(call.input)) {
            problems.push(`steps[${index}].calls[${at}] must be a tool name and an input object`)
            return
          }
          const broken = call.invalid
          if (broken === undefined) calls.push({ name: call.name, input: call.input })
          else if (isObject(broken) && typeof broken.raw === 'string' && typeof broken.error === 'string') calls.push({ name: call.name, input: call.input, invalid: { raw: broken.raw, error: broken.error } })
          else problems.push(`steps[${index}].calls[${at}].invalid must be the raw text and the error`)
        })
    }
    return { ...(typeof step.text === 'string' ? { text: step.text } : {}), ...(calls.length ? { calls } : {}) }
  })
}

async function readJson(file: string, dir: string, max = MAX_FILE_BYTES): Promise<unknown> {
  const stat = await fs.stat(file)
  if (stat.size > max) throw new TaskError(dir, [`${path.basename(file)} is larger than ${max / (1024 * 1024)} MB`])
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    throw new TaskError(dir, [`${path.basename(file)} is not JSON: ${error instanceof Error ? error.message : String(error)}`])
  }
}

/** A task and its reference run, if it has one. */
export async function readTask(folder: string): Promise<BenchTask> {
  // Absolute: the checks run in the project's folder and name the task's own by this path.
  const dir = path.resolve(folder)
  const task = parseTask(await readJson(path.join(dir, 'task.json'), dir), dir)
  const projectStat = await fs.stat(path.join(dir, 'project')).catch(() => undefined)
  if (!projectStat?.isDirectory()) throw new TaskError(dir, ['the task has no project folder'])
  const solutionFile = path.join(dir, 'solution.json')
  if (await fs.stat(solutionFile).catch(() => undefined)) task.solution = parseSolution(await readJson(solutionFile, dir), dir)
  const replayFile = path.join(dir, 'replay.json')
  if (await fs.stat(replayFile).catch(() => undefined)) {
    if (task.solution) throw new TaskError(dir, ['a task has solution.json or replay.json, not both'])
    task.replay = parseReplay(await readJson(replayFile, dir, MAX_REPLAY_BYTES), dir)
  }
  return task
}

/** Every task in a folder of tasks, by id; one that cannot be read is in `broken` with its problems. */
export async function readTasks(root: string): Promise<{ tasks: BenchTask[]; broken: TaskError[] }> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const tasks: BenchTask[] = []
  const broken: TaskError[] = []
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name)
    if (!(await fs.stat(path.join(dir, 'task.json')).catch(() => undefined))) continue
    try {
      tasks.push(await readTask(dir))
    } catch (error) {
      broken.push(error instanceof TaskError ? error : new TaskError(dir, [error instanceof Error ? error.message : String(error)]))
    }
  }
  return { tasks, broken }
}
