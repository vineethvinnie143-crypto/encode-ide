# 0122. The agent finds pages before it fetches them, and DuckDuckGo is asked one search at a time

- Status: Accepted, builds on 0058
- Date: 2026-10-25

## Context

The owner reported that the model "could not use web search", with a screenshot of one turn. In that turn the agent
made no search at all:

- It fetched four Gcore addresses it had made up.
- Two of them redirected (HTTP 301) from gcore.com to docs.gcore.com, which WebFetch reports and does not follow.
- The other two, and the redirect target the agent fetched next, do not exist, because the paths were invented.
- One search finds the real pages, such as `docs.gcore.com/ddos-protection`.

Three things made that turn likely:

- **Nothing told the model not to guess.** WebFetch's description said only that `url` must be a full address.
- **A failed page said nothing about what to do next.** A 404 came back as the site's own error page. The model's next
  step was to guess another path.
- **A failed search sent it straight to guessing.** DuckDuckGo, the default provider, needs no key. A check from the
  owner's computer, made the way eNCode searches, found it blocked: six searches all got HTTP 202 with DuckDuckGo's
  picture puzzle ("Unfortunately, bots use DuckDuckGo too... Select all squares containing a duck") and no results.
  The first search was blocked too, and a pause between searches made no difference. The error said "limiting
  searches for now (HTTP 202)", and the model then guessed addresses.
- DuckDuckGo also slows down bursts of searches with a plain 202 or 429. A model that searches for three things at
  once (searches run in parallel, as reads do) is such a burst.

## Decision

- **Find, then fetch.**
  - WebFetch's description says to use an address the model was given or found: from the user, a WebSearch result,
    or a link on a page. It also says never to guess one.
  - WebSearch's description says it is also for finding pages to fetch.
  - Their short descriptions, for models that need no guide, say the same in a few words.
  - To stay within the tool budget, two other lines were shortened, so the net cost is about 15 characters.
- **A page that did not come says what to do.** A failed fetch gets one line of advice before the site's own text:
  - 404 or 410: there is no page at this address. Do not guess another one: find the page with WebSearch, or fetch
    the site's home page and follow its links.
  - 401 or 403: the site needs a sign-in or turns programs away, so use another source.
  - 429 and 5xx: use another source, or try later.
- **A failed search says what to do.** The error from the provider is followed by: do not guess page addresses
  instead; tell the user the search failed (Settings → Agent → Web search can choose another provider), or fetch a
  page known to exist and follow its links. "No results" suggests fewer or other words.
- **DuckDuckGo is asked one search at a time.**
  - The searches of a session go in a queue, at least 1.5 seconds apart.
  - A plain HTTP 202 or 429 is asked once more, after 4 seconds. A second refusal is a `limit` error that says so,
    and suggests trying again in a few minutes or Tavily, Exa or Brave Search with a key.
- **The puzzle is said at once.** A page with no results that has `anomaly-modal`, `challenge-form` or "bots use
  DuckDuckGo" is the puzzle, whatever its status.
  - It is not asked again, because no program can solve it.
  - The error says DuckDuckGo is blocking searches from this computer with a picture puzzle eNCode cannot solve, and
    names Settings > Agent > Web search and the keyed providers.
  - For the next 10 minutes, DuckDuckGo searches fail with the same words without contacting it.
  - A search stopped while it waits in the queue stops at once. A failed search does not hold up the next one.
  - The request itself is unchanged: the same address, the same GET and eNCode's own user agent. The searches go only
    to the provider the person chose, as before (0058).

## Consequences

- A model that lacks an address searches for it, and one that guessed wrong is told to search instead of guessing
  again. A turn like the reported one costs one search and one fetch instead of four fetches.
- Parallel searches through DuckDuckGo take about 1.5 seconds longer each, after the first. A search DuckDuckGo
  slowed down takes about 4 seconds longer, and usually succeeds.
- On a computer DuckDuckGo blocks, search does not work without a key. The person and the model read the same plain
  reason, and the model is told not to guess. Tavily's free plan (1,000 searches a month, no card, checked
  2026-10-25) is the easiest fix.
- eNCode does not dress up as a browser or try to get around the puzzle. DuckDuckGo shows it on purpose, and the
  request stays what it says it is.
- Tests:
  - `search.test.ts` covers:
    - a retry after a 202, and one retry and no more after a 429;
    - the puzzle (202 or 200) said at once, nothing sent for 10 minutes, then asked again;
    - a result about the challenge page kept as a result;
    - a page with no results read as no results;
    - three searches at once spaced apart;
    - a failed search that does not block the next;
    - a queued search that stops when asked.
  - `web.test.ts` covers the advice after a 404, a 403 and a 503, a failed search, and no results.
