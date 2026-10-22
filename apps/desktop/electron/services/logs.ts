import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  at: number
  level: LogLevel
  text: string
}

export interface LogOptions {
  /** Largest size of the log file before it is moved aside to `<name>.1`, bytes. Default 1 MiB. */
  maxFileBytes?: number
  /** Lines kept in memory for a diagnostics report. Default 1000. */
  keepLines?: number
  /** Longest line kept; the rest is cut off. Default 2000. */
  maxLineLength?: number
  /** How long lines wait to be written together, ms. Default 200. */
  flushAfterMs?: number
  now?: () => number
  /** Applied to every line before it is kept or written, so no key reaches the disk. */
  redact?: (text: string) => string
}

export const LOG_FILE = 'eNCode.log'

/** Writes that failed in a row before the file is given up on for this run. */
const MAX_FAILURES = 3

/** How much of the end of each file a report reads. */
const TAIL_BYTES = 256 * 1024

/** The last `bytes` of a file as text, from the start of a whole line; empty when there is no such file. */
function readEnd(file: string, bytes: number): string {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const { size } = fs.fstatSync(fd)
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    fs.closeSync(fd)
  }
}

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>

/**
 * What the main process says, kept for the last thousand lines in memory and in `<dir>/eNCode.log` (one older
 * file beside it), so a report of a problem can include what led up to it, including from before a restart.
 * Writing never throws: a full disk must not stop the app.
 */
export class LogService {
  readonly file: string
  private readonly lines: LogLine[] = []
  private queued = ''
  private size = 0
  private timer: NodeJS.Timeout | undefined
  private failures = 0

  private readonly maxFileBytes: number
  private readonly keepLines: number
  private readonly maxLineLength: number
  private readonly flushAfterMs: number
  private readonly now: () => number
  private readonly redact: (text: string) => string

  constructor(readonly dir: string, options: LogOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024
    this.keepLines = options.keepLines ?? 1000
    this.maxLineLength = options.maxLineLength ?? 2000
    this.flushAfterMs = options.flushAfterMs ?? 200
    this.now = options.now ?? Date.now
    this.redact = options.redact ?? ((text) => text)
    this.file = path.join(dir, LOG_FILE)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    } catch {
      this.failures = MAX_FAILURES
    }
  }

  private get broken(): boolean {
    return this.failures >= MAX_FAILURES
  }

  write(level: LogLevel, text: string): void {
    const at = this.now()
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue
      const clean = this.redact(raw)
      const line = clean.length > this.maxLineLength ? `${clean.slice(0, this.maxLineLength)} [cut: ${clean.length - this.maxLineLength} more characters]` : clean
      this.lines.push({ at, level, text: line })
      if (!this.broken) this.queued += `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${line}\n`
    }
    if (this.lines.length > this.keepLines) this.lines.splice(0, this.lines.length - this.keepLines)
    if (!this.timer && !this.broken) {
      this.timer = setTimeout(() => this.flush(), this.flushAfterMs)
      this.timer.unref?.()
    }
  }

  /** The last lines, oldest first. */
  recent(count = this.keepLines): LogLine[] {
    return this.lines.slice(-count)
  }

  /**
   * The last lines as they were written, oldest first, from the files, so lines from before a restart are there
   * too. Falls back to this run's memory when the files cannot be read.
   */
  tail(count = 400): string[] {
    this.flush()
    try {
      const lines = [`${this.file}.1`, this.file].flatMap((file) => readEnd(file, TAIL_BYTES).split('\n')).filter(Boolean)
      if (lines.length) return lines.slice(-count)
    } catch {
      /* the memory copy below */
    }
    return this.recent(count).map((line) => `${new Date(line.at).toISOString()} ${line.level.toUpperCase().padEnd(5)} ${line.text}`)
  }

  /** Writes what is waiting. Called before the process ends. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.queued || this.broken) {
      this.queued = ''
      return
    }
    const chunk = this.queued
    this.queued = ''
    try {
      const bytes = Buffer.byteLength(chunk)
      if (this.size > 0 && this.size + bytes > this.maxFileBytes) {
        fs.renameSync(this.file, `${this.file}.1`)
        this.size = 0
      }
      fs.appendFileSync(this.file, chunk, { mode: 0o600 })
      this.size += bytes
      this.failures = 0
    } catch {
      // Out of space, a locked file or a removed folder: keep running, and keep the memory copy.
      this.failures++
    }
  }

  /** Everything the console would print is kept here too. Returns the function that puts the console back. */
  captureConsole(target: ConsoleLike = console): () => void {
    const original = { log: target.log, info: target.info, warn: target.warn, error: target.error }
    const hook = (level: LogLevel, name: keyof typeof original) => {
      target[name] = (...args: unknown[]) => {
        ;(original[name] as (...data: unknown[]) => void).apply(target, args)
        try {
          this.write(level, format(...args))
        } catch {
          /* a value that cannot be formatted is not worth a crash */
        }
      }
    }
    hook('info', 'log')
    hook('info', 'info')
    hook('warn', 'warn')
    hook('error', 'error')
    return () => Object.assign(target, original)
  }
}
