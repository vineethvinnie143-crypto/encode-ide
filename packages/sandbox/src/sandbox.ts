/**
 * The sandbox as the rest of the program sees it: one object for the whole program (it probes the machine once),
 * and one small view for each session's shells. A view turns the session's folders and settings into a policy,
 * prepares what the engine needs (Windows: the permission entries, the first time a folder is used) and rewrites
 * each spawn.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineLimits, EnginePolicy, SandboxEngine, SandboxStatus, SpawnSpec } from './engine'
import { SandboxError } from './errors'
import { createLinuxEngine } from './linux'
import { createMacEngine } from './macos'
import { buildPolicy, gitDirectories, type PolicyIo } from './policy'
import { DEFAULT_SETTINGS, type SandboxSettings } from './settings'
import { createWindowsEngine } from './windows/engine'

export interface SandboxOptions {
  platform?: NodeJS.Platform
  home?: string
  /** The sandbox's own folder: its temp folder, the Windows helper and its state. */
  dir: string
  /** The engine to use; by default the one for the platform. */
  engine?: SandboxEngine
  env?: Record<string, string | undefined>
  io?: PolicyIo
  warn?(message: string): void
}

/** What a session tells the sandbox. */
export interface SessionScope {
  /** The session's folder first, then any extra folders the person allowed edits in. */
  roots(): readonly string[]
  settings(): SandboxSettings
}

export interface SessionSandbox {
  /** Whether commands run in the sandbox right now, and if not why not. Give the shell's program to learn whether it can run in it. */
  state(program?: string): { active: boolean; reason?: string; required: boolean; allowUnsandboxed: boolean; limits?: EngineLimits }
  /** Rewrites a spawn. Throws a SandboxError when the sandbox is required and not available, or a folder cannot be prepared. */
  wrapSpawn(spec: SpawnSpec): Promise<SpawnSpec>
  /** The folder the shell keeps its scripts in while the sandbox is active, so that they are readable and writable inside it. */
  scratchRoot(): Promise<string | undefined>
  /** Starts preparing the session's folders so that the first command does not wait. */
  warm(): void
}

export const defaultIo: PolicyIo = {
  realpath(file) {
    try {
      return fs.realpathSync.native(file)
    } catch {
      return file
    }
  },
  stat(file) {
    try {
      const stat = fs.statSync(file)
      return stat.isDirectory() ? 'dir' : 'file'
    } catch {
      return undefined
    }
  },
  readText(file) {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 64 * 1024) return undefined
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
}

function engineFor(platform: NodeJS.Platform, dir: string, home: string, warn?: (message: string) => void): SandboxEngine | undefined {
  if (platform === 'linux') return createLinuxEngine()
  if (platform === 'darwin') return createMacEngine()
  if (platform === 'win32') return createWindowsEngine({ dir, home, ...(warn ? { warn } : {}) })
  return undefined
}

const SCRATCH_MAX_AGE_MS = 24 * 3_600_000

export class Sandbox {
  private readonly platform: NodeJS.Platform
  private readonly home: string
  private readonly engine: SandboxEngine | undefined
  private readonly io: PolicyIo
  private readonly env: Record<string, string | undefined>
  private readonly temp: string
  private readonly cacheRoot: string
  private probed: Promise<SandboxStatus> | undefined
  private result: SandboxStatus
  private readonly prepared = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private progress: string | undefined

  constructor(private readonly options: SandboxOptions) {
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? os.homedir()
    this.engine = options.engine ?? engineFor(this.platform, options.dir, this.home, options.warn)
    this.io = options.io ?? defaultIo
    this.env = options.env ?? process.env
    this.temp = path.join(options.dir, 'tmp')
    this.cacheRoot = path.join(options.dir, 'cache')
    this.result = this.engine
      ? { state: 'unavailable', reason: 'Not checked yet.', limits: this.engine.limits, engine: this.engine.name, required: false, allowUnsandboxed: true }
      : { state: 'unavailable', reason: `There is no sandbox for ${this.platform}.`, required: false, allowUnsandboxed: true }
  }

  /** Checks once whether this machine can run the engine. Later calls return the first answer; `refresh` asks again. */
  start(): Promise<SandboxStatus> {
    this.probed ??= this.check()
    return this.probed
  }

  refresh(): Promise<SandboxStatus> {
    this.probed = undefined
    this.prepared.clear()
    return this.start()
  }

  /** The last answer: `unavailable` with "Not checked yet" before `start` has finished. */
  status(): SandboxStatus {
    return { ...this.result }
  }

  /** What is being prepared right now ("Preparing C:\\work for the sandbox"), or nothing. */
  working(): string | undefined {
    return this.progress
  }

