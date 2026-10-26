/**
 * A debug run through a language's own debugger over the Debug Adapter Protocol (ADR 0144): debugpy for Python, Delve
 * for Go, lldb-dap for C, C++ and Rust. The debugger is a separate program, started for the run and stopped with it;
 * this side keeps the run in the same shape as a Node.js run (ADR 0143), so the panel, the editor and the agent see
 * one kind of run whatever the language.
 *
 * The protocol's ids (threads, frames, values) are the debugger's and live only while the program stays paused; the
 * run gives out its own small ids for them and forgets them when the program goes on, so an id of an earlier pause
 * never reaches the debugger. What the debugger sends is bounded: so many threads and frames, values cut at a length.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { killTree } from '@encode/tools'
import { ADAPTERS, pauseReason, type AdapterKind, type AdapterProfile } from './adapters'
import { DapConnection, DapError, type DapEvent } from './dap'
import { OutputBatch } from './output'
import { fileKey } from './paths'
import { CHUNK } from './node-target'
import type { Breakpoint, BreakpointStatus, EvaluateContext, EvaluateResult, ExceptionFilters, FrameView, OutputLine, PauseReason, RunSession, ScopeView, SessionView, StepKind, ThreadView, VariableView } from './types'

/** The debugger to start for a run, and how it is reached. */
export interface AdapterProgram {
  file: string
  /** `{clientAddr}` in one is the address the debugger dials in on (Delve's `--client-addr`). */
  args: string[]
  cwd: string
  env: Record<string, string>
  /** `stdio`: it speaks over its standard input and output. `dial`: it connects to the address it is given. */
  transport: 'stdio' | 'dial'
  verbatim?: boolean
}

/** What the run's work before the debugger (a build) can use. */
export interface PrepareContext {
  /** The run's own folder, where a build may put the program it makes. */
  runDir: string
  print(category: 'stdout' | 'stderr' | 'info', text: string): void
  signal: AbortSignal
}

export interface DapPlan {
  kind: 'dap'
  profile: AdapterKind
  adapter: AdapterProgram
  request: 'launch' | 'attach'
  /** The arguments of `launch` or `attach`, as this debugger reads them. */
  arguments: Record<string, unknown>
  /** A folder of this run's own; removed when the run ends. */
  runDir: string
  /** Work before the debugger starts, such as a build; what it gives back is added to the arguments. */
  prepare?(context: PrepareContext): Promise<Record<string, unknown> | void>
  /** A Rust program: its panics are its exceptions. */
  rust?: boolean
}

export interface DapSessionOptions {
  id: string
  name: string
  plan: DapPlan
  platform?: NodeJS.Platform
  breakpoints(): Map<string, Breakpoint[]>
  exceptions: ExceptionFilters
  /** A file of the person's own code: frames elsewhere are dimmed and folded. */
  isOwn?(file: string): boolean
  onChange(): void
  onOutput(lines: OutputLine[]): void
  /** For tests. */
  spawn?: typeof spawn
}

const INITIALIZE_MS = 20_000
/** A launch may build the program first (Delve's debug mode). */
const LAUNCH_MS = 180_000
const DIAL_MS = 20_000
const REQUEST_MS = 15_000
const STOP_MS = 3_000
const MAX_THREADS = 200
/** Threads whose frames are read when all stop; the one that stopped is always read. */
const MAX_STACKS = 32
const MAX_FRAMES = 200
const OTHER_FRAMES = 40
const MAX_VARIABLES = 2_000
const MAX_VALUE_CHARS = 10_000
const MAX_NAME_CHARS = 500
const TAIL_LINES = 30
const GONE_GRACE_MS = 200
/** How long a debugger that closed its connection as it started is given to exit, so that its exit code can be told. */
const EXIT_WAIT_MS = 1_000
/** Windows's STATUS_DLL_NOT_FOUND: the program could not load a library it needs (LLVM's lldb-dap, its Python's). */
const MISSING_DLL = 0xc0000135
/** How Windows ends a program that crashed, by its exit code. */
const CRASHES: Record<number, string> = { 0xc0000005: 'an access violation', 0xc00000fd: 'a stack overflow', 0xc0000409: 'a check that failed in it', 0xc000001d: 'an instruction the processor does not have' }
/** A hover reads names and their fields only: nothing that calls anything. */
const NAME_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)

interface ThreadEntry {
  id: number
  dap: number
  name: string
  paused: boolean
  reason?: PauseReason
  exception?: string
  frames?: FrameView[]
}

/** What one of the run's value ids stands for: the debugger's reference, a part of it, or groups of its items. */
type RefTarget = { dap: number; indexed: number; named: number } | { dap: number; filter: 'indexed'; start: number; count: number } | { dap: number; filter: 'named' }

interface Placed {
  id: string
  dap?: number
  verified: boolean
  line?: number
  message?: string
}

