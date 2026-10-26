/**
 * A folder's debugger (ADR 0143): its breakpoints and when it stops for exceptions, kept between runs; the ways it
 * can be run (debug-configs.ts); and its runs, as the panel and the editor see them, with files named by their paths
 * in the folder. A Node.js run is a DebugSession of @encode/debug; a Python, Go, C, C++ or Rust run is a DapSession,
 * through that language's own debugger (ADR 0144). Both are the same kind of run to everything here.
 *
 * A run starts the folder's code with the person's own environment, as a terminal does, so it starts only in a folder
 * the person trusts, and only when the person starts it. Attaching connects only to a program on this machine.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { workspaceKey } from '@encode/config'
import { DapSession, DebugSession, type Breakpoint, type BreakpointStatus, type EvaluateContext, type EvaluateResult, type ExceptionFilters, type FrameView, type OutputLine, type RunSession, type ScopeView, type SessionView, type SourceView, type StepKind, type ThreadView, type VariableView } from '@encode/debug'
import type { AgentBreakpoint, AgentDebugger, AgentDebugRun } from '@encode/tools'
import type { WorkspaceConfig } from './config'
import { debugConfigs, planRun, RunProblem, type DebugConfigs, type RunContext, type RunPlan } from './debug-configs'
import type { WorkspaceFs } from './fs'

export type { Breakpoint, BreakpointStatus, EvaluateContext, EvaluateResult, ExceptionFilters, OutputLine, PauseReason, ScopeView, StepKind, VariableView } from '@encode/debug'

export interface DebugOptions {
  /** Where each folder's breakpoints are kept between runs of eNCode; without it they last as long as the program. */
  stateDir?: string
  /** Where each run's own folder is made. Default: the system's temp folder. */
  runDir?: string
  /** eNCode's own Node.js, for a file when no Node.js is installed. */
  node?: { file: string; env?: Record<string, string> }
  /** eNCode's tools folder, where it installs debuggers (debugpy, Delve) when the person says yes. */
  tools?: string
  /** What runs start from. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** What the panel shows of a folder changed: its runs, a breakpoint's state. Called after a short pause, never in a burst. */
  onChange?(root: string): void
  /** What a run printed, a batch at a time. */
  onOutput?(root: string, run: string, lines: OutputLine[]): void
  /** For tests. */
  spawn?: typeof spawn
  nodeVersion?(file: string, env: Record<string, string>): Promise<[number, number] | null>
  ask?: RunContext['ask']
}

/** A file a frame is in, with its path in the folder when it is the folder's. */
export interface DebugSourceView extends SourceView {
  /** '/'-separated. */
  rel?: string
}

export type DebugFrameView = Omit<FrameView, 'source'> & { source: DebugSourceView | null }
export type DebugThreadView = Omit<ThreadView, 'frames'> & { frames?: DebugFrameView[] }

/** A run as the panel shows it. */
export type DebugRunView = Omit<SessionView, 'threads'> & {
  threads: DebugThreadView[]
  /** The configuration it was started from. */
  config: string
  /** What it runs, in a line. */
  detail: string
  /** Who started it: the person, or an agent through its Debug tool (ADR 0145). */
  by: 'person' | 'agent'
}

/** The folder's debugger as one session's agent sees it (ADR 0145); `close` stops the runs that agent started. */
export interface AgentDebugView extends AgentDebugger {
  close(): Promise<void>
}

/** A breakpoint, with how it stands in the runs going on. */
export interface FolderBreakpoint extends Breakpoint {
  /** Placed in code that runs (true), or not yet (false); absent while nothing runs. */
  verified?: boolean
  /** The line it was placed on, when not its own. */
  placed?: number
  message?: string
}

export interface DebugState {
  /** Debugging runs the folder's code: it waits for the folder to be trusted. */
  trusted: boolean
  /** By path in the folder, '/'-separated. */
  breakpoints: Record<string, FolderBreakpoint[]>
  exceptions: ExceptionFilters
  runs: DebugRunView[]
}

export type DebugAction = { kind: 'continue' | 'pause' | 'stop' | 'restart' | 'dismiss'; thread?: number } | { kind: 'step'; step: StepKind; thread?: number }

