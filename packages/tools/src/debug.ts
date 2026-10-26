/**
 * Debug: the agent's way into the folder's debugger (ADR 0145), the one the person uses from the gutter and the Debug
 * tab. The agent starts a run with breakpoints of its own, and each stop comes back as one report: where it stopped
 * with the lines around, the stack, the frame's values and what the program printed. Then it steps, evaluates, reads
 * values and stops the run.
 *
 * A start runs the folder's code outside the sandbox with the person's environment, so the person approves each one
 * (`debug` access). The run is the agent's from then on: stepping it and evaluating in it were part of that approval.
 * A run the person started can be read freely; stepping it, evaluating in it or stopping it asks them first. The
 * agent's breakpoints belong to its run only: the person's are neither read nor changed.
 */
import fs from 'node:fs/promises'
import { fail } from './files'
import { displayPath, resolveInputPath } from './paths'
import { decodeText, MAX_TEXT_FILE_BYTES, plural } from './text'
import type { AgentBreakpoint, AgentDebugger, AgentDebugFrame, AgentDebugRun, AgentDebugThread, AgentDebugValue, Tool, ToolAccess, ToolContext, ToolOutcome } from './types'

const ACTIONS = ['start', 'continue', 'step', 'pause', 'evaluate', 'variables', 'breakpoints', 'state', 'stop'] as const
type Action = (typeof ACTIONS)[number]

interface BreakpointInput {
  file: string
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export interface DebugInput extends Record<string, unknown> {
  action: Action
  config?: string
  file?: string
  breakpoints?: BreakpointInput[]
  stopOn?: 'uncaught' | 'all' | 'none'
  run?: string
  step?: 'over' | 'into' | 'out'
  expression?: string
  frame?: number
  name?: string
  wait?: number
}

const DEFAULT_WAIT_S = 30
const MAX_WAIT_S = 120
/** Runs of one session at a time: each holds a program, often paused. */
const MAX_OWN_RUNS = 3
const MAX_BREAKPOINTS = 50
const CONTEXT_LINES = 2
const SHOWN_FRAMES = 12
const SHOWN_VALUES = 30
const SHOWN_CHILDREN = 100
const VALUE_CHARS = 240
const TYPE_CHARS = 24
const PRINTED_LINES = 60
const PRINTED_CHARS = 4_000
const LINE_CHARS = 200
const EXCEPTION_CHARS = 600
const HIT_CONDITION = /^\s*(==|>=|<=|>|<|%)?\s*\d{1,9}\s*$/

const unavailable = 'Debug is not available here: this eNCode has no debugger for the folder (it runs in the desktop app, for the main agent).'

/** What each of a session's own runs stops on, as its start asked; a report of a run that ended on an error says what would have stopped it. */
const STOP_ON = new WeakMap<AgentDebugger, Map<string, NonNullable<DebugInput['stopOn']>>>()
/** A JavaScript error as Node.js prints one it did not stop for: the error's line, then its stack. */
const JS_ERROR = /^\s*(?:Uncaught )?\w*Error\b/m
const JS_FRAME = /^\s+at .+:\d+:\d+\)?\s*$/m
/**
 * V8 counts an error thrown while an ES module loads as caught, since Node.js's module loader catches it to report it:
 * stopping on uncaught exceptions lets it through, and only stopping on every exception stops where it is thrown.
 */
const LET_THROUGH =
  'It ended on an error that did not stop it: the program caught it, or Node.js\'s module loader did (an error thrown while an ES module loads counts as caught). Start again with stopOn "all" to stop where it is thrown.'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ')
const shown = (file: string, ctx: ToolContext) => displayPath(file, ctx)
const fileOf = (input: string, ctx: ToolContext) => resolveInputPath(input, { root: ctx.cwd ?? ctx.root, home: ctx.home, platform: ctx.platform })
const live = (run: AgentDebugRun) => run.state !== 'ended'
const seconds = (input: DebugInput) => Math.min(MAX_WAIT_S, Math.max(1, Math.round(input.wait ?? DEFAULT_WAIT_S)))

