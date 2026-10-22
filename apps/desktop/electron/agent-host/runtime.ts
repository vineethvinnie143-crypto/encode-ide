/**
 * The agent host's program: waits for the main process to say where things
 * are, then serves the session API on the port. It never touches Electron, so
 * it runs under node:test as well as in the utility process.
 */
import { AgentHost, createProfileClient, serveHost, type AgentSettings, type HostOptions } from '@encode/core'
import { Peer, RpcError, type Port } from '@encode/protocol'
import type { DesktopHostApi, HostConfig, HostInit, MainApi } from './api'

export interface HostRuntimeOptions {
  /** Lets a test replace pieces of the host (the shell, the web, the model). */
  hostOptions?: Partial<HostOptions>
  /** Where problems are written. Default: the console. */
  log?: (message: string) => void
  /** Called after `shutdown` has answered; the process exits here. */
  onShutdown?: () => void
  /** How long the main process may take to hand over a key, ms. */
  keyTimeoutMs?: number
}

export interface HostRuntime {
  peer: Peer<DesktopHostApi, MainApi>
  host(): AgentHost | undefined
}

const agentSettings = (config: HostConfig): AgentSettings => ({
  policy: config.policy,
  maxSteps: config.maxSteps,
  maxGoalRounds: config.maxGoalRounds,
})

export function runHostRuntime(port: Port, options: HostRuntimeOptions = {}): HostRuntime {
  const log = options.log ?? ((message: string) => console.error(`[agent-host] ${message}`))
  const peer = new Peer<DesktopHostApi, MainApi>(port, { onProtocolError: (error) => log(error.message) })
  let host: AgentHost | undefined
  let config: HostConfig | undefined

  const client = createProfileClient({
    profile: () => config?.profile ?? null,
    // Asked for at every call: the key is held here only while a request is being made.
    apiKey: async (profile) => {
      try {
        return (await peer.request('key', { profileId: profile.id, baseUrl: profile.baseUrl }, { timeoutMs: options.keyTimeoutMs ?? 10_000 })) || undefined
      } catch (error) {
        log(`could not get the key for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
  })

  peer.handle('init', async (init: HostInit) => {
    if (host) throw new RpcError('invalid-state', 'The agent host is already set up.')
    config = init.config
    const created = new AgentHost({
      dir: init.dir,
      home: init.home,
      workspace: init.workspace,
      client,
      settings: () => agentSettings(config!),
      emit: (event) => peer.notify('event', event),
      onJobs: (jobs) => peer.notify('jobs', jobs),
      warn: (message) => peer.notify('warn', message),
      ...options.hostOptions,
    })
    if (init.legacySessionsFile) {
      try {
        await created.importLegacySessions(init.legacySessionsFile)
      } catch (error) {
        log(`could not import the earlier sessions: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    host = created
    serveHost(peer, created)
  })

  peer.handle('configure', (next: HostConfig) => {
    config = next
  })

  peer.handle('shutdown', async () => {
    const closing = host
    host = undefined
    await closing?.dispose()
    if (options.onShutdown) setImmediate(options.onShutdown)
  })

  return { peer, host: () => host }
}