export type DebugResult = { ok: true } | { ok: false; reason: string }

/** How a start ended: the run, or why there is none, and what eNCode can install to fix that (`debugpy`, `delve`). */
export type DebugStart = { ok: true; run: string } | { ok: false; reason: string; install?: string }

export const DEBUG_UNTRUSTED = "Debugging runs the folder's code, so it runs only in folders you trust. Trust the folder to debug it."

const MAX_FILES = 1_000
const MAX_PER_FILE = 500
const MAX_TOTAL = 5_000
const MAX_EXPRESSION_CHARS = 2_000
const MAX_LINE = 10_000_000
/** Runs that ended stay listed, with their output, until this many newer ones did. */
const KEEP_ENDED = 3
const SAVE_DELAY_MS = 300
const CHANGE_DELAY_MS = 25
/** A source map larger than this is not read. */
const MAX_MAP_BYTES = 50 * 1024 * 1024
/** What an agent's run printed is kept for its reports, up to this many lines. */
const MAX_PRINTED = 2_000
/**
 * What a program printed just before it stopped can come in just after the stop: its pipe and the debugger's
 * connection are two channels (on Windows the stop often wins). A report after a stop waits for the output to be
 * quiet this long, and at most AFTER_STOP_MS.
 */
const QUIET_MS = 150
const AFTER_STOP_MS = 600
const MAX_AGENT_BREAKPOINTS = 50
const BREAKPOINT_ID = /^[\w-]{1,64}$/
const HIT_CONDITION = /^\s*(==|>=|<=|>|<|%)?\s*\d{1,9}\s*$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const lineNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LINE

/** A file's breakpoints as the editor sent them, checked; null when they do not read as breakpoints. */
export function readBreakpoints(value: unknown): Breakpoint[] | null {
  if (!Array.isArray(value) || value.length > MAX_PER_FILE) return null
  const seen = new Set<string>()
  const list: Breakpoint[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !BREAKPOINT_ID.test(item.id) || seen.has(item.id) || !lineNumber(item.line) || typeof item.enabled !== 'boolean') return null
    if (item.column !== undefined && !lineNumber(item.column)) return null
    const text = (key: 'condition' | 'logMessage') => {
      const field = item[key]
      if (field === undefined || field === '') return undefined
      return typeof field === 'string' && field.length <= MAX_EXPRESSION_CHARS ? field : null
    }
    const condition = text('condition')
    const logMessage = text('logMessage')
    const hit = item.hitCondition
    if (condition === null || logMessage === null || (hit !== undefined && hit !== '' && (typeof hit !== 'string' || !HIT_CONDITION.test(hit)))) return null
    seen.add(item.id)
    list.push({
      id: item.id,
      line: item.line,
      ...(item.column !== undefined ? { column: item.column as number } : {}),
      ...(condition?.trim() ? { condition } : {}),
      ...(typeof hit === 'string' && hit.trim() ? { hitCondition: hit.trim() } : {}),
      ...(logMessage?.trim() ? { logMessage } : {}),
      enabled: item.enabled,
    })
  }
  return list
}

/** Exception filters as the panel sent them; null when they do not read as such. */
export function readExceptions(value: unknown): ExceptionFilters | null {
  if (!isRecord(value) || typeof value.uncaught !== 'boolean' || typeof value.all !== 'boolean') return null
  return { uncaught: value.uncaught, all: value.all }
}

const ACTIONS = new Set(['continue', 'pause', 'stop', 'restart', 'dismiss', 'step'])
const STEPS = new Set(['over', 'into', 'out'])
const MAX_ID = 2 ** 31 - 1

/** What the panel asked a run to do, checked; null when it does not read as an action. */
export function readDebugAction(value: unknown): DebugAction | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !ACTIONS.has(value.kind)) return null
  const thread = value.thread
  if (thread !== undefined && (typeof thread !== 'number' || !Number.isInteger(thread) || thread < 0 || thread > MAX_ID)) return null
  const on = thread === undefined ? {} : { thread: thread as number }
  if (value.kind === 'step') return typeof value.step === 'string' && STEPS.has(value.step) ? { kind: 'step', step: value.step as StepKind, ...on } : null
  return { kind: value.kind as Exclude<DebugAction['kind'], 'step'>, ...on }
}

