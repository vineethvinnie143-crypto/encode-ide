/**
 * Web search providers. Parallel's search for AI agents and DuckDuckGo's HTML page need no account; Brave Search,
 * Tavily and Exa answer a keyed API with results made for programs. Every provider hands back the same short hits, so
 * what the model reads (and what it costs in tokens) does not depend on who answered.
 *
 * Every request goes through safeFetch (public addresses only, checked after DNS). A request that carries a key or a
 * body follows no redirect, so what it carries goes to the provider's address and nowhere else.
 */
import { randomUUID } from 'node:crypto'
import type { SearchHit } from '../types'
import { decodeEntities, htmlToText } from './html'
import { safeFetch, type FetchOptions, type FetchOutcome } from './safe-fetch'

export type SearchProviderId = 'parallel' | 'duckduckgo' | 'brave' | 'tavily' | 'exa'

export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = ['parallel', 'duckduckgo', 'brave', 'tavily', 'exa']

/** Where each provider's search goes. The app's Settings screen shows the same addresses (shared/search.ts). */
export const SEARCH_ENDPOINTS: Record<SearchProviderId, string> = {
  parallel: 'https://search.parallel.ai/mcp',
  duckduckgo: 'https://html.duckduckgo.com/html/',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  exa: 'https://api.exa.ai/search',
}

export interface SearchRequest {
  query: string
  allowedDomains?: readonly string[]
  blockedDomains?: readonly string[]
  /** How many results the model should get at most. */
  limit: number
  signal: AbortSignal
}

export interface SearchProvider {
  readonly id: SearchProviderId
  /** Where a query is sent, which is what an approval names. */
  readonly endpoint: string
  search(request: SearchRequest): Promise<SearchHit[]>
}

/** What went wrong, in terms the person can act on: a key that was refused, a limit that was reached, a service that is down. */
export type SearchErrorKind = 'key' | 'limit' | 'unavailable' | 'failed'

export class SearchError extends Error {
  readonly kind: SearchErrorKind
  /**
   * A provider that needs no key could not search from this computer (it limits or blocks searches, or is down), so
   * a key of the person's own would help: the app offers to add a free Tavily key.
   */
  readonly keyHelps: boolean

  constructor(kind: SearchErrorKind, message: string, keyHelps = false) {
    super(message)
    this.name = 'SearchError'
    this.kind = kind
    this.keyHelps = keyHelps
  }
}

/** The API key, read when a search is made so that a key changed in Settings applies at once. Empty means none. */
export type KeySource = () => string | Promise<string>

export interface ProviderOptions {
  /** Network settings for safeFetch; tests widen the address check. */
  fetch?: Omit<FetchOptions, 'signal' | 'method' | 'headers' | 'body'>
  /** The provider's address; tests point it at a local server. */
  endpoint?: string
}

/** What a search costs the model: this many hits, each this long. */
const SNIPPET_CHARS = 400
const TITLE_CHARS = 200
const QUERY_CHARS = 400
const API_TIMEOUT_MS = 20_000
const API_MAX_BYTES = 1_000_000
const MAX_DOMAINS = 20

// ---- hits ------------------------------------------------------------------------------------------------------------

const BLOCK_TAG = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td)\b[^>]*>/gi
const INLINE_TAG = /<\/?(?:b|i|u|em|strong|span|mark|a|code|small|sup|sub)\b[^>]*>/gi
/** Characters that change how text reads without being seen: zero-width ones and direction controls. */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/**
 * Text from a field of an API answer: the markup some of them leave in (highlighting, links) taken out, entities
 * decoded, characters that cannot be seen dropped, in one line, cut to length. Angle brackets that are not markup, as
 * in "Array<T>", stay.
 */
