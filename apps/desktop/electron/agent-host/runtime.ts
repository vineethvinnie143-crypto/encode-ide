/**
 * The agent host's program: waits for the main process to say where things
 * are, then serves the session API on the port. It never touches Electron, so
 * it runs under node:test as well as in the utility process.
 *
 * Model calls go to the offline demo, to nothing (no model is set up yet), or to the model router, which turns
 * the settings' roles into ordered model lists, fails over silently and keeps the free models coming. Keys never
 * rest here: the router asks for one when it makes a request, and the main process answers only for the server
 * the key was entered for.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AgentHost, NO_MODEL_MESSAGE, createDemoClient, serveHost, type AgentSettings, type HostOptions } from '@encode/core'
import { Peer, RpcError, type Port } from '@encode/protocol'
import {
  createAnthropicAdapter,
  createOpenAICompatibleAdapter,
  createOpenRouterAdapter,
  type BudgetQuery,
  type ClientEvent,
  type CompletionOutcome,
  type CompletionRequest,
  type ModelBudget,
  type ModelClient,
  type ModelRole,
} from '@encode/providers'
import { createRouter, parseRouterConfig, type ConfigProblem, type KeySource, type ModelRouter, type RouterAlert, type RouterOptions } from '@encode/router'
import { SearchError, createSearchProvider, createWebAccess, type KeySource as SearchKeySource, type ProviderOptions, type SearchProvider } from '@encode/tools'
import { Sandbox } from '@encode/sandbox'
import { Workspaces } from '@encode/workspace'
import { DEFAULT_SEARCH_PROVIDER, isKeyedSearchProvider, isSearchProviderId, searchProviderInfo, type KeyedSearchProviderId, type SearchCheckResult, type SearchProviderId } from '../../shared/search'
import type { ModelAlert, ModelStatus, ReasoningEffort } from '../../shared/types'
import { writePrivateFile } from '../services/private-file'
import type { DesktopHostApi, HostConfig, HostInit, MainApi, ModelCheckResult } from './api'
import { reviewChanges } from './code-review'
import { draftCommitMessage } from './commit-message'

export interface HostRuntimeOptions {
  /** Lets a test replace pieces of the host (the shell, the web, the model). */
  hostOptions?: Partial<HostOptions>
  /** Where problems are written. Default: the console. */
  log?: (message: string) => void
  /** Called after `shutdown` has answered; the process exits here. */
  onShutdown?: () => void
  /** How long the main process may take to hand over a key, ms. */
  keyTimeoutMs?: number
  /** The network for model providers and their model lists; a test replaces it. Default: the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** How often what the router has learned is written, if it changed, ms. Default 30 000. */
  stateIntervalMs?: number
  /** The web search providers; a test points them at a server of its own. */
  search?: { fetch?: ProviderOptions['fetch']; endpoints?: Partial<Record<SearchProviderId, string>> }
}

export interface HostRuntime {
  peer: Peer<DesktopHostApi, MainApi>
  host(): AgentHost | undefined
  router(): ModelRouter | undefined
}

const agentSettings = (config: HostConfig): AgentSettings => ({
  policy: config.policy,
  maxSteps: config.maxSteps,
  maxGoalRounds: config.maxGoalRounds,
  computer: config.computer,
})

const NO_MODEL_BUDGET: ModelBudget = { model: 'none', contextWindow: 128_000, maxOutputTokens: 8_192 }

/** How long the status page waits for the model lists before it shows what it has. */
const STATUS_WAIT_MS = 15_000

/** The test search of the Settings screen: one plain query, and no longer than a person will wait. */
const SEARCH_CHECK_QUERY = 'web search test'
const SEARCH_CHECK_TIMEOUT_MS = 20_000

/** A drafted commit message is waited for in a dialog: a person will wait this long, not more. */
const DRAFT_TIMEOUT_MS = 90_000
/** A review reads a large change and thinks it over: it gets longer than a commit message. */
const REVIEW_TIMEOUT_MS = 5 * 60_000

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function problemText(problem: ConfigProblem): string {
  return problem.path ? `${problem.path}: ${problem.message}` : problem.message
}

