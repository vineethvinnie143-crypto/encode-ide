# @encode/router

eNCode's `ModelClient`. It turns roles (`main`, `explore`, `planner`, `reviewer`, `summarizer`, `utility`, and your own) into ordered model lists, keeps a registry of what each model can do, tracks health with circuit breakers, fails over silently when an attempt dies (before or during the stream), and serves `@free`: a pool of free OpenRouter models that rotates without interrupting the session.

```
core ──complete() / budget()──▶ ModelRouter ──stream()──▶ ProviderAdapter ──▶ HTTP
                                 registry · health · free tier · free pool · selection
                                 catalog + quota sync (injected fetch)
```

The contract (`ModelClient`, `CompletionRequest`, `CompletionOutcome`, `ClientEvent`, `TransportError`, the adapters and the assembler) lives in `@encode/providers`; this package only depends on that. `DirectClient` in `@encode/providers` is the same interface with no failover, so the app runs without the router and swaps it in without code changes.

## Use

```ts
import { createAnthropicAdapter, createOpenAICompatibleAdapter, createOpenRouterAdapter } from '@encode/providers'
import { createRouter, parseRouterConfig, type KeySource } from '@encode/router'

const { config, problems } = parseRouterConfig(settings.router) // problems → the Settings page
const router = createRouter({
  config,
  adapters: [createOpenRouterAdapter(), createOpenAICompatibleAdapter(), createAnthropicAdapter()],
  keys, // a KeySource: OS keychain, environment, gateway token
  onAlert: (alert) => ui.notify(alert), // key refused, sign in, payment, quota, catalog, billed
  onLog: (entry) => log[entry.level](entry.message),
  onTrace: (trace) => telemetry.request(trace), // once per request, however it ends
})
router.restore(await store.read()) // optional warm start; anything malformed is skipped

const outcome = await router.complete({
  role: 'main',
  payload, // system, messages, tools: the canonical ModelRequest
  requirements, // promptTokens, maxOutputTokens, tools, images
  sticky: sessionId, // keep this session on the model it moved to
  signal,
  onEvent, // attempt · text · thinking · tool-call · discard · switch · wait
  validateToolCall, // optional schema check
})
```

`complete()` rejects only when the caller aborts, and then with exactly `signal.reason`. Everything else is an outcome:

| Outcome | Meaning | What core does |
| --- | --- | --- |
| `done` | A clean, finished reply. `message.origin` names the model that answered. | Commit it. |
| `compact` | The prompt fits no available window. `window` is the largest one. | Compact below `window`, call again. |
| `paused` | Nothing can run. `reason` is one of `rate-limit`, `quota`, `payment`, `auth`, `network`, `unavailable`, `no-model`, `refused`; `message` is user-facing; `retryAt` when waiting helps. | Show it; resume at `retryAt`. |

Nothing reaches core's history before an attempt finishes cleanly. Text, thinking and tool calls stream to `onEvent` as they arrive, so the UI is live; if the attempt then fails, a `discard` event tells the UI to forget it, and a `switch` event names the next model.

Other methods, for the host and the Settings page:

- `budget(role, query)`: the window and output limit of the model a call would use now, for compacting before sending.
- `preview(role, requirements, query)`: the models a call would try, in order, and why each other one is left out.
- `refresh({ providers?, force? })`: sync catalogs and the free quota. Single-flight per provider; forced refreshes at most once a minute.
- `checkModel('provider:model')`: a tiny tool-call test, for the Test button; feeds health and the canary. Reports what the provider billed for it (`cost`).
- `runCanaries({ limit? })`: canary the free models nothing has vouched for lately. Runs only while OpenRouter reports at least 100 free requests left today, so on a 50-a-day account the pool learns from real calls instead.
- `status()`: whether free-only mode is on, model health, provider blocks, free-tier counts and catalog state, for a status page.
- `snapshot()` / `restore()`: catalogs, learned facts, health, canaries, free-tier counts. Persist it, version 1, JSON.
- `configure(config)`: apply new settings live. Health, learned facts and counts carry over.
- `keysChanged(provider)`: **the host must call this when the user changes a key or tops up credit.** It lifts the blocks a refused key or a payment failure set.

## Settings

`parseRouterConfig` treats settings as untrusted. It never throws: anything invalid is dropped with a `{ path, message }` problem, and the rest still works.