export function plainSnippet(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = decodeEntities(value.replace(BLOCK_TAG, ' ').replace(INLINE_TAG, ''))
    .replace(HIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A host name from what the model passed as a domain: "example.com", "https://www.example.com/docs", "*.example.com". */
export function domainOf(entry: string): string {
  const raw = entry.trim().toLowerCase()
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw.replace(/^\*?\./, '')}`
  try {
    return new URL(withScheme).hostname.replace(/^\*?\./, '')
  } catch {
    return ''
  }
}

function domainList(entries: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const entry of entries ?? []) {
    const domain = domainOf(entry)
    if (domain) seen.add(domain)
  }
  return [...seen].slice(0, MAX_DOMAINS)
}

export function hostMatches(url: string, domains: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some((domain) => {
    const d = domain.toLowerCase().replace(/^\*?\./, '')
    return host === d || host.endsWith(`.${d}`)
  })
}

interface RawHit {
  title?: unknown
  url?: unknown
  snippet?: unknown
}

/**
 * The hits of a provider's answer: web addresses only, no duplicates, markup and entities out of the words, each part
 * cut to length, and the person's domain filters applied whatever the provider did with them.
 */
export function toHits(raw: readonly RawHit[], request: Pick<SearchRequest, 'allowedDomains' | 'blockedDomains' | 'limit'>): SearchHit[] {
  const allowed = domainList(request.allowedDomains)
  const blocked = domainList(request.blockedDomains)
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const item of raw) {
    if (typeof item.url !== 'string') continue
    let url: URL
    try {
      url = new URL(item.url.trim())
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (allowed.length && !hostMatches(url.href, allowed)) continue
    if (blocked.length && hostMatches(url.href, blocked)) continue
    const key = `${url.host}${url.pathname.replace(/\/$/, '')}${url.search}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ title: plainSnippet(item.title, TITLE_CHARS) || url.hostname, url: url.href, snippet: plainSnippet(item.snippet, SNIPPET_CHARS) })
    if (hits.length >= request.limit) break
  }
  return hits
}

function clipQuery(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim()
  if (flat.length <= QUERY_CHARS) return flat
  const cut = flat.slice(0, QUERY_CHARS)
  const space = cut.lastIndexOf(' ')
  return space > QUERY_CHARS / 2 ? cut.slice(0, space) : cut
}

// ---- the keyed APIs --------------------------------------------------------------------------------------------------

interface ApiCall {
  name: string
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  /** The key the call carries: if an error message echoes it back, it is taken out before anyone reads the message. */
  secret: string
}

function errorDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  for (const field of ['detail', 'error', 'message']) {
    const inner = record[field]
    const text = errorDetail(inner)
    if (text) return text
  }
  return ''
}

async function callApi(call: ApiCall, options: ProviderOptions, signal: AbortSignal): Promise<unknown> {
  const outcome = await safeFetch(call.url, {
    timeoutMs: API_TIMEOUT_MS,
    maxBytes: API_MAX_BYTES,
    ...options.fetch,
    signal,
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  })
  switch (outcome.kind) {
    case 'refused':
      throw new SearchError('failed', `${call.name} could not be reached (${outcome.reason}).`)
    case 'redirect':
      throw new SearchError('failed', `${call.name} answered with a redirect to ${outcome.location}, which is not followed.`)
    case 'binary':
      throw new SearchError('failed', `${call.name} answered with something that is not text (${outcome.contentType || 'unknown type'}).`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(outcome.text)
  } catch {
    parsed = undefined
  }
  const status = outcome.status
  if (status >= 200 && status < 300) {
    if (parsed === undefined) throw new SearchError('failed', `${call.name} answered with something that is not JSON.`)
    return parsed
  }
  // A provider's own words can quote the key it refused. The message goes to the person and to the model, so the key
  // is taken out before the words are cut to length.
  const detail = plainSnippet(errorDetail(parsed).split(call.secret).join('[the key]'), 160)
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401 || status === 403) throw new SearchError('key', `${call.name} refused the API key (HTTP ${status}${suffix}). Check it in Settings.`)
  if (status === 402 || status === 429 || status === 432 || status === 433) {
    throw new SearchError('limit', `${call.name} says this key has reached its limit or its credit (HTTP ${status}${suffix}). Try again later or choose another search provider in Settings.`)
  }
  if (status >= 500) throw new SearchError('unavailable', `${call.name} is not available right now (HTTP ${status}).`)
  throw new SearchError('failed', `${call.name} refused the search (HTTP ${status}${suffix}).`)
}

async function readKey(source: KeySource, name: string): Promise<string> {
  const key = (await source()).trim()
  if (!key) throw new SearchError('key', `There is no API key for ${name}. Add one in Settings, or choose another search provider.`)
  return key
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
}