interface Stored {
  version: 1
  breakpoints: Record<string, Breakpoint[]>
  exceptions: ExceptionFilters
}

/** What an agent's run has of its own: its breakpoints by whole path, and when it stops for exceptions. */
interface OwnStops {
  breakpoints: Map<string, Breakpoint[]>
  exceptions: ExceptionFilters
}

/** A start an agent asked for (ADR 0145). */
interface AgentStart extends OwnStops {
  owner: string
  /** The session's scratch folder, a real path: a probe there runs as a file of the folder does (ADR 0149). */
  scratch?: string
  signal?: AbortSignal
}

/** Resolves once nothing more was printed for QUIET_MS, or after AFTER_STOP_MS, or when the call is stopped. */
async function quiet(printed: Run['printed'], signal: AbortSignal): Promise<void> {
  const count = () => printed.before + printed.lines.length
  const end = Date.now() + AFTER_STOP_MS
  let seen = -1
  while (seen !== count() && Date.now() < end && !signal.aborted) {
    seen = count()
    await new Promise((resolve) => setTimeout(resolve, Math.min(QUIET_MS, end - Date.now())))
  }
}

interface Run {
  id: string
  config: string
  file?: string
  plan: RunPlan
  session: RunSession
  /** The session whose agent started it; absent for the person's runs. */
  owner?: string
  own?: OwnStops
  /** The last lines it printed, and how many came before them. */
  printed: { lines: OutputLine[]; before: number }
  /** Called at each change of the run, for an agent waiting on it. */
  waiters: Set<() => void>
}

