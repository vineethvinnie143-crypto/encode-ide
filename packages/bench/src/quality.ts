/**
 * How the code a run left reads, beyond its hidden checks passing (the plan's Q3). A change that passes the tests can
 * still be one a reviewer sends back: a file that no longer parses where no test loads it, ten times the change the
 * task needed, a scratch file left in the project, a test edited to pass, a debug print, a TODO in place of the work.
 *
 * Each of these is counted by shape, without a model, and judged against the task's reference solution where it has
 * one: the reference adding a print or a test file makes that fine for the run too. A run with none of them is clean.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentEnvironment } from '@encode/tools'
import { isTestPath } from '@encode/core'
import { benchEnvironment } from './checks'
import { within, type FileChanges } from './project'
import type { ProgramEnv, Programs } from './programs'
import type { BenchTask, Program } from './task'

export interface QualityFacts {
  /** Lines added and lines removed over every changed file: lines of one version the other does not have. */
  changedLines: number
  /** Files the run added. */
  added: string[]
  /** Test files the run added or changed. */
  tests: string[]
  /** Added lines that print or stop for debugging: console.log, print, debugger, breakpoint. */
  debug: number
  /** Added lines that leave the work undone: TODO, FIXME, NotImplementedError, "not implemented". */
  stubs: number
  /** Added or changed files that do not parse. */
  unparsed: string[]
}

export interface Quality {
  /** What a reviewer would send back, a sentence each; none means the run's code is clean. */
  issues: string[]
  facts: QualityFacts
}

/** Larger or binary files are not read for quality. */
const MAX_READ = 512 * 1024
const PARSE_TIMEOUT_MS = 20_000

const DEBUG: Record<string, RegExp[]> = {
  js: [/\bconsole\.(?:log|debug|trace|dir)\s*\(/, /^\s*debugger\s*;?\s*$/],
  py: [/^\s*print\s*\(/, /\bbreakpoint\s*\(\s*\)/, /\bpdb\.set_trace\s*\(/],
  lua: [/^\s*print\s*\(/],
}
const STUB = [/\b(?:TODO|FIXME|XXX)\b/, /\braise\s+NotImplementedError\b/, /\bnot implemented\b/i]

const kindOf = (file: string): 'js' | 'py' | 'lua' | 'json' | undefined => {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'js'
  if (extension === '.py') return 'py'
  if (extension === '.lua') return 'lua'
  if (extension === '.json') return 'json'
  return undefined
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_READ) return undefined
    const data = await fs.readFile(file)
    return data.includes(0) ? undefined : data.toString('utf8')
  } catch {
    return undefined
  }
}

/** Where a file of the run's project came from in the task's own folder, through the folders git would not keep. */
function sourceOf(task: BenchTask, file: string): string {
  for (const [from, name] of Object.entries(task.rename)) if (within(file, name)) return path.join(task.dir, 'project', from, file.slice(name.length))
  return path.join(task.dir, 'project', ...file.split('/'))
}

/** The lines of `after` that `before` does not have (each line of `before` matched once), and how many of `before` are gone. */
export function lineChanges(before: string, after: string): { added: string[]; removed: number } {
  const left = new Map<string, number>()
  for (const line of before.split(/\r?\n/)) left.set(line, (left.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after.split(/\r?\n/)) {
    const count = left.get(line) ?? 0
    if (count > 0) left.set(line, count - 1)
    else added.push(line)
  }
  return { added: added.filter((line) => line.trim()), removed: [...left].reduce((sum, [line, count]) => sum + (line.trim() ? count : 0), 0) }
}

const PARSERS: Record<'js' | 'py' | 'lua', { program: Program; args: (file: string) => string[] }> = {
  js: { program: 'node', args: (file) => ['--check', file] },
  // ast.parse compiles nothing to disk, unlike py_compile.
  py: { program: 'python', args: (file) => ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], "rb").read(), sys.argv[1])', file] },
  lua: { program: 'lua', args: (file) => ['-e', 'assert(loadfile(os.getenv("BENCH_FILE")))'] },
}

/** Whether the file parses; undefined when the program to tell is not here. */
function parses(kind: 'js' | 'py' | 'lua', file: string, programs: Programs, programEnv?: ProgramEnv): Promise<boolean | undefined> {
  const parser = PARSERS[kind]
  const program = programs[parser.program]
  if (!program) return Promise.resolve(undefined)
  const { env } = agentEnvironment(benchEnvironment(), { extra: { ...programEnv?.[parser.program], BENCH_FILE: file } })
  return new Promise((resolve) => {
    const child = spawn(program[0]!, [...program.slice(1), ...parser.args(file)], { cwd: path.dirname(file), env, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), PARSE_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** What the run's changes are made of, read from the project as the run left it and the task's own copy. */
export async function qualityFacts(task: BenchTask, root: string, changes: FileChanges, programs: Programs, programEnv?: ProgramEnv): Promise<QualityFacts> {
  const facts: QualityFacts = { changedLines: 0, added: [...changes.added], tests: [], debug: 0, stubs: 0, unparsed: [] }
  for (const file of [...changes.added, ...changes.changed, ...changes.removed]) if (isTestPath(file)) facts.tests.push(file)
  for (const file of changes.removed) facts.changedLines += lineChanges((await readText(sourceOf(task, file))) ?? '', '').removed
  for (const file of [...changes.added, ...changes.changed]) {
    const full = path.join(root, ...file.split('/'))
    const after = await readText(full)
    if (after === undefined) continue
    const before = changes.added.includes(file) ? '' : ((await readText(sourceOf(task, file))) ?? '')
    const { added, removed } = lineChanges(before, after)
    facts.changedLines += added.length + removed
    const kind = kindOf(file)
    const debug = kind && kind !== 'json' ? DEBUG[kind]! : []
    for (const line of added) {
      if (debug.some((pattern) => pattern.test(line))) facts.debug++
      if (STUB.some((pattern) => pattern.test(line))) facts.stubs++
    }
    if (kind === 'json') {
      try {
        JSON.parse(after)
      } catch {
        facts.unparsed.push(file)
      }
    } else if (kind && (await parses(kind, full, programs, programEnv)) === false) facts.unparsed.push(file)
  }
  facts.tests.sort()
  return facts
}

/** A change this much larger than the reference's is too large: three times it, and twenty lines past it at least. */
export const oversized = (lines: number, reference: number): boolean => lines > Math.max(reference * 3, reference + 20)

/** What a reviewer would send back, judged against the reference solution's facts where there are any. */
export function judgeQuality(facts: QualityFacts, reference?: QualityFacts): string[] {
  const issues: string[] = []
  if (facts.unparsed.length) issues.push(`does not parse: ${facts.unparsed.join(', ')}`)
  if (!reference) return issues
  if (oversized(facts.changedLines, reference.changedLines)) issues.push(`changed ${facts.changedLines} lines where the reference changed ${reference.changedLines}`)
  const stray = facts.added.filter((file) => !reference.added.includes(file))
  if (stray.length) issues.push(`added files the task did not need: ${stray.join(', ')}`)
  const tests = facts.tests.filter((file) => !reference.tests.includes(file))
  if (tests.length) issues.push(`changed tests: ${tests.join(', ')}`)
  if (facts.debug > reference.debug) issues.push(`left ${facts.debug - reference.debug} debug ${facts.debug - reference.debug === 1 ? 'line' : 'lines'}`)
  if (facts.stubs > reference.stubs) issues.push('left a TODO or a stub')
  return issues
}
