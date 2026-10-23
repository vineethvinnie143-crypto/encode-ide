/**
 * Language servers eNCode installs when the person asks (ADR 0083): one install at a time per server, its progress
 * for the Settings screen, and what to tell the folders' hubs once a server is there or gone. Servers go in eNCode's
 * own tools folder, shared by every folder; what may run is still decided per folder (trusted folders only). A library
 * a server reads (FiveM's natives, ADR 0084) is installed the same way, and its server starts again to read it.
 */
import { InstallFailed, installServer, LANGUAGE_LIBRARIES, LANGUAGE_SERVERS, planInstall, removeInstall, type Installable, type InstallContext, type InstallPlan, type LibrarySpec, type ServerSpec } from '@encode/lsp'
import { agentEnvironment } from '@encode/tools'
import { launchContext, type InstallState, type ServerTools } from './code'

export interface ServerInstallsOptions {
  tools: ServerTools
  platform: NodeJS.Platform
  catalog?: readonly ServerSpec[]
  libraries?: readonly LibrarySpec[]
  /** What installers start from, before secrets are taken out. */
  env?: Record<string, string | undefined>
  /** A server was installed or removed: the folders look for it again (stopping it first, when it is to be removed). */
  rediscover(id: string, options: { stop?: boolean }): Promise<void>
  /** Progress or a result to show. */
  onChange?(): void
  /** For tests: how a toolchain's installer runs. */
  run?: InstallContext['run']
}

export class ServerInstalls {
  private readonly running = new Map<string, { promise: Promise<InstallResult>; done: number; total: number; abort: AbortController }>()
  private readonly errors = new Map<string, string>()
  private lastProgress = 0

  constructor(private readonly options: ServerInstallsOptions) {}

  private spec(id: string): ServerSpec | LibrarySpec | undefined {
    return (this.options.catalog ?? LANGUAGE_SERVERS).find((spec) => spec.id === id) ?? (this.options.libraries ?? LANGUAGE_LIBRARIES).find((spec) => spec.id === id)
  }

  /** The folders' servers look again; for a library, its server starts again, so that it reads the library. */
  private async rediscover(spec: Installable, how: { stop?: boolean }): Promise<void> {
    const library = 'server' in spec && typeof spec.server === 'string' ? spec.server : null
    if (!library) return this.options.rediscover(spec.id, how)
    await this.options.rediscover(library, { stop: true })
    if (!how.stop) await this.options.rediscover(library, {})
  }

  private context(root: string, extra: Partial<InstallContext> = {}): InstallContext {
    const env = agentEnvironment(this.options.env ?? process.env, { platform: this.options.platform }).env
    return {
      ...launchContext(this.options.tools, root, this.options.platform, env),
      toolsDir: this.options.tools.dir,
      fetch: this.options.tools.fetch ?? ((input, init) => fetch(input, init)),
      ...(this.options.run ? { run: this.options.run } : {}),
      ...extra,
    }
  }

  /** What installing the server would do, for the person to read first. */
  async plan(id: string, root: string): Promise<InstallPlan | { unavailable: string }> {
    const spec = this.spec(id)
    if (!spec) return { unavailable: 'eNCode does not know that language server.' }
    try {
      return await planInstall(spec, this.context(root))
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Installs the server; a second ask while it runs waits for the same install. */
  install(id: string, root: string): Promise<InstallResult> {
    const known = this.running.get(id)
    if (known) return known.promise
    const spec = this.spec(id)
    if (!spec) return Promise.resolve({ ok: false, reason: 'eNCode does not know that language server.' })
    const abort = new AbortController()
    const entry = { done: 0, total: 0, abort, promise: Promise.resolve<InstallResult>({ ok: false, reason: '' }) }
    this.errors.delete(id)
    entry.promise = (async (): Promise<InstallResult> => {
      try {
        const dir = await installServer(
          spec,
          this.context(root, {
            signal: abort.signal,
            onProgress: (done, total) => {
              entry.done = done
              entry.total = total
              // Progress is told a few times a second at most.
              if (Date.now() - this.lastProgress > 250) {
                this.lastProgress = Date.now()
                this.options.onChange?.()
              }
            },
          }),
        )
        await this.rediscover(spec, {})
        return { ok: true, dir }
      } catch (error) {
        // Stopped by the person: nothing to report as a failure.
        if (abort.signal.aborted) return { ok: false, reason: 'The install was stopped.' }
        const reason = error instanceof InstallFailed ? error.message : `The install failed: ${error instanceof Error ? error.message : String(error)}`
        this.errors.set(id, reason)
        return { ok: false, reason }
      } finally {
        this.running.delete(id)
        this.options.onChange?.()
      }
    })()
    this.running.set(id, entry)
    this.options.onChange?.()
    return entry.promise
  }

  /** Stops an install that runs; it ends as failed, with nothing left behind. */
  cancel(id: string): void {
    this.running.get(id)?.abort.abort()
  }

  /** Removes what eNCode installed; the folders stop the server first, and look for another after. */
  async remove(id: string): Promise<InstallResult> {
    const spec = this.spec(id)
    if (!spec) return { ok: false, reason: 'eNCode does not know that language server.' }
    if (this.running.has(id)) return { ok: false, reason: 'It is being installed.' }
    await this.rediscover(spec, { stop: true })
    try {
      removeInstall(spec, this.options.tools.dir)
      return { ok: true, dir: '' }
    } catch (error) {
      return { ok: false, reason: `eNCode could not remove all of it: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      this.errors.delete(id)
      await this.rediscover(spec, {})
      this.options.onChange?.()
    }
  }

  state(id: string): InstallState | undefined {
    const running = this.running.get(id)
    if (running) return { done: running.done, total: running.total }
    const error = this.errors.get(id)
    return error ? { error } : undefined
  }

  dispose(): void {
    for (const entry of this.running.values()) entry.abort.abort()
  }
}

export type InstallResult = { ok: true; dir: string } | { ok: false; reason: string }