/** The run a call names, else the newest one going on of this session, else the person's newest. */
function chooseRun(runs: AgentDebugRun[], input: DebugInput): AgentDebugRun | undefined {
  if (input.run) return runs.find((run) => run.id === input.run)
  const newest = [...runs].reverse()
  return newest.find((run) => run.mine && live(run)) ?? newest.find(live) ?? newest.find((run) => run.mine)
}

/** The configuration a start names: by id, else by name, case aside. */
function chooseConfig(configs: Awaited<ReturnType<AgentDebugger['configs']>>, asked: string) {
  const wanted = asked.trim().toLowerCase()
  return configs.find((config) => config.id === asked) ?? configs.find((config) => config.name.toLowerCase() === wanted) ?? configs.find((config) => config.name.toLowerCase() === `script: ${wanted}`)
}

const configOf = (input: DebugInput) => input.config?.trim() || 'file'

function startWhat(input: DebugInput, ctx: ToolContext, detail?: string): string {
  const config = configOf(input)
  if (config === 'file') return input.file ? shown(fileOf(input.file, ctx), ctx) : 'the file'
  return detail ? `"${input.config}" (${detail})` : `"${input.config}"`
}

function breakpointWords(list: readonly BreakpointInput[] | undefined, ctx: ToolContext): string {
  if (!list?.length) return 'no breakpoints'
  const words = list.slice(0, 8).map((item) => {
    const where = `${shown(fileOf(item.file, ctx), ctx)}:${item.line}`
    if (item.logMessage) return `${where} prints "${clip(item.logMessage, 60)}"`
    const when = [item.condition ? `when ${clip(item.condition, 60)}` : '', item.hitCondition ? `on hit ${item.hitCondition}` : ''].filter(Boolean).join(', ')
    return when ? `${where} (${when})` : where
  })
  return `${plural(list.length, 'breakpoint')}: ${words.join('; ')}${list.length > 8 ? '; …' : ''}`
}

// ---------------------------------------------------------------- reading

/** A file's lines, for the lines around a stop; null when it cannot be read as text. */
async function linesOf(file: string): Promise<string[] | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) return null
    const decoded = decodeText(await fs.readFile(file))
    return decoded ? decoded.text.split(/\r\n|\r|\n/) : null
  } catch {
    return null
  }
}

