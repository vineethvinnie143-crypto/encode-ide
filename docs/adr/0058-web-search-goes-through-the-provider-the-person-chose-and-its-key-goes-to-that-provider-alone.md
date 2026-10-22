# 0058. Web search goes through the provider the person chose, and its key goes to that provider alone

- Status: Accepted
- Date: 2026-10-22

## Context

`WebSearch` read DuckDuckGo's HTML page, the one provider that needs no account. That page is made for people: it
answers a program it has decided to slow down with HTTP 202 or an empty page, and its markup is not a contract. A
person who wants the agent to search reliably brings a key for Brave Search, Tavily or Exa, and a key brings its own
ways to go wrong:

- **A key must go to its provider and nowhere else.** A model key is bound to the server its profile points at (0052)
  because that address is a setting. A search provider's address is not a setting at all, but a request that carries
  a key must still not be able to end up elsewhere, and a redirect is how it would.
- **The agent host is not where keys rest.** It is the process that handles web pages and tool output. It may hold a
  key for the length of one request and no longer.
- **Searches leave the machine in the words of a query.** Whatever the model puts in the query reaches the provider,
  and a page it read can make it put anything there (T2). Moving a search to another provider without saying so would
  send those words to a service nobody chose for them.
- **Providers answer differently, and results cost tokens.** Brave returns descriptions with markup, Tavily passages,
  Exa highlights, DuckDuckGo a page; every result is read again with every later request of the turn.
- **A failure has to be something the person can act on.** "HTTP 401" tells nothing to someone who pasted a key into
  the wrong field.

## Decision

- **Four providers, fixed in the code.** DuckDuckGo (no key), Brave Search, Tavily and Exa (a key each). Their
  addresses are in `@encode/tools` (`SEARCH_ENDPOINTS`); the app's list of names, hosts and where to get a key is
  `shared/search.ts`, and a test keeps the two in step. There is no setting for an address: a test can point a
  provider at a server of its own through an option, a person cannot.
- **One setting, `searchProvider`, DuckDuckGo until changed.** The host reads it at every search, so a change applies
  to the next search with no restart. A provider that needs a key and has none fails with "There is no API key for
  Brave Search. Add one in Settings, or choose another search provider." and sends nothing. No search moves to another
  provider on its own, whatever happens.
- **Keys rest as model keys do.** A key is sealed by the operating system's keychain under the name `search:<provider>`
  in the key vault (0008), held in memory only when there is no keychain, written nowhere in the clear, and listed among
  the secrets a log and a diagnostics report are scrubbed of. The page learns only which providers have a key, and sets
  or removes one with `settings.setSearchKey`. A key is one line of printable characters, at most 4096.
- **The host asks for the key at every search.** The configuration the host is given names the provider and carries
  nothing of a key. For a provider that needs one the host asks the main process, in a request of its own that names
  only the provider (a schema allows Brave, Tavily and Exa and nothing else), and holds the key for the length of the
  request.
- **A request that carries a key follows no redirect.** Keyed calls go through `safeFetch` (public addresses only,
  checked after DNS, 20 seconds, 1 MB) with the key in the header the provider asks for (`x-subscription-token`, a bearer
  token, `x-api-key`). `safeFetch` follows a same-host redirect only for a plain GET with no headers of the caller's; any
  other request that is redirected comes back as a refusal that names the redirect, so a key never travels to an address
  the provider's own did not name.
- **Every provider answers the same way.** At most eight hits, each a title (200 characters), an address (http or https
  only, no repeats) and a snippet (400). Markup a provider leaves in the words is taken out (HTML tags only, so
  `Array<T>` stays) and entities are decoded; a query is cut to 400 characters at a word. The model's allowed and
  blocked domains go to the provider that understands them and are applied again to what comes back, so they hold
  whatever the provider did with them. What the tool hands the model is wrapped as untrusted web content (0032).
- **Failures say what to do.** An answer is sorted into key (401, 403), limit (402, 429 and the like), unavailable (5xx)
  and failed. The message names the provider and, where it helps, Settings. A key never appears in a message.
- **The approval names the provider.** A search asks before its first contact with the provider's host in a session,
  like any fetch (0007), and the card says which host ("Approving allows api.search.brave.com until the session
  ends"). Choosing another provider asks again for the new host.
- **Settings → Agent → Web search.** The providers as a list, the key field of the one chosen with a link to where to
  get a key, *Test search* and *Remove the stored key*. The test saves what was changed, then makes one search through
  the code the agent uses with the key as it is stored. An answer with no result counts as not working, since that is
  what a slowed DuckDuckGo looks like. A diagnostics report names the provider and whether its key is stored.

## Consequences

- A person can have steady search with a key of their own, and DuckDuckGo stays a zero-setup default that can fail when
  it limits the computer.
- A key is in the main process and, for the length of one search, in the host. A compromised host could ask for a key
  again and send it anywhere it can reach. What the key opens is searches on the person's account with that provider and
  nothing else, and the same host already holds model keys for as long (0052).
- The words searched for go to the provider chosen. The card in Settings says so, and Full access skips the question
  before the first search (R1).
- The test costs one request each time it is pressed, and the providers meter by request.
- A provider whose answer changes shape needs only its own function changed; a result without a usable address is
  dropped rather than shown.
- Not covered: a provider of the person's own (a self-hosted SearXNG, say). It would need an address setting, and with
  it the same binding of a key to its origin that models have; it can follow when someone asks.
