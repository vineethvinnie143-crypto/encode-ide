# 0123. Parallel answers searches for free, and a free Tavily key is offered when it cannot

- Status: Accepted, builds on 0058 and 0122
- Date: 2026-10-25

## Context

0122 found DuckDuckGo blocking the owner's computer: it answered every search, the first one included, with a picture
puzzle only a person can solve. So search did not work at all without a key, on the provider that was the default. The
owner asked for a permanent fix that costs nothing, and chose this one from four options.

What was checked on 2026-10-25:

- **Parallel** runs a free search service for AI agents at `search.parallel.ai/mcp`. It is an MCP server and needs no
  account and no key. Its `web_search` tool takes an objective, a few keyword queries and a `session_id`, which its free
  use is limited by. It returns about ten pages, each with a relevant passage. Its limits for free use are not
  published.
- **The check from the owner's computer.** eNCode's own requests (curl, no key) went to Parallel, from the computer
  DuckDuckGo blocks:
  - The server answered every request with plain JSON (never an event stream).
  - It gave an `Mcp-Session-Id` at initialize and spoke protocol version 2025-06-18.
  - Three searches within six seconds each answered in about 1.1 seconds, with no limit and no rate-limit headers.
  - The results came as structured content and, in the text, as the same JSON. Each passage is markdown, about 900
    characters. A passage can begin in the middle of a word and hold a zero-width space.
- **Free with a key:**
  - Tavily: 1,000 searches a month, no card.
  - Exa: about $10 of searches a month.
  - Brave Search: no longer free since February 2026; it needs a card.
  - Google's Custom Search: closed to new customers.
  - Bing's search API: retired in August 2025.

## Decision

- **Parallel is a search provider** (`parallel`), in eNCode's own code over safeFetch, like the others.
  - **Session.** It opens an MCP session once (initialize, then the initialized notice). Searches made at once share
    it. Stopping one search does not stop the session the others wait on. A session the server no longer knows (HTTP
    404) is opened again, once.
  - **What a search asks.** One `web_search` call:
    - The objective is the query.
    - The keyword query is the query without quotation marks, which its queries may not hold.
    - Up to three allowed domains become one `site:` query each.
    - The domain filters are applied again to what comes back, as for every provider.
  - **What it sends.** No key, no model name, nothing about the person or the computer. The `session_id` is a random
    value made when the provider is made, so one per run of the app.
  - **What comes back.** The answer is read as JSON or as an event stream, whichever the server sends. The results
    come from the structured content, or from the same JSON in the text.
  - **Passages become plain words.**
    - Markdown links keep their words.
    - Heading, quote and list marks go, and so does the piece of a word a passage can begin with.
    - The snippet is cut to the same 400 characters as every provider's, so a search costs the model the same whoever
      answers.
  - **Failures.**
    - HTTP 429, a refusal that speaks of a limit, and HTTP 401/403 are a `limit`.
    - HTTP 5xx is `unavailable`. Anything it cannot read is `failed`.
    - Each says what happened, and ends with: try again later, or add a free Tavily key in Settings > Agent > Web
      search.
- **Parallel is the default.**
  - A new install, the CLI and the agent host before its settings arrive all search with it.
  - Every settings file from before this holds DuckDuckGo, chosen or not. Such a file moves to Parallel once. A
    provider chosen in Settings since then is kept (`searchChosen`), DuckDuckGo included.
  - Settings lists Parallel first, then Tavily, Exa, Brave Search and DuckDuckGo. Parallel's summary says its free use
    has limits it does not publish, and links its terms.
- **Hidden characters leave every snippet.** Zero-width characters and direction controls are taken out of every
  provider's snippets, not only Parallel's. They change how text reads without being seen.
- **A free key is offered when a free search cannot be made.**
  - A provider without a key (Parallel or DuckDuckGo) marks the errors a key of the person's own would fix
    (`keyHelps`): a limit, a block, a service that is down, an answer it cannot read. A network that is down is not
    marked.
  - WebSearch passes the mark on to the step the app shows (`offer: 'search-key'`), through the agent loop.
  - The last request in the chat with such a step shows a card under it: "Web search did not work from this
    computer". It names the provider and offers **Add a free Tavily key** and **Not now**.
    - The card shows only while search still goes to a provider without a key.
    - **Not now** keeps it away until the app starts again.
  - **Add a free Tavily key** opens Settings > Agent > Web search with Tavily chosen and its key field ready.
- **A provider that needs a key is used once its key is saved.**
  - Choosing one that has no key yet chooses it on the screen only. The screen says searches go to the provider before
    it until the key is saved.
  - Saving the key (or Test search with one typed) stores the key and then uses the provider.
  - So choosing Tavily on the way to pasting its key does not stop the agent's searches meanwhile.
- **DuckDuckGo stays** as a choice, and its errors now point to Parallel or a free Tavily key. Its requests are as
  0122 left them.

## Consequences

- Search works without a key on a computer DuckDuckGo blocks, from the first start.
- The words of each search go to Parallel, which is said where the provider is chosen and on the first search's
  approval (`search.parallel.ai`). Parallel's terms and privacy policy apply to its free use.
- Parallel can limit or stop its free use at any time, and its limits are not published.
  - When it does, the person reads why, and the card takes them to a free Tavily key in two clicks.
  - The agent is told the same and is told not to guess addresses (0122).
  - Nothing switches provider without the person (0058).
- Parallel's own instructions (fetch only when excerpts are not enough) are not passed to the model. eNCode's WebSearch
  and WebFetch descriptions keep their budget, and the advice of 0122 already says to search first.
- One run of the app is one `session_id`, so all its chats share Parallel's free limit. It is not changed to get around
  a limit.
- Tests:
  - `search.test.ts` runs Parallel against a fake MCP server, and checks:
    - one session, its headers, and the arguments of the call;
    - passages read from the structured content, from the text and from an event stream;
    - `site:` queries and domain filters;
    - a forgotten session opened again once;
    - each kind of failure, with its words and the offer;
    - an initialize that fails, and the next search trying again;
    - searches at once sharing one session, one of them stopped;
    - a private address refused without the offer;
    - one random `session_id`.
  - It also checks DuckDuckGo's errors and their offer.
  - `web.test.ts` checks the offer only on errors a key would fix. `loop.test.ts` checks it reaching the step.
  - `settings.test.ts` checks the move from DuckDuckGo, and DuckDuckGo chosen since. The host's `search.test.ts` checks
    Parallel as the default with no key asked for. `turns.test.ts` checks which request shows the card.
  - The smoke checks:
    - the new default and its approval host;
    - the order of providers and Parallel's terms link;
    - Brave Search chosen on the screen and used only once its key is saved.