export class DapSession implements RunSession {
  readonly id: string
  private readonly platform: NodeJS.Platform
  private readonly profile: AdapterProfile
  private state: SessionView['state'] = 'starting'
  private exitCode: number | null | undefined
  /** The debugger's own exit code, once it has exited. */
  private adapterCode: number | null | undefined
  private message: string | undefined
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null
  private server: net.Server | null = null
  private dap: DapConnection | null = null
  private caps: Record<string, unknown> = {}
  private readonly threads = new Map<number, ThreadEntry>()
  private readonly byDap = new Map<number, number>()
  private nextThread = 1
  private readonly frames = new Map<number, { dap: number; thread: number; scopes: boolean }>()
  private nextFrame = 1
  private readonly refs = new Map<number, RefTarget>()
  private nextRef = 1
  /** Counts the program's pauses and goes: what was read for an older pause is dropped. */
  private generation = 0
  private exceptions: ExceptionFilters
  private readonly wanted = new Map<string, { file: string; list: Breakpoint[] }>()
  private readonly sending = new Map<string, Promise<void>>()
  private readonly placed = new Map<string, Placed[]>()
  private ready = false
  private functionsSet = false
  private readonly out: OutputBatch
  private readonly tail: string[] = []
  private stopping = false
  private readonly abort = new AbortController()
  private initialized: { resolve(): void; reject(error: Error): void } | null = null
  private cleanup: Promise<void> = Promise.resolve()

  constructor(private readonly options: DapSessionOptions) {
    this.id = options.id
    this.platform = options.platform ?? process.platform
    this.profile = ADAPTERS[options.plan.profile]
    this.exceptions = options.exceptions
    this.out = new OutputBatch(
      (lines) => options.onOutput(lines),
      (category, line) => category === 'console' && this.profile.chatter.some((pattern) => pattern.test(line)),
    )
  }

  get ended(): boolean {
    return this.state === 'ended'
  }

  get settled(): Promise<void> {
    return this.cleanup
  }

