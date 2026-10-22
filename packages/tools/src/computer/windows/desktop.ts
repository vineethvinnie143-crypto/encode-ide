/**
 * The Windows desktop: the helper program of this folder, built and started on first use, behind the
 * `DesktopBackend` contract.
 *
 * What lives here is the part that is not about the screen: when the helper starts and restarts, how long each
 * kind of request may take, what is handed to the helper (the applications a call may reach, eNCode's own
 * processes it must never touch) and what is checked before the answer is trusted. The helper does the rest.
 * It runs under the user's own account with no more rights than eNCode has, and it is given a short list of
 * environment variables rather than eNCode's whole environment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  DesktopError,
  type ActRequest,
  type ActResult,
  type AppId,
  type BackendInfo,
  type DesktopBackend,
  type Look,
  type LookRequest,
  type Outline,
  type Point,
  type WindowId,
  type WindowInfo,
} from '../contract'
import { matchElements } from '../outline'
import { ensureHelper, type BuildOptions, type HelperBuild } from './build'
import { HelperClient } from './client'
import { asAct, asInfo, asLook, asPoint, asWindow, asWindows } from './validate'

export interface WindowsDesktopOptions {
  /** Where compiled helpers are kept. Default: eNCode's folder under the user's local application data. */
  cacheDir?: string
  /** Processes whose windows are never used, besides this one and its parent: eNCode's own. */
  ownPids?: readonly number[]
  /** Programs whose windows are never used, besides the one running this: eNCode's own executable. */
  ownPaths?: readonly string[]
  /** Tests only: let the helper work on windows of programs that run as administrator. */
  allowElevated?: boolean
  /** How the helper is built. */
  build?: Omit<BuildOptions, 'cacheDir'>
  ensure?: (options: BuildOptions) => Promise<HelperBuild>
  spawn?: (exe: string) => ChildProcessWithoutNullStreams
  helloTimeoutMs?: number
  stuckMs?: number
  log?: (message: string) => void
  /** Milliseconds; replaced in tests. */
  now?: () => number
}

/** The longest each kind of request may take before the helper is told to stop, ms. Settling time is added where it applies. */
export const REQUEST_TIMEOUTS = { ready: 30_000, windows: 10_000, focus: 15_000, look: 30_000, act: 45_000, cursor: 5_000 } as const

/** Elements a search reads before it filters: more than any outline lists, so a name deep in a big window is still found. */
const SEARCH_SCAN = 2_500

/** Time per step on top of the base, and per typed character: a slow application takes a while to take the keys. */
const PER_STEP_MS = 4_000
const PER_CHARACTER_MS = 2

/** A helper that could not be built or started is not tried again at once: the next call would fail the same way and cost seconds. */
const FAILURE_MEMORY_MS = 30_000

/** The variables the helper needs to start .NET and the screen. Nothing else of eNCode's environment goes along: it holds no secret the helper could use. */
const HELPER_ENV = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const

export function helperEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Windows variable names are not case-sensitive, and Node keeps the spelling it was given.
  for (const wanted of HELPER_ENV) {
    const key = Object.keys(source).find((name) => name.toLowerCase() === wanted.toLowerCase())
    if (key && source[key] !== undefined) env[wanted] = source[key]
  }
  return env
}

function defaultSpawn(exe: string): ChildProcessWithoutNullStreams {
  return spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment() })
}

function defaultCacheDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'eNCode', 'helper')
}

interface Connection {
  client: HelperClient
  info: BackendInfo
}