/** An exception as its runtime prints it, without the stack trace that follows the message (`    at …`, `  File …`). */
function exceptionMessage(text: string): string {
  const lines = text.split(/\r?\n/)
  const trace = lines.findIndex((line, index) => index > 0 && /^\s+(at |File ")/.test(line))
  return (trace > 0 ? lines.slice(0, trace) : lines.slice(0, 5)).join('\n').trim()
}

/** The thread a stop is about: the one that stopped for a reason of its own, else the first paused. */
function stoppedThread(run: AgentDebugRun): AgentDebugThread | undefined {
  const paused = run.threads.filter((thread) => thread.state === 'paused')
  return paused.find((thread) => thread.reason && thread.reason !== 'pause') ?? paused[0]
}

/** The frame worth showing: the first in the person's code with a file, else the top. */
function ownFrame(frames: readonly AgentDebugFrame[]): number {
  const own = frames.findIndex((frame) => !frame.skipped && frame.file)
  return own >= 0 ? own : 0
}

/** A value in a line; the type only of a value with fields (its class), where it says something the value does not. */
function valueLine(value: AgentDebugValue, indent = '  '): string {
  const type = value.ref && value.type && value.type.length <= TYPE_CHARS && !value.value.startsWith(value.type) ? ` (${value.type})` : ''
  return `${indent}${clip(value.name, 80)} = ${clip(oneLine(value.value), VALUE_CHARS)}${type}`
}

function frameWhere(frame: AgentDebugFrame, ctx: ToolContext): string {
  return frame.file ? `${shown(frame.file, ctx)}:${frame.line}` : `line ${frame.line}`
}

function stackLines(frames: readonly AgentDebugFrame[], chosen: number, ctx: ToolContext): string[] {
  const lines: string[] = []
  let folded = 0
  for (const [index, frame] of frames.slice(0, SHOWN_FRAMES).entries()) {
    // Runs of the runtime's own frames fold into a count, as the panel folds them.
    if (frame.skipped && index !== chosen) {
      folded++
      continue
    }
    if (folded) lines.push(`    … ${plural(folded, "frame")} of the runtime`)
    folded = 0
    lines.push(`  ${index === chosen ? '→' : ' '} #${index} ${clip(frame.name, 80)}  ${frameWhere(frame, ctx)}`)
  }
  if (folded) lines.push(`    … ${plural(folded, "frame")} of the runtime`)
  if (frames.length > SHOWN_FRAMES) lines.push(`    … ${frames.length - SHOWN_FRAMES} more`)
  return lines
}

/** The values of a frame: the first scope that is not costly to read (its locals). */
/** Scopes inside a function's own (V8's blocks: a loop's `let`, a catch's error), read together with the function's. */
const INNER_SCOPES: ReadonlySet<string> = new Set(['Block', 'Catch', 'With', 'Eval'])

/**
 * The values of a frame: its first scope, and when that is a block inside the function, the scopes out to the
 * function's own, so a stop in a loop shows the loop's variable and the function's together. A name an inner scope
 * has hides the outer one, as in the program.
 */
async function frameValues(debug: AgentDebugger, run: AgentDebugRun, frame: AgentDebugFrame): Promise<{ scope: string; values: AgentDebugValue[] } | null> {
  const scopes = (await debug.scopes(run.id, frame.id).catch(() => [])).filter((item) => !item.expensive)
  if (!scopes.length) return null
  const read: typeof scopes = []
  for (const scope of scopes) {
    read.push(scope)
    if (!INNER_SCOPES.has(scope.name)) break
  }
  const values: AgentDebugValue[] = []
  const seen = new Set<string>()
  for (const scope of read) {
    for (const value of await debug.variables(run.id, scope.ref).catch(() => [])) {
      if (seen.has(value.name)) continue
      seen.add(value.name)
      values.push(value)
    }
  }
  return { scope: [...new Set(read.map((scope) => scope.name))].join(', '), values }
}

function printedLines(debug: AgentDebugger, run: AgentDebugRun, heading: string): string[] {
  const { lines, dropped } = debug.printed(run.id)
  const text = lines.map((line) => clip(line.text.replace(/\r?\n$/, ''), LINE_CHARS)).join('\n').split('\n')
  if (!text.length || (text.length === 1 && !text[0])) return []
  let kept = text.slice(-PRINTED_LINES)
  while (kept.join('\n').length > PRINTED_CHARS && kept.length > 1) kept = kept.slice(1)
  const left = text.length - kept.length + dropped
  return [heading, ...(left ? [`  (${plural(left, 'earlier line')} left out)`] : []), ...kept.map((line) => `  ${line}`)]
}

/** One report of a run as it stands: where it stopped and what is there, or how it ended, or that it goes on. */
async function report(debug: AgentDebugger, run: AgentDebugRun, ctx: ToolContext, waited?: number): Promise<string> {
  const name = `Run ${run.id} (${run.detail || run.name})`
  const out: string[] = []
  if (run.state === 'ended') {
    const how = run.exitCode !== undefined && run.exitCode !== null ? `ended with exit code ${run.exitCode}` : 'ended'
    out.push(`${name} ${how}.${run.message ? ` ${run.message}` : ''}`)
  } else if (run.state === 'paused') {
    const thread = stoppedThread(run)
    const frames = thread?.frames ?? []
    const chosen = ownFrame(frames)
    const frame = frames[chosen]
    if (!thread || !frame) {
      out.push(`${name} is paused, and its stack could not be read.`)
    } else {
      const why = thread.reason && thread.reason !== 'other' ? `: ${thread.reason}` : ''
      out.push(`${name} paused at ${frameWhere(frame, ctx)} in ${clip(frame.name, 80)}${why}${run.threads.length > 1 ? ` (thread ${thread.name})` : ''}.`)
      // Its message: the stack below says where.
      if (thread.exception) out.push(`Exception: ${clip(exceptionMessage(thread.exception), EXCEPTION_CHARS)}`)
      const lines = frame.file ? await linesOf(frame.file) : null
      if (lines) {
        const width = String(frame.line + CONTEXT_LINES).length
        for (let line = Math.max(1, frame.line - CONTEXT_LINES); line <= Math.min(lines.length, frame.line + CONTEXT_LINES); line++) {
          out.push(`  ${line === frame.line ? '→' : ' '} ${String(line).padStart(width)}  ${clip(lines[line - 1] ?? '', LINE_CHARS)}`)
        }
      }
      out.push('Stack:', ...stackLines(frames, chosen, ctx))
      const read = await frameValues(debug, run, frame)
      if (read) {
        out.push(`Values (${read.scope}, frame #${chosen}):`)
        if (!read.values.length) out.push('  none')
        for (const value of read.values.slice(0, SHOWN_VALUES)) out.push(valueLine(value))
        if (read.values.length > SHOWN_VALUES) out.push(`  … ${read.values.length - SHOWN_VALUES} more: read them with variables.`)
      }
    }
  } else {
    out.push(`${name} is ${run.state === 'starting' ? 'starting' : 'running'}${waited ? ` after ${waited} s: it has not stopped` : ''}.${waited ? ' Call continue to wait longer, pause to stop it where it is, or stop.' : ''}`)
  }
  if (run.mine) {
    const missed = debug.statuses(run.id).filter((status) => !status.verified)
    if (missed.length && run.state !== 'ended') {
      out.push('Breakpoints not placed yet:', ...missed.slice(0, 10).map((status) => `  ${shown(status.file, ctx)}:${status.line}${status.message ? `: ${clip(status.message, 160)}` : ''}`))
    }
  }
  const printed = printedLines(debug, run, run.state === 'ended' ? 'It printed:' : 'Printed since the last report:')
  out.push(...printed)
  if (run.state === 'ended' && run.mine && run.exitCode && /^(?:node|tsx)\b/.test(run.detail) && STOP_ON.get(debug)?.get(run.id) === 'uncaught') {
    const text = printed.join('\n')
    if (JS_ERROR.test(text) && JS_FRAME.test(text)) out.push(LET_THROUGH)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- acting

function toBreakpoints(list: readonly BreakpointInput[], ctx: ToolContext): AgentBreakpoint[] {
  return list.map((item) => ({
    file: fileOf(item.file, ctx),
    line: item.line,
    ...(item.condition?.trim() ? { condition: item.condition.trim() } : {}),
    ...(item.hitCondition?.trim() ? { hitCondition: item.hitCondition.trim() } : {}),
    ...(item.logMessage ? { logMessage: item.logMessage } : {}),
  }))
}

async function settle(debug: AgentDebugger, run: AgentDebugRun, input: DebugInput, ctx: ToolContext): Promise<ToolOutcome> {
  const wait = seconds(input)
  const after = await debug.wait(run.id, run.stops, wait * 1000, ctx.signal)
  if (!after) return fail(`Run ${run.id} is gone.`)
  const text = await report(debug, after, ctx, after.state === 'running' || after.state === 'starting' ? wait : undefined)
  return { ok: true, content: text }
}

async function start(debug: AgentDebugger, input: DebugInput, ctx: ToolContext): Promise<ToolOutcome> {
  const runs = await debug.runs()
  const going = runs.filter((run) => run.mine && live(run))
  if (going.length >= MAX_OWN_RUNS) return fail(`${plural(going.length, 'run')} of yours are going on (${going.map((run) => `${run.id}: ${run.detail}`).join(', ')}). Stop one first.`)
  const asked = configOf(input)
  let config = 'file'
  if (asked !== 'file') {
    const configs = await debug.configs()
    const found = chooseConfig(configs, asked)
    if (!found) return fail(`There is no configuration "${asked}". The folder runs: ${configs.map((item) => `"${item.name}"`).join(', ')}. Or give file to run a file.`)
    if (found.problem) return fail(`"${found.name}" cannot run: ${found.problem}`)
    config = found.id
  }
  const exceptions = { uncaught: input.stopOn !== 'none', all: input.stopOn === 'all' }
  const started = await debug.start({
    config,
    ...(input.file ? { file: fileOf(input.file, ctx) } : {}),
    breakpoints: toBreakpoints(input.breakpoints ?? [], ctx),
    exceptions,
    signal: ctx.signal,
  })
  if (!started.ok) {
    const install = started.install ? ` eNCode can install it: ask the person to press F5 on the file in the editor, which offers the install.` : ''
    return fail(`${started.reason}${install}`)
  }
  let stopsOn = STOP_ON.get(debug)
  if (!stopsOn) STOP_ON.set(debug, (stopsOn = new Map()))
  stopsOn.set(started.run, input.stopOn ?? 'uncaught')
  const run = (await debug.runs()).find((item) => item.id === started.run)
  if (!run) return fail(`Run ${started.run} ended as it started.`)
  return settle(debug, { ...run, stops: 0 }, input, ctx)
}

/** A variable of a frame by its path (`item.tags`, `items[0]`), with its children read. */
async function variable(debug: AgentDebugger, run: AgentDebugRun, frame: AgentDebugFrame, path: string): Promise<{ value: AgentDebugValue; children: AgentDebugValue[] } | string> {
  const steps = path.replace(/\[(\w+)\]/g, '.$1').split('.').map((step) => step.trim()).filter(Boolean)
  const scopes = await debug.scopes(run.id, frame.id)
  let found: AgentDebugValue | undefined
  for (const scope of scopes.filter((item) => !item.expensive)) {
    found = (await debug.variables(run.id, scope.ref)).find((item) => item.name === steps[0])
    if (found) break
  }
  if (!found) return `There is no ${steps[0]} in frame ${frame.name}. Its values are listed with variables and no name.`
  for (const step of steps.slice(1)) {
    if (!found.ref) return `${found.name} has no fields (${clip(oneLine(found.value), 80)}).`
    const next: AgentDebugValue | undefined = (await debug.variables(run.id, found.ref)).find((item) => item.name === step || item.name === `'${step}'` || item.name === `"${step}"`)
    if (!next) return `${found.name} has no ${step}.`
    found = next
  }
  return { value: found, children: found.ref ? await debug.variables(run.id, found.ref) : [] }
}

function pausedFrame(run: AgentDebugRun, input: DebugInput): { thread: AgentDebugThread; frame: AgentDebugFrame; index: number } | string {
  const thread = stoppedThread(run)
  const frames = thread?.frames ?? []
  if (!thread || !frames.length) return `Run ${run.id} is ${run.state === 'ended' ? 'over' : 'not paused'}: values are read while it is paused.`
  const index = input.frame ?? ownFrame(frames)
  const frame = frames[index]
  if (!frame) return `The stack has frames #0 to #${frames.length - 1}.`
  return { thread, frame, index }
}

async function act(debug: AgentDebugger, run: AgentDebugRun, input: DebugInput, ctx: ToolContext): Promise<ToolOutcome> {
  switch (input.action) {
    case 'state':
      return { ok: true, content: await report(debug, run, ctx) }
    case 'continue':
    case 'step':
    case 'pause': {
      if (!live(run)) return { ok: true, content: await report(debug, run, ctx) }
      const paused = run.threads.some((thread) => thread.state === 'paused')
      if (input.action === 'pause' && paused) return { ok: true, content: await report(debug, run, ctx) }
      if (input.action === 'step' && !paused) return fail(`Run ${run.id} is running: it steps only while paused. Call pause first, or continue to wait for a breakpoint.`)
      // A run that goes on is only waited for: continue on it waits longer.
      if (input.action !== 'continue' || paused) {
        const thread = paused ? stoppedThread(run)?.id : undefined
        const done = await debug.act(run.id, input.action === 'step' ? { kind: 'step', step: input.step ?? 'over' } : { kind: input.action }, thread)
        if (!done.ok) return fail(done.reason)
      }
      return settle(debug, run, input, ctx)
    }
    case 'stop': {
      if (live(run)) {
        const done = await debug.act(run.id, { kind: 'stop' })
        if (!done.ok) return fail(done.reason)
      }
      const after = await debug.wait(run.id, Number.MAX_SAFE_INTEGER, 5_000, ctx.signal)
      return { ok: true, content: await report(debug, after ?? run, ctx) }
    }
    case 'breakpoints': {
      if (!run.mine) return fail(`Run ${run.id} is the person's: its breakpoints are theirs. Start a run of your own with the breakpoints you need.`)
      if (!live(run)) return fail(`Run ${run.id} is over.`)
      const done = await debug.setBreakpoints(run.id, toBreakpoints(input.breakpoints ?? [], ctx))
      if (!done.ok) return fail(done.reason)
      const statuses = debug.statuses(run.id)
      if (!statuses.length) return { ok: true, content: `Run ${run.id} has no breakpoints now.` }
      return {
        ok: true,
        content: [`Run ${run.id} has ${plural(statuses.length, 'breakpoint')}:`, ...statuses.map((status) => `  ${shown(status.file, ctx)}:${status.line}${status.verified ? (status.placed ? ` (placed on line ${status.placed})` : '') : `: not placed yet${status.message ? `, ${clip(status.message, 160)}` : ''}`}`)].join('\n'),
      }
    }
    case 'evaluate': {
      const at = pausedFrame(run, input)
      if (typeof at === 'string') return fail(at)
      const result = await debug.evaluate(run.id, input.expression!, { frame: at.frame.id, thread: at.thread.id })
      if (!result.ok) return fail(`${input.expression}: ${result.message}`)
      const lines = [valueLine({ name: input.expression!, value: result.value, ...(result.type ? { type: result.type } : {}) }, '')]
      if (result.ref) {
        const children = await debug.variables(run.id, result.ref).catch(() => [])
        for (const child of children.slice(0, 20)) lines.push(valueLine(child))
        if (children.length > 20) lines.push(`  … ${children.length - 20} more`)
      }
      return { ok: true, content: lines.join('\n') }
    }
    case 'variables': {
      const at = pausedFrame(run, input)
      if (typeof at === 'string') return fail(at)
      if (!input.name?.trim()) {
        const scopes = await debug.scopes(run.id, at.frame.id)
        if (!scopes.length) return { ok: true, content: `Frame #${at.index} (${at.frame.name}) has no values to read.` }
        const lines: string[] = []
        for (const scope of scopes.slice(0, 4)) {
          if (scope.expensive) {
            lines.push(`${scope.name}: many values, read one by name.`)
            continue
          }
          const values = await debug.variables(run.id, scope.ref)
          lines.push(`${scope.name} (frame #${at.index}, ${at.frame.name}):`, ...values.slice(0, SHOWN_CHILDREN).map((value) => valueLine(value)))
          if (values.length > SHOWN_CHILDREN) lines.push(`  … ${values.length - SHOWN_CHILDREN} more`)
        }
        return { ok: true, content: lines.join('\n') }
      }
      const found = await variable(debug, run, at.frame, input.name)
      if (typeof found === 'string') return fail(found)
      const lines = [valueLine(found.value, ''), ...found.children.slice(0, SHOWN_CHILDREN).map((child) => valueLine(child))]
      if (found.children.length > SHOWN_CHILDREN) lines.push(`  … ${found.children.length - SHOWN_CHILDREN} more`)
      return { ok: true, content: lines.join('\n') }
    }
    case 'start':
      throw new Error('a start has no run yet')
  }
}

async function overview(debug: AgentDebugger, ctx: ToolContext): Promise<string> {
  const [configs, runs] = await Promise.all([debug.configs().catch(() => []), debug.runs()])
  const lines = ['The folder runs (config):']
  for (const config of configs.slice(0, 30)) lines.push(`  ${config.id === 'file' ? '"file"' : `"${config.name}"`}: ${clip(config.detail, 120)}${config.problem ? ` (cannot run: ${clip(config.problem, 120)})` : ''}`)
  if (!runs.length) {
    lines.push('No runs.')
    return lines.join('\n')
  }
  lines.push('Runs:')
  for (const run of runs) {
    const thread = stoppedThread(run)
    const frame = thread?.frames?.[ownFrame(thread.frames)]
    const where = run.state === 'paused' && frame ? ` at ${frameWhere(frame, ctx)}` : run.state === 'ended' && run.exitCode !== undefined && run.exitCode !== null ? `, exit code ${run.exitCode}` : ''
    lines.push(`  ${run.id} ${run.mine ? '(yours)' : "(the person's)"}: ${clip(run.detail || run.name, 100)}, ${run.state}${where}`)
  }
  return lines.join('\n')
}

/** Words of a request that ask for the debugger: such a request lists Debug, which ToolSearch otherwise loads (ADR 0148). */
const ASKS_FOR_DEBUGGER = /\b(?:debugger|debugging|breakpoints?|step through|debug (?:it|this|that|the|why|what|how|where))\b/i

/** Whether a request of the person's asks for the debugger. */
export function asksForDebugger(request: string): boolean {
  return ASKS_FOR_DEBUGGER.test(request)
}

export const debugTool: Tool<DebugInput> = {
  definition: {
    name: 'Debug',
    description: [
      "Debugs a program of the project with eNCode's debugger: Node.js, TypeScript, Python, Go, C, C++ and Rust. Use it when reading the code and running it do not show why it misbehaves: stop at a line and read the values there.",
      '',
      '- start: runs config ("file" with file, or a configuration state lists) with breakpoints, and waits until it stops or ends. The person approves each start: the program runs outside the sandbox, as in their terminal.',
      '- continue, step (over, into, out), pause: then waits for the next stop. continue on a running program waits longer.',
      '- evaluate: an expression in a paused frame (frame: its number in the stack). It can change the program.',
      '- variables: the values of a frame, or one of them and its fields (name: "item.tags").',
      "- breakpoints: replaces your run's breakpoints.",
      '- state: what the folder runs, and the runs going on. With run, that run now.',
      '- stop: ends the run. Stop runs you no longer need; at most three of yours run at once.',
      '',
      'A stop reports where, with the lines around, the stack, the frame\'s values and what the program printed. Your breakpoints are your run\'s own; the person sees your runs in their Debug tab. Without run, the call acts on your newest run.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        config: { type: 'string', maxLength: 200, description: 'start: "file", or a configuration\'s name. Default "file".' },
        file: { type: 'string', description: 'start with config "file": the file to run, absolute or relative to the project. A probe in your scratch folder runs too.' },
        breakpoints: {
          type: 'array',
          maxItems: MAX_BREAKPOINTS,
          description: "start, breakpoints: the run's breakpoints.",
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              condition: { type: 'string', maxLength: 2000, description: 'Stops only when this is true.' },
              hitCondition: { type: 'string', maxLength: 20, description: 'Stops only on some hits: "5" (from the 5th on), "==5", "%5".' },
              logMessage: { type: 'string', maxLength: 2000, description: 'Prints this instead of stopping; {expression} is replaced by its value.' },
            },
            required: ['file', 'line'],
            additionalProperties: false,
          },
        },
        stopOn: { type: 'string', enum: ['uncaught', 'all', 'none'], description: 'start: which exceptions stop the program. Default uncaught.' },
        run: { type: 'string', maxLength: 64, description: 'The run, as start or state named it.' },
        step: { type: 'string', enum: ['over', 'into', 'out'], description: 'step: default over.' },
        expression: { type: 'string', maxLength: 2000, description: 'evaluate: in the language of the program.' },
        frame: { type: 'integer', minimum: 0, description: "evaluate, variables: the frame's number in the stack. Default the frame the stop shows." },
        name: { type: 'string', maxLength: 500, description: 'variables: a value of the frame, with fields after dots.' },
        wait: { type: 'integer', minimum: 1, maximum: MAX_WAIT_S, description: `start, continue, step, pause: seconds to wait for a stop or the end. Default ${DEFAULT_WAIT_S}.` },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: false,
  defer: 'always',
  check(input) {
    if (input.action === 'start' && configOf(input) === 'file' && !input.file?.trim()) return 'start needs file, or config with a configuration\'s name.'
    if (input.action === 'evaluate' && !input.expression?.trim()) return 'evaluate needs expression.'
    if (input.action === 'breakpoints' && !input.breakpoints) return 'breakpoints needs breakpoints: the whole list, or [] for none.'
    for (const item of input.breakpoints ?? []) {
      if (item.hitCondition !== undefined && !HIT_CONDITION.test(item.hitCondition)) return `hitCondition "${item.hitCondition}" is not a count: give "5", "==5", ">5" or "%5".`
    }
    return undefined
  },
  async access(input, ctx): Promise<ToolAccess> {
    const debug = ctx.debug
    if (!debug || input.action === 'state') return { type: 'none' }
    if (input.action === 'start') {
      const asked = configOf(input)
      const config = asked === 'file' ? undefined : chooseConfig(await debug.configs().catch(() => []), asked)
      const file = input.file ? fileOf(input.file, ctx) : ''
      return { type: 'debug', action: 'start', what: startWhat(input, ctx, config?.detail), key: `${config?.id ?? asked}\0${file}` }
    }
    const run = chooseRun(await debug.runs(), input)
    // Reading a run asks nothing; driving the person's own run asks them.
    if (!run || run.mine || input.action === 'variables') return { type: 'none' }
    return { type: 'debug', action: 'drive', what: `${run.id}, ${run.detail || run.name}`, key: run.id }
  },
  async describe(input, ctx) {
    if (input.action === 'start') {
      const config = input.config && configOf(input) !== 'file' ? chooseConfig(await ctx.debug?.configs().catch(() => []) ?? [], input.config) : undefined
      return { title: `Debug ${startWhat(input, ctx)}`, detail: [config ? `Runs ${config.detail}` : '', breakpointWords(input.breakpoints, ctx)].filter(Boolean).join('. ') }
    }
    const verb = input.action === 'evaluate' ? `Evaluate ${clip(input.expression ?? '', 80)}` : input.action === 'step' ? `Step ${input.step ?? 'over'}` : input.action[0]!.toUpperCase() + input.action.slice(1)
    return { title: `Debug: ${verb}${input.run ? ` in run ${input.run}` : ''}`, ...(input.action === 'breakpoints' ? { detail: breakpointWords(input.breakpoints, ctx) } : {}) }
  },
  async run(input, ctx) {
    const debug = ctx.debug
    if (!debug) return fail(unavailable)
    try {
      if (input.action === 'start') return await start(debug, input, ctx)
      if (input.action === 'state' && !input.run) return { ok: true, content: await overview(debug, ctx) }
      const runs = await debug.runs()
      const run = chooseRun(runs, input)
      if (!run) return fail(input.run ? `There is no run ${input.run}. ${runs.length ? `The runs are ${runs.map((item) => item.id).join(', ')}.` : 'Nothing runs: start one.'}` : 'Nothing runs: start one.')
      return await act(debug, run, input, ctx)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}