  view(): SessionView {
    const threads: ThreadView[] = [...this.threads.values()].map((thread) =>
      thread.paused
        ? { id: thread.id, name: thread.name, state: 'paused', ...(thread.reason ? { reason: thread.reason } : {}), ...(thread.exception ? { exception: thread.exception } : {}), frames: thread.frames ?? [] }
        : { id: thread.id, name: thread.name, state: 'running' },
    )
    const state = this.state === 'ended' ? 'ended' : threads.some((thread) => thread.state === 'paused') ? 'paused' : this.state
    return {
      id: this.id,
      name: this.options.name,
      kind: this.options.plan.request,
      state,
      threads,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.message ? { message: this.message } : {}),
    }
  }

  async start(): Promise<void> {
    const plan = this.options.plan
    try {
      await fs.mkdir(plan.runDir, { recursive: true, mode: 0o700 })
      let extra: Record<string, unknown> = {}
      if (plan.prepare) {
        extra = (await plan.prepare({ runDir: plan.runDir, signal: this.abort.signal, print: (category, line) => this.out.print(category, line.endsWith('\n') ? line : `${line}\n`) })) ?? {}
        this.out.flush()
      }
      if (this.ended) return
      await this.startAdapter(plan.adapter)
      const dap = this.dap!
      // Waited for from before the initialize request: the protocol lets a debugger send it right after its answer.
      const initialized = new Promise<void>((resolve, reject) => {
        this.initialized = { resolve, reject }
      })
      initialized.catch(() => undefined)
      this.caps = await dap.request(
        'initialize',
        {
          clientID: 'encode',
          clientName: 'eNCode',
          adapterID: this.profile.adapterId,
          locale: 'en',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
          supportsVariableType: true,
          supportsVariablePaging: true,
          supportsRunInTerminalRequest: false,
          supportsStartDebuggingRequest: false,
          supportsMemoryReferences: false,
          supportsProgressReporting: false,
          supportsInvalidatedEvent: false,
        },
        { timeoutMs: INITIALIZE_MS },
      )
      const timer = setTimeout(() => this.initialized?.reject(new Error(`${this.profile.label} did not get ready within ${LAUNCH_MS / 1000} s.`)), LAUNCH_MS)
      timer.unref?.()
      const launched = dap.request(plan.request, { ...plan.arguments, ...extra }, { timeoutMs: LAUNCH_MS })
      // The debugger may answer the launch before it is ready for breakpoints (Delve), or only after (debugpy).
      try {
        await Promise.race([initialized, launched.then(() => initialized)])
      } finally {
        clearTimeout(timer)
      }
      await this.configure()
      await launched
      if (this.state === 'starting') this.state = 'running'
      this.options.onChange()
    } catch (error) {
      // Stopped by the person while it started (in its build): not a failure.
      if (this.stopping) return this.programEnded()
      const reason = await this.failure(error)
      this.end(reason)
      throw new Error(reason)
    }
  }

  /** Why the run could not start, with the last lines the debugger wrote when it said nothing itself. */
  private async failure(error: unknown): Promise<string> {
    const said = error instanceof Error ? error.message : String(error)
    if (error instanceof DapError && error.code === 'failed') return said
    // The debugger closed as it started: how it exited says more than the closed connection (a missing DLL on Windows).
    if (error instanceof DapError && error.code === 'closed' && this.exited) {
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref?.())])
      if (this.adapterCode !== undefined) return this.goneReason(this.endedWith(this.adapterCode), this.adapterCode)
    }
    const tail = this.tail.filter((line) => line.trim()).slice(-6).join('\n')
    return tail && !said.includes(tail) ? `${said}\n${tail}` : said
  }

  private async startAdapter(adapter: AdapterProgram): Promise<void> {
    let address: string | null = null
    let dialed: Promise<net.Socket> | null = null
    if (adapter.transport === 'dial') {
      const server = net.createServer()
      this.server = server
      if (this.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => resolve())
        })
        address = `127.0.0.1:${(server.address() as net.AddressInfo).port}`
      } else {
        // A socket in the run's own folder, which only its owner may open.
        const file = path.join(this.options.plan.runDir, 'dap.sock')
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(file, () => resolve())
        })
        address = `unix:${file}`
      }
      dialed = new Promise<net.Socket>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.profile.label} did not connect within ${DIAL_MS / 1000} s.`)), DIAL_MS)
        timer.unref?.()
        server.once('connection', (socket) => {
          clearTimeout(timer)
          // One debugger, one connection: nothing else is let in.
          server.close()
          server.on('connection', (other) => other.destroy())
          resolve(socket)
        })
      })
    }
    const args = adapter.args.map((arg) => (address ? arg.replace('{clientAddr}', address) : arg))
    const child = (this.options.spawn ?? spawn)(adapter.file, args, {
      cwd: adapter.cwd,
      env: adapter.env,
      stdio: [adapter.transport === 'stdio' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // Its own process group, so that stopping the run stops the program the debugger started too.
      detached: this.platform !== 'win32',
      windowsHide: true,
      shell: false,
      ...(adapter.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    this.exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => reject(new Error(`${this.profile.label} could not be started: ${error.message}`)))
    })
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        this.tail.push(clip(line, 500))
        if (this.tail.length > TAIL_LINES) this.tail.shift()
      }
    }
    child.stderr?.on('data', keep)
    child.once('exit', (exitCode) => {
      this.adapterCode = exitCode
    })
    // What the debugger sent last may still be on its way when it closes: it is read first.
    void this.exited.then(() => setTimeout(() => this.adapterGone(this.endedWith(this.adapterCode ?? null), this.adapterCode ?? null), GONE_GRACE_MS).unref?.())
    const handlers = { onEvent: (event: DapEvent) => this.event(event), onClose: (reason: string) => this.lost(reason) }
    if (adapter.transport === 'stdio') {
      this.dap = new DapConnection(child.stdout!, child.stdin!, handlers)
      return
    }
    child.stdout?.on('data', keep)
    const ended = this.exited.then(() => {
      throw new Error(`${this.profile.label} ended before it connected.`)
    })
    const socket = await Promise.race([dialed!, ended])
    this.dap = new DapConnection(socket, socket, handlers)
  }

  private lost(reason: string): void {
    if (this.ended) return
    this.initialized?.reject(new DapError(reason, 'closed'))
    // While the run starts, the start says why it failed.
    if (this.state === 'starting') return
    // A debugger that is exiting says with its exit code why; one that stays is given up on a moment later.
    if (this.child && this.adapterCode === undefined) setTimeout(() => this.adapterGone(reason), EXIT_WAIT_MS).unref?.()
    else this.adapterGone(reason)
  }

  /** `lldb-dap ended (code 1)`; on Windows a code of its own (a crash, a missing DLL) in hexadecimal, as Windows names it. */
  private endedWith(code: number | null): string {
    const status = code === null ? null : code >>> 0
    const shown = status === null ? 'none' : this.platform === 'win32' && status >= 0xc0000000 ? `0x${status.toString(16).toUpperCase()}` : String(code)
    return `${this.profile.label} ended (code ${shown})`
  }

  /** The debugger went away: the run is over, as asked, as the program ended, or as something failed. */
  private adapterGone(reason: string, code: number | null = null): void {
    if (this.ended) return
    if (this.stopping || this.exitCode !== undefined) return this.programEnded()
    this.end(this.goneReason(reason, code))
  }

  /** The debugger exited unasked: when, a library Windows could not find, and the last lines it wrote. */
  private goneReason(reason: string, code: number | null): string {
    const said = this.tail.filter((line) => line.trim()).slice(-6).join('\n')
    const status = code === null ? null : code >>> 0
    const windows = this.platform === 'win32' && status !== null
    const dll = windows && status === MISSING_DLL ? ` Windows could not find a library (DLL) it needs.${this.profile.kind === 'lldb' ? " LLVM's lldb-dap needs the Python its LLVM release was built with: install that Python, or a newer LLVM." : ''}` : ''
    const crash = windows && CRASHES[status] ? ` It crashed, with ${CRASHES[status]}.` : ''
    return `${reason} ${this.state === 'starting' ? 'before the program started' : 'while the program ran'}.${dll}${crash}${said ? `\n${said}` : ''}`
  }

  // ---- Breakpoints ----

  private async configure(): Promise<void> {
    for (const [file, list] of this.options.breakpoints()) {
      const key = fileKey(file, this.platform)
      if (!this.wanted.has(key)) this.wanted.set(key, { file, list })
    }
    this.ready = true
    await Promise.all([...this.wanted.keys()].map((key) => this.queue(key)))
    await this.sendExceptions()
    if (this.caps.supportsConfigurationDoneRequest) await this.dap!.request('configurationDone', {}, { timeoutMs: REQUEST_MS })
  }

  async setBreakpoints(file: string, list: Breakpoint[]): Promise<void> {
    const key = fileKey(file, this.platform)
    this.wanted.set(key, { file, list })
    if (this.ready && !this.ended) await this.queue(key)
  }

  /** A file's breakpoints are sent one request after another, each with the newest list: the last asked for wins. */
  private queue(key: string): Promise<void> {
    const before = this.sending.get(key) ?? Promise.resolve()
    const next = before.then(() => this.sendFile(key)).catch(() => undefined)
    this.sending.set(key, next)
    return next
  }

  private async sendFile(key: string): Promise<void> {
    const wanted = this.wanted.get(key)
    const dap = this.dap
    if (!wanted || !dap || dap.closed) return
    const placed: Placed[] = []
    const sent: { item: Breakpoint; body: Record<string, unknown> }[] = []
    for (const item of wanted.list) {
      const problem = this.unsupported(item)
      if (typeof problem === 'string') {
        placed.push({ id: item.id, verified: false, message: problem })
        continue
      }
      sent.push({ item, body: { line: item.line, ...(item.column ? { column: item.column } : {}), ...problem } })
    }
    try {
      const answer = await dap.request('setBreakpoints', { source: { path: wanted.file, name: path.basename(wanted.file) }, breakpoints: sent.map((entry) => entry.body), lines: sent.map((entry) => entry.item.line), sourceModified: false }, { timeoutMs: REQUEST_MS })
      const list = Array.isArray(answer.breakpoints) ? answer.breakpoints : []
      sent.forEach((entry, index) => {
        const got = isRecord(list[index]) ? list[index] : {}
        placed.push({
          id: entry.item.id,
          ...(typeof got.id === 'number' ? { dap: got.id } : {}),
          verified: got.verified === true,
          ...(typeof got.line === 'number' && got.line !== entry.item.line ? { line: got.line } : {}),
          ...(typeof got.message === 'string' && got.message.trim() ? { message: clip(got.message.trim(), 300) } : {}),
        })
      })
    } catch (error) {
      for (const entry of sent) placed.push({ id: entry.item.id, verified: false, message: error instanceof Error ? clip(error.message, 300) : 'The debugger could not place it.' })
    }
    // A newer list may have been asked for while this one was on its way: it is sent next and replaces these.
    this.placed.set(key, placed)
    this.options.onChange()
  }

  /** What the debugger is told of a breakpoint's condition, count and message; why not, when it cannot do one. */
  private unsupported(item: Breakpoint): Record<string, unknown> | string {
    const body: Record<string, unknown> = {}
    if (item.condition) {
      if (!this.caps.supportsConditionalBreakpoints) return `${this.profile.label} cannot stop on a condition.`
      body.condition = item.condition
    }
    if (item.hitCondition) {
      if (!this.caps.supportsHitConditionalBreakpoints) return `${this.profile.label} cannot count hits.`
      const hit = this.profile.hitCondition(item.hitCondition)
      if ('problem' in hit) return hit.problem
      body.hitCondition = hit.value
    }
    if (item.logMessage) {
      if (!this.caps.supportsLogPoints) return `${this.profile.label} cannot print instead of stopping.`
      body.logMessage = item.logMessage
    }
    return body
  }

  statuses(file: string): BreakpointStatus[] {
    return (this.placed.get(fileKey(file, this.platform)) ?? []).map((item) => ({ id: item.id, verified: item.verified, ...(item.line ? { line: item.line } : {}), ...(item.message ? { message: item.message } : {}) }))
  }

  private breakpointChanged(body: Record<string, unknown>): void {
    const got = isRecord(body.breakpoint) ? body.breakpoint : null
    if (!got || body.reason !== 'changed' || typeof got.id !== 'number') return
    for (const list of this.placed.values()) {
      const item = list.find((entry) => entry.dap === got.id)
      if (!item) continue
      item.verified = got.verified === true
      if (typeof got.line === 'number') item.line = got.line
      item.message = typeof got.message === 'string' && got.message.trim() ? clip(got.message.trim(), 300) : undefined
      this.options.onChange()
      return
    }
  }

  async setExceptions(filters: ExceptionFilters): Promise<void> {
    this.exceptions = filters
    if (this.ready && !this.ended) await this.sendExceptions().catch(() => undefined)
  }

  private offeredFilters(): string[] {
    const list = Array.isArray(this.caps.exceptionBreakpointFilters) ? this.caps.exceptionBreakpointFilters : []
    return list.map((filter) => (isRecord(filter) ? text(filter.filter) : undefined)).filter((id): id is string => !!id)
  }

  private async sendExceptions(): Promise<void> {
    const dap = this.dap
    if (!dap || dap.closed) return
    const offered = this.offeredFilters()
    if (offered.length) await dap.request('setExceptionBreakpoints', { filters: this.profile.exceptionFilters(this.exceptions, offered) }, { timeoutMs: REQUEST_MS })
    const functions = this.profile.exceptionFunctions(this.exceptions, { rust: this.options.plan.rust === true })
    // Sent empty too once one was set, so that turning an exception off takes its function away.
    if (this.caps.supportsFunctionBreakpoints && (functions.length || this.functionsSet)) {
      this.functionsSet = functions.length > 0
      await dap.request('setFunctionBreakpoints', { breakpoints: functions.map((name) => ({ name })) }, { timeoutMs: REQUEST_MS })
    }
  }

  // ---- Events ----

  private event({ event, body }: DapEvent): void {
    switch (event) {
      case 'initialized':
        this.initialized?.resolve()
        return
      case 'stopped':
        void this.stopped(body)
        return
      case 'continued':
        this.went(typeof body.threadId === 'number' ? body.threadId : undefined, body.allThreadsContinued !== false)
        return
      case 'thread':
        this.threadEvent(body)
        return
      case 'output':
        this.output(body)
        return
      case 'breakpoint':
        this.breakpointChanged(body)
        return
      case 'exited':
        if (typeof body.exitCode === 'number') this.exitCode = body.exitCode
        return
      case 'terminated':
        this.programEnded()
        return
      case 'capabilities':
        if (isRecord(body.capabilities)) this.caps = { ...this.caps, ...body.capabilities }
        return
    }
  }

  private output(body: Record<string, unknown>): void {
    const line = text(body.output)
    // What the debugger says after the program is over is about itself.
    if (!line || this.ended) return
    const category = body.category === 'stdout' || body.category === 'stderr' ? body.category : body.category === 'important' ? 'info' : body.category === 'telemetry' ? null : 'console'
    if (!category) return
    const source = isRecord(body.source) ? text(body.source.path) : undefined
    this.out.print(category, line, source && typeof body.line === 'number' ? { path: source, line: body.line } : undefined)
  }

  private threadEvent(body: Record<string, unknown>): void {
    if (typeof body.threadId !== 'number') return
    if (body.reason === 'started') this.thread(body.threadId, `Thread ${body.threadId}`)
    else if (body.reason === 'exited') {
      const id = this.byDap.get(body.threadId)
      if (id === undefined) return
      this.threads.delete(id)
      this.byDap.delete(body.threadId)
    } else return
    this.options.onChange()
  }

  /** The run's entry for one of the debugger's threads, made when it is new. */
  private thread(dap: number, name: string): ThreadEntry | null {
    const known = this.byDap.get(dap)
    if (known !== undefined) return this.threads.get(known) ?? null
    if (this.threads.size >= MAX_THREADS) return null
    const entry: ThreadEntry = { id: this.nextThread++, dap, name: clip(name, 200), paused: false }
    this.threads.set(entry.id, entry)
    this.byDap.set(dap, entry.id)
    return entry
  }

  private async stopped(body: Record<string, unknown>): Promise<void> {
    const dap = this.dap
    if (!dap || this.ended) return
    const generation = ++this.generation
    this.forget()
    const reason = pauseReason(body.reason)
    const threadId = typeof body.threadId === 'number' ? body.threadId : undefined
    // A crash the person did not ask to stop for goes on, as it would without a debugger.
    if (reason === 'exception' && this.profile.alwaysStopsOnCrash && !this.offeredFilters().length && !this.exceptions.uncaught && !this.exceptions.all) {
      void dap.request('continue', threadId !== undefined ? { threadId } : {}, { timeoutMs: REQUEST_MS }).catch(() => undefined)
      return
    }
    // The program was not asked to stop at its first line.
    if (reason === 'entry') {
      void dap.request('continue', threadId !== undefined ? { threadId } : {}, { timeoutMs: REQUEST_MS }).catch(() => undefined)
      return
    }
    try {
      const answer = await dap.request('threads', {}, { timeoutMs: REQUEST_MS })
      if (generation !== this.generation) return
      const listed = (Array.isArray(answer.threads) ? answer.threads : []).filter(isRecord).filter((item) => typeof item.id === 'number')
      const live = new Set<number>()
      for (const item of listed.slice(0, MAX_THREADS)) {
        const entry = this.thread(item.id as number, text(item.name) ?? `Thread ${String(item.id)}`)
        if (!entry) continue
        entry.name = clip(text(item.name) ?? entry.name, 200)
        live.add(entry.dap)
      }
      for (const [id, entry] of this.threads) {
        if (live.has(entry.dap)) continue
        this.threads.delete(id)
        this.byDap.delete(entry.dap)
      }
    } catch {
      // The threads the run knew, as they were.
    }
    const all = body.allThreadsStopped === true
    const top = threadId !== undefined ? this.thread(threadId, `Thread ${threadId}`) : [...this.threads.values()][0]
    for (const entry of this.threads.values()) {
      if (!all && entry !== top) continue
      entry.paused = true
      entry.reason = entry === top ? reason : 'pause'
      entry.exception = undefined
    }
    if (top && reason === 'exception') top.exception = await this.exceptionText(top.dap, body)
    const read = [top, ...[...this.threads.values()].filter((entry) => entry !== top && entry.paused).slice(0, MAX_STACKS - 1)].filter((entry): entry is ThreadEntry => !!entry)
    await Promise.all(read.map((entry) => this.readStack(entry, entry === top ? MAX_FRAMES : OTHER_FRAMES, generation)))
    if (generation !== this.generation) return
    // A stop in a function an exception goes through (a Go or Rust panic) is the run's exception.
    const crash = top && reason === 'breakpoint' && top.frames?.[0] ? this.profile.exceptionStop(top.frames[0].name) : null
    if (top && crash) {
      top.reason = 'exception'
      top.exception = crash
    }
    this.options.onChange()
  }

  private async exceptionText(thread: number, body: Record<string, unknown>): Promise<string> {
    const said = [text(body.text), text(body.description)].filter((part): part is string => !!part?.trim())
    if (this.caps.supportsExceptionInfoRequest) {
      try {
        const info = await this.dap!.request('exceptionInfo', { threadId: thread }, { timeoutMs: REQUEST_MS })
        const details = isRecord(info.details) ? info.details : {}
        const head = [text(info.exceptionId), text(info.description)].filter((part): part is string => !!part?.trim()).join(': ')
        const stack = text(details.stackTrace)
        if (head || stack) return clip([head, stack].filter(Boolean).join('\n'), 4_000)
      } catch {
        /* what the stop said */
      }
    }
    return clip(said.join(': ') || 'An exception', 4_000)
  }

  private async readStack(entry: ThreadEntry, levels: number, generation: number): Promise<void> {
    try {
      const answer = await this.dap!.request('stackTrace', { threadId: entry.dap, startFrame: 0, levels }, { timeoutMs: REQUEST_MS })
      if (generation !== this.generation) return
      entry.frames = (Array.isArray(answer.stackFrames) ? answer.stackFrames : []).filter(isRecord).slice(0, levels).map((frame) => this.frame(frame, entry.id))
    } catch {
      if (generation === this.generation) entry.frames = []
    }
  }

  private frame(frame: Record<string, unknown>, thread: number): FrameView {
    const id = this.nextFrame++
    const source = isRecord(frame.source) ? frame.source : null
    const file = source ? text(source.path) ?? null : null
    const label = frame.presentationHint === 'label'
    this.frames.set(id, { dap: typeof frame.id === 'number' ? frame.id : -1, thread, scopes: !label })
    const dimmed = label || frame.presentationHint === 'subtle' || source?.presentationHint === 'deemphasize' || !file || (this.options.isOwn ? !this.options.isOwn(file) : false)
    return {
      id,
      name: clip(text(frame.name) ?? '(unnamed)', MAX_NAME_CHARS),
      source: source ? { path: file, name: clip(text(source.name) ?? (file ? path.basename(file) : 'code without a file'), MAX_NAME_CHARS) } : null,
      line: Math.max(1, count(frame.line)),
      column: Math.max(1, count(frame.column)),
      ...(dimmed ? { skipped: true } : {}),
      ...(label ? { noScopes: true } : {}),
    }
  }

  /** The program went on: what was read while it was paused is no longer the debugger's to answer. */
  private went(dapThread: number | undefined, all: boolean): void {
    let changed = false
    for (const entry of this.threads.values()) {
      if (!all && entry.dap !== dapThread) continue
      if (!entry.paused) continue
      entry.paused = false
      entry.reason = undefined
      entry.exception = undefined
      entry.frames = undefined
      changed = true
    }
    if (all) {
      this.generation++
      this.forget()
    }
    if (changed) this.options.onChange()
  }

  private forget(): void {
    this.frames.clear()
    this.refs.clear()
  }

  // ---- Running ----

  private target(threadId: number | undefined): ThreadEntry | undefined {
    if (threadId !== undefined) return this.threads.get(threadId)
    return [...this.threads.values()].find((entry) => entry.paused) ?? [...this.threads.values()][0]
  }

  async resume(threadId?: number): Promise<void> {
    const entry = this.target(threadId)
    if (!entry || !this.dap) return
    const before = this.generation
    const answer = await this.dap.request('continue', { threadId: entry.dap }, { timeoutMs: REQUEST_MS })
    // A stop that came before the answer is newer than the going on.
    if (this.generation === before) this.went(entry.dap, answer.allThreadsContinued !== false)
  }

  async pause(threadId?: number): Promise<void> {
    const entry = this.target(threadId)
    if (!entry || !this.dap) return
    await this.dap.request('pause', { threadId: entry.dap }, { timeoutMs: REQUEST_MS })
  }

  async step(kind: StepKind, threadId?: number): Promise<void> {
    const entry = this.target(threadId)
    if (!entry || !this.dap || !entry.paused) return
    const command = kind === 'over' ? 'next' : kind === 'into' ? 'stepIn' : 'stepOut'
    const before = this.generation
    await this.dap.request(command, { threadId: entry.dap, granularity: 'line' }, { timeoutMs: REQUEST_MS })
    // Every thread goes on while one steps, as the debuggers do it; a stop that came before the answer is newer.
    if (this.generation === before) this.went(entry.dap, true)
  }

  // ---- Values ----

  private register(target: RefTarget): number {
    const id = this.nextRef++
    this.refs.set(id, target)
    return id
  }

  async scopes(frameId: number): Promise<ScopeView[]> {
    const frame = this.frames.get(frameId)
    if (!frame || !frame.scopes || frame.dap < 0 || !this.dap) return []
    const generation = this.generation
    const answer = await this.dap.request('scopes', { frameId: frame.dap }, { timeoutMs: REQUEST_MS })
    if (generation !== this.generation) return []
    return (Array.isArray(answer.scopes) ? answer.scopes : [])
      .filter(isRecord)
      .slice(0, 50)
      .map((scope) => ({
        name: clip(text(scope.name) ?? 'Scope', MAX_NAME_CHARS),
        ref: this.register({ dap: count(scope.variablesReference), indexed: count(scope.indexedVariables), named: count(scope.namedVariables) }),
        expensive: scope.expensive === true,
      }))
  }

  async variables(ref: number): Promise<VariableView[]> {
    const target = this.refs.get(ref)
    if (!target || !target.dap || !this.dap) return []
    if ('indexed' in target && target.indexed > CHUNK) {
      // The named ones first, then the items in groups, as a long array is shown.
      const named = target.named ? await this.read({ dap: target.dap, filter: 'named' }) : []
      return [...named, ...this.groups(target.dap, 0, target.indexed)]
    }
    if ('filter' in target && target.filter === 'indexed' && target.count > CHUNK) return this.groups(target.dap, target.start, target.count)
    return this.read(target)
  }

  /** Groups of items: of CHUNK, or of CHUNK² and so on, so that a list of them is never longer than CHUNK. */
  private groups(dap: number, from: number, length: number): VariableView[] {
    let size = CHUNK
    while (length / size > CHUNK) size *= CHUNK
    const out: VariableView[] = []
    for (let start = from; start < from + length; start += size) {
      const items = Math.min(size, from + length - start)
      out.push({ name: `[${start} … ${start + items - 1}]`, value: '', ref: this.register({ dap, filter: 'indexed', start, count: items }), kind: 'chunk' })
    }
    return out
  }

  private async read(target: RefTarget): Promise<VariableView[]> {
    const generation = this.generation
    const args: Record<string, unknown> = { variablesReference: target.dap }
    if ('filter' in target) {
      args.filter = target.filter
      if (target.filter === 'indexed') Object.assign(args, { start: target.start, count: target.count })
    }
    const answer = await this.dap!.request('variables', args, { timeoutMs: REQUEST_MS })
    if (generation !== this.generation) return []
    return (Array.isArray(answer.variables) ? answer.variables : []).filter(isRecord).slice(0, MAX_VARIABLES).map((item) => this.variable(item))
  }

  private variable(item: Record<string, unknown>): VariableView {
    const name = clip(text(item.name) ?? '', MAX_NAME_CHARS)
    const hint = isRecord(item.presentationHint) ? item.presentationHint : {}
    const reference = count(item.variablesReference)
    const kind: VariableView['kind'] | undefined =
      /^\(return\)|^~r\d+$/.test(name) ? 'return' : hint.visibility === 'private' ? 'private' : hint.visibility === 'internal' || hint.visibility === 'protected' || /^(special|function|class|protected) variables$/.test(name) ? 'internal' : undefined
    return {
      name,
      value: clip(text(item.value) ?? '', MAX_VALUE_CHARS),
      ...(text(item.type) ? { type: clip(text(item.type)!, MAX_NAME_CHARS) } : {}),
      ...(reference ? { ref: this.register({ dap: reference, indexed: count(item.indexedVariables), named: count(item.namedVariables) }) } : {}),
      ...(hint.lazy === true && reference ? { lazy: true } : {}),
      ...(kind ? { kind } : {}),
    }
  }

  async evaluate(expression: string, options: { frameId?: number; threadId?: number; context: EvaluateContext }): Promise<EvaluateResult> {
    if (!this.dap || this.ended) return { ok: false, message: 'No program of this run is being debugged now.' }
    if (options.context === 'hover' && !NAME_CHAIN.test(expression.trim())) return { ok: false, message: 'A hover reads names only.' }
    const frame = options.frameId !== undefined ? this.frames.get(options.frameId) : undefined
    const context = options.context === 'hover' ? (this.caps.supportsEvaluateForHovers ? 'hover' : 'watch') : options.context === 'repl' ? this.profile.replContext : options.context
    const generation = this.generation
    try {
      const answer = await this.dap.request('evaluate', { expression, context, ...(frame && frame.dap >= 0 ? { frameId: frame.dap } : {}) }, { timeoutMs: options.context === 'hover' ? 2_000 : options.context === 'watch' ? 5_000 : 30_000 })
      if (generation !== this.generation) return { ok: false, message: 'The program went on.' }
      const reference = count(answer.variablesReference)
      return {
        ok: true,
        value: clip(text(answer.result) ?? '', MAX_VALUE_CHARS),
        ...(text(answer.type) ? { type: clip(text(answer.type)!, MAX_NAME_CHARS) } : {}),
        ...(reference ? { ref: this.register({ dap: reference, indexed: count(answer.indexedVariables), named: count(answer.namedVariables) }) } : {}),
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? clip(error.message, 2_000) : String(error) }
    }
  }

  // ---- Ending ----

  async stop(): Promise<void> {
    if (this.ended) return
    this.stopping = true
    this.abort.abort()
    const dap = this.dap
    if (dap && !dap.closed) {
      const launched = this.options.plan.request === 'launch'
      const gone = this.exited ?? Promise.resolve()
      const wait = (ms: number) => Promise.race([gone, new Promise((resolve) => setTimeout(resolve, ms).unref?.())])
      if (launched && this.caps.supportsTerminateRequest) {
        await dap.request('terminate', {}, { timeoutMs: STOP_MS }).catch(() => undefined)
        await wait(STOP_MS)
      }
      if (!dap.closed && this.child?.exitCode === null) {
        await dap.request('disconnect', { restart: false, terminateDebuggee: launched }, { timeoutMs: STOP_MS }).catch(() => undefined)
        await wait(STOP_MS)
      }
    }
    if (this.child) await killTree(this.child, this.platform, this.exited ?? undefined)
    this.programEnded()
  }

  /** The program is over (the debugger says so): the run ends, and the debugger with it. */
  private programEnded(): void {
    if (this.ended) return
    this.out.flush()
    if (this.options.plan.request === 'launch') {
      const code = this.exitCode
      this.out.line({ category: 'info', text: this.stopping ? 'The program was stopped.' : code === undefined || code === null ? 'The program ended.' : `The program exited with code ${code}.` })
    }
    this.end()
  }

  private end(message?: string): void {
    if (this.ended) return
    this.state = 'ended'
    if (message) this.message = message
    this.abort.abort()
    this.initialized?.reject(new Error(message ?? 'The run ended.'))
    this.threads.clear()
    this.byDap.clear()
    this.forget()
    this.out.flush()
    const dap = this.dap
    const child = this.child
    const exited = this.exited
    const server = this.server
    const runDir = this.options.plan.runDir
    this.cleanup = (async () => {
      // A debugger that does not leave by itself once the program is over is stopped; then its folder goes.
      if (dap && !dap.closed) await dap.request('disconnect', { restart: false, terminateDebuggee: this.options.plan.request === 'launch' }, { timeoutMs: STOP_MS }).catch(() => undefined)
      dap?.close('The run ended.')
      if (child && exited) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_MS).unref?.())])
        await killTree(child, this.platform, exited)
      }
      server?.close()
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined)
    })()
    this.options.onChange()
  }
}