/** The caller stops waiting when its signal fires; the work it was waiting for goes on for whoever else needs it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function desktopError(error: unknown): DesktopError {
  if (error instanceof DesktopError) return error
  return new DesktopError('unavailable', `The desktop helper could not be started: ${error instanceof Error ? error.message : String(error)}`)
}

const NEVER = new AbortController().signal

export class WindowsDesktop implements DesktopBackend {
  private client: HelperClient | undefined
  private info: BackendInfo | undefined
  private connecting: Promise<Connection> | undefined
  private failure: { error: DesktopError; until: number } | undefined
  /** The highest window number the helper has handed out, so that a restarted helper goes on from it and an old id never names another window. */
  private highestWindow = 0
  private disposed = false

  constructor(private readonly options: WindowsDesktopOptions = {}) {}

  private clock(): number {
    return (this.options.now ?? Date.now)()
  }

  // ---------------------------------------------------------------- the helper's life

  private connect(signal: AbortSignal): Promise<Connection> {
    if (this.disposed) return Promise.reject(new DesktopError('unavailable', 'Computer use was shut down.'))
    const client = this.client
    if (client?.alive && this.info) return Promise.resolve({ client, info: this.info })
    if (!this.connecting) {
      const job = this.establish().finally(() => {
        this.connecting = undefined
      })
      // Everyone waiting may have given up by the time it fails; that is not an unhandled error.
      job.catch(() => undefined)
      this.connecting = job
    }
    return abortable(this.connecting, signal)
  }

  private async establish(): Promise<Connection> {
    let client = this.client
    if (!client?.alive) {
      this.client = undefined
      this.info = undefined
      if (this.failure && this.failure.until > this.clock()) throw this.failure.error
      try {
        client = await this.launch()
      } catch (error) {
        const failure = desktopError(error)
        this.failure = { error: failure, until: this.clock() + FAILURE_MEMORY_MS }
        throw failure
      }
      this.failure = undefined
      this.client = client
    }
    // The helper stays up when this fails (a locked screen, say), so the next call only asks again.
    const info = asInfo(
      await client.request(
        'ready',
        {
          ownPids: [...new Set([process.pid, process.ppid, ...(this.options.ownPids ?? [])].filter((pid) => Number.isInteger(pid) && pid > 0))],
          ownPaths: [...new Set([process.execPath, ...(this.options.ownPaths ?? [])])],
          allowElevated: this.options.allowElevated === true,
          firstWindow: this.highestWindow + 1,
        },
        { signal: NEVER, timeoutMs: REQUEST_TIMEOUTS.ready },
      ),
    )
    if (this.disposed) {
      await client.dispose()
      throw new DesktopError('unavailable', 'Computer use was shut down.')
    }
    this.info = info
    return { client, info }
  }

  private async launch(): Promise<HelperClient> {
    const build = await (this.options.ensure ?? ensureHelper)({ cacheDir: this.options.cacheDir ?? defaultCacheDir(), ...this.options.build })
    if (build.built) this.options.log?.(`desktop helper built (${build.hash})`)
    const spawnHelper = this.options.spawn ?? defaultSpawn
    const client = new HelperClient({
      spawn: () => spawnHelper(build.exe),
      ...(this.options.helloTimeoutMs !== undefined ? { helloTimeoutMs: this.options.helloTimeoutMs } : {}),
      ...(this.options.stuckMs !== undefined ? { stuckMs: this.options.stuckMs } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    })
    await client.start()
    if (this.disposed) {
      await client.dispose()
      throw new DesktopError('unavailable', 'Computer use was shut down.')
    }
    return client
  }

  private async call<T>(op: string, args: unknown, signal: AbortSignal, timeoutMs: number, parse: (value: unknown) => T): Promise<T> {
    const { client } = await this.connect(signal)
    return parse(await client.request(op, args, { signal, timeoutMs }))
  }

  // ---------------------------------------------------------------- what comes back

  private note(windows: readonly WindowInfo[]): void {
    for (const window of windows) {
      const number = Number(window.id.slice(1))
      if (number > this.highestWindow) this.highestWindow = number
    }
  }

  /** Records the windows an answer names, and cuts the outline down to what a search asked for. */
  private shaped(look: Look, outline: LookRequest['outline']): Look {
    this.note([look.window, ...look.related])
    if (typeof outline !== 'object' || !look.outline) return look
    const found = matchElements(look.outline.elements, outline)
    const narrowed: Outline = { elements: found, total: found.length }
    return { ...look, outline: narrowed }
  }

  // ---------------------------------------------------------------- the contract

  async ready(signal: AbortSignal): Promise<BackendInfo> {
    return (await this.connect(signal)).info
  }

  async windows(signal: AbortSignal): Promise<WindowInfo[]> {
    const list = await this.call('windows', {}, signal, REQUEST_TIMEOUTS.windows, asWindows)
    this.note(list)
    return list
  }

  async focus(request: { window: WindowId; allowed: readonly AppId[] }, signal: AbortSignal): Promise<WindowInfo> {
    const window = await this.call('focus', { window: request.window, allowed: [...request.allowed] }, signal, REQUEST_TIMEOUTS.focus, (value) => asWindow(value))
    this.note([window])
    return window
  }

  async look(request: LookRequest, signal: AbortSignal): Promise<Look> {
    const args = {
      window: request.window,
      allowed: [...request.allowed],
      image: request.image,
      outline: request.outline === 'none' ? 'none' : 'full',
      maxElements: typeof request.outline === 'object' ? SEARCH_SCAN : request.maxElements,
      maxImageEdge: request.maxImageEdge,
      maxImagePixels: request.maxImagePixels,
      ...(request.zoom ? { zoom: { capture: request.zoom.capture, box: [...request.zoom.box] } } : {}),
      ...(request.settleMs ? { settleMs: Math.round(request.settleMs) } : {}),
    }
    const look = await this.call('look', args, signal, REQUEST_TIMEOUTS.look + (request.settleMs ?? 0), asLook)
    return this.shaped(look, request.outline)
  }

  async act(request: ActRequest, signal: AbortSignal): Promise<ActResult> {
    const typed = request.steps.reduce((sum, step) => sum + (step.kind === 'type' ? step.text.length : 0), 0)
    const args = {
      window: request.window,
      allowed: [...request.allowed],
      steps: request.steps,
      ...(request.expectCursor ? { expectCursor: [...request.expectCursor] } : {}),
      look: {
        image: request.look.image,
        outline: request.look.outline === 'none' ? 'none' : 'full',
        maxElements: typeof request.look.outline === 'object' ? SEARCH_SCAN : request.look.maxElements,
        maxImageEdge: request.look.maxImageEdge,
        maxImagePixels: request.look.maxImagePixels,
      },
      settleMs: Math.round(request.settleMs),
      pace: request.pace,
    }
    const timeout = REQUEST_TIMEOUTS.act + request.settleMs + request.steps.length * PER_STEP_MS + typed * PER_CHARACTER_MS
    const result = await this.call('act', args, signal, timeout, asAct)
    this.note(result.opened)
    return { ...result, look: result.look ? this.shaped(result.look, request.look.outline) : null }
  }

  async cursor(signal: AbortSignal): Promise<Point> {
    return this.call('cursor', {}, signal, REQUEST_TIMEOUTS.cursor, (value) => asPoint(value, 'cursor'))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const connecting = this.connecting
    if (connecting) await connecting.catch(() => undefined)
    const client = this.client
    this.client = undefined
    this.info = undefined
    await client?.dispose()
  }
}

export function createWindowsDesktop(options: WindowsDesktopOptions = {}): WindowsDesktop {
  return new WindowsDesktop(options)
}
