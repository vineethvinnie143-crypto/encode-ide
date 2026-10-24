/**
 * The checks of a task, run by the benchmark after the agent has finished: never by the agent, and with the agent's
 * environment (secrets taken out), so a check sees the project as a fresh terminal would.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentEnvironment } from '@encode/tools'
import { changesBetween, snapshot, within, type Snapshot } from './project'
import type { Programs } from './programs'
import type { BenchTask, Check, Program } from './task'

export interface CheckResult {
  name: string
  kind: Check['kind']
  passed: boolean
  /** Why it failed, briefly: the end of a test run's output, the text that was missing. */
  detail?: string
}

export interface CheckContext {
  /** The project as the agent left it. */
  root: string
  /** The task's own checks folder, which the agent never saw. */
  checksDir: string
  programs: Programs
  /** The project before the agent started. */
  before: Snapshot
  /** The agent's last reply. */
  reply: string
  /** Tool calls that failed, commands aside. */
  toolFailures?: number
  signal?: AbortSignal
}

const OUTPUT_KEPT = 4_000
const MAX_SEARCHED_BYTES = 1024 * 1024
const MAX_SEARCHED_FILES = 5_000

const PROGRAM_WORDS: Record<string, Program> = { '{{node}}': 'node', '{{python}}': 'python', '{{lua}}': 'lua' }

/**
 * What the agent's commands and the checks start from: this process's environment, less what node --test sets when the
 * benchmark itself runs under it, with which a `node --test` inside would report to the outer run and pass whatever
 * happened.
 */
export function benchEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'NODE_TEST_CONTEXT'))
}

/** The end of a long output, where a test runner says what failed. */
const tail = (text: string): string => (text.length > OUTPUT_KEPT ? `…${text.slice(-OUTPUT_KEPT)}` : text).trim()

function runCommand(check: Extract<Check, { kind: 'command' }>, context: CheckContext): Promise<CheckResult> {
  const program = context.programs[PROGRAM_WORDS[check.run[0]!]!]
  if (!program) return Promise.resolve({ name: check.name, kind: 'command', passed: false, detail: `${check.run[0]} is not installed here` })
  const fill = (arg: string) => arg.split('{{root}}').join(context.root).split('{{checks}}').join(context.checksDir)
  const args = [...program.slice(1), ...check.run.slice(1).map(fill)]
  const { env } = agentEnvironment(benchEnvironment(), { extra: { BENCH_ROOT: context.root, BENCH_CHECKS: context.checksDir, NO_COLOR: '1', FORCE_COLOR: '0' } })
  return new Promise((resolve) => {
    let output = ''
    const take = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_KEPT * 4) output = output.slice(-OUTPUT_KEPT * 2)
    }
    const child = spawn(program[0]!, args, { cwd: context.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let timedOut = false
    const stop = () => child.kill('SIGKILL')
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, check.timeoutMs)
    context.signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const finish = (result: CheckResult) => {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', stop)
      resolve(result)
    }
    child.on('error', (error) => finish({ name: check.name, kind: 'command', passed: false, detail: `could not start: ${error.message}` }))
    child.on('close', (code) => {
      if (code === 0 && !timedOut) return finish({ name: check.name, kind: 'command', passed: true })
      const why = timedOut ? `stopped after ${check.timeoutMs / 1000} s` : `exit code ${code ?? 'none'}`
      finish({ name: check.name, kind: 'command', passed: false, detail: `${why}\n${tail(output)}`.trim() })
    })
  })
}

async function readProjectFile(root: string, file: string): Promise<Buffer | undefined> {
  try {
    const full = path.join(root, ...file.split('/'))
    const stat = await fs.lstat(full)
    if (!stat.isFile() || stat.size > MAX_SEARCHED_BYTES) return undefined
    return await fs.readFile(full)
  } catch {
    return undefined
  }
}