  /** Why a program cannot run in this system's sandbox (Windows: Git Bash), or nothing. */
  unsupported(file: string): string | undefined {
    return this.engine?.unsupported?.(file)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.options.warn?.(`A sandbox listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async check(): Promise<SandboxStatus> {
    const engine = this.engine
    if (!engine) {
      this.changed()
      return this.status()
    }
    let probe: Awaited<ReturnType<SandboxEngine['probe']>>
    try {
      probe = await engine.probe()
    } catch (error) {
      probe = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.result = probe.ok
      ? { state: 'active', engine: engine.name, limits: engine.limits, required: false, allowUnsandboxed: true }
      : { state: 'unavailable', engine: engine.name, limits: engine.limits, reason: probe.reason ?? 'The sandbox failed its test.', required: false, allowUnsandboxed: true }
    if (probe.ok) void this.sweep()
    this.changed()
    return this.status()
  }

  /** Scripts of commands that ended long ago (a crash can leave them) are not kept. */
  private async sweep(): Promise<void> {
    try {
      for (const entry of await fs.promises.readdir(this.temp, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('encode-shell-')) continue
        const full = path.join(this.temp, entry.name)
        const stat = await fs.promises.stat(full)
        if (Date.now() - stat.mtimeMs > SCRATCH_MAX_AGE_MS) await fs.promises.rm(full, { recursive: true, force: true })
      }
    } catch {
      // The folder may not exist yet.
    }
  }

  private async policy(scope: SessionScope): Promise<EnginePolicy> {
    const settings = scope.settings()
    // The two caches nearly every tool wants must exist to be writable; making them is what the tools would do themselves.
    if (this.platform !== 'win32' && settings.caches) {
      for (const name of ['.npm', '.cache']) await fs.promises.mkdir(path.join(this.home, name), { recursive: true }).catch(() => undefined)
    }
    // A protected path that does not exist yet is not held, and git runs what its hooks folder holds outside the sandbox.
    // A repository without that folder gets an empty one first, as `git init` would have made it.
    for (const root of scope.roots()) {
      for (const gitDir of gitDirectories(this.io.realpath(root), this.io, this.platform)) {
        if (this.io.stat(gitDir) === 'dir') await fs.promises.mkdir(path.join(gitDir, 'hooks')).catch(() => undefined)
      }
    }
    return buildPolicy({
      platform: this.platform,
      home: this.home,
      roots: scope.roots(),
      settings,
      temp: this.io.realpath(this.temp),
      ...(this.platform === 'win32' ? { cacheRoot: this.io.realpath(this.cacheRoot) } : {}),
      env: this.env,
      io: this.io,
    })
  }

  private async prepare(policy: EnginePolicy): Promise<void> {
    const engine = this.engine!
    const key = JSON.stringify([policy.writable, policy.protected, policy.unreadable])
    let job = this.prepared.get(key)
    if (!job) {
      await fs.promises.mkdir(policy.temp, { recursive: true, mode: 0o700 })
      if (this.platform === 'win32') await fs.promises.mkdir(this.cacheRoot, { recursive: true })
      job = engine
        .prepare(policy, (message) => {
          this.progress = message
          this.changed()
        })
        .finally(() => {
          this.progress = undefined
          this.changed()
        })
      this.prepared.set(key, job)
      job.catch(() => this.prepared.delete(key))
    }
    return job
  }

  session(scope: SessionScope): SessionSandbox {
    const sandbox = this
    return {
      state(program) {
        const settings = scope.settings()
        const base = { required: settings.required, allowUnsandboxed: settings.allowUnsandboxed }
        if (!settings.enabled) return { ...base, active: false, reason: 'The sandbox is turned off in the settings.' }
        const status = sandbox.result
        const limits = status.limits ? { limits: status.limits } : {}
        if (status.state !== 'active') return { ...base, active: false, reason: status.reason ?? 'The sandbox is not available.', ...limits }
        const unsupported = program ? sandbox.unsupported(program) : undefined
        if (unsupported) return { ...base, active: false, reason: unsupported, ...limits }
        return { ...base, active: true, ...limits }
      },

      async wrapSpawn(spec) {
        const settings = scope.settings()
        if (!settings.enabled) return spec
        await sandbox.start()
        if (sandbox.result.state !== 'active' || !sandbox.engine) {
          if (settings.required) throw new SandboxError('unavailable', `Commands are not run because the settings require the sandbox and it is not available: ${sandbox.result.reason ?? 'unknown reason'}`)
          return spec
        }
        const unsupported = sandbox.engine.unsupported?.(spec.file)
        if (unsupported) {
          if (settings.required) throw new SandboxError('unavailable', `Commands are not run because the settings require the sandbox. ${unsupported}`)
          return spec
        }
        const policy = await sandbox.policy(scope)
        await sandbox.prepare(policy)
        return sandbox.engine.wrap(spec, policy)
      },

      async scratchRoot() {
        const settings = scope.settings()
        if (!settings.enabled) return undefined
        await sandbox.start()
        if (sandbox.result.state !== 'active') return undefined
        await fs.promises.mkdir(sandbox.temp, { recursive: true, mode: 0o700 })
        return sandbox.io.realpath(sandbox.temp)
      },

      warm() {
        if (!scope.settings().enabled) return
        void sandbox.start().then(async () => {
          if (sandbox.result.state !== 'active') return
          try {
            await sandbox.prepare(await sandbox.policy(scope))
          } catch (error) {
            sandbox.options.warn?.(`The sandbox could not be prepared: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      },
    }
  }
}

export { DEFAULT_SETTINGS }