```jsonc
{
  "providers": {
    "openrouter": { "type": "openrouter" },
    "anthropic": { "type": "anthropic" },
    "local": { "type": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1" },
    "gateway": { "type": "openai-compatible", "baseUrl": "https://gateway.example/v1", "free": true }
  },
  "roles": {
    "main": ["anthropic:<model>", "openrouter:qwen/qwen3-coder", "@free"],
    "reviewer": ["openrouter:deepseek/deepseek-r1"],
    "utility": ["@free"]
  },
  "freeOnly": false, // true: never send a request to a model that is not free (see below)
  "tools": { "WebFetch": { "role": "utility" } },
  "agents": { "security-review": { "models": ["anthropic:<model>"] } },
  "models": { "local:qwen3": { "contextWindow": 32000, "tools": true } },
  "freePool": { "requestsPerMinute": 20, "dataCollection": "deny", "exclude": ["*/experimental-*"] },
  "limits": { "maxFailovers": 3, "maxFailoverMs": 90000 }
}
```

- **Any model for any role.** A model ref is `<provider>:<model id>`, split at the first colon (ids contain colons: `openrouter:qwen/qwen3-coder:free`). `@free` stands for the free pool. Each later entry is the fallback for the ones before it.
- **Resolution.** A subagent's assignment beats a tool's, which beats the role. A role nobody configured follows `explore|planner|reviewer → main`, `summarizer → utility → main`, and with nothing configured at all, `@free` serves.
- **Base URLs** must be `https://`, or `http://` to this machine; no credentials, query or fragment. An OpenAI-compatible provider at `openrouter.ai` is promoted to the `openrouter` type.
- **Keys never appear in settings.** They come from the `KeySource`.
- **Overrides** (`models`) beat what failures taught (a window only ever shrinks), which beats the provider's catalog, which beats the shared model table. Unknown local models get a modest 32k window until an overflow says otherwise.
- **Limits** are clamped; the defaults are in `DEFAULT_LIMITS`.
- **`freeOnly`** is off unless set, and on whenever its value cannot be read (`"freeOnly": "true"` turns it on, with a problem saying so): a switch that guards against spending money must not fall back to off because of a typo.

## Failover policy

Every failure is classified once, by `@encode/providers`' `TransportError` (kind, `scope: 'model' | 'account'`, `code`, `retryAt`), and answered by one rule:

