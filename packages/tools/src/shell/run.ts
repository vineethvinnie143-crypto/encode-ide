/**
 * The agent's shell: every command runs in a fresh process of the user's
 * shell (Git Bash or PowerShell), never sourcing a profile, with stdin
 * closed. The working directory carries over from one command to the next;
 * variables do not. A command that leaves the workspace has its directory
 * reset to the workspace root, and says so.
 *
 * The command reaches the shell in a private script file, not on the command
 * line, so no layer of command-line quoting can change what runs. A sandbox
 * can rewrite every spawn through `wrapSpawn`; a command the person has let
 * leave it starts with `unsandboxed`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isInside } from '@encode/permissions'
import { collapseCarriageReturns, stripAnsi } from '../text'
import type { AgentShell, SandboxView, ShellDialect, ShellResult, ShellRunOptions, ShellState, SpawnSpec, SpawnWrapper } from '../types'
import { detectShell, type ShellProgram } from './detect'
import { agentEnvironment } from './environment'
import { windowsSystemProgram } from './programs'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
/** What a command's output is held to in memory: the start and the end. */
const HEAD_CHARS = 200_000
const TAIL_CHARS = 800_000
const KILL_GRACE_MS = 2_000
/** After the shell exits, how long to wait for output still in the pipes before closing them. */
const DRAIN_MS = 500

/** Keeps the start and the end of a long output, and counts what fell between. */
export class OutputBuffer {
  private head = ''
  private tail = ''
  private dropped = 0

  constructor(
    private readonly headLimit = HEAD_CHARS,
    private readonly tailLimit = TAIL_CHARS,
  ) {}

  push(text: string): void {
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length
      this.head += text.slice(0, room)
      text = text.slice(room)
    }
    if (!text) return
    this.tail += text
    if (this.tail.length > this.tailLimit) {
      this.dropped += this.tail.length - this.tailLimit
      this.tail = this.tail.slice(this.tail.length - this.tailLimit)
    }
  }

  get length(): number {
    return this.head.length + this.dropped + this.tail.length
  }

  text(): string {
    return this.dropped ? `${this.head}\n\n… [${this.dropped} characters cut] …\n\n${this.tail}` : this.head + this.tail
  }
}

/** Ends a process and everything it started. `finished` settles when the caller is done with the process; by default that is its `close`. */
export async function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform, finished?: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const exited = finished ?? new Promise<void>((resolve) => child.once('close', () => resolve()))
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(windowsSystemProgram('taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS)
    timer.unref()
    void exited.then(() => clearTimeout(timer))
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS * 2).unref())])
}

function bashQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function pwshQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** A path the shell itself can open: forward slashes for Git Bash on Windows. */
function shellPath(file: string, dialect: ShellDialect, platform: NodeJS.Platform): string {
  return dialect === 'bash' && platform === 'win32' ? file.replace(/\\/g, '/') : file
}

function bashScript(command: string, cwdFile: string): string {
  return [
    `eval ${bashQuote(command)}`,
    '__encode_status=$?',
    `{ if command -v cygpath >/dev/null 2>&1; then cygpath -w "$PWD"; else pwd -P; fi; } > ${bashQuote(cwdFile)} 2>/dev/null`,
    'exit $__encode_status',
    '',
  ].join('\n')
}

function pwshScript(commandFile: string, cwdFile: string): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$__encodeStatus = 0',
    'try {',
    `  $__encodeCommand = [System.IO.File]::ReadAllText(${pwshQuote(commandFile)})`,
    '  Invoke-Expression -Command $__encodeCommand',
    '  $__encodeOk = $?',
    '  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__encodeStatus = $LASTEXITCODE } elseif (-not $__encodeOk) { $__encodeStatus = 1 }',
    '} catch {',
    '  [Console]::Error.WriteLine($_.ToString())',
    '  $__encodeStatus = 1',
    '} finally {',
    `  try { [System.IO.File]::WriteAllText(${pwshQuote(cwdFile)}, (Get-Location).ProviderPath) } catch {}`,
    '}',
    'exit $__encodeStatus',
    '',
  ].join('\r\n')
}

