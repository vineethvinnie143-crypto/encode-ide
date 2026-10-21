# 0020. The free tier runs behind our own gateway

- Status: Accepted
- Date: 2026-10-21

## Context

The free tier needs a model account that users do not have to set up: an OpenRouter key for
`:free` models, owned and paid for by eNCode. A key inside a desktop app is not a secret. It
can be read from the installer, from memory or from the first request's headers, and from
there it is copied into other tools, drained, or pointed at paid models until the account is
closed.

The free models are also scarce. OpenRouter allows 20 requests a minute and 1,000 a day for
the whole account (50 a day until the account has bought $10 of credit), so one heavy user
can use up the day for everyone.

The free tier therefore needs a place to hold the key, a way to tell users apart, a fair
split of a small budget, a guarantee that nothing it sends costs money, and a switch that
turns it off within a minute. Options considered:

- **Ship the key in the app, obfuscated.** Anyone can extract it. Rejected.
- **Ask every user for their own OpenRouter account.** Still offered as Connect OpenRouter
  ([0022](0022-connect-openrouter-with-pkce-on-a-loopback-listener.md)), but it is not a free
  tier that works on first launch.
- **A Node service on a server we run.** It needs patching, scaling, TLS and someone on call,
  for a service that mostly forwards streams.
- **Cloudflare Workers with Durable Objects.** No servers to run, and a Durable Object gives
  one strongly consistent counter per account and one for the whole budget, which is what
  quotas need.

## Decision

- **The key never leaves the gateway.** `apps/gateway` holds `OPENROUTER_API_KEY` as a
  Worker secret, which the owner sets once with `wrangler secret put`. It is not in the app, the
  repository, `wrangler.jsonc`, `.dev.vars`, CI or a log. The app talks only to the gateway and
  holds a short-lived session, so shipping a build never ships the key.
  - One key serves everyone, the owner included, because all free-tier traffic goes through the
    gateway. A key that has been pasted anywhere (a chat, an issue, a commit) is replaced before
    it is deployed.
  - The key carries the lowest credit limit OpenRouter lets it work with ($0, and $1 if a $0
    limit blocks free models too), so OpenRouter itself refuses a request that would cost money.
    The gateway's firewall below is the control that matters, and the limit is the backstop.
- **A Worker around a host-agnostic core.** `src/core` is plain TypeScript behind small ports
  (accounts, per-account quota, global control, address limiter, config store, logger,
  clock). `src/worker` binds them to D1, three SQLite-backed Durable Objects and KV, and
  `src/testing` binds them to memory. Unit tests and the client-against-gateway tests run the
  real core, and `wrangler dev` runs the real Worker in an end-to-end test. Changing host
  means rewriting adapters, not the gateway.
- **Sign-in is required**, with GitHub ([0021](0021-sessions-are-rotating-device-bound-refresh-tokens.md)).
  Quotas bind to the account. Sign-up starts as an allowlist (`SIGNUP_MODE`) and opens later.
- **Two virtual models**, `encode/free-main` and `encode/free-fast`. The gateway picks the
  real model for each request from a pool it rebuilds hourly from OpenRouter's catalog, so
  the app does not follow catalog changes.
- **A cost firewall.** The upstream request is rebuilt field by field from an allowlist and
  checked once more just before it is sent (`assertFreeOnly`). It names only `:free` models and
  carries no provider routing, plugins, web search or files. A client cannot widen it.
- **Budgets at three levels.**
  - Per account: requests a minute and a day, tokens a day, concurrent streams. Round-the-clock
    or machine-speed use is flagged and held to a quarter of the limits.
  - For everyone: a daily ceiling and a per-minute pacer, both below OpenRouter's, and a fair
    share that shrinks each account's limits as the day's budget runs down.
  - Per address: sign-in starts, polls and refreshes.
- **A kill switch and alerts.** `KILL_SWITCH` (takes effect on the next deploy) or the switch
  in KV (about a minute) turns the free tier off with a message. Alerts cover a high daily
  count, a failing model, a refused key, spend above zero and flagged accounts. They carry
  metadata only.
- **Failures the router can act on.** Admission errors are HTTP errors before any `200`.
  Failures after the first content end the stream with an in-band error. Every error code maps
  to one client action (`errorAction` in `@encode/gateway-protocol`), so the router moves to
  its next tier by rule. [The protocol](../gateway-protocol.md) is written down once, in code
  and in prose.
- **No prompts kept.** The gateway logs an HMAC of the account id, the model, token counts,
  latency and the outcome. `GET /v1/status` returns the data policy, since free providers may
  log and train on prompts.
- **The repository deploys nothing.** `wrangler.jsonc` holds placeholder ids and no secrets,
  and `apps/gateway/DEPLOY.md` is the checklist for the account owner.

## Consequences

- We run a service. Its runbooks are in `apps/gateway/README.md`. An outage ends the free tier
  only: the router falls through to the user's own keys.
- The Workers Free plan allows 10 ms of CPU per request, which streaming and token handling
  can exceed, so the Workers Paid plan is the recommended home.
- The whole user base shares 1,000 free requests a day. At 150 a day per account that is a
  handful of heavy users, so `free_tier_exhausted` is an expected state that the app handles
  like any other next-tier signal. Growth needs more credit or more keys, and the budget
  settings are variables, not code.
- Free providers can log prompts. The app must show the data policy before the first free
  request and point private work at the user's own key.
- Cloudflare is the one host-specific dependency (Workers, Durable Objects, D1, KV, cron).
  GitHub is the identity dependency.
