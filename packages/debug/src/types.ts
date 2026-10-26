/**
 * The debugger as the editor, the panel and the agent see it, whatever program is debugged: breakpoints, the programs
 * of a run and where each is paused, its frames, scopes and variables, and what it prints. Lines and columns are
 * 1-based here, as people count them.
 */

/** A breakpoint the person set: where, and when it stops or what it prints instead. */
export interface Breakpoint {
  /** Stable for the life of the breakpoint. */
  id: string
  line: number
  column?: number
  /** It stops only when this is true. */
  condition?: string
  /** It stops only on some hits: `5` (from the fifth on), `==5`, `>5`, `>=5`, `<5`, `<=5`, `%5` (every fifth). */
  hitCondition?: string
  /** It prints this instead of stopping; `{expression}` is replaced by its value. */
  logMessage?: string
  enabled: boolean
}

/** How a breakpoint stands in the run: placed in code that runs, or why not yet. */
export interface BreakpointStatus {
  id: string
  verified: boolean
  /** The line it was placed on, when that is not the line it was set on. */
  line?: number
  message?: string
}

/** When the program stops for an exception. */
export interface ExceptionFilters {
  uncaught: boolean
  /** Also those that are caught. */
  all: boolean
}

export type PauseReason = 'breakpoint' | 'step' | 'exception' | 'pause' | 'entry' | 'debugger' | 'other'

/** Code a frame is in: a file by its whole path, or code that is not a file (`node:internal/…`, an eval). */
export interface SourceView {
  path: string | null
  name: string
}

export interface FrameView {
  /** For scopes and evaluation, while the program stays paused. */
  id: number
  name: string
  source: SourceView | null
  line: number
  column: number
  /** The first frame after an async boundary names it ("await", "setTimeout"). */
  async?: string
  /** Code the person did not write (Node.js's own, a skipped file): shown dimmed, stepped over. */
  skipped?: boolean
  /** It has no scopes: a frame of an async stack, kept for where it was. */
  noScopes?: boolean
}

/** One program of a run (a process, a thread of one): running, or paused and where. */
export interface ThreadView {
  id: number
  name: string
  state: 'running' | 'paused'
  reason?: PauseReason
  /** The exception it stopped for, as its stack reads. */
  exception?: string
  frames?: FrameView[]
}

export type SessionState = 'starting' | 'running' | 'paused' | 'ended'

export interface SessionView {
  id: string
  /** The configuration's name. */
  name: string
  kind: 'launch' | 'attach'
  state: SessionState
  threads: ThreadView[]
  /** How many times the run has stopped with its frames read: a stop after an action is one more than before it. */
  stops: number
  /** How the program ended, when it did. */
  exitCode?: number | null
  /** Why it could not start or why it ended, in words. */
  message?: string
}

export interface ScopeView {
  name: string
  ref: number
  /** Many variables (the global scope): opened only when asked. */
  expensive: boolean
}

export interface VariableView {
  name: string
  value: string
  type?: string
  /** It has children, read with this. */
  ref?: number
  /** A getter not run yet: reading `ref` runs it and gives its value. */
  lazy?: boolean
  kind?: 'property' | 'internal' | 'private' | 'chunk' | 'this' | 'return'
}

export type EvaluateContext = 'repl' | 'watch' | 'hover'

export type EvaluateResult = { ok: true; value: string; type?: string; ref?: number } | { ok: false; message: string }

export interface OutputLine {
  category: 'stdout' | 'stderr' | 'console' | 'error' | 'info'
  text: string
  /** Where a console call was made. */
  source?: { path: string; line: number }
}

export type StepKind = 'over' | 'into' | 'out'

/**
 * A debug run, whatever debugs it: eNCode's own client of Node.js's inspector (ADR 0143), or a language's own debugger
 * over the Debug Adapter Protocol (ADR 0144). The folder's debugger drives every run through this.
 */
export interface RunSession {
  readonly id: string
  readonly ended: boolean
  /** Settles once the run has ended and its folder is gone. */
  readonly settled: Promise<void>
  view(): SessionView
  /** Starts the run; fails, with the run ended and why in its view, when it cannot. */
  start(): Promise<void>
  /** A file's enabled breakpoints, by its whole path, as they are now. */
  setBreakpoints(file: string, list: Breakpoint[]): Promise<void>
  statuses(file: string): BreakpointStatus[]
  setExceptions(filters: ExceptionFilters): Promise<void>
  resume(threadId?: number): Promise<void>
  pause(threadId?: number): Promise<void>
  step(kind: StepKind, threadId?: number): Promise<void>
  scopes(frameId: number): Promise<ScopeView[]>
  variables(ref: number): Promise<VariableView[]>
  evaluate(expression: string, options: { frameId?: number; threadId?: number; context: EvaluateContext }): Promise<EvaluateResult>
  /** Stops the run: a started program ends; one attached to goes on without the debugger. */
  stop(): Promise<void>
}
