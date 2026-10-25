/**
 * The agent's way onto the web: fetches through safeFetch (public addresses
 * only, checked after DNS; redirects to another host handed back), pages
 * converted to readable text and cached for a quarter of an hour, and a web
 * search through the provider the person chose (DuckDuckGo needs no account).
 */
import type { FetchedPage, WebAccess } from '../types'
import { htmlToText, pageTitle } from './html'
import { safeFetch, type FetchOptions } from './safe-fetch'
import { duckDuckGoProvider, type DuckDuckGoOptions, type SearchProvider } from './search'

export { parseSearchResults } from './search'

export type WebErrorKind = 'refused' | 'redirect' | 'binary' | 'failed'

export class WebError extends Error {
  readonly kind: WebErrorKind
  readonly location?: string

  constructor(kind: WebErrorKind, message: string, location?: string) {
    super(message)
    this.name = 'WebError'
    this.kind = kind
    if (location) this.location = location
  }
}

export interface WebAccessOptions {
  /** Network settings for safeFetch; tests widen the address check. */
  fetch?: Omit<FetchOptions, 'signal'>
  /** The search page of the default provider. Default: DuckDuckGo's HTML endpoint. */
  searchUrl?: string
  /** Who answers a search, asked on every search so that a change in Settings applies at once. Default DuckDuckGo. */
  searchProvider?: () => SearchProvider
  /** How the default DuckDuckGo provider spaces its searches; tests shorten the waits. */
  duckDuckGo?: Pick<DuckDuckGoOptions, 'gapMs' | 'retryMs'>
  /** How long a fetched page is reused. Default 15 minutes. */
  cacheMs?: number
  now?: () => number
}

const CACHE_LIMIT = 50
/** Results a search hands the model. Few, because each one costs tokens in every later request of the turn. */
export const SEARCH_RESULTS = 8
const IP_HOST = /^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/i

/** http becomes https, except for addresses that are only ever plain http. */
export function upgradeUrl(raw: string): string {
  const url = raw.trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' && !IP_HOST.test(parsed.hostname) && parsed.hostname !== 'localhost') {
      parsed.protocol = 'https:'
      return parsed.href
    }
    return parsed.href
  } catch {
    return url
  }
}

export function createWebAccess(options: WebAccessOptions = {}): WebAccess {
  const cacheMs = options.cacheMs ?? 15 * 60_000
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; page: FetchedPage }>()

  async function fetchPage(raw: string, signal: AbortSignal): Promise<FetchedPage> {
    const url = upgradeUrl(raw)
    const cached = cache.get(url)
    if (cached && now() - cached.at < cacheMs) return cached.page
    const outcome = await safeFetch(url, { ...options.fetch, signal })
    switch (outcome.kind) {
      case 'refused':
        throw new WebError('refused', outcome.reason)
      case 'redirect':
        throw new WebError('redirect', `${outcome.url} redirects (HTTP ${outcome.status}) to ${outcome.location}`, outcome.location)
      case 'binary':
        throw new WebError('binary', `${outcome.url} returned ${outcome.contentType || 'binary content'} (HTTP ${outcome.status}), which is not text`)
    }
    const html = /html/i.test(outcome.contentType) || /^\s*<(!doctype|html)/i.test(outcome.text)
    let text = outcome.text
    if (html) {
      const title = pageTitle(outcome.text)
      text = htmlToText(outcome.text, outcome.url)
      if (title && !text.startsWith(`# ${title}`)) text = `# ${title}\n\n${text}`
    }
    const page: FetchedPage = { url, finalUrl: outcome.url, status: outcome.status, contentType: outcome.contentType, text, truncated: outcome.truncated }
    if (outcome.status < 400) {
      cache.set(url, { at: now(), page })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    }
    return page
  }

  const fallback = duckDuckGoProvider({
    ...options.duckDuckGo,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.searchUrl ? { endpoint: options.searchUrl } : {}),
  })
  const provider = () => options.searchProvider?.() ?? fallback

  return {
    fetch: fetchPage,
    search: (query, searchOptions) =>
      provider().search({
        query,
        ...(searchOptions.allowedDomains ? { allowedDomains: searchOptions.allowedDomains } : {}),
        ...(searchOptions.blockedDomains ? { blockedDomains: searchOptions.blockedDomains } : {}),
        limit: SEARCH_RESULTS,
        signal: searchOptions.signal,
      }),
    searchTarget: () => provider().endpoint,
  }
}