| Failure | Response |
| --- | --- |
| timeout, 5xx, overloaded, protocol error, stream cut mid-reply | The model cools down: 5 s, doubling to 15 min, or until the time the provider named (capped at a day). Costs failover budget. The breaker opens after 3 in a row or when more than half of the last 20 calls failed; then one request at a time probes it. |
| 429 for one model | That model cools until its `Retry-After` or reset; without one, a doubling backoff. Never trips the breaker, costs no budget. |
| 429 for the account (OpenRouter's 20 a minute) | The free tier closes until its reset; on other providers the provider (or its paid models) is held back until then. Pacing keeps eNCode under OpenRouter's limit in the first place. |
| Daily quota spent | The free tier closes until midnight UTC (or the provider's time). One alert. |
| 402 / budget spent | On a paid model, the provider's paid models are blocked; on a free model (a negative balance stops those too), the whole provider. One alert. |
| Key refused | The provider is blocked until `keysChanged()`. The gateway's `token_expired` is refreshed once and retried; `invalid_token` asks for sign-in. |
| 404 model gone | Excluded for the request and cooled for 6 h; a pool model also triggers a catalog refetch. |
| Tools or images unsupported | Learned; the model is left out of calls that need them. |
| Context overflow | The window is learned, from the error or bounded by the size sent, and a model the prompt no longer fits is skipped. One that still seems to fit gets one more try before it is excluded. Then a larger window, else `compact`. |
| Network failure | The provider is held back for 10 s; the model's health is untouched. Costs budget. |
| Content filter | Paused as `refused`. eNCode does not route around a safety filter to another model. |
| Unreadable tool JSON, or an empty reply | The same model once more, then another model. If the budget runs out, the flawed reply is committed so core can answer it. |

**The failover budget.** A request pauses after more than `maxFailovers` (3) costly failures, `maxFailoverMs` (90 s) since the first problem, or `maxAttempts` (12). A wait short enough to fit the remaining budget (a per-minute cap, a cooldown) is sat out and announced with a `wait` event instead of failing. A lone model is retried after its short cooldown before the request pauses.

**Watchdogs.** No first token in 20 s aborts the attempt (60 s for reasoning models, 180 s for servers on this machine, which may be loading the model). After the first token, 60 s of silence aborts it. Keepalives prove the server is alive, not the model: each buys time, up to a cap (120 s before the first token, 300 s after the last content), so a proxy that pings in front of a stuck upstream cannot hold a request forever. An adapter that ignores its abort signal is abandoned, not awaited.

**Tool calls.** Malformed JSON goes through the shared repair, which never completes a truncated value. A call cut off by the output limit, or by a filter, never runs. A call that parses but fails `validateToolCall` is committed as `invalid` with the model's raw arguments, for core to answer so the model corrects itself; a schema error is the model's to fix, so it is not retried elsewhere.

**Context fit.** A prompt is fitted with a 10% margin for another tokenizer (none for the session's own model), and the output budget is clamped to the room the window leaves.

## The free pool

`@free` is the free models of the pool's providers (the user's OpenRouter account first, then providers marked `free`, such as eNCode's gateway), read from their catalogs at run time. Nothing is hard-coded, because the set changes every few weeks.

- **Membership.** A model must be free (see [Only free models](#only-free-models)), have a window of at least `minContextWindow`, not have retired, and not match `exclude`.
- **Ranking.** One weighted score: role fit dominates (gateway virtual models name their roles), then the eval score for the role (else a prior from window and age), health in this session, and whether it passed the canary. The session's current model leads, which keeps prompt caches warm; it changes only on failure.
- **Canaries.** A model that cannot make a valid tool call fails its canary and stays out for a week. Passing is re-checked after 30 days. Real traffic feeds the canary too: a pooled model that returns a valid tool call has passed.
- **Pacing.** A sliding 20-a-minute window; a wait up to `maxPacingWaitMs` (15 s) beats moving to a paid tier.
- **Quota.** The daily count comes from OpenRouter's `GET /key` (`free_model_daily_requests`) plus eNCode's own tally, re-read every 15 minutes because other apps may share the key. A spent day closes the tier until midnight UTC.
- **Server-side fallbacks.** OpenRouter's `models` parameter carries up to `serverFallbacks` further free models, tried before the first byte. Health and the canary are credited to the model that answered; a fallback never reaches a paid model.
- **Data policy.** `freePool.dataCollection: "deny"` keeps prompts away from endpoints that train on them.

## Only free models

`"freeOnly": true` makes the router refuse every model that is not free. A role may list paid models, failover may run out of free ones, a free tier may close: none of it ever sends a request to a model that costs money. It pauses instead, with a message that says what to change.

**What counts as free.** On OpenRouter, only an id that ends in `:free` carries the promise that calling it costs nothing, and every price OpenRouter lists for it must be zero: prompt and completion tokens, but also a price per request, per image, per web search, for reasoning and for the cache. A price that is missing, unreadable or not one this code has heard of counts against the model, so a new kind of charge cannot pass as free. A model priced at zero without the `:free` id is left out: a zero price can change without notice. On a provider marked `free` (eNCode's gateway, a server on this machine) every model is free. `freeVerdict(id, pricing)` says why a model is not.

**Layers.** Selection sets a model that is not free aside before it looks at anything else (`not-free`, with a message). The router looks again right before it sends, because the catalog can change while a key is being read. `checkModel()` refuses too. OpenRouter's server-side fallbacks are only ever free models. A snapshot read back from disk cannot vouch for a model that has a price.

**A bill for a model listed as free.** OpenRouter reports what each request cost. If a model the registry believes free is billed, the reply is kept, the model counts as paid from then on (learned, so it survives restarts; `registry.unlearn(key)` forgets it), free-only mode never sends it another request, and a `billed` alert tells the user. A listing is a promise; the bill is the evidence.

**When nothing is free.** A request pauses as `no-model`: "Only free models are enabled, and none of the main role's models is free. Add "@free" to the role in Settings, or turn off free-only mode." If the free model list has not loaded yet, the pause says so instead.

The strongest guard is not in this code: on openrouter.ai, give the key a credit limit of $0, and no call can ever be billed whatever any software does.

**Checking it yourself.** `scripts/free-models.mjs` reads OpenRouter's public model list (no key needed), prints the models `@free` would try first with every price as OpenRouter wrote it, lists what it left out and why, and exits 1 if anything contradicts "every pick is free".

```
node scripts/free-models.mjs                       # the picks and their prices
node scripts/free-models.mjs --file models.json    # the same from a saved copy of /api/v1/models, offline
OPENROUTER_API_KEY=sk-or-... node scripts/free-models.mjs --test 3
```

With `--test`, it also makes real calls to the top picks through the router in free-only mode, and compares the key's credit usage and free-request count from before and after: the credits must be unchanged and the free count must have moved. The key is read from the environment only, goes to openrouter.ai and nowhere else, and is never printed. Behind a proxy (`HTTPS_PROXY`), run it with `NODE_USE_ENV_PROXY=1`: Node's `fetch` ignores the proxy otherwise.

## Keys (BYOK)

The router stores no keys. It asks a `KeySource`:

```ts
interface KeySource {
  has(provider: string): boolean // cheap, synchronous: selection calls it often
  get(provider: string, origin: string): Promise<string | undefined> // may refresh a token first
  invalidate?(provider: string): void // the provider refused the key
}
```

`origin` is the provider's base URL origin. A `KeySource` must return a key only for the origin it was saved against, so a changed base URL can never carry an old key to a new server. Keys travel from this machine to the provider and nowhere else. Every message that leaves the router (pause messages, alerts, logs) is redacted: the keys in use, and anything shaped like a key or credential.

The catalog is public, so no key is sent with it; `GET /key` and non-OpenRouter model lists carry the provider's key.

## Testing

`@encode/router/testing` is for the router's own tests and for integration tests elsewhere:

```ts
import { catalogEntry, faults, TestWorld } from '@encode/router/testing'

const world = new TestWorld({
  catalogs: { openrouter: [catalogEntry('vendor/a:free'), catalogEntry('vendor/b:free')] },
  behavior: { 'vendor/a:free': faults.cutStream('half an answer') },
})
const { outcome, events, text } = await world.complete() // runs on a fake clock
```

`FakeClock` jumps to the next timer whenever everything waits, so a 15-minute cooldown takes milliseconds and a hang is an error. `faults` builds what real providers do (`reply` and `toolCall` take a `cost` to play a provider that bills): `cutStream`, `midStreamError`, `stallAfter`, `slowFirstToken`, `keepaliveOnly`, `rateLimited`, `freeMinuteCap`, `quotaExhausted`, `serverError`, `overloaded`, `networkError`, `auth`, `payment`, `contextOverflow`, `notFound`, `noTools`, `badToolJson`, `emptyReply`, `contentFilter`, `hangIgnoringAbort`, `servedBy`.

`chaos.test.ts` throws random combinations of those at random settings and checks eight invariants: `complete()` rejects only on abort; the event stream is well formed; only a clean finish commits; no model is called while it cools down and no free model while the free tier is closed; at most 20 free requests reach OpenRouter in any minute; a request pauses only when its budget is spent or nothing can run; every request ends in bounded simulated time; and with free-only mode on, no model that is not free is ever called, however the free ones fail. `ENCODE_PROPERTY_SEED` replays a failure, `ENCODE_PROPERTY_RUNS` runs more cases.

```
node scripts/test.mjs packages/router
ENCODE_PROPERTY_RUNS=3000 ENCODE_PROPERTY_SEED=7 node scripts/test.mjs packages/router/src/chaos
```

## Runs anywhere

Router sources use only `fetch`, timers, `AbortController` and the provider contract, so the same code runs in the desktop agent host, the CLI and the Cloudflare Workers gateway. `sources.test.ts` fails the build on a `node:` import, `process`, `Buffer`, or any import other than `@encode/providers`. Tests and `testing/` run on Node and are exempt.

## Integration notes

- **Core.** Depend on `ModelClient` from `@encode/providers`, never on this package. Pass a `sticky` session key, `requirements` calibrated against reported usage, and `validateToolCall`. Call `budget()` before sending to decide when to compact.
- **App and UI.** Subscribe to `onAlert` (`key-refused`, `sign-in`, `payment`, `quota`, `catalog`, `billed`) for banners, `onEvent`'s `wait` and `switch` for the in-chat notice, and `status()` / `preview()` for the model indicator and the Settings page. Call `keysChanged()` when keys or credit change, `refresh({ force: true })` for a Refresh button, `checkModel()` for Test, and persist `snapshot()` periodically.
- **Gateway.** eNCode's gateway is one more OpenAI-compatible provider with `free: true` and role-tagged virtual models (`encode/free-main`, `encode/free-fast`); `/v1/models` entries may carry `roles`, `context_length` and `supports_tools`. The router understands its error codes: `token_expired` (refresh, retry once), `invalid_token` (block, sign-in alert), `rate_limited` and `concurrency_limited` (cooldown), `daily_quota_exhausted`, `free_tier_exhausted` and `service_disabled` (skip the gateway tier until `retry_after`), `upstream_unavailable` (a server failure: the virtual model cools down), `model_not_found`.