export interface AgentShellOptions {
  /** The workspace root; commands start here and return here when they leave it. */
  root: string
  /** Default: detected (Git Bash, then PowerShell on Windows; bash elsewhere). */
  program?: ShellProgram
  /** On Windows, look for this shell first (PowerShell can run in the sandbox, Git Bash cannot). Ignored where it is not found. */
  prefer?: ShellDialect
  /** The environment to start from. Default: this process's. */
  baseEnv?: Record<string, string | undefined>
  /** Variable names to keep although they look like secrets. */
  keepEnv?: readonly string[]
  /** Variables to add. */
  extraEnv?: Record<string, string>
  /** Rewrites every spawn, to run commands inside a sandbox. */
  wrapSpawn?: SpawnWrapper
  /** Whether that wrapper confines commands right now, and whether a command may ask to leave it. Read each time; given the shell's own program, which a sandbox may be unable to confine. */
  sandbox?: (shell: string) => SandboxView
  /**
   * Where the scripts of confined commands are kept, when the system's temp folder is not one a command can use
   * (a sandbox gives commands a temp folder of their own). Undefined: the system's.
   */
  scratchRoot?: () => string | undefined | Promise<string | undefined>
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  platform?: NodeJS.Platform
}

export interface RunningCommand {
  child: ChildProcess
  /** Resolves when the process has exited and its output is flushed. */
  done: Promise<{ exitCode: number | null; signal: string | null; cwdFile: string }>
  kill(): Promise<void>
}

export interface ManagedShell extends AgentShell {
  /** Names removed from the environment because they looked like secrets. */
  readonly removedEnv: readonly string[]
  /** Starts a command without waiting for it: background jobs use this. */
  start(command: string, options: { cwd?: string; unsandboxed?: boolean; onOutput?(text: string): void }): Promise<RunningCommand>
  /** Moves the working directory, if it is a directory inside the workspace. */
  setCwd(dir: string): Promise<boolean>
  dispose(): Promise<void>
}

export class ShellUnavailableError extends Error {
  readonly code = 'shell-unavailable'
  constructor(platform: NodeJS.Platform) {
    super(
      platform === 'win32'
        ? 'No shell was found for running commands. Install Git for Windows (it brings Git Bash) or PowerShell 7, or set ENCODE_SHELL to the path of bash.exe or pwsh.exe.'
        : 'No bash was found for running commands. Install bash, or set ENCODE_SHELL to its path.',
    )
  }
}