async function checkFile(check: Extract<Check, { kind: 'file' }>, root: string): Promise<CheckResult> {
  const fail = (detail: string): CheckResult => ({ name: check.name, kind: 'file', passed: false, detail })
  const data = await readProjectFile(root, check.path)
  if (!check.exists) return data === undefined && !(await fs.lstat(path.join(root, ...check.path.split('/'))).catch(() => undefined)) ? { name: check.name, kind: 'file', passed: true } : fail(`${check.path} is still there`)
  if (data === undefined) return fail(`${check.path} is missing`)
  const text = data.toString('utf8')
  const missing = check.includes.filter((part) => !text.includes(part))
  if (missing.length) return fail(`${check.path} does not hold ${missing.map((part) => JSON.stringify(part)).join(', ')}`)
  const present = check.excludes.filter((part) => text.includes(part))
  if (present.length) return fail(`${check.path} still holds ${present.map((part) => JSON.stringify(part)).join(', ')}`)
  if (check.eol) {
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/\n/g) ?? []).length - crlf
    if (check.eol === 'crlf' ? lf > 0 : crlf > 0) return fail(`${check.path} has ${check.eol === 'crlf' ? `${lf} lines ending in LF alone` : `${crlf} lines ending in CRLF`}`)
  }
  if (check.json) {
    try {
      JSON.parse(text)
    } catch (error) {
      return fail(`${check.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { name: check.name, kind: 'file', passed: true }
}

async function checkSearch(check: Extract<Check, { kind: 'search' }>, root: string, after: Snapshot): Promise<CheckResult> {
  const pattern = new RegExp(check.pattern, check.flags)
  const files = [...after.keys()].filter((file) => check.paths.some((named) => within(file, named))).slice(0, MAX_SEARCHED_FILES)
  const hits: string[] = []
  for (const file of files) {
    const data = await readProjectFile(root, file)
    if (data && pattern.test(data.toString('utf8'))) hits.push(file)
  }
  const passed = check.expect === 'some' ? hits.length > 0 : hits.length === 0
  if (passed) return { name: check.name, kind: 'search', passed }
  return { name: check.name, kind: 'search', passed, detail: check.expect === 'some' ? `/${check.pattern}/ is in none of ${check.paths.join(', ')}` : `/${check.pattern}/ is in ${hits.slice(0, 5).join(', ')}` }
}

function checkUnchanged(check: Extract<Check, { kind: 'unchanged' }>, before: Snapshot, after: Snapshot): CheckResult {
  const changes = changesBetween(before, after)
  const touched = [...changes.added, ...changes.changed, ...changes.removed].filter((file) => !check.paths.length || check.paths.some((named) => within(file, named)))
  return touched.length ? { name: check.name, kind: 'unchanged', passed: false, detail: `changed: ${touched.slice(0, 10).join(', ')}` } : { name: check.name, kind: 'unchanged', passed: true }
}

function checkReply(check: Extract<Check, { kind: 'reply' }>, reply: string): CheckResult {
  if (check.matches && !new RegExp(check.matches, check.flags).test(reply)) return { name: check.name, kind: 'reply', passed: false, detail: `the reply does not match /${check.matches}/` }
  if (check.excludes && new RegExp(check.excludes, check.flags).test(reply)) return { name: check.name, kind: 'reply', passed: false, detail: `the reply matches /${check.excludes}/` }
  return { name: check.name, kind: 'reply', passed: true }
}

/** Every check of the task, in order; each runs whatever the ones before it found. */
export async function runChecks(task: BenchTask, context: CheckContext): Promise<CheckResult[]> {
  const after = await snapshot(context.root)
  const results: CheckResult[] = []
  for (const check of task.checks) {
    if (context.signal?.aborted) break
    switch (check.kind) {
      case 'command':
        results.push(await runCommand(check, context))
        break
      case 'file':
        results.push(await checkFile(check, context.root))
        break
      case 'search':
        results.push(await checkSearch(check, context.root, after))
        break
      case 'unchanged':
        results.push(checkUnchanged(check, context.before, after))
        break
      case 'reply':
        results.push(checkReply(check, context.reply))
        break
      case 'tools': {
        const failed = context.toolFailures ?? 0
        results.push(failed <= check.failedAtMost ? { name: check.name, kind: 'tools', passed: true } : { name: check.name, kind: 'tools', passed: false, detail: `${failed} tool ${failed === 1 ? 'call' : 'calls'} failed` })
        break
      }
    }
  }
  return results
}
