/**
 * The agent's way onto the web: fetches through safeFetch (public addresses
 * only, checked after DNS; redirects to another host handed back), pages
 * converted to readable text and cached for a quarter of an hour, and a web
 * search that needs no account.
 */
import type { FetchedPage, SearchHit, WebAccess } from '../types'
import { decodeEntities, htmlToText, pageTitle } from './html'
import { safeFetch, type FetchOptions } from './safe-fetch'

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
  /** The search page. Default: DuckDuckGo's HTML endpoint. */
  searchUrl?: string
  /** How long a fetched page is reused. Default 15 minutes. */
  cacheMs?: number
  now?: () => number
}

const CACHE_LIMIT = 50
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

function hostMatches(url: string, domains: readonly string[]): boolean {
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

  return {
    fetch: fetchPage,
    async search(query, searchOptions) {
      const endpoint = options.searchUrl ?? 'https://html.duckduckgo.com/html/'
      const outcome = await safeFetch(`${endpoint}?q=${encodeURIComponent(query)}`, { ...options.fetch, signal: searchOptions.signal })
      if (outcome.kind !== 'response') throw new WebError('failed', `The search service could not be reached (${outcome.kind === 'refused' ? outcome.reason : outcome.kind}).`)
      if (outcome.status !== 200) throw new WebError('failed', `The search service answered HTTP ${outcome.status}.`)
      let hits = parseSearchResults(outcome.text)
      if (searchOptions.allowedDomains?.length) hits = hits.filter((hit) => hostMatches(hit.url, searchOptions.allowedDomains!))
      if (searchOptions.blockedDomains?.length) hits = hits.filter((hit) => !hostMatches(hit.url, searchOptions.blockedDomains!))
      return hits.slice(0, 10)
    },
  }
}