function inner(value: unknown, ...path: string[]): unknown {
  let at: unknown = value
  for (const step of path) {
    if (typeof at !== 'object' || at === null) return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at
}

/** Brave Search: a GET with the key in X-Subscription-Token. Domain filters are search operators, then applied again. */
export function braveProvider(key: KeySource, options: ProviderOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.brave
  return {
    id: 'brave',
    endpoint,
    async search(request) {
      const secret = await readKey(key, 'Brave Search')
      const allowed = domainList(request.allowedDomains)
      const blocked = domainList(request.blockedDomains)
      // One allowed domain is an operator; several are filtered from a longer page of results.
      const operators = [...(allowed.length === 1 ? [`site:${allowed[0]}`] : []), ...blocked.slice(0, 5).map((domain) => `-site:${domain}`)]
      const count = allowed.length > 1 || blocked.length > 0 ? Math.min(20, request.limit * 2) : request.limit
      const query = new URLSearchParams({ q: clipQuery([...operators, request.query].join(' ')), count: String(count), text_decorations: 'false' })
      const answer = await callApi(
        { name: 'Brave Search', url: `${endpoint}?${query}`, method: 'GET', headers: { 'x-subscription-token': secret, accept: 'application/json' }, secret },
        options,
        request.signal,
      )
      return toHits(
        records(inner(answer, 'web', 'results')).map((item) => ({ title: item.title, url: item.url, snippet: item.description })),
        request,
      )
    },
  }
}

/** Tavily: a POST with the key as a bearer token; it filters domains itself. */
export function tavilyProvider(key: KeySource, options: ProviderOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.tavily
  return {
    id: 'tavily',
    endpoint,
    async search(request) {
      const secret = await readKey(key, 'Tavily')
      const allowed = domainList(request.allowedDomains)
      const blocked = domainList(request.blockedDomains)
      const body = JSON.stringify({
        query: clipQuery(request.query),
        search_depth: 'basic',
        max_results: Math.min(20, request.limit),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        ...(allowed.length ? { include_domains: allowed } : {}),
        ...(blocked.length ? { exclude_domains: blocked } : {}),
      })
      const answer = await callApi(
        { name: 'Tavily', url: endpoint, method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' }, body, secret },
        options,
        request.signal,
      )
      return toHits(
        records(inner(answer, 'results')).map((item) => ({ title: item.title, url: item.url, snippet: item.content })),
        request,
      )
    },
  }
}

/** Exa: a POST with the key in x-api-key; the snippet is the highlights it finds for the query, a few hundred characters. */
export function exaProvider(key: KeySource, options: ProviderOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.exa
  return {
    id: 'exa',
    endpoint,
    async search(request) {
      const secret = await readKey(key, 'Exa')
      const allowed = domainList(request.allowedDomains)
      const blocked = domainList(request.blockedDomains)
      const body = JSON.stringify({
        query: clipQuery(request.query),
        type: 'auto',
        numResults: Math.min(25, request.limit),
        ...(allowed.length ? { includeDomains: allowed } : {}),
        ...(blocked.length ? { excludeDomains: blocked } : {}),
        contents: { highlights: { maxCharacters: SNIPPET_CHARS } },
      })
      const answer = await callApi(
        { name: 'Exa', url: endpoint, method: 'POST', headers: { 'x-api-key': secret, 'content-type': 'application/json', accept: 'application/json' }, body, secret },
        options,
        request.signal,
      )
      return toHits(
        records(inner(answer, 'results')).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: Array.isArray(item.highlights) && item.highlights.length ? item.highlights.filter((part) => typeof part === 'string').join(' … ') : (item.text ?? item.summary),
        })),
        request,
      )
    },
  }
}

// ---- DuckDuckGo ------------------------------------------------------------------------------------------------------

/** The real address behind a DuckDuckGo result link. */
function resultUrl(href: string): string {
  const decoded = decodeEntities(href)
  const match = /[?&]uddg=([^&]+)/.exec(decoded)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return decoded
    }
  }
  return decoded.startsWith('//') ? `https:${decoded}` : decoded
}

export function parseSearchResults(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const block of blocks) {
    const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const snippet = /<(?:a|div|td)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(block)
    const title = htmlToText(link[2]).replace(/\s+/g, ' ').trim()
    const url = resultUrl(link[1])
    if (!title || !/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    hits.push({ title, url, snippet: snippet ? htmlToText(snippet[1]).replace(/\s+/g, ' ').trim() : '' })
  }
  return hits
}