export function runHostRuntime(port: Port, options: HostRuntimeOptions = {}): HostRuntime {
  const log = options.log ?? ((message: string) => console.error(`[agent-host] ${message}`))
  const peer = new Peer<DesktopHostApi, MainApi>(port, { onProtocolError: (error) => log(error.message) })
  let host: AgentHost | undefined
  let workspaces: Workspaces | undefined
  let sandbox: Sandbox | undefined
  let sandboxListener: (() => void) | undefined
  let config: HostConfig | undefined
  let router: ModelRouter | undefined
  let problems: ConfigProblem[] = []
  let stateFile: string | undefined
  let stateTimer: NodeJS.Timeout | undefined
  let stateWritten = ''

  /** The router names a provider by an id of its own; people know it by the name they gave the profile. */
  const humanize = (text: string): string => {
    let out = text
    for (const [provider, entry] of Object.entries(config?.providers ?? {}).sort((a, b) => b[0].length - a[0].length)) out = out.split(provider).join(entry.name)
    return out
  }

  /** Asked for at every use: the key is held here only while a request is being made. */
  const requestKey = async (profileId: string, origin: string): Promise<string> => {
    try {
      return (await peer.request('key', { profileId, baseUrl: origin }, { timeoutMs: options.keyTimeoutMs ?? 10_000 })) || ''
    } catch (error) {
      log(`could not get the key for ${profileId}: ${describe(error)}`)
      return ''
    }
  }

  const keys: KeySource = {
    has: (provider) => (config?.providers[provider]?.keyRevision ?? null) !== null,
    get: async (provider, origin) => {
      const entry = config?.providers[provider]
      if (!entry || entry.keyRevision === null) return undefined
      return (await requestKey(entry.profile, origin)) || undefined
    },
  }

  /** A search provider's key, asked for at every search: it is held here only while the search is being made. */
  const searchKeyOf =
    (provider: KeyedSearchProviderId): SearchKeySource =>
    async () => {
      try {
        return (await peer.request('searchKey', { provider }, { timeoutMs: options.keyTimeoutMs ?? 10_000 })) || ''
      } catch (error) {
        log(`could not get the search key for ${provider}: ${describe(error)}`)
        return ''
      }
    }

  /** Who answers a search is read from the settings at every search, so a change in Settings applies at once. */
  const searchProviders = new Map<SearchProviderId, SearchProvider>()
  const searchProvider = (): SearchProvider => {
    const id = isSearchProviderId(config?.searchProvider) ? config.searchProvider : DEFAULT_SEARCH_PROVIDER
    let provider = searchProviders.get(id)
    if (!provider) {
      const endpoint = options.search?.endpoints?.[id]
      provider = createSearchProvider(id, isKeyedSearchProvider(id) ? searchKeyOf(id) : () => '', {
        ...(options.search?.fetch ? { fetch: options.search.fetch } : {}),
        ...(endpoint ? { endpoint } : {}),
      })
      searchProviders.set(id, provider)
    }
    return provider
  }

  const alertOf = (alert: RouterAlert): ModelAlert => ({
    kind: alert.type,
    profileId: config?.providers[alert.provider]?.profile ?? null,
    message: humanize(alert.message),
    ...('until' in alert && alert.until ? { until: alert.until } : {}),
  })

  const makeRouter = (initial: HostConfig): ModelRouter => {
    const parsed = parseRouterConfig(initial.router)
    problems = parsed.problems
    const fetchImpl = options.fetch ? { fetch: options.fetch } : {}
    return createRouter({
      config: parsed.config,
      adapters: [createOpenRouterAdapter(fetchImpl), createOpenAICompatibleAdapter(fetchImpl), createAnthropicAdapter(fetchImpl)],
      keys,
      ...(options.fetch ? { fetch: options.fetch as unknown as RouterOptions['fetch'] } : {}),
      onAlert: (alert) => {
        try {
          peer.notify('alert', alertOf(alert))
        } catch (error) {
          log(`could not pass on an alert: ${describe(error)}`)
        }
      },
      onLog: (entry) => {
        if (entry.level !== 'debug') log(`router ${entry.level}: ${humanize(entry.message)}`)
      },
      onTrace: (trace) => {
        // One line for each request that did not simply work, so a report says what happened without a line per call.
        if (trace.outcome !== 'done' || trace.attempts > 1) {
          log(`request ${trace.role}: ${trace.outcome}${trace.reason ? ` (${trace.reason})` : ''}, ${trace.attempts} ${trace.attempts === 1 ? 'attempt' : 'attempts'}${trace.model ? ` ending at ${humanize(trace.model)}` : ''}`)
        }
      },
    })
  }

  const saveState = (): void => {
    if (!stateFile || !router) return
    try {
      const json = JSON.stringify(router.snapshot())
      if (json === stateWritten) return
      writePrivateFile(stateFile, json)
      stateWritten = json
    } catch (error) {
      log(`could not save what the model router has learned: ${describe(error)}`)
    }
  }

  const loadState = (): void => {
    if (!stateFile || !router) return
    try {
      const json = fs.readFileSync(stateFile, 'utf8')
      router.restore(JSON.parse(json))
      stateWritten = JSON.stringify(router.snapshot())
    } catch (error) {
      // Nothing saved yet is normal; a damaged file just means starting to learn again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`could not read what the model router had learned: ${describe(error)}`)
    }
  }

  const demo = createDemoClient()
  const nothing: ModelClient = {
    budget: async () => NO_MODEL_BUDGET,
    complete: async () => ({ kind: 'paused', reason: 'no-model', message: NO_MODEL_MESSAGE }),
  }
  const pick = (): ModelClient => (config?.model === 'demo' ? demo : config?.model === 'router' && router ? router : nothing)
  /** "p-1f3a:qwen/qwen3-coder" as people know it: "OpenRouter: qwen/qwen3-coder". */
  const humanizeKey = (key: string): string => {
    const colon = key.indexOf(':')
    const entry = colon > 0 ? config?.providers[key.slice(0, colon)] : undefined
    return entry ? `${entry.name}: ${key.slice(colon + 1)}` : key
  }
  const humanizeEvent = (event: ClientEvent): ClientEvent => {
    switch (event.type) {
      case 'switch':
        return { ...event, from: humanizeKey(event.from), to: humanizeKey(event.to), reason: humanize(event.reason) }
      case 'wait':
      case 'discard':
        return { ...event, reason: humanize(event.reason) }
      default:
        return event
    }
  }
  const client: ModelClient = {
    budget: (role: ModelRole, query?: BudgetQuery): Promise<ModelBudget> => pick().budget(role, query),
    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      const onEvent = request.onEvent
      // The effort the person chose for the role wins over the one the caller asked for; the adapter drops it for a model without a dial.
      const effort = (config?.efforts as Record<string, ReasoningEffort | undefined> | undefined)?.[request.role]
      const asked = effort ? { ...request, payload: { ...request.payload, reasoning: effort } } : request
      const outcome = await pick().complete(onEvent ? { ...asked, onEvent: (event) => onEvent(humanizeEvent(event)) } : asked)
      return outcome.kind === 'paused' ? { ...outcome, message: humanize(outcome.message) } : outcome
    },
  }

  function apply(next: HostConfig): void {
    const previous = config
    config = next
    if (!router) return
    const parsed = parseRouterConfig(next.router)
    problems = parsed.problems
    router.configure(parsed.config)
    // A new key may be another account, and a payment problem may be solved: let the router try again.
    for (const [provider, entry] of Object.entries(next.providers)) {
      const before = previous?.providers[provider]
      if (before && before.keyRevision !== entry.keyRevision) router.keysChanged(provider)
    }
  }

  function statusOf(): ModelStatus {
    const now = Date.now()
    const status = router?.status()
    return {
      problems: problems.map((problem) => humanize(problemText(problem))),
      providers: Object.entries(config?.providers ?? {}).map(([provider, entry]) => {
        const catalog = status?.catalogs.find((candidate) => candidate.provider === provider)
        const block = status?.blocks.filter((candidate) => (candidate.scope === `provider:${provider}` || candidate.scope === `paid:${provider}`) && candidate.until > now).sort((a, b) => b.until - a.until)[0]
        const tier = status?.freeTiers.find((candidate) => candidate.provider === provider)
        return {
          profileId: entry.profile,
          name: entry.name,
          ...(catalog?.fetchedAt !== undefined ? { models: catalog.models, free: catalog.free } : {}),
          ...(catalog?.error ? { catalogError: humanize(catalog.error) } : {}),
          ...(block ? { blocked: { message: humanize(block.reason), until: block.until } } : {}),
          ...(tier?.daily ? { freeLeft: tier.daily.remaining } : {}),
        }
      }),
    }
  }

  peer.handle('init', async (init: HostInit) => {
    if (host) throw new RpcError('invalid-state', 'The agent host is already set up.')
    config = init.config
    stateFile = init.routerStateFile
    router = makeRouter(init.config)
    loadState()
    if (stateFile) {
      stateTimer = setInterval(saveState, options.stateIntervalMs ?? 30_000)
      stateTimer.unref?.()
    }
    // The sandbox around the agent's commands: found out once, here, so that the first session already knows whether it has one.
    sandbox = init.sandboxDir ? new Sandbox({ dir: init.sandboxDir, home: init.home, warn: (message) => peer.notify('warn', message) }) : undefined
    sandboxListener = sandbox?.onChange(() => {
      try {
        peer.notify('sandbox', { working: sandbox?.working() ?? null })
      } catch (error) {
        log(`could not pass on a change of the sandbox: ${describe(error)}`)
      }
    })
    void sandbox?.start()
    // The settings, trust and permission rules of each folder a session works in; the Permissions screen reads the same pictures.
    workspaces = new Workspaces({
      home: init.home,
      ...(sandbox ? { sandbox } : {}),
      warn: (message) => peer.notify('warn', message),
      onMcpChange: (root) => {
        try {
          peer.notify('mcp', { root })
        } catch (error) {
          log(`could not pass on a change of MCP servers: ${describe(error)}`)
        }
      },
      ...(init.checkpointsDir ? { checkpoints: { dir: init.checkpointsDir } } : {}),
      // Hooks are told where the conversation is written, as Claude Code's are.
      transcriptPath: (sessionId) => path.join(init.dir, `${sessionId}.jsonl`),
    })
    const created = new AgentHost({
      dir: init.dir,
      home: init.home,
      workspace: init.workspace,
      client,
      settings: () => agentSettings(config!),
      emit: (event) => peer.notify('event', event),
      onJobs: (jobs) => peer.notify('jobs', jobs),
      warn: (message) => peer.notify('warn', message),
      scope: workspaces.scope,
      web: createWebAccess({ searchProvider }),
      ...options.hostOptions,
    })
    if (init.legacySessionsFile) {
      try {
        await created.importLegacySessions(init.legacySessionsFile)
      } catch (error) {
        log(`could not import the earlier sessions: ${describe(error)}`)
      }
    }
    host = created
    serveHost(peer, created)
  })

  peer.handle('configure', (next: HostConfig) => apply(next))

  peer.handle('modelStatus', async () => {
    // The lists are read when a request needs them; the page asks for them so it has something to show.
    if (router) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([router.refresh().catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, STATUS_WAIT_MS)))])
      if (timer) clearTimeout(timer)
    }
    return statusOf()
  })

  peer.handle('modelCheck', async ({ profileId, model }): Promise<ModelCheckResult> => {
    const provider = Object.entries(config?.providers ?? {}).find(([, entry]) => entry.profile === profileId)?.[0]
    if (!router || !provider) return { ok: false, message: 'This connection is not set up yet.' }
    const result = await router.checkModel(`${provider}:${model}`)
    // A model that answers but cannot call a tool cannot drive the agent: that is a failed test, with its own words.
    const ok = result.ok && result.toolCall
    const message = result.ok && !result.toolCall ? 'The model answered, but it did not call the tool it was given, so it cannot drive the agent. Choose another model.' : result.message
    return { ok, message: humanize(message), ...(result.ttftMs !== undefined ? { ms: result.ttftMs } : {}) }
  })

  peer.handle('modelRecheck', async () => {
    if (!router) return
    for (const provider of Object.keys(config?.providers ?? {})) router.keysChanged(provider)
    await router.refresh({ force: true }).catch(() => undefined)
  })

  peer.handle('searchCheck', async (): Promise<SearchCheckResult> => {
    const provider = searchProvider()
    const name = searchProviderInfo(provider.id).name
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_CHECK_TIMEOUT_MS)
    try {
      const hits = await provider.search({ query: SEARCH_CHECK_QUERY, limit: 3, signal: controller.signal })
      const ms = Date.now() - started
      if (hits.length) return { ok: true, message: `${name} answered with ${hits.length} ${hits.length === 1 ? 'result' : 'results'}.`, ms }
      return { ok: false, message: `${name} answered, but found nothing for the test search. If this keeps happening, choose another search provider.`, ms }
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, message: `${name} did not answer within ${SEARCH_CHECK_TIMEOUT_MS / 1000} seconds.` }
      // The person is in Settings already: "add one in Settings" would send them where they are.
      if (error instanceof SearchError && error.kind === 'key' && /^There is no API key/.test(error.message)) return { ok: false, message: `There is no API key for ${name}. Paste one above, then press Test search.` }
      return { ok: false, message: describe(error) }
    } finally {
      clearTimeout(timer)
    }
  })

  peer.handle('permissionsReport', async ({ root }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.report(root)
  })

  peer.handle('permissionsAct', async ({ root, action }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.act(root, action)
  })

  peer.handle('mcpReport', async ({ root, start }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.mcpReport(root, start === false ? { start: false } : {})
  })

  peer.handle('mcpAct', async ({ root, action }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.mcpAct(root, action)
  })

  peer.handle('sandboxReport', async ({ root }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.sandboxReport(root)
  })

  peer.handle('sandboxAct', async ({ root, action }) => {
    if (!workspaces) throw new RpcError('invalid-state', 'The agent host is not set up yet.')
    return workspaces.sandboxAct(root, action)
  })

  peer.handle('draftCommit', async (input) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS)
    try {
      return { message: await draftCommitMessage(client, input, controller.signal) }
    } catch (error) {
      throw new RpcError('failed', controller.signal.aborted ? `No model wrote a message within ${DRAFT_TIMEOUT_MS / 1000} seconds. Write it yourself, or try again.` : describe(error))
    } finally {
      clearTimeout(timer)
    }
  })

  peer.handle('codeReview', async (input) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS)
    try {
      return await reviewChanges(client, input, controller.signal)
    } catch (error) {
      throw new RpcError('failed', controller.signal.aborted ? `The Reviewer did not answer within ${REVIEW_TIMEOUT_MS / 60_000} minutes. Ask again, or about a smaller part of the change.` : describe(error))
    } finally {
      clearTimeout(timer)
    }
  })

  peer.handle('shutdown', async () => {
    const closing = host
    host = undefined
    sandboxListener?.()
    sandboxListener = undefined
    if (stateTimer) clearInterval(stateTimer)
    stateTimer = undefined
    // Both are quick for a program that is going away: the sessions stop their commands, the folders their MCP servers.
    await Promise.all([closing?.dispose(), workspaces?.close()])
    saveState()
    if (options.onShutdown) setImmediate(options.onShutdown)
  })

  return { peer, host: () => host, router: () => router }
}
