/**
 * The conversation with the helper process: one request per line in, one answer per line out.
 *
 * A request that is cancelled, or that takes longer than it should, is not simply forgotten: the helper is told
 * to stop at its next safe point, and one that is still busy a few seconds later is killed, so a stuck call never
 * holds the desktop. If the helper dies, everything waiting on it fails with a message that says so, and the
 * backend starts a new one for the next call.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { DesktopError, type DesktopErrorCode } from '../contract'
import { HELPER_PROTOCOL } from './build'

const CODES = new Set<DesktopErrorCode>([
  'unavailable',
  'window-gone',
  'not-allowed',
  'covered',
  'stale-capture',
  'stale-element',
  'no-element',
  'hung',
  'password',
  'interrupted',
  'busy',
  'timeout',
  'refused',
  'failed',
])

const MAX_LINE = 64 * 1024 * 1024
const STDERR_TAIL = 2_000

export interface ClientOptions {
  spawn: () => ChildProcessWithoutNullStreams
  /** How long the helper may take to say hello, ms. The first start may wait for an antivirus scan. */
  helloTimeoutMs?: number
  /** How long a cancelled request may keep the helper busy before it is killed, ms. */
  stuckMs?: number
  log?: (message: string) => void
}

export interface RequestOptions {
  signal: AbortSignal
  timeoutMs: number
}

interface Pending {
  op: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  signal: AbortSignal
  onAbort: () => void
  /** The caller has stopped waiting; the helper has not answered yet. */
  abandoned: boolean
  stuck?: NodeJS.Timeout
}