export interface DuckDuckGoOptions extends ProviderOptions {
  /** The least time between two searches. Default 1.5 s. */
  gapMs?: number
  /** How long to wait before the one retry of a search DuckDuckGo slowed down. Default 4 s. */
  retryMs?: number
  /** How long searches fail without asking after DuckDuckGo showed its puzzle. Default 10 minutes. */
  blockedMs?: number
  now?: () => number
}

/** What a page DuckDuckGo shows instead of results has, when it wants to know whether a person is asking. */
const CHALLENGE = /anomaly-modal|challenge-form|bots use DuckDuckGo/i

/** Where the person can make search work again, said at the end of a provider's error. */
const SETTINGS = 'Settings > Agent > Web search'

const PUZZLE = `DuckDuckGo is blocking searches from this computer: it answers every one with a picture puzzle to prove a person is searching, which eNCode cannot solve. Choose Parallel (free, no key) or add a free Tavily key in ${SETTINGS}.`

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const stop = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * DuckDuckGo's HTML page: no account, no key, and results that are less stable than an API's.
 *
 * It slows down a burst of searches from one computer (a model that searches for three things at once) with HTTP 202,
 * so searches go one at a time, a moment apart, and one that was slowed down is asked again once, after a wait. From
 * some computers it answers every search, the first included, with a picture puzzle for a person to solve. Asking
 * again does not help there, so that is said at once, and for a while searches fail without asking.
 */
export function duckDuckGoProvider(options: DuckDuckGoOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.duckduckgo
  const gapMs = options.gapMs ?? 1_500
  const retryMs = options.retryMs ?? 4_000
  const blockedMs = options.blockedMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  let queue: Promise<unknown> = Promise.resolve()
  let last = 0
  let blockedUntil = 0

  const ask = (request: SearchRequest) => safeFetch(`${endpoint}?q=${encodeURIComponent(clipQuery(request.query))}`, { ...options.fetch, signal: request.signal })
  type Outcome = Awaited<ReturnType<typeof ask>>
  // The puzzle comes with HTTP 202 (or 200); a page with results that mentions it is still results.
  const puzzle = (outcome: Outcome) => outcome.kind === 'response' && !/result__a/.test(outcome.text) && CHALLENGE.test(outcome.text)
  const slowed = (outcome: Outcome) => outcome.kind === 'response' && (outcome.status === 202 || outcome.status === 429)

  async function searchNow(request: SearchRequest): Promise<SearchHit[]> {
    if (now() < blockedUntil) throw new SearchError('limit', PUZZLE, true)
    const wait = last + gapMs - now()
    if (wait > 0) await pause(wait, request.signal)
    try {
      let outcome = await ask(request)
      if (slowed(outcome) && !puzzle(outcome)) {
        await pause(retryMs, request.signal)
        outcome = await ask(request)
      }
      if (outcome.kind !== 'response') throw new SearchError('failed', `The search service could not be reached (${outcome.kind === 'refused' ? outcome.reason : outcome.kind}).`)
      if (puzzle(outcome)) {
        blockedUntil = now() + blockedMs
        throw new SearchError('limit', PUZZLE, true)
      }
      if (slowed(outcome)) {
        throw new SearchError('limit', `DuckDuckGo is limiting searches from this computer for now (HTTP ${outcome.status}). Try again in a few minutes, or choose Parallel (free, no key) or add a free Tavily key in ${SETTINGS}.`, true)
      }
      if (outcome.status >= 500) throw new SearchError('unavailable', `DuckDuckGo is not available right now (HTTP ${outcome.status}).`, true)
      if (outcome.status !== 200) throw new SearchError('failed', `The search service answered HTTP ${outcome.status}.`)
      return toHits(parseSearchResults(outcome.text), request)
    } finally {
      last = now()
    }
  }

  return {
    id: 'duckduckgo',
    endpoint,
    search(request) {
      const result = queue.then(() => searchNow(request))
      queue = result.catch(() => undefined)
      return result
    },
  }
}

// ---- Parallel --------------------------------------------------------------------------------------------------------

export interface ParallelOptions extends ProviderOptions {
  /**
   * What Parallel's free use counts searches by, sent with every search for as long as the provider lives. Default a
   * random value: it says nothing about the person or the computer.
   */
  sessionId?: string
}

