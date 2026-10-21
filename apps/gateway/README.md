# eNCode gateway

The free tier's server: a Cloudflare Worker that holds eNCode's OpenRouter key so the key never
ships inside the app. Users sign in with GitHub, and the gateway gives each account a small
daily allowance of `:free` models, shares one scarce budget fairly, refuses anything that could
cost money, and can be switched off in a minute.

**Status: built and tested, not deployed.** Nothing in this repository creates an account,
a secret or a deployment. [DEPLOY.md](DEPLOY.md) is the checklist for whoever owns the
Cloudflare account.

- The wire protocol, for the app and the router: [docs/gateway-protocol.md](../../docs/gateway-protocol.md),
  defined in code by `packages/gateway-protocol`.
- The app's side (sign-in, sessions, Connect OpenRouter): [packages/accounts](../../packages/accounts/README.md).
- Why it is built this way: [ADR 0020](../../docs/adr/0020-the-free-tier-runs-behind-our-own-gateway.md),
  [0021](../../docs/adr/0021-sessions-are-rotating-device-bound-refresh-tokens.md) and the
  [threat model](../../docs/security/threat-model.md#the-free-tier-gateway-and-accounts).

## How it is built

```
src/core/      the gateway: routing, sign-in, sessions, chat proxy, cost firewall, quotas,
               budget, pool, admin API. Plain TypeScript behind ports; no Cloudflare types.
src/worker/    the Cloudflare adapters: Durable Objects, D1, KV, and the fetch and cron entry
src/testing/   in-memory adapters and a harness that wires a whole gateway for tests
migrations/    D1 schema
scripts/       fake-upstream.mjs (fake OpenRouter and GitHub), workers-e2e.mjs
```

A chat request goes through these steps in order, and each can end it:

1. **Kill switch.** On, the answer is `service_disabled` with the operator's message.
2. **Client version** (`MIN_CLIENT_VERSION`), then the **bearer token**: signature, expiry, and
   whether the session was revoked.
3. **Request rebuild.** The body is parsed against an allowlist and limits (the cost firewall).
   Unknown fields are dropped, a model other than the two virtual ones is refused.
4. **Admission.** The account's Durable Object checks requests, tokens, concurrency and flags.
   The global Durable Object checks the daily budget and paces upstream starts. Refusals are
   HTTP errors, before any `200`.
5. **Upstream.** Up to three real `:free` models from the pool, tried in order within a 50
   second pre-stream budget. Streaming starts only when a model produces content.
6. **Settle.** Real token counts replace the estimate. A request that failed before the
   account got anything is refunded, up to a daily cap.

| Store | Holds |
| --- | --- |
| Durable Object `UserQuotaObject`, one per account | Today's counters, leases for running requests, revoked sessions, the machine-speed flag |
| Durable Object `ControlObject`, one for everyone | The daily budget and fair share, upstream pacing, model health and cooldowns, metrics, alerts |
| Durable Object `AddressLimiterObject`, one per address bucket | Sign-in start, poll and refresh counts. Addresses are HMACs. |
| D1 `DB` | Accounts, sessions (hashes only) and the allowlist |
| KV `CONFIG` | The kill switch, the model pool and the pool overrides |

The cron job (`*/5 * * * *`) refreshes OpenRouter's counters for the key, rebuilds the pool when
it is an hour old, delivers alerts and deletes sessions that ended more than 30 days ago.

## Run it locally

Needs no account and no network. From the repository root, after `pnpm install` (in Windows
PowerShell, use `copy` for `cp` and run the fake upstream in its own terminal instead of `&`):

```bash
cd apps/gateway
cp .dev.vars.example .dev.vars          # placeholders only; the file is git-ignored
node scripts/fake-upstream.mjs &        # fake OpenRouter and GitHub on 127.0.0.1:8790
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev --test-scheduled # http://127.0.0.1:8787
```

Fill the free pool (this is what the cron does), then walk through what the app does: status,
models, GitHub sign-in, a streamed chat, the quota and sign-out.

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*%2F5+*+*+*+*"
node scripts/try-gateway.mjs http://127.0.0.1:8787 "Say hello"
```

The same script is the check to run after a deploy ([DEPLOY.md](DEPLOY.md)). Against a real
gateway it prints the code to approve on GitHub. It prints no token and keeps nothing.

The fake GitHub approves at once as `octocat`. `.dev.vars.example` sets `SIGNUP_MODE=open` and
`ENVIRONMENT=development`, which also lets the upstream URLs be plain `http` on loopback.
`GET /__requests` on the fake upstream shows exactly what the gateway sent to OpenRouter, and
`POST /__script` with `{"next":["rate_limited","error"]}` makes the next chat requests fail.

## Tests

```bash
pnpm test gateway                       # the core against in-memory adapters, and the protocol package
pnpm --filter @encode/gateway typecheck
pnpm --filter @encode/gateway test:workers
```

`test:workers` starts `wrangler dev` (the real Workers runtime with local Durable Objects, D1
and KV) against the fake upstream and walks through the app's and the operator's flows. It
then checks every request the fake OpenRouter received against the cost firewall's promises:
`:free` models only, only allowlisted fields, never a client-chosen model. It needs no account
and cleans up after itself. `ENCODE_E2E_VERBOSE=1` prints wrangler's output.

`src/core/accounts-client.test.ts` runs the real `@encode/accounts` against the real core in
process, which is where client and server are held to the same protocol.

## Configuration

Secrets are set with `wrangler secret put` and never live in a file. Variables go under `vars`
in `wrangler.jsonc`. A missing or malformed required value makes every request answer
`internal_error` ("not configured correctly") and logs the problem names once (`config_invalid`),
instead of running on a guess.

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | secret, required | | The free-tier key, for `:free` models only. One line of printable ASCII. Set once with `wrangler secret put` and never kept in a file; the same key serves every user. |
| `GATEWAY_SECRET` | secret, required | | At least 32 random characters. Signs access tokens and keys the log and address HMACs. |
| `GATEWAY_SECRET_PREVIOUS` | secret | | The old secret while rotating: its access tokens still verify. |
| `ADMIN_TOKEN` | secret | off | At least 32 characters. Turns on `/admin`. |
| `ALERT_WEBHOOK_URL` | secret | off | A Slack or Discord compatible webhook for alerts (https). |
| `GITHUB_CLIENT_ID` | var | | The GitHub OAuth app (device flow enabled). Without it sign-in is off. |
| `SIGNUP_MODE` | var | `allowlist` | `allowlist` (logins in `ALLOWED_GITHUB_LOGINS` or the admin allowlist), `open` or `closed`. Existing accounts always sign in. |
| `ALLOWED_GITHUB_LOGINS` | var | empty | Comma-separated GitHub logins. |
| `MIN_GITHUB_ACCOUNT_AGE_DAYS` | var | `30` | Younger GitHub accounts get `account_not_eligible`. |
| `KILL_SWITCH`, `KILL_SWITCH_MESSAGE` | var | off | `1`, `true`, `on` or `yes` turns the free tier off. Needs a deploy; the admin API switch needs none. |
| `MIN_CLIENT_VERSION` | var | none | Older apps get `client_outdated`. Apps that send no version are served. |
| `USER_REQUESTS_PER_DAY` | var | `150` | Per account, resets at UTC midnight. |
| `USER_REQUESTS_PER_MINUTE` | var | `10` | Per account. |
| `USER_INPUT_TOKENS_PER_DAY`, `USER_OUTPUT_TOKENS_PER_DAY` | var | `8000000`, `800000` | Per account, settled on real usage. |
| `USER_MAX_CONCURRENT` | var | `2` | Streams per account at once. |
| `USER_REFUNDS_PER_DAY` | var | `20` | Requests handed back after upstream failures. |
| `GLOBAL_REQUESTS_PER_DAY` | var | `950` | Everyone together. OpenRouter allows 1,000 once $10 of credit was bought, 50 before. |
| `GLOBAL_REQUESTS_PER_MINUTE` | var | `18` | Upstream starts a minute. OpenRouter allows 20. |
| `MAX_BODY_BYTES` | var | `4194304` | Request size. |
| `MAX_OUTPUT_TOKENS`, `DEFAULT_OUTPUT_TOKENS` | var | `16384`, `8192` | The cap, and what a request without `max_tokens` gets. |
| `UPSTREAM_FALLBACK_MODELS` | var | `3` | Models offered to OpenRouter per attempt (1 to 3). |
| `APP_TITLE`, `APP_URL` | var | `eNCode`, none | Sent to OpenRouter as `X-Title` and `HTTP-Referer`. |
| `ENVIRONMENT` | var | `production` | `development` also allows plain `http` upstream URLs on loopback. |
| `OPENROUTER_BASE_URL`, `GITHUB_BASE_URL`, `GITHUB_API_BASE_URL` | var | the real ones | For tests and local runs. Never needed in production. |

Fixed in `src/core/config.ts`, because changing them changes the protocol or the threat model:
token lifetimes (access 1 hour, refresh 30 days idle, session 180 days, grace 120 seconds),
sign-in limits per address, the machine-speed flag, and the upstream timeouts.

The free pool is rebuilt from OpenRouter's catalog: only ids ending in `:free` whose listed
prices are all zero. `encode/free-main` needs tool support and 32k of context, and orders by
context size and then recency. `encode/free-fast` needs 16k and orders by the time to first
token the gateway has measured. These are heuristics, so pin, block or approve models with the
admin API when an evaluation says otherwise.

## Operating it

The admin API lives under `/admin` and exists only when `ADMIN_TOKEN` is set. Anything else,
including a wrong token, answers `404`.

```bash
A="authorization: Bearer $ADMIN_TOKEN"; B=https://<your-gateway>
curl -s $B/admin/status -H "$A"
```

| Call | Does |
| --- | --- |
| `GET /admin/status` | The day's budget, models cooling down, the kill switch and the pool |
| `GET /admin/metrics?days=7` | Requests, outcomes, tokens and time to first token per model, per day (up to 15 days) |
| `PUT /admin/kill-switch` `{"on":true,"message":"…"}` | Turns the free tier off or on. Reaches every location in about a minute. |
| `GET /admin/pool` | The current pool and overrides |
| `PUT /admin/pool/overrides` `{"block":[…],"pin":{"encode/free-main":[…]},"approvedOnly":false,"approved":[…]}` | Rebuilds the pool with `:free` ids you block, pin first, or approve exclusively |
| `POST /admin/pool/sync` | Rebuilds the pool from the catalog now |
| `GET /admin/accounts/<login>` | The account, live sessions and today's quota |
| `POST /admin/accounts/<login>/suspend` `{"reason":"…"}` | Suspends and signs the account out everywhere |
| `POST /admin/accounts/<login>/unsuspend` | Lifts a suspension |
| `POST /admin/accounts/<login>/sign-out` | Ends every session without suspending |
| `POST /admin/accounts/<login>/clear-flag` | Removes a machine-speed flag early |
| `GET /admin/allowlist`, `POST /admin/allowlist` `{"login":"…"}`, `DELETE /admin/allowlist/<login>` | Who may sign up while `SIGNUP_MODE` is `allowlist` |

Alerts go to the log (`alert`) and, when set, to `ALERT_WEBHOOK_URL`, each at most once a day:

| Alert | Means | Do |
| --- | --- | --- |
| `paid_usage` (critical) | The key spent credit, so a request was not free | Switch the free tier off, then find the request in the logs. Check the firewall tests. |
| `key_refused`, `payment_required` (critical) | OpenRouter answered 401 or 402 for our key | Check the secret, the balance and the key's limit. Users get `free_tier_exhausted` in 15 minute stretches until it is fixed. |
| `quota_high` | The day's shared budget is 80% used | Nothing is wrong. Consider lowering `USER_REQUESTS_PER_DAY` or buying credit. |
| `free_quota_exhausted` | OpenRouter says the account's daily free requests are gone | Users get `free_tier_exhausted` until the next UTC midnight. |
| `credit_low` | The key has under 20% of its credit limit left | Raise the limit, or leave it as the backstop it is meant to be. |
| `model_errors:<model>` | A model failed over 10% of at least 20 attempts today | The gateway already routes around it. Block it if it stays bad. |
| `flagged:<id>` | An account ran round the clock or at machine speed | It runs at a quarter of its limits for a day. Look it up with `GET /admin/accounts/<login>`. |

Common situations:

- **Something is wrong with the free tier.** `PUT /admin/kill-switch` with a message. Clients
  get `service_disabled` with that message, and the router moves on to the user's own keys.
- **A person abuses it.** Suspend the account. The suspension ends their sessions at once, and
  their refresh tokens stop working.
- **Rotate `GATEWAY_SECRET`.** Move the current value to `GATEWAY_SECRET_PREVIOUS`, set a new
  `GATEWAY_SECRET`, deploy. Access tokens signed with the old secret work for up to an hour
  and refresh tokens are unaffected, so nobody is signed out. Remove the previous value after
  an hour.
- **Rotate the OpenRouter key.** Create the new key, `wrangler secret put OPENROUTER_API_KEY`,
  then delete the old one on OpenRouter. In-flight requests finish on the old key.
- **A model misbehaves.** Block it with `PUT /admin/pool/overrides`. Blocking takes effect on
  the next pool rebuild, which the call itself triggers.
- **Logs.** `wrangler tail`, or the observability dashboard. Each line is JSON with an event
  name, a request id and metadata. They never hold prompts, completions, tokens, keys, GitHub
  logins or device ids. Accounts appear as a short HMAC (`log_id`), which
  `GET /admin/accounts/<login>` returns, so a login can be traced to its lines.

## Known limits

- The free models are slow and sometimes absent. The gateway fails over before the first byte
  and says so honestly after it, and the router carries the user to the next tier.
- Many free models are closed to a given account: by its privacy settings (a 404 naming the
  guardrails) or because OpenRouter reserves them for listed apps (a 403 naming agentic
  harnesses). The gateway retires such a model for 15 minutes at a time and never shows the refusal
  to a user. Which models work depends on the account's settings ([DEPLOY.md](DEPLOY.md#5-openrouter-privacy-and-which-free-models-work)),
  and `GET /admin/metrics` shows the outcomes per model.
- A GitHub OAuth app allows a limited number of device-flow sign-ins an hour. That is plenty
  for a beta. A public release should add a loopback web flow.
- One OpenRouter key means one shared budget. Per-account limits and fair share keep it usable,
  and more credit or more keys are the only way to raise the ceiling.
- Nothing here has met production traffic. Read the [threat model](../../docs/security/threat-model.md#the-free-tier-gateway-and-accounts)
  again after the first deploy.
