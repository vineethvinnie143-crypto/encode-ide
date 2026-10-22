import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

/**
 * Runs a hook's command line through a shell, feeds it the event as JSON on
 * stdin and collects what it prints. A command that outlives its timeout is
 * stopped with everything it started: the whole process group on macOS and
 * Linux, the whole tree (taskkill /T) on Windows.
 */

export interface HookShell {
  /** Absolute path of the shell program. */
  file: string
  /** The arguments that make it run one command line, such as ['-c', line]. */
  args(command: string): string[]
}

export interface HookRun {
  /** Null when the command was stopped or could not start. */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Why the command could not start. */
  error?: string
}

export interface HookRunOptions {
  stdin: string
  env: Record<string, string>
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

export type HookRunner = (command: string, options: HookRunOptions) => Promise<HookRun>

/** Output kept from each stream; a hook that prints more is cut. */
const MAX_OUTPUT_BYTES = 1024 * 1024
/** How long to wait for the output pipes to close once the command has exited (a background child may hold them). */
const DRAIN_MS = 250

class Collector {
  private readonly chunks: Buffer[] = []
  private size = 0

  add(chunk: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) return
    const room = MAX_OUTPUT_BYTES - this.size
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(kept)
    this.size += kept.length
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** Stops a process and everything it started. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid
  if (pid === undefined) return
  if (platform === 'win32') {
    const taskkill = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill('SIGKILL'))
    return
  }
  try {
    // The child leads its own process group (detached), so -pid reaches everything it started.
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export function createProcessRunner(shell: HookShell, platform: NodeJS.Platform = process.platform): HookRunner {
  return (command, options) =>
    new Promise<HookRun>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(shell.file, shell.args(command), {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: platform !== 'win32',
        })
      } catch (error) {
        resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const stdout = new Collector()
      const stderr = new Collector()
      child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))

      let timedOut = false
      let settled = false
      let exitCode: number | null = null
      const stop = () => killTree(child, platform)
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, options.timeoutMs)
      options.signal?.addEventListener('abort', stop, { once: true })

      const finish = (error?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', stop)
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve({ exitCode: timedOut ? null : exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, ...(error ? { error } : {}) })
      }
      child.on('error', (error) => finish(error.message))
      child.on('close', () => finish())
      child.on('exit', (code) => {
        exitCode = code
        // Normally 'close' follows at once; a background child that kept the pipes open must not hold the hook.
        setTimeout(() => finish(), DRAIN_MS)
      })
      // A hook that never reads stdin closes it early; that is not an error.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin)
    })
}