export function createAgentShell(options: AgentShellOptions): ManagedShell {
  const platform = options.platform ?? process.platform
  const program = options.program ?? detectShell(options.baseEnv ?? process.env, platform, options.prefer)
  if (!program) throw new ShellUnavailableError(platform)
  const { env, removed } = agentEnvironment(options.baseEnv ?? process.env, { platform, keep: options.keepEnv, extra: options.extraEnv })
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const root = options.root
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeout = options.maxTimeoutMs ?? MAX_TIMEOUT_MS
  let cwd = root
  let counter = 0
  /** One scratch folder for each place scripts are kept: the system's temp folder, and the sandbox's. */
  const scratch = new Map<string, Promise<string>>()
  const running = new Set<RunningCommand>()

  const scratchDir = async (confined: boolean) => {
    const base = (confined ? await options.scratchRoot?.() : undefined) ?? os.tmpdir()
    let made = scratch.get(base)
    if (!made) {
      made = fs.mkdtemp(path.join(base, 'encode-shell-'))
      scratch.set(base, made)
      made.catch(() => scratch.delete(base))
    }
    return made
  }

  let rootReal: Promise<string> | undefined
  /** Inside the workspace once links and short names are resolved (fs.promises.realpath is the native one): a link out of it does not count. */
  const inside = async (dir: string) => {
    rootReal ??= fs.realpath(root).catch(() => root)
    const real = await fs.realpath(dir).catch(() => dir)
    return isInside(await rootReal!, real, pathApi)
  }

  async function start(command: string, startOptions: { cwd?: string; unsandboxed?: boolean; onOutput?(text: string): void }): Promise<RunningCommand> {
    const confined = Boolean(options.wrapSpawn) && !startOptions.unsandboxed
    const dir = await scratchDir(confined)
    const id = ++counter
    const cwdFile = path.join(dir, `${id}.cwd`)
    const scriptFile = path.join(dir, program!.dialect === 'bash' ? `${id}.sh` : `${id}.ps1`)
    const files = [scriptFile, cwdFile]
    let args: string[]
    if (program!.dialect === 'bash') {
      await fs.writeFile(scriptFile, bashScript(command, shellPath(cwdFile, 'bash', platform)), { mode: 0o600 })
      args = ['--noprofile', '--norc', shellPath(scriptFile, 'bash', platform)]
    } else {
      const commandFile = path.join(dir, `${id}.command.txt`)
      files.push(commandFile)
      await fs.writeFile(commandFile, command, { mode: 0o600 })
      await fs.writeFile(scriptFile, pwshScript(commandFile, cwdFile), { mode: 0o600 })
      args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptFile]
    }

    let spec: SpawnSpec = { file: program!.file, args, env: { ...env, PWD: startOptions.cwd ?? cwd }, cwd: startOptions.cwd ?? cwd }
    if (confined) spec = await options.wrapSpawn!(spec)
    if (!pathApi.isAbsolute(spec.file)) throw new Error(`The sandbox returned a program without an absolute path: ${spec.file}`)

    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    })
    const decoders = [new TextDecoder('utf-8'), new TextDecoder('utf-8')]
    const forward = (index: number) => (chunk: Buffer) => {
      const text = decoders[index].decode(chunk, { stream: true })
      if (text) startOptions.onOutput?.(text)
    }
    child.stdout?.on('data', forward(0))
    child.stderr?.on('data', forward(1))

    const done = new Promise<{ exitCode: number | null; signal: string | null; cwdFile: string }>((resolve) => {
      let settled = false
      const finish = (exitCode: number | null, signal: string | null) => {
        if (settled) return
        settled = true
        for (const decoder of decoders) {
          const rest = decoder.decode()
          if (rest) startOptions.onOutput?.(rest)
        }
        running.delete(handle)
        resolve({ exitCode, signal, cwdFile })
      }
      child.once('error', (error) => {
        startOptions.onOutput?.(`${error.message}\n`)
        finish(127, null)
      })
      // 'close' waits for every holder of the pipes. A process the command left behind (a daemon it started, a
      // grandchild a tree kill missed) can hold them long after the shell is gone, so after 'exit' wait only for
      // output already written, then stop listening.
      child.once('exit', (exitCode, signal) => {
        const timer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(exitCode, signal)
        }, DRAIN_MS)
        timer.unref()
        child.once('close', () => clearTimeout(timer))
      })
      child.once('close', (exitCode, signal) => finish(exitCode, signal))
    }).finally(() => {
      // The cwd file is read before cleanup by run(); background jobs do not need it.
      setTimeout(() => void Promise.all(files.map((file) => fs.rm(file, { force: true }))), 5_000).unref()
    })
    const handle: RunningCommand = { child, done, kill: () => killTree(child, platform, done) }
    running.add(handle)
    return handle
  }

  async function readCwd(cwdFile: string): Promise<string | undefined> {
    try {
      const text = (await fs.readFile(cwdFile, 'utf8')).replace(/^\uFEFF/, '').trim()
      return text ? pathApi.resolve(text) : undefined
    } catch {
      return undefined
    }
  }

  async function isDirectory(dir: string): Promise<boolean> {
    try {
      return (await fs.stat(dir)).isDirectory()
    } catch {
      return false
    }
  }

  async function run(command: string, runOptions: ShellRunOptions): Promise<ShellResult> {
    const { signal } = runOptions
    if (signal.aborted) throw signal.reason
    const timeoutMs = Math.min(maxTimeout, Math.max(1_000, runOptions.timeoutMs ?? defaultTimeout))
    const output = new OutputBuffer()
    const handle = await start(command, {
      ...(runOptions.unsandboxed ? { unsandboxed: true } : {}),
      onOutput: (text) => {
        output.push(text)
        runOptions.onOutput?.(collapseCarriageReturns(stripAnsi(text)))
      },
    })
    let timedOut = false
    let interrupted = false
    const timer = setTimeout(() => {
      timedOut = true
      void handle.kill()
    }, timeoutMs)
    const onAbort = () => {
      interrupted = true
      void handle.kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let result: Awaited<RunningCommand['done']>
    try {
      result = await handle.done
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    let notice: string | undefined
    const ended = await readCwd(result.cwdFile)
    if (ended && ended !== cwd && (await isDirectory(ended))) {
      if (await inside(ended)) cwd = ended
      else {
        cwd = root
        notice = `Shell cwd was reset to ${root}`
      }
    }
    if (!(await isDirectory(cwd))) {
      cwd = root
      notice = `Shell cwd was reset to ${root}`
    }

    return {
      output: collapseCarriageReturns(stripAnsi(output.text())),
      exitCode: timedOut || interrupted ? null : result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut,
      interrupted,
      cwd,
      ...(notice ? { notice } : {}),
    }
  }

  return {
    dialect: program.dialect,
    program: program.file,
    removedEnv: removed,
    state: (): ShellState => ({ cwd, env: { ...env }, dialect: program.dialect, ...(options.sandbox ? { sandbox: options.sandbox(program.file) } : {}) }),
    run,
    start,
    async setCwd(dir) {
      const target = pathApi.resolve(root, dir)
      if (!(await isDirectory(target)) || !(await inside(target))) return false
      cwd = target
      return true
    },
    async dispose() {
      await Promise.all([...running].map((handle) => handle.kill()))
      await Promise.all(
        [...scratch.values()].map(async (made) => {
          const dir = await made.catch(() => undefined)
          if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        }),
      )
    },
  }
}
