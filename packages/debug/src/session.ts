/**
 * A debug run (ADR 0143): a Node.js program started for it, with every Node.js program that one starts, or a program
 * already running whose inspector it attaches to. Each program is a thread of the run; the run ends when the program it
 * started exits, or when the person stops it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { killTree } from '@encode/tools'
import { readBootInfo, withBootloader, prepareRunFolder, type BootInfo } from './boot'
import { CdpConnection, inspectorTargets, type SocketFactory } from './cdp'
import { NodeTarget, type TargetHost } from './node-target'
import { OutputBatch } from './output'
import type { Breakpoint, BreakpointStatus, EvaluateContext, EvaluateResult, ExceptionFilters, OutputLine, RunSession, ScopeView, SessionView, StepKind, ThreadView, VariableView } from './types'

/** A program to start: what runs, where, with what. The caller found the program and checked the folder. */
export interface LaunchPlan {
  kind: 'launch'
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** A folder of this run's own, for the bootloader and what it writes; removed when the run ends. */
  runDir: string
  /** On Windows: `args` are passed as written (a command line for cmd.exe, already quoted). */
  verbatim?: boolean
}

/** A program already running, whose inspector listens on a port. */
export interface AttachPlan {
  kind: 'attach'
  host: string
  port: number
}

export interface SessionOptions {
  id: string
  name: string
  plan: LaunchPlan | AttachPlan
  platform?: NodeJS.Platform
  /** The breakpoints of every file, by whole path, as they are when a program of the run starts. */
  breakpoints(): Map<string, Breakpoint[]>
  exceptions: ExceptionFilters
  /** Scripts stepped over and dimmed, as regular expressions on their names. */
  skip?: string[]
  /** A source map's text, or null; bounded by the caller. */
  readText(file: string): Promise<string | null>
  /** Something the views show changed. */
  onChange(): void
  /** What the run printed, a batch at a time. */
  onOutput(lines: OutputLine[]): void
  /** For tests. */
  spawn?: typeof spawn
  socket?: SocketFactory
  fetch?: typeof fetch
}

interface Thread {
  id: number
  name: string
  target: NodeTarget
  pid?: number
  exception?: string
}

