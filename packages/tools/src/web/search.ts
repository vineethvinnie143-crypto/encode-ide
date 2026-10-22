/**
 * Web search providers. DuckDuckGo's HTML page needs no account; Brave Search, Tavily and Exa answer a keyed API
 * with results made for programs. Every provider hands back the same short hits, so what the model reads (and what it
 * costs in tokens) does not depend on who answered.
 *
 * Every request goes through safeFetch (public addresses only, checked after DNS). A request that carries a key
 * follows no redirect, so the key goes to the provider's address and nowhere else.
 */
import type { SearchHit } from '../types'
import { decodeEntities, htmlToText } from './html'
import { safeFetch, type FetchOptions } from './safe-fetch'

export type SearchProviderId = 'duckduckgo' | 'brave' | 'tavily' | 'exa'

export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = ['duckduckgo', 'brave', 'tavily', 'exa']

/** Where each provider's search goes. The app's Settings screen shows the same addresses (shared/search.ts). */
export const SEARCH_ENDPOINTS: Record<SearchProviderId, string> = {
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

  constructor(kind: SearchErrorKind, message: string) {
    super(message)
    this.name = 'SearchError'
    this.kind = kind
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

/**
 * Text from a field of an API answer: the markup some of them leave in (highlighting, links) taken out, entities
 * decoded, in one line, cut to length. Angle brackets that are not markup, as in "Array<T>", stay.
 */
export function plainSnippet(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = decodeEntities(value.replace(BLOCK_TAG, ' ').replace(INLINE_TAG, ''))
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

/** DuckDuckGo's HTML page: no account, no key, and results that are less stable than an API's. */
export function duckDuckGoProvider(options: ProviderOptions = {}): SearchProvider {
  const endpoint = options.endpoint ?? SEARCH_ENDPOINTS.duckduckgo
  return {
    id: 'duckduckgo',
    endpoint,
    async search(request) {
      const outcome = await safeFetch(`${endpoint}?q=${encodeURIComponent(clipQuery(request.query))}`, { ...options.fetch, signal: request.signal })
      if (outcome.kind !== 'response') throw new SearchError('failed', `The search service could not be reached (${outcome.kind === 'refused' ? outcome.reason : outcome.kind}).`)
      // DuckDuckGo answers 202 or 429 to a program it has decided to slow down.
      if (outcome.status === 202 || outcome.status === 429) {
        throw new SearchError('limit', `DuckDuckGo is limiting searches from this computer for now (HTTP ${outcome.status}). Try again later, or choose a search provider with a key in Settings.`)
      }
      if (outcome.status >= 500) throw new SearchError('unavailable', `DuckDuckGo is not available right now (HTTP ${outcome.status}).`)
      if (outcome.status !== 200) throw new SearchError('failed', `The search service answered HTTP ${outcome.status}.`)
      return toHits(parseSearchResults(outcome.text), request)
    },
  }
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
    default:
      return duckDuckGoProvider(options)
  }
}
