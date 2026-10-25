# 0128. A conversation stays where its cache is, and Usage says how much was cached

- Status: Accepted, builds on 0062 and 0094
- Date: 2026-10-25

## Context

Every step sends the instructions, the tools and the whole conversation again (0062). What makes that affordable is
the provider's prompt cache: a cached token costs 2% to 50% of a normal one, depending on the provider. A long session
on a caching provider should read nearly everything from the cache. Three things could still make it miss, and nothing
showed when it did:

- **OpenRouter routes each request on its own.** It keeps a conversation on the provider that cached it only after it
  has seen a cache hit. A `session_id` in the request makes it do so from the first request on. eNCode sent none.
- **Claude's cache lasts five minutes** from the start of the request that last read it. A person who reads an answer
  for six minutes, an approval that waits, or a long test run between two steps makes the next request write the
  whole conversation again at 1.25 times the normal price. The hour-long cache costs 2 times to write and survives
  those waits.
- **Nobody could see the misses.** Settings > Usage put the cached share in a tooltip, and diagnostics had none.

The owner set a goal of 25% lower cost per solved task than other tools at equal accuracy. A review of the context
system (the doc "eNCode compaction and cost review") put this first: it costs no accuracy, and it shows what the
cache misses today, before the larger changes to shortening.

## Decision

- **A key for each conversation** (`packages/core/src/cache-hints.ts`). Every request of the agent loop carries
  `cacheKey`: `encode-` and 32 hex characters of a SHA-256 of the session id and the agent's id. The main agent, each
  subagent and each attempt of `/best` get their own, since each is its own conversation. The key names nothing on
  this computer.
  - OpenRouter gets it as `session_id` in the chat-completions body, and as the `x-session-id` header on its Messages
    endpoint (the preset path of 0035).
  - OpenAI's own servers (`*.openai.com`) get it as `prompt_cache_key`, which sends requests with the same key to the
    same cache.
  - Other OpenAI-compatible servers get nothing, since a server may refuse a field it does not document. DeepSeek,
    Gemini and the rest cache by themselves.
- **The hour-long cache after the first long wait.** The session keeps a `CacheClock` across its turns and loops.
  Once two of the main agent's requests have started more than five minutes apart, every later request carries
  `cacheTtl: '1h'`. The adapters then give each cache mark `ttl: '1h'`, for Claude only, directly or through
  OpenRouter. All marks get the same lifetime, so none is shorter than a mark after it, which Anthropic requires.
  Before the first long wait, the five-minute cache is strictly cheaper, so nothing changes.
- **The cached share is shown and judged** (`apps/desktop/shared/cache-share.ts`).
  - Settings > Usage has a **Cached** column for each model and each project.
  - A share below 80% over at least 20 calls is marked low, with a sentence on the likely causes. One cause is an
    OpenRouter preset with a fixed provider order, which turns off its sticky routing.
  - A model that reported no cached token over 20 calls is told apart: its provider may not cache, or may not say.
  - The diagnostics report has a **Prompt cache, last 7 days** section with the same numbers and verdicts.
- **Tests.**
  - The adapters' tests cover where the key goes and where it does not, and that the hour goes on every mark of a
    Claude request and on no other.
  - The loop's test has a six-minute step and checks the requests that follow.
  - The share's verdicts and the diagnostics section are unit tested.
  - The smoke checks that the Usage page shows the column.

## Consequences

- A long session through OpenRouter stays on one provider from its first request, while that provider answers. When
  it fails, OpenRouter routes the next request elsewhere, as before.
- A Claude session with long waits pays 2 times instead of 1.25 times for what each request adds to the cache.
  It no longer pays 1.25 times the whole conversation after every wait. A session that never waits five minutes is
  unchanged.
- Low cache shares are visible to the person and in a tester's report, so the next cost changes (the review's R1 to
  R6) start from measured misses.
- Still open: a keep-alive request that refreshes Claude's five-minute cache during a wait, instead of the hour-long
  one. It is cheaper on models whose cache reads cost 2.5% to 5%, but it spends money while nobody is there, so it is
  left out for now.