/** Node.js's lines about its inspector, which are the debugger's business, not the program's output. */
const INSPECTOR_LINES = [/^Debugger listening on ws:\/\//, /^For help, see: https:\/\/nodejs\.org\//, /^Debugger attached\.$/, /^Waiting for the debugger to disconnect\.\.\.$/]
/** The folder of the run is looked in this often too, for systems whose file events are late or missing. */
const POLL_MS = 150
const DEFAULT_SKIP = ['^node:internal/', '^node:']

export class DebugSession implements RunSession {
  readonly id: string
  private readonly platform: NodeJS.Platform
  private readonly threads = new Map<number, Thread>()
  private nextThread = 1
  private refs = 1
  private frames = 1
  private state: SessionView['state'] = 'starting'
  private exitCode: number | null | undefined
  private stops = 0
  private message: string | undefined
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private readonly seen = new Set<number>()
  private exceptions: ExceptionFilters
  private readonly out: OutputBatch
  private stopping = false
  private readonly host: TargetHost
  private cleanup: Promise<void> = Promise.resolve()

  constructor(private readonly options: SessionOptions) {
    this.id = options.id
    this.platform = options.platform ?? process.platform
    this.exceptions = options.exceptions
    this.out = new OutputBatch(
      (lines) => options.onOutput(lines),
      (category, text) => category === 'stderr' && INSPECTOR_LINES.some((pattern) => pattern.test(text)),
    )
    this.host = {
      platform: this.platform,
      readText: options.readText,
      nextRef: () => this.refs++,
      nextFrame: () => this.frames++,
    }
  }

  view(): SessionView {
    const threads: ThreadView[] = [...this.threads.values()].map((thread) => {
      const target = thread.target
      if (!target.isPaused) return { id: thread.id, name: thread.name, state: 'running' }
      return { id: thread.id, name: thread.name, state: 'paused', ...(target.pauseReason ? { reason: target.pauseReason } : {}), ...(thread.exception ? { exception: thread.exception } : {}), frames: target.frames ?? [] }
    })
    const state = this.state === 'ended' ? 'ended' : threads.some((thread) => thread.state === 'paused') ? 'paused' : this.state
    return {
      id: this.id,
      name: this.options.name,
      kind: this.options.plan.kind,
      state,
      threads,
      stops: this.stops,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.message ? { message: this.message } : {}),
    }
  }

  get ended(): boolean {
    return this.state === 'ended'
  }

  /** Settles once the run has ended and its folder is gone. */
  get settled(): Promise<void> {
    return this.cleanup
  }

  /** Starts the run; fails, with the run ended and why in its view, when it cannot. */
  async start(): Promise<void> {
    try {
      if (this.options.plan.kind === 'attach') await this.attach(this.options.plan)
      else await this.launch(this.options.plan)
      if (this.state === 'starting') this.state = 'running'
      this.options.onChange()
    } catch (error) {
      this.end(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async attach(plan: AttachPlan): Promise<void> {
    let targets: Awaited<ReturnType<typeof inspectorTargets>>
    try {
      targets = await inspectorTargets(plan.host, plan.port, this.options.fetch ? { fetch: this.options.fetch } : {})
    } catch {
      throw new Error(`Nothing answers as a Node.js inspector at ${plan.host}:${plan.port}. Start the program with --inspect (or --inspect=${plan.port}) and try again.`)
    }
    const first = targets[0]
    if (!first) throw new Error(`The inspector at ${plan.host}:${plan.port} lists no program to debug.`)
    // The address the person gave, whatever host the program names (a container names its own): only the path is its.
    let socketPath: string
    try {
      socketPath = new URL(first.webSocketDebuggerUrl).pathname
    } catch {
      throw new Error(`The inspector at ${plan.host}:${plan.port} gave an address that does not read as one.`)
    }
    const where = plan.host.includes(':') && !plan.host.startsWith('[') ? `[${plan.host}]` : plan.host
    await this.connect(`ws://${where}:${plan.port}${socketPath}`, first.title || `${plan.host}:${plan.port}`, { console: true, stripsTypes: false })
  }

  private async launch(plan: LaunchPlan): Promise<void> {
    const bootloader = await prepareRunFolder(plan.runDir)
    const env: Record<string, string> = { ...plan.env, ENCODE_DEBUG_DIR: plan.runDir }
    const optionsKey = Object.keys(env).find((key) => key.toUpperCase() === 'NODE_OPTIONS') ?? 'NODE_OPTIONS'
    env[optionsKey] = withBootloader(env[optionsKey], bootloader, this.platform)
    this.watchRunFolder(plan.runDir)
    const child = (this.options.spawn ?? spawn)(plan.file, plan.args, {
      cwd: plan.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so that stopping the run stops everything it started.
      detached: this.platform !== 'win32',
      windowsHide: true,
      shell: false,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    this.exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => reject(new Error(`${path.basename(plan.file)} could not be started: ${error.message}`)))
    })
    child.stdout?.on('data', (chunk: Buffer) => this.out.print('stdout', chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => this.out.print('stderr', chunk.toString('utf8')))
    child.once('exit', (code, signal) => {
      this.exitCode = code ?? (signal ? null : 0)
    })
    void this.exited.then(() => {
      for (const stream of ['stdout', 'stderr'] as const) this.out.end(stream)
      const code = this.exitCode
      this.out.line({ category: 'info', text: code === null ? 'The program was stopped.' : `The program exited with code ${code ?? 0}.` })
      this.end()
    })
  }

  private watchRunFolder(dir: string): void {
    const look = () => void this.lookForPrograms(dir)
    try {
      this.watcher = watch(dir, look)
      this.watcher.on('error', () => undefined)
    } catch {
      /* the poll looks instead */
    }
    this.poll = setInterval(look, POLL_MS)
    this.poll.unref?.()
  }

  private async lookForPrograms(dir: string): Promise<void> {
    if (this.state === 'ended') return
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const pid = Number(/^(\d+)\.json$/.exec(name)?.[1])
      if (!pid || this.seen.has(pid)) continue
      this.seen.add(pid)
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
      const info = text ? readBootInfo(text) : null
      if (!info || info.pid !== pid) continue
      void this.connect(info.url, programName(info), { console: false, stripsTypes: info.typescript && !info.loaders, pid }).catch((error: unknown) => {
        this.out.line({ category: 'error', text: `The debugger could not attach to process ${pid}: ${error instanceof Error ? error.message : String(error)}` })
      })
    }
  }

  private async connect(url: string, name: string, options: { console: boolean; stripsTypes: boolean; pid?: number }): Promise<void> {
    const cdp = await CdpConnection.connect(url, this.options.socket ? { socket: this.options.socket } : {})
    if (this.state === 'ended') {
      cdp.close()
      return
    }
    const target = new NodeTarget(cdp, this.host, { console: options.console, stripsTypes: options.stripsTypes, skip: this.options.skip ?? DEFAULT_SKIP })
    const thread: Thread = { id: this.nextThread++, name, target, ...(options.pid ? { pid: options.pid } : {}) }
    this.threads.set(thread.id, thread)
    target.onEvent((event) => {
      switch (event.type) {
        case 'paused':
          thread.exception = event.exception
          // A program attached to that waited at its first line goes on; the person's breakpoints stop it.
          if (event.reason === 'entry') {
            void target.resume().catch(() => undefined)
            return
          }
          this.stops++
          break
        case 'resumed':
          thread.exception = undefined
          break
        case 'output':
          this.out.line(event.line)
          return
        case 'closed':
          this.threads.delete(thread.id)
          // An attached program that went away ends the run.
          if (this.options.plan.kind === 'attach' && !this.threads.size) this.end(this.stopping ? undefined : 'The program closed its debugger connection.')
          break
      }
      this.options.onChange()
    })
    try {
      await target.start(this.options.breakpoints(), this.exceptions)
    } catch (error) {
      // A program that ended while it was being attached to is not an error of the run's.
      if (target.closed) return
      throw error
    }
    this.options.onChange()
  }

  private thread(id: number | undefined): Thread | undefined {
    if (id !== undefined) return this.threads.get(id)
    return [...this.threads.values()].find((thread) => thread.target.isPaused) ?? [...this.threads.values()][0]
  }

  /** A file's breakpoints changed: every program of the run gets them. */
  async setBreakpoints(file: string, list: Breakpoint[]): Promise<void> {
    await Promise.all([...this.threads.values()].map((thread) => thread.target.setBreakpoints(file, list).catch(() => undefined)))
  }

  /** How a file's breakpoints stand: placed when any program of the run placed them. */
  statuses(file: string): BreakpointStatus[] {
    const merged = new Map<string, BreakpointStatus>()
    for (const thread of this.threads.values()) {
      for (const status of thread.target.statuses(file)) {
        const known = merged.get(status.id)
        if (!known || (!known.verified && status.verified)) merged.set(status.id, status)
      }
    }
    return [...merged.values()]
  }

  async setExceptions(filters: ExceptionFilters): Promise<void> {
    this.exceptions = filters
    await Promise.all([...this.threads.values()].map((thread) => thread.target.setExceptions(filters).catch(() => undefined)))
  }

  async resume(threadId?: number): Promise<void> {
    await this.thread(threadId)?.target.resume()
  }

  async pause(threadId?: number): Promise<void> {
    await this.thread(threadId)?.target.pause()
  }

  async step(kind: StepKind, threadId?: number): Promise<void> {
    await this.thread(threadId)?.target.step(kind)
  }

  /** The scopes of a frame; a frame is known by the thread that is paused in it. */
  async scopes(frameId: number): Promise<ScopeView[]> {
    for (const thread of this.threads.values()) if (thread.target.hasFrame(frameId)) return thread.target.scopes(frameId)
    return []
  }

  async variables(ref: number): Promise<VariableView[]> {
    for (const thread of this.threads.values()) if (thread.target.hasRef(ref)) return thread.target.variables(ref)
    return []
  }

  /** Evaluates in a frame, or in the thread (the paused one, else the first) as it runs. */
  async evaluate(expression: string, options: { frameId?: number; threadId?: number; context: EvaluateContext }): Promise<EvaluateResult> {
    let thread: Thread | undefined
    if (options.frameId !== undefined) thread = [...this.threads.values()].find((candidate) => candidate.target.hasFrame(options.frameId!))
    thread ??= this.thread(options.threadId)
    if (!thread) return { ok: false, message: 'No program of this run is being debugged now.' }
    return thread.target.evaluate(expression, options.frameId !== undefined && thread.target.hasFrame(options.frameId) ? options.frameId : undefined, options.context)
  }

  /** Stops the run: a started program and everything it started end; one attached to goes on without the debugger. */
  async stop(): Promise<void> {
    if (this.state === 'ended') return
    this.stopping = true
    if (this.child) {
      await killTree(this.child, this.platform, this.exited ?? undefined)
      // The run ends when the program has closed (above), or now if it never will.
    }
    this.end()
  }

  private end(message?: string): void {
    if (this.state === 'ended') return
    this.state = 'ended'
    if (message) this.message = message
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    for (const thread of this.threads.values()) thread.target.close()
    this.threads.clear()
    this.out.flush()
    if (this.options.plan.kind === 'launch') this.cleanup = fs.rm(this.options.plan.runDir, { recursive: true, force: true }).catch(() => undefined)
    this.options.onChange()
  }
}

/** A program of the run as the call stack names it: its script and its process. */
function programName(info: BootInfo): string {
  const script = info.argv[0] ? path.basename(info.argv[0]) : 'node'
  return `${script} (${info.pid})`
}
