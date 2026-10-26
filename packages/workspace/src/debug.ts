/**
 * A folder's debugger (ADR 0143): its breakpoints and when it stops for exceptions, kept between runs; the ways it
 * can be run (debug-configs.ts); and its runs, each a DebugSession of @encode/debug, as the panel and the editor see
 * them, with files named by their paths in the folder.
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
import { DebugSession, type Breakpoint, type BreakpointStatus, type EvaluateContext, type EvaluateResult, type ExceptionFilters, type FrameView, type OutputLine, type ScopeView, type SessionView, type SourceView, type StepKind, type ThreadView, type VariableView } from '@encode/debug'
import type { WorkspaceConfig } from './config'
import { debugConfigs, planRun, RunProblem, type DebugConfigs, type RunPlan } from './debug-configs'
import type { WorkspaceFs } from './fs'

export type { Breakpoint, BreakpointStatus, EvaluateContext, EvaluateResult, ExceptionFilters, OutputLine, PauseReason, ScopeView, StepKind, VariableView } from '@encode/debug'

export interface DebugOptions {
  /** Where each folder's breakpoints are kept between runs of eNCode; without it they last as long as the program. */
  stateDir?: string
  /** Where each run's own folder is made. Default: the system's temp folder. */
  runDir?: string
  /** eNCode's own Node.js, for a file when no Node.js is installed. */
  node?: { file: string; env?: Record<string, string> }
  /** What runs start from. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** What the panel shows of a folder changed: its runs, a breakpoint's state. Called after a short pause, never in a burst. */
  onChange?(root: string): void
  /** What a run printed, a batch at a time. */
  onOutput?(root: string, run: string, lines: OutputLine[]): void
  /** For tests. */
  spawn?: typeof spawn
  nodeVersion?(file: string, env: Record<string, string>): Promise<[number, number] | null>
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

interface Run {
  id: string
  config: string
  file?: string
  plan: RunPlan
  session: DebugSession
}

export class FolderDebugger {
  readonly root: string
  private readonly platform: NodeJS.Platform
  private breakpoints = new Map<string, Breakpoint[]>()
  private exceptions: ExceptionFilters = { uncaught: true, all: false }
  private loaded: Promise<void> | null = null
  private readonly runs = new Map<string, Run>()
  private nextRun = 1
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
    const live = [...this.runs.values()].filter((run) => !run.session.ended)
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
      threads: view.threads.map((thread) => ({ ...thread, ...(thread.frames ? { frames: thread.frames.map((frame) => ({ ...frame, source: source(frame.source) })) } : {}) })),
    }
  }

  configs(): Promise<DebugConfigs> {
    return debugConfigs(this.root)
  }

  /** Starts a run of a configuration; `file` is the editor's file, by its path in the folder. */
  async start(request: { config: string; file?: string }): Promise<{ ok: true; run: string } | { ok: false; reason: string }> {
    if (this.closed) return { ok: false, reason: 'eNCode is closing.' }
    await this.load()
    if (!(await this.config.refresh()).folder.trusted) return { ok: false, reason: DEBUG_UNTRUSTED }
    let file: string | undefined
    if (request.file !== undefined) {
      const rel = this.relative(request.file)
      if (!rel) return { ok: false, reason: 'That file is not in the open folder.' }
      file = this.whole(rel)
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
      })
    } catch (error) {
      if (error instanceof RunProblem) return { ok: false, reason: error.message }
      throw error
    }
    return this.launch(request.config, file, plan)
  }

  private async launch(config: string, file: string | undefined, plan: RunPlan): Promise<{ ok: true; run: string } | { ok: false; reason: string }> {
    // A configuration started again replaces its earlier run that ended; only a few ended runs stay listed.
    for (const [id, run] of this.runs) if (run.config === config && run.session.ended) this.runs.delete(id)
    const ended = [...this.runs.values()].filter((run) => run.session.ended)
    for (const run of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED + 1))) this.runs.delete(run.id)
    const id = `r${this.nextRun++}`
    const runDir = path.join(this.options.runDir ?? path.join(os.tmpdir(), 'encode-debug'), `${process.pid}-${id}-${Date.now().toString(36)}`)
    const session = new DebugSession({
      id,
      name: plan.name,
      plan:
        plan.kind === 'attach'
          ? { kind: 'attach', host: plan.host, port: plan.port }
          : { kind: 'launch', file: plan.file, args: plan.args, cwd: plan.cwd, env: plan.env, runDir, ...(plan.verbatim ? { verbatim: true } : {}) },
      platform: this.platform,
      breakpoints: () => this.placed(),
      exceptions: this.exceptions,
      readText: (map) => readBounded(map),
      onChange: () => this.changed(),
      onOutput: (lines) => {
        try {
          this.options.onOutput?.(this.root, id, lines)
        } catch {
          /* a listener's trouble is its own */
        }
      },
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    })
    const run: Run = { id, config, ...(file ? { file } : {}), plan, session }
    this.runs.set(id, run)
    this.changed()
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
    await Promise.all([...this.runs.values()].filter((run) => !run.session.ended).map((run) => run.session.setBreakpoints(this.whole(file), enabled).catch(() => undefined)))
    this.changed()
    return { ok: true }
  }

  async setExceptions(filters: ExceptionFilters): Promise<DebugResult> {
    await this.load()
    this.exceptions = filters
    this.save()
    await Promise.all([...this.runs.values()].filter((run) => !run.session.ended).map((run) => run.session.setExceptions(filters).catch(() => undefined)))
    this.changed()
    return { ok: true }
  }

  scopes(runId: string, frame: number): ScopeView[] {
    return this.runs.get(runId)?.session.scopes(frame) ?? []
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