/** The MCP version eNCode speaks to Parallel, which is the one its server answers with. */
const MCP_VERSION = '2025-06-18'
const PARALLEL = "Parallel's free search"
const MAX_SITES = 3

interface RpcMessage {
  id?: unknown
  result?: unknown
  error?: unknown
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The JSON-RPC message with this id, from a body of JSON or from an event stream, which a server may answer with. */
function rpcMessage(outcome: Extract<FetchOutcome, { kind: 'response' }>, id: number): RpcMessage | undefined {
  const messages: unknown[] = []
  if (/text\/event-stream/i.test(outcome.contentType)) {
    for (const event of outcome.text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) messages.push(parsed(data))
    }
  } else messages.push(parsed(outcome.text))
  return records(messages.flat()).find((message) => message.id === id)
}

/**
 * Parallel's excerpts as plain words: markdown links keep their words, heading, quote and list marks go, and the
 * piece of a word an excerpt can begin with ("ion\n\nDDoS Protection…") goes too.
 */
export function excerptText(value: unknown): string {
  const parts = Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : []
  return parts
    .map((part) =>
      part
        .replace(/^[a-z][\w'\u2019-]*(?=\r?\n)/, '')
        .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/^[ \t]*(?:#{1,6}|>|[*+-]|\d+[.)])(?=[ \t]|$)/gm, '')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1'),
    )
    .join(' … ')
}

/**
 * What a search asks Parallel: the query as the objective and as the keywords, which may not hold quoted phrases. A
 * few allowed domains become one `site:` query each, and the filters are applied again to what comes back.
 */
export function parallelArguments(request: Pick<SearchRequest, 'query' | 'allowedDomains'>, sessionId: string): Record<string, unknown> {
  const objective = clipQuery(request.query)
  const words = objective.replace(/"/g, ' ').replace(/\s+/g, ' ').trim() || objective
  const allowed = domainList(request.allowedDomains)
  const queries = allowed.length && allowed.length <= MAX_SITES ? allowed.map((domain) => `site:${domain} ${words}`) : [words]
  return { objective, search_queries: queries, session_id: sessionId }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

function textParts(content: unknown): string {
  return records(content)
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** A refusal in Parallel's own words that is about how many searches it takes, as opposed to what was asked. */
const LIMIT_WORDS = /rate.?limit|too many|quota|slow down|try again later/i

/**
 * Parallel's search for AI agents (search.parallel.ai), free with no account and no key, reached as the MCP server it
 * is: initialize once, then one `web_search` call per search. Its answers carry a few relevant passages of each page.
 *
 * Parallel limits free use by the `session_id` each search names, and does not publish the limits. A limit reached,
 * a refusal or a service that is down is said plainly, with a free Tavily key as the way to keep searching.
 */
export function parallelProvider(options: ParallelOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.parallel
  const sessionId = options.sessionId ?? randomUUID()
  let nextId = 1
  /** The MCP session the server gave (an empty string when it gives none), shared by the searches made at once. */
  let session: Promise<string> | undefined

  const advice = `add a free Tavily key in ${SETTINGS}`

  async function post(message: Record<string, unknown>, mcpSession: string | undefined, signal?: AbortSignal): Promise<Extract<FetchOutcome, { kind: 'response' }>> {
    const outcome = await safeFetch(endpoint, {
      timeoutMs: API_TIMEOUT_MS,
      maxBytes: API_MAX_BYTES,
      ...options.fetch,
      ...(signal ? { signal } : {}),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(mcpSession === undefined ? {} : { 'mcp-protocol-version': MCP_VERSION }),
        ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    })
    switch (outcome.kind) {
      case 'refused':
        throw new SearchError('failed', `${PARALLEL} could not be reached (${outcome.reason}).`)
      case 'redirect':
        throw new SearchError('failed', `${PARALLEL} answered with a redirect to ${outcome.location}, which is not followed. Try again later, or ${advice}.`, true)
      case 'binary':
        throw new SearchError('failed', `${PARALLEL} answered with something that is not text (${outcome.contentType || 'unknown type'}). Try again later, or ${advice}.`, true)
    }
    return outcome
  }

  function statusError(status: number): SearchError {
    if (status === 429) return new SearchError('limit', `${PARALLEL} is limiting searches from this computer for now (HTTP 429). Try again in a few minutes, or ${advice}.`, true)
    if (status === 401 || status === 403) return new SearchError('limit', `${PARALLEL} refused searches from this computer (HTTP ${status}). Try again later, or ${advice}.`, true)
    if (status >= 500) return new SearchError('unavailable', `${PARALLEL} is not available right now (HTTP ${status}). Try again later, or ${advice}.`, true)
    return new SearchError('failed', `${PARALLEL} refused the search (HTTP ${status}). Try again later, or ${advice}.`, true)
  }

  /** Parallel's own words about a search it would not make, as one sentence. */
  function refusal(words: string): SearchError {
    const detail = plainSnippet(words, 160).replace(/[.!]?$/, '.')
    if (LIMIT_WORDS.test(detail)) return new SearchError('limit', `${PARALLEL} is limiting searches from this computer for now: ${detail} Try again in a few minutes, or ${advice}.`, true)
    return new SearchError('failed', `${PARALLEL} could not search${detail === '.' ? '.' : `: ${detail}`} Try again later, or ${advice}.`, true)
  }

  function rpcError(error: unknown): SearchError {
    const words = typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string' ? ((error as Record<string, unknown>).message as string) : ''
    return refusal(words)
  }

  /** Opens the MCP session. It is not tied to the search that asked first, so stopping that search leaves it to the others. */
  async function open(): Promise<string> {
    const id = nextId++
    const reply = await post({ id, method: 'initialize', params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'eNCode', version: '0.1.0' } } }, undefined)
    if (reply.status !== 200) throw statusError(reply.status)
    const message = rpcMessage(reply, id)
    if (message?.error !== undefined) throw rpcError(message.error)
    if (message?.result === undefined) throw new SearchError('failed', `${PARALLEL} answered in a way eNCode does not understand. Try again later, or ${advice}.`, true)
    const mcpSession = reply.headers['mcp-session-id'] ?? ''
    // The server answers this with 202 and nothing else; a refusal here shows on the search that follows.
    await post({ method: 'notifications/initialized' }, mcpSession)
    return mcpSession
  }

  function opened(): Promise<string> {
    if (!session) {
      const opening = open()
      session = opening
      opening.catch(() => {
        if (session === opening) session = undefined
      })
    }
    return session
  }

  async function search(request: SearchRequest, again = false): Promise<SearchHit[]> {
    const current = opened()
    const mcpSession = await untilAborted(current, request.signal)
    const id = nextId++
    const reply = await post({ id, method: 'tools/call', params: { name: 'web_search', arguments: parallelArguments(request, sessionId) } }, mcpSession, request.signal)
    // A session the server no longer knows (it restarted, or ends sessions after a while) is opened again, once.
    if (reply.status === 404 && mcpSession && !again) {
      if (session === current) session = undefined
      return search(request, true)
    }
    if (reply.status !== 200) throw statusError(reply.status)
    const message = rpcMessage(reply, id)
    if (!message) throw new SearchError('failed', `${PARALLEL} answered in a way eNCode does not understand. Try again later, or ${advice}.`, true)
    if (message.error !== undefined) throw rpcError(message.error)
    const result = typeof message.result === 'object' && message.result !== null ? (message.result as Record<string, unknown>) : {}
    if (result.isError === true) throw refusal(textParts(result.content))
    // The results come as structured content and, for clients that read only text, as the same JSON in the text.
    const found = inner(result, 'structuredContent', 'results') ?? inner(parsed(textParts(result.content)), 'results')
    if (!Array.isArray(found)) throw new SearchError('failed', `${PARALLEL} answered without results eNCode can read. Try again later, or ${advice}.`, true)
    return toHits(
      records(found).map((item) => ({ title: item.title, url: item.url, snippet: excerptText(item.excerpts) })),
      request,
    )
  }

  return { id: 'parallel', endpoint, search: (request) => search(request) }
}

/** The provider for an id; keyed ones read their key from `key` when a search is made. */
export function createSearchProvider(id: SearchProviderId, key: KeySource, options: ProviderOptions = {}): SearchProvider {
  switch (id) {
    case 'brave':
      return braveProvider(key, options)
    case 'tavily':
      return tavilyProvider(key, options)
    case 'exa':
      return exaProvider(key, options)
    case 'duckduckgo':
      return duckDuckGoProvider(options)
    default:
      return parallelProvider(options)
  }
}