export class FolderDebugger {
  readonly root: string
  private readonly platform: NodeJS.Platform
  private breakpoints = new Map<string, Breakpoint[]>()
  private exceptions: ExceptionFilters = { uncaught: true, all: false }
  private loaded: Promise<void> | null = null
  private readonly runs = new Map<string, Run>()
  private nextRun = 1
  private nextAgentBreakpoint = 1
  private saveTimer: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly fs: WorkspaceFs,
    private readonly options: DebugOptions,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.root = config.root
    this.platform = platform
  }

  private get api(): typeof path.posix {
    return this.platform === 'win32' ? path.win32 : path.posix
  }

  private stateFile(): string | null {
    const dir = this.options.stateDir
    if (!dir) return null
    const key = createHash('sha256').update(workspaceKey(this.root, this.platform === 'win32')).digest('hex').slice(0, 24)
    return path.join(dir, `${key}.json`)
  }

  /** The breakpoints kept from earlier runs of eNCode, read once; a file that does not read is started over. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.stateFile()
      const text = file ? await this.fs.read(file).catch(() => null) : null
      if (!text) return
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return
      }
      if (!isRecord(raw) || raw.version !== 1) return
      const exceptions = readExceptions(raw.exceptions)
      if (exceptions) this.exceptions = exceptions
      if (!isRecord(raw.breakpoints)) return
      let total = 0
      for (const [rel, value] of Object.entries(raw.breakpoints).slice(0, MAX_FILES)) {
        const list = readBreakpoints(value)
        if (!list?.length || !this.relative(rel) || total + list.length > MAX_TOTAL) continue
        total += list.length
        this.breakpoints.set(rel, list)
      }
    })()
    return this.loaded
  }

  private save(): void {
    const file = this.stateFile()
    if (!file || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const stored: Stored = { version: 1, breakpoints: Object.fromEntries(this.breakpoints), exceptions: this.exceptions }
      void this.fs.writeAtomic(file, JSON.stringify(stored)).catch(() => undefined)
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private changed(): void {
    if (this.changeTimer || !this.options.onChange) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      try {
        this.options.onChange?.(this.root)
      } catch {
        /* a listener's trouble is its own */
      }
    }, CHANGE_DELAY_MS)
    this.changeTimer.unref?.()
  }

  /** A path the editor gave, as the folder's file: '/'-separated, inside the folder; null otherwise. */
  private relative(rel: string): string | null {
    if (!rel || rel.includes('\0') || rel.length > 4_096) return null
    const file = this.api.resolve(this.root, rel)
    const back = this.api.relative(this.root, file)
    if (!back || back.startsWith('..') || this.api.isAbsolute(back)) return null
    return back.split(this.api.sep).join('/')
  }

  /** A file of the folder's own, by its whole path. */
  private inFolder(file: string): boolean {
    return this.within(this.root, file)
  }

  private within(folder: string, file: string): boolean {
    const back = this.api.relative(folder, file)
    return !!back && !back.startsWith('..') && !this.api.isAbsolute(back)
  }

  /** A path an agent gave, as a whole path in its session's scratch folder; null otherwise. */
  private inScratch(scratch: string, given: string): string | null {
    if (!given || given.includes('\0') || given.length > 4_096) return null
    const file = this.api.resolve(this.root, given)
    return this.within(scratch, file) ? file : null
  }

  /**
   * The program of an agent's start in its scratch folder (ADR 0149), by its real path: a link there that leads out of
   * the folder runs what it leads to, which the person was not shown, so it is refused.
   */
  private async probe(scratch: string, given: string): Promise<{ file: string } | { reason: string } | null> {
    const file = this.inScratch(scratch, given)
    if (!file) return null
    const real = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : null))
    if (real === undefined) return { reason: `There is no ${given}: write the probe first.` }
    return real && this.within(scratch, real) ? { file: real } : { reason: `${given} leads out of your scratch folder.` }
  }

  private whole(rel: string): string {
    return this.api.resolve(this.root, ...rel.split('/'))
  }

  /** Every enabled breakpoint by whole path, as a program of a run starts. */
  private placed(): Map<string, Breakpoint[]> {
    const map = new Map<string, Breakpoint[]>()
    for (const [rel, list] of this.breakpoints) {
      const enabled = list.filter((breakpoint) => breakpoint.enabled)
      if (enabled.length) map.set(this.whole(rel), enabled)
    }
    return map
  }

  async state(): Promise<DebugState> {
    await this.load()
    const trusted = (await this.config.refresh()).folder.trusted
    // The person's breakpoints stand as the person's runs placed them; an agent's run has its own.
    const live = [...this.runs.values()].filter((run) => !run.session.ended && !run.owner)
    const breakpoints: Record<string, FolderBreakpoint[]> = {}
    for (const [rel, list] of this.breakpoints) {
      const statuses = new Map<string, BreakpointStatus>()
      for (const run of live) {
        for (const status of run.session.statuses(this.whole(rel))) {
          const known = statuses.get(status.id)
          if (!known || (!known.verified && status.verified)) statuses.set(status.id, status)
        }
      }
      breakpoints[rel] = list.map((breakpoint) => {
        if (!live.length || !breakpoint.enabled) return breakpoint
        const status = statuses.get(breakpoint.id)
        return { ...breakpoint, verified: status?.verified ?? false, ...(status?.line && status.line !== breakpoint.line ? { placed: status.line } : {}), ...(status?.message ? { message: status.message } : {}) }
      })
    }
    return { trusted, breakpoints, exceptions: this.exceptions, runs: [...this.runs.values()].map((run) => this.runView(run)) }
  }

  private runView(run: Run): DebugRunView {
    const view = run.session.view()
    const source = (from: SourceView | null): DebugSourceView | null => {
      if (!from?.path) return from
      const back = this.api.relative(this.root, from.path)
      return back && !back.startsWith('..') && !this.api.isAbsolute(back) ? { ...from, rel: back.split(this.api.sep).join('/') } : from
    }
    return {
      ...view,
      config: run.config,
      detail: run.plan.detail,
      by: run.owner ? 'agent' : 'person',
      threads: view.threads.map((thread) => ({ ...thread, ...(thread.frames ? { frames: thread.frames.map((frame) => ({ ...frame, source: source(frame.source) })) } : {}) })),
    }
  }

  configs(): Promise<DebugConfigs> {
    return debugConfigs(this.root)
  }

  /** Starts a run of a configuration; `file` is the editor's file, by its path in the folder. `agent`: an agent's run. */
  async start(request: { config: string; file?: string }, agent?: AgentStart): Promise<DebugStart> {
    if (this.closed) return { ok: false, reason: 'eNCode is closing.' }
    await this.load()
    if (!(await this.config.refresh()).folder.trusted) return { ok: false, reason: DEBUG_UNTRUSTED }
    let file: string | undefined
    if (request.file !== undefined) {
      const rel = this.relative(request.file)
      if (rel) file = this.whole(rel)
      else {
        // An agent's probe in its scratch folder, which reaches the folder's files by their whole paths (ADR 0149).
        const probe = agent?.scratch ? await this.probe(agent.scratch, request.file) : null
        if (!probe) return { ok: false, reason: agent?.scratch ? 'That file is in neither the open folder nor your scratch folder.' : 'That file is not in the open folder.' }
        if ('reason' in probe) return { ok: false, reason: probe.reason }
        file = probe.file
      }
    }
    let plan: RunPlan
    try {
      plan = await planRun(request.config, {
        root: this.root,
        platform: this.platform,
        env: this.options.env ?? process.env,
        ...(file ? { file } : {}),
        ...(this.options.node ? { node: this.options.node } : {}),
        ...(this.options.nodeVersion ? { nodeVersion: this.options.nodeVersion } : {}),
        ...(this.options.tools ? { tools: this.options.tools } : {}),
        ...(this.options.ask ? { ask: this.options.ask } : {}),
      })
    } catch (error) {
      if (error instanceof RunProblem) return { ok: false, reason: error.message, ...(error.install ? { install: error.install } : {}) }
      throw error
    }
    if (agent?.signal?.aborted) return { ok: false, reason: 'The run was stopped.' }
    return this.launch(request.config, file, plan, agent)
  }

  private async launch(config: string, file: string | undefined, plan: RunPlan, agent?: AgentStart): Promise<DebugStart> {
    // A configuration started again replaces its earlier run that ended, by the same hand; only a few ended runs stay listed.
    for (const [id, run] of this.runs) if (run.config === config && run.owner === agent?.owner && run.session.ended) this.runs.delete(id)
    const ended = [...this.runs.values()].filter((run) => run.session.ended)
    for (const run of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED + 1))) this.runs.delete(run.id)
    const id = `r${this.nextRun++}`
    const runDir = path.join(this.options.runDir ?? path.join(os.tmpdir(), 'encode-debug'), `${process.pid}-${id}-${Date.now().toString(36)}`)
    const own: OwnStops | undefined = agent ? { breakpoints: agent.breakpoints, exceptions: agent.exceptions } : undefined
    const printed: Run['printed'] = { lines: [], before: 0 }
    const waiters: Run['waiters'] = new Set()
    const shared = {
      id,
      name: plan.name,
      platform: this.platform,
      breakpoints: () => (own ? new Map(own.breakpoints) : this.placed()),
      exceptions: own?.exceptions ?? this.exceptions,
      onChange: () => {
        for (const waiter of [...waiters]) waiter()
        this.changed()
      },
      onOutput: (lines: OutputLine[]) => {
        printed.lines.push(...lines)
        const over = printed.lines.length - MAX_PRINTED
        if (over > 0) {
          printed.lines.splice(0, over)
          printed.before += over
        }
        try {
          this.options.onOutput?.(this.root, id, lines)
        } catch {
          /* a listener's trouble is its own */
        }
      },
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    }
    const session: RunSession =
      plan.kind === 'dap'
        ? new DapSession({ ...shared, plan: { ...plan.dap, runDir }, isOwn: (path) => this.inFolder(path) || (!!agent?.scratch && this.within(agent.scratch, path)) })
        : new DebugSession({
            ...shared,
            plan: plan.kind === 'attach' ? { kind: 'attach', host: plan.host, port: plan.port } : { kind: 'launch', file: plan.file, args: plan.args, cwd: plan.cwd, env: plan.env, runDir, ...(plan.verbatim ? { verbatim: true } : {}) },
            readText: (map) => readBounded(map),
          })
    const run: Run = { id, config, ...(file ? { file } : {}), plan, session, ...(agent ? { owner: agent.owner, own } : {}), printed, waiters }
    this.runs.set(id, run)
    this.changed()
    // The agent's call was stopped: so is its run, a build included.
    const signal = agent?.signal
    if (signal) {
      const stop = () => void session.stop().catch(() => undefined)
      signal.addEventListener('abort', stop, { once: true })
      const forget = () => {
        if (!session.ended) return
        signal.removeEventListener('abort', stop)
        waiters.delete(forget)
      }
      waiters.add(forget)
    }
    try {
      await session.start()
    } catch (error) {
      // The run is listed, ended, with why: the panel shows it.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, run: id }
  }

  async act(runId: string, action: DebugAction): Promise<DebugResult | { ok: true; run: string }> {
    const run = this.runs.get(runId)
    if (!run) return { ok: false, reason: 'That run is over.' }
    const session = run.session
    try {
      switch (action.kind) {
        case 'continue':
          await session.resume(action.thread)
          break
        case 'pause':
          await session.pause(action.thread)
          break
        case 'step':
          await session.step(action.step, action.thread)
          break
        case 'stop':
          await session.stop()
          break
        case 'dismiss':
          if (!session.ended) await session.stop()
          this.runs.delete(runId)
          this.changed()
          break
        case 'restart': {
          // An agent's probe in its scratch folder is its own to start (ADR 0149).
          if (run.file && !this.inFolder(run.file)) return { ok: false, reason: "That run's program is the agent's probe, outside the open folder: only the agent can start it again." }
          await session.stop()
          await session.settled
          this.runs.delete(runId)
          if (!(await this.config.refresh()).folder.trusted) return { ok: false, reason: DEBUG_UNTRUSTED }
          // Worked out again: the file or the configuration may have changed.
          const rel = run.file ? this.api.relative(this.root, run.file).split(this.api.sep).join('/') : undefined
          return this.start({ config: run.config, ...(rel ? { file: rel } : {}) })
        }
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true }
  }

  /** A file's breakpoints, as the editor has them now; every run gets them. */
  async setBreakpoints(rel: string, list: Breakpoint[]): Promise<DebugResult> {
    await this.load()
    const file = this.relative(rel)
    if (!file) return { ok: false, reason: 'That file is not in the open folder.' }
    const others = [...this.breakpoints].reduce((all, [key, items]) => all + (key === file ? 0 : items.length), 0)
    if (others + list.length > MAX_TOTAL || (!this.breakpoints.has(file) && this.breakpoints.size >= MAX_FILES)) return { ok: false, reason: `A folder keeps at most ${MAX_TOTAL} breakpoints.` }
    if (list.length) this.breakpoints.set(file, list)
    else this.breakpoints.delete(file)
    this.save()
    const enabled = list.filter((breakpoint) => breakpoint.enabled)
    await Promise.all([...this.runs.values()].filter((run) => !run.session.ended && !run.own).map((run) => run.session.setBreakpoints(this.whole(file), enabled).catch(() => undefined)))
    this.changed()
    return { ok: true }
  }

  async setExceptions(filters: ExceptionFilters): Promise<DebugResult> {
    await this.load()
    this.exceptions = filters
    this.save()
    await Promise.all([...this.runs.values()].filter((run) => !run.session.ended && !run.own).map((run) => run.session.setExceptions(filters).catch(() => undefined)))
    this.changed()
    return { ok: true }
  }

  async scopes(runId: string, frame: number): Promise<ScopeView[]> {
    return (await this.runs.get(runId)?.session.scopes(frame).catch(() => [])) ?? []
  }

  async variables(runId: string, ref: number): Promise<VariableView[]> {
    return (await this.runs.get(runId)?.session.variables(ref).catch(() => [])) ?? []
  }

  async evaluate(runId: string, expression: string, options: { frame?: number; thread?: number; context: EvaluateContext }): Promise<EvaluateResult> {
    const session = this.runs.get(runId)?.session
    if (!session || session.ended) return { ok: false, message: 'That run is over.' }
    if (!expression.trim()) return { ok: false, message: 'Type an expression.' }
    if (expression.length > MAX_EXPRESSION_CHARS * 4) return { ok: false, message: 'That expression is too long.' }
    return session.evaluate(expression, { ...(options.frame !== undefined ? { frameId: options.frame } : {}), ...(options.thread !== undefined ? { threadId: options.thread } : {}), context: options.context }).catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
  }

  /** An agent's breakpoints, checked as the person's are, by whole path; or what is wrong with them. `scratch`: its probes may have some (ADR 0149). */
  private agentBreakpoints(list: readonly AgentBreakpoint[], scratch?: string): Map<string, Breakpoint[]> | string {
    if (list.length > MAX_AGENT_BREAKPOINTS) return `A run takes at most ${MAX_AGENT_BREAKPOINTS} breakpoints.`
    const map = new Map<string, Breakpoint[]>()
    for (const item of list) {
      const rel = typeof item.file === 'string' ? this.relative(item.file) : null
      const whole = rel ? this.whole(rel) : typeof item.file === 'string' && scratch ? this.inScratch(scratch, item.file) : null
      if (!whole) return `${String(item.file)} is ${scratch ? 'in neither the open folder nor your scratch folder' : 'not in the open folder'}.`
      if (!lineNumber(item.line)) return `${String(item.line)} is not a line number.`
      if ((item.condition?.length ?? 0) > MAX_EXPRESSION_CHARS || (item.logMessage?.length ?? 0) > MAX_EXPRESSION_CHARS) return `A condition or a log message is at most ${MAX_EXPRESSION_CHARS} characters.`
      if (item.hitCondition !== undefined && !HIT_CONDITION.test(item.hitCondition)) return `"${item.hitCondition}" is not a hit count: "5", "==5", ">5" or "%5".`
      const breakpoint: Breakpoint = {
        id: `a${this.nextAgentBreakpoint++}`,
        line: item.line,
        enabled: true,
        ...(item.condition?.trim() ? { condition: item.condition.trim() } : {}),
        ...(item.hitCondition?.trim() ? { hitCondition: item.hitCondition.trim() } : {}),
        ...(item.logMessage ? { logMessage: item.logMessage } : {}),
      }
      map.set(whole, [...(map.get(whole) ?? []), breakpoint])
    }
    return map
  }

  /**
   * The folder's debugger as the agent of one session sees it (ADR 0145): the runs it started, with breakpoints of
   * their own, and the person's runs. The approvals are the Debug tool's; this keeps each agent to its own runs and the
   * person's, and keeps the person's breakpoints out of an agent's runs and the agent's out of the person's.
   * `scratch`: the session's scratch folder (ADR 0141), a real path, where the agent's probes may run (ADR 0149).
   */
  forAgent(owner: string, scratch?: string): AgentDebugView {
    /** How much of each run's output this agent has read. */
    const marks = new Map<string, number>()
    const visible = (id: string): Run | undefined => {
      const run = this.runs.get(id)
      return run && (!run.owner || run.owner === owner) ? run : undefined
    }
    const view = (run: Run): AgentDebugRun => {
      const seen = run.session.view()
      return {
        id: run.id,
        name: seen.name,
        detail: run.plan.detail,
        mine: run.owner === owner,
        state: seen.state,
        stops: seen.stops,
        threads: seen.threads.map((thread) => ({
          id: thread.id,
          name: thread.name,
          state: thread.state,
          ...(thread.reason ? { reason: thread.reason } : {}),
          ...(thread.exception ? { exception: thread.exception } : {}),
          ...(thread.frames ? { frames: thread.frames.map((frame) => ({ id: frame.id, name: frame.name, file: frame.source?.path ?? null, line: frame.line, ...(frame.skipped ? { skipped: true } : {}) })) } : {}),
        })),
        ...(seen.exitCode !== undefined ? { exitCode: seen.exitCode } : {}),
        ...(seen.message ? { message: seen.message } : {}),
      }
    }
    const gone = { ok: false as const, reason: 'There is no such run.' }
    return {
      configs: async () => (await this.configs()).configs.map((config) => ({ id: config.id, name: config.name, detail: config.detail, ...(config.problem ? { problem: config.problem } : {}) })),
      start: async (request) => {
        await this.load()
        const breakpoints = this.agentBreakpoints(request.breakpoints, scratch)
        if (typeof breakpoints === 'string') return { ok: false, reason: breakpoints }
        const exceptions = readExceptions(request.exceptions)
        if (!exceptions) return { ok: false, reason: 'Those are not exception stops.' }
        return this.start({ config: request.config, ...(request.file !== undefined ? { file: request.file } : {}) }, { owner, breakpoints, exceptions, ...(scratch ? { scratch } : {}), ...(request.signal ? { signal: request.signal } : {}) })
      },
      runs: async () => [...this.runs.values()].filter((run) => !run.owner || run.owner === owner).map(view),
      wait: async (id, stops, ms, signal) => {
        const run = visible(id)
        if (!run) return null
        const done = () => run.session.ended || run.session.view().stops > stops
        if (!done() && !signal.aborted) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              run.waiters.delete(check)
              signal.removeEventListener('abort', finish)
              resolve()
            }
            const check = () => {
              if (done()) finish()
            }
            const timer = setTimeout(finish, ms)
            run.waiters.add(check)
            signal.addEventListener('abort', finish, { once: true })
          })
        }
        if (!run.session.ended && run.session.view().stops > stops) await quiet(run.printed, signal)
        return view(run)
      },
      act: async (id, action, thread) => {
        if (!visible(id)) return gone
        const done = await this.act(id, { ...action, ...(thread !== undefined ? { thread } : {}) })
        return done.ok ? { ok: true } : done
      },
      setBreakpoints: async (id, list) => {
        const run = visible(id)
        if (!run?.own || run.owner !== owner) return { ok: false, reason: "Only a run the agent started takes the agent's breakpoints." }
        const next = this.agentBreakpoints(list, scratch)
        if (typeof next === 'string') return { ok: false, reason: next }
        const before = run.own.breakpoints
        run.own.breakpoints = next
        const files = new Set([...before.keys(), ...next.keys()])
        if (!run.session.ended) await Promise.all([...files].map((file) => run.session.setBreakpoints(file, next.get(file) ?? []).catch(() => undefined)))
        this.changed()
        return { ok: true }
      },
      statuses: (id) => {
        const run = visible(id)
        if (!run?.own) return []
        return [...run.own.breakpoints].flatMap(([file, list]) => {
          const statuses = new Map(run.session.statuses(file).map((status) => [status.id, status]))
          return list.map((breakpoint) => {
            const status = statuses.get(breakpoint.id)
            return { file, line: breakpoint.line, verified: status?.verified ?? false, ...(status?.line && status.line !== breakpoint.line ? { placed: status.line } : {}), ...(status?.message ? { message: status.message } : {}) }
          })
        })
      },
      scopes: async (id, frame) => (visible(id) ? this.scopes(id, frame) : []),
      // An object's prototype is in every object: it says nothing the agent needs.
      variables: async (id, ref) => (visible(id) ? (await this.variables(id, ref)).filter((value) => value.name !== '[[Prototype]]') : []),
      evaluate: async (id, expression, at) => (visible(id) ? this.evaluate(id, expression, { ...at, context: 'repl' }) : { ok: false, message: gone.reason }),
      printed: (id) => {
        const run = visible(id)
        if (!run) return { lines: [], dropped: 0 }
        const { lines, before } = run.printed
        const from = marks.get(id) ?? 0
        const first = Math.max(from, before)
        marks.set(id, before + lines.length)
        return { lines: lines.slice(first - before).map((line) => ({ category: line.category, text: line.text })), dropped: first - from }
      },
      close: async () => {
        const mine = [...this.runs.values()].filter((run) => run.owner === owner)
        await Promise.all(mine.map((run) => (run.session.ended ? undefined : run.session.stop().catch(() => undefined))))
      },
    }
  }

  /** Stops every run: a program started for one ends, one attached to goes on. */
  async close(): Promise<void> {
    this.closed = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    await Promise.all([...this.runs.values()].map(async (run) => {
      await run.session.stop().catch(() => undefined)
      await run.session.settled
    }))
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      const file = this.stateFile()
      if (file) await this.fs.writeAtomic(file, JSON.stringify({ version: 1, breakpoints: Object.fromEntries(this.breakpoints), exceptions: this.exceptions } satisfies Stored)).catch(() => undefined)
    }
  }
}

/** A source map's text, when the file is not larger than a map can sensibly be. */
async function readBounded(file: string): Promise<string | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_MAP_BYTES) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}
