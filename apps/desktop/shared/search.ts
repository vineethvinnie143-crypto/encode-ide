/**
 * The web search providers as the app presents them: which ones exist, which need an account's key, and where a query
 * goes. The addresses themselves live in @encode/tools (SEARCH_ENDPOINTS); a test keeps the two in step. There is no
 * setting for an address, so a key can only ever go to the provider it was entered for.
 *
 * No runtime dependencies: the main process, the agent host and the renderer all read this.
 */

export type SearchProviderId = 'duckduckgo' | 'brave' | 'tavily' | 'exa'

export type KeyedSearchProviderId = Exclude<SearchProviderId, 'duckduckgo'>

export interface SearchProviderInfo {
  id: SearchProviderId
  name: string
  /** An API key from the provider's own account is needed. */
  needsKey: boolean
  /** The host a query is sent to, which is also the host an approval names. */
  host: string
  /** Where the person gets a key; the Settings screen links it. */
  keyUrl?: string
  /** One or two sentences for the Settings screen. */
  summary: string
}

export const DEFAULT_SEARCH_PROVIDER: SearchProviderId = 'duckduckgo'

export const SEARCH_PROVIDERS: readonly SearchProviderInfo[] = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    needsKey: false,
    host: 'html.duckduckgo.com',
    summary: 'No account and no key. It reads DuckDuckGo’s web page, so it can fail or come back empty when DuckDuckGo decides to slow searches from this computer.',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    needsKey: true,
    host: 'api.search.brave.com',
    keyUrl: 'https://brave.com/search/api/',
    summary: 'Brave’s own index through an API made for programs. Steady results; needs an API key.',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    needsKey: true,
    host: 'api.tavily.com',
    keyUrl: 'https://tavily.com/',
    summary: 'A search API made for AI agents, with short relevant passages. Needs an API key.',
  },
  {
    id: 'exa',
    name: 'Exa',
    needsKey: true,
    host: 'api.exa.ai',
    keyUrl: 'https://exa.ai/',
    summary: 'Finds pages by meaning and returns the passages that answer the query. Needs an API key.',
  },
]

export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = SEARCH_PROVIDERS.map((provider) => provider.id)

export const KEYED_SEARCH_PROVIDER_IDS: readonly KeyedSearchProviderId[] = SEARCH_PROVIDERS.filter((provider) => provider.needsKey).map((provider) => provider.id as KeyedSearchProviderId)

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return typeof value === 'string' && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value)
}

export function isKeyedSearchProvider(value: unknown): value is KeyedSearchProviderId {
  return typeof value === 'string' && (KEYED_SEARCH_PROVIDER_IDS as readonly string[]).includes(value)
}

export function searchProviderInfo(id: SearchProviderId): SearchProviderInfo {
  return SEARCH_PROVIDERS.find((provider) => provider.id === id) ?? SEARCH_PROVIDERS[0]
}

/** The result of a test search through the provider in use. */
export interface SearchCheckResult {
  ok: boolean
  message: string
  /** How long the answer took, ms. */
  ms?: number
}