export class HelperClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private nextId = 1
  private stderr = ''
  private dead: DesktopError | undefined
  private hello: { resolve: () => void; reject: (error: unknown) => void } | undefined
  pid = 0

  constructor(private readonly options: ClientOptions) {}

  get alive(): boolean {
    return this.child !== undefined && this.dead === undefined
  }

  /** Starts the process and waits for it to say hello. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.child) throw new Error('The helper client was already started.')
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.options.spawn()
    } catch (error) {
      throw new DesktopError('unavailable', `The desktop helper could not be started: ${describe(error)}${BLOCKED_HINT}`)
    }
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => this.fail(new DesktopError('unavailable', `The desktop helper could not be started: ${describe(error)}${BLOCKED_HINT}`)))
    child.on('exit', (code, why) =>
      this.fail(new DesktopError('unavailable', `The desktop helper stopped (${why ? `signal ${why}` : `exit code ${code}`}).${this.stderr.trim() ? ` ${this.stderr.trim().split(/\r?\n/).pop()}` : ''}`)),
    )

    const said = new Promise<void>((resolve, reject) => {
      this.hello = { resolve, reject }
    })
    const timeoutMs = this.options.helloTimeoutMs ?? 20_000
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DesktopError('unavailable', `The desktop helper did not start within ${Math.round(timeoutMs / 1000)} seconds.${BLOCKED_HINT}`)), timeoutMs)
    })
    let aborted: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      if (!signal) return
      aborted = () => reject(signal.reason)
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
    try {
      await Promise.race([said, late, cancelled])
    } catch (error) {
      // The process may take a moment to go; nothing may be sent to it meanwhile.
      this.fail(error instanceof DesktopError ? error : new DesktopError('unavailable', 'The desktop helper was stopped before it finished starting.'))
      this.kill()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && aborted) signal.removeEventListener('abort', aborted)
    }
  }

  // ---------------------------------------------------------------- reading

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.onLine(line)
    }
    if (this.buffer.length > MAX_LINE) {
      this.fail(new DesktopError('failed', 'The desktop helper sent an answer that is far too large.'))
      this.kill()
    }
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.options.log?.(`desktop helper: unreadable line (${line.slice(0, 80)})`)
      return
    }
    if (typeof message !== 'object' || message === null) return
    const fields = message as Record<string, unknown>
    if (fields.event === 'hello') {
      if (fields.protocol !== HELPER_PROTOCOL) {
        this.hello?.reject(new DesktopError('unavailable', `The desktop helper speaks protocol ${String(fields.protocol)}, not ${HELPER_PROTOCOL}.`))
      } else {
        this.pid = typeof fields.pid === 'number' ? fields.pid : 0
        this.hello?.resolve()
      }
      this.hello = undefined
      return
    }
    if (typeof fields.id !== 'number') return
    const entry = this.pending.get(fields.id)
    if (!entry) return
    this.pending.delete(fields.id)
    this.release(entry)
    if (entry.abandoned) return
    if (fields.ok === true) {
      entry.resolve(fields.result)
      return
    }
    const failure = (typeof fields.error === 'object' && fields.error !== null ? fields.error : {}) as Record<string, unknown>
    const code = typeof failure.code === 'string' && CODES.has(failure.code as DesktopErrorCode) ? (failure.code as DesktopErrorCode) : 'failed'
    entry.reject(new DesktopError(code, typeof failure.message === 'string' && failure.message ? failure.message : 'The desktop helper reported a failure without saying why.'))
  }

  // ---------------------------------------------------------------- requests

  private release(entry: Pending): void {
    clearTimeout(entry.timer)
    if (entry.stuck) clearTimeout(entry.stuck)
    entry.signal.removeEventListener('abort', entry.onAbort)
  }

  private send(message: unknown): boolean {
    const child = this.child
    if (!child || this.dead || !child.stdin.writable) return false
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** The caller stops waiting. The helper is told to stop; one that does not answer soon after is killed. */
  private abandon(id: number, entry: Pending, error: unknown): void {
    if (entry.abandoned) return
    entry.abandoned = true
    clearTimeout(entry.timer)
    entry.signal.removeEventListener('abort', entry.onAbort)
    this.send({ op: 'cancel', id })
    entry.stuck = setTimeout(() => {
      if (this.pending.has(id)) {
        this.options.log?.(`desktop helper: ${entry.op} did not stop after it was cancelled; restarting the helper`)
        this.fail(new DesktopError('unavailable', 'The desktop helper stopped answering and was restarted.'))
        this.kill()
      }
    }, this.options.stuckMs ?? 8_000)
    entry.stuck.unref?.()
    entry.reject(error)
  }

  request(op: string, args: unknown, options: RequestOptions): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead)
    if (options.signal.aborted) return Promise.reject(options.signal.reason)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = {
        op,
        resolve,
        reject,
        signal: options.signal,
        abandoned: false,
        timer: setTimeout(() => this.abandon(id, entry, new DesktopError('timeout', `The desktop helper did not answer ${op} within ${Math.round(options.timeoutMs / 1000)} seconds.`)), options.timeoutMs),
        onAbort: () => this.abandon(id, entry, options.signal.reason),
      }
      options.signal.addEventListener('abort', entry.onAbort, { once: true })
      this.pending.set(id, entry)
      if (!this.send({ id, op, args })) {
        this.pending.delete(id)
        this.release(entry)
        reject(this.dead ?? new DesktopError('unavailable', 'The desktop helper is not running.'))
      }
    })
  }

  // ---------------------------------------------------------------- the end

  private fail(error: DesktopError): void {
    if (this.dead) return
    this.dead = error
    this.hello?.reject(error)
    this.hello = undefined
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      this.release(entry)
      if (!entry.abandoned) entry.reject(error)
    }
  }

  private kill(): void {
    try {
      this.child?.kill()
    } catch {
      // Already gone.
    }
  }

  /** Asks the helper to finish by closing its input, and kills it if it has not gone within a moment. */
  async dispose(): Promise<void> {
    const child = this.child
    if (!child) return
    this.fail(new DesktopError('unavailable', 'The desktop helper was stopped.'))
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill()
        resolve()
      }, 1_500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.end()
      } catch {
        this.kill()
      }
    })
  }
}

const BLOCKED_HINT = ' If an antivirus program blocks it, allow the file named encode-desktop-helper.exe in eNCode\'s helper folder.'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
