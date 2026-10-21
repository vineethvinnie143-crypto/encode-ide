# The eNCode gateway protocol

The free tier is served by `apps/gateway`, a Cloudflare Worker that holds eNCode's OpenRouter
key so the key never ships inside the app ([ADR 0020](adr/0020-the-free-tier-runs-behind-our-own-gateway.md)).
Clients speak OpenAI-compatible chat to it, with a sign-in in front.

Everything on the wire is defined once, in code, by `packages/gateway-protocol`: paths,
virtual model ids, header names, error codes and the shape of every body. The gateway and
the app both import it. This page explains how the pieces fit, and what a client does about
each failure. The app side of sign-in and token handling is `packages/accounts`.

- Base URL: configured in the app, always `https`, except a loopback address while
  developing. `packages/accounts` refuses anything else, so a token never travels in clear text.
- Bodies are JSON, except a streamed chat answer, which is server-sent events.
- Every request carries `x-encode-client: <app>/<version>` (for example `desktop/0.1.0`).
  The gateway can refuse versions below `MIN_CLIENT_VERSION` with `client_outdated`.
- Every response carries `x-encode-request-id`. Quote it in bug reports; it is the only
  thing that ties a user's report to a log line, because the gateway logs no prompts.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/status` | none | Is the free tier available, the data policy, the oldest client served |
| `GET /v1/models` | none | The two virtual models, their roles, limits and availability |
| `POST /v1/auth/device/start` | none | Begin GitHub sign-in |
| `POST /v1/auth/device/poll` | none | Finish GitHub sign-in |
| `POST /v1/auth/refresh` | refresh token | Trade a refresh token for a new session |
| `POST /v1/auth/logout` | refresh token | End a session (always `204`) |
| `GET /v1/me` | bearer | The account and today's quota |
| `POST /v1/chat/completions` | bearer | Chat |
| `/admin/*` | admin token | Operations; not part of the client protocol, see `apps/gateway/README.md` |

## Signing in

GitHub's device flow, proxied by the gateway, so the app never sees a GitHub token and the
GitHub OAuth app needs no client secret.

1. The app creates a **device id** once per install (32 random bytes, base64url) and keeps it
   in the keychain with the session.
2. `POST /v1/auth/device/start` with `{ "device_id": "…" }` returns
   `{ device_code, user_code, verification_uri, expires_in, interval }`. The app shows the
   user code and opens the verification link (`https://github.com/login/device`).
3. The app polls `POST /v1/auth/device/poll` with `{ device_code, device_id }` every
   `interval` seconds. The answer is one of:
   - `{ "status": "pending", "interval": 5 }`: keep waiting;
   - `{ "status": "slow_down", "interval": 10 }`: keep waiting, more slowly;
   - `{ "status": "denied" }` or `{ "status": "expired" }`: stop;
   - `{ "status": "complete", access_token, token_type: "Bearer", expires_in,
     refresh_token, refresh_expires_in, account }`: signed in.

   A refusal comes back as an error instead: `signup_closed` (invite-only),
   `account_not_eligible` (GitHub account too new or not a person), `account_suspended`,
   or `service_disabled`. Their messages are written for the user. They end with the same
   promise, "Your own keys still work", because the free tier is never the only way in.

### Sessions

- The **access token** (`ea1.…`, one hour) is a signed bearer token. Quotas bind to the
  account, not to the token, so extracting one buys nothing.
- The **refresh token** (`er1_…`, 30 days unused, 180 days at most) is single use. Each
  `POST /v1/auth/refresh` with `{ refresh_token, device_id }` returns a whole new session.
- A refresh token only works with the device id it was issued to. A mismatch ends the
  whole session.
- **Grace window.** The previous refresh token is honored once more for 120 seconds, so a
  response lost in transit does not sign anyone out. Presenting it after that is treated as
  theft and ends the session on every device. The next refresh then fails with
  `invalid_grant`.
- `POST /v1/auth/logout` with `{ refresh_token, device_id }` ends the session at once, access
  token included. It answers `204` whether or not the token was known.
- A suspended account loses every session at once.

What a client must do (`packages/accounts` does all of it):

- Refresh **single-flight**: one request however many callers ask, and store the new
  session **before** using its token. The old refresh token is spent the moment the gateway
  answers.
- Refresh a little early (two minutes), and on a `401` with `token_expired` once.
- On `invalid_grant`, or a second `401`, remove the saved session and ask the user to sign
  in. Do not retry.
- Keep tokens in the OS keychain only ([ADR 0008](adr/0008-api-keys-in-the-os-keychain-only.md)),
  never in settings, logs or the renderer.

## Chat

`POST /v1/chat/completions` is OpenAI's chat completions API with a few differences.

**Models.** Only two ids exist. The gateway picks the real `:free` model behind each, per
request, from a pool it rebuilds hourly from OpenRouter's catalog:

| Virtual model | Router roles | Behind it |
| --- | --- | --- |
| `encode/free-main` | main, planner, reviewer | The strongest free models that support tool calls |
| `encode/free-fast` | explore, summarizer, utility | The fastest free models |

Any other `model` is `model_not_found`. `GET /v1/models` lists both with `context_length`,
`max_output_tokens`, `supports_tools`, `supports_images` and `available`.

**Request.** The gateway rebuilds the request from an allowlist, so a client cannot choose a
model, add fallbacks, pick a provider, enable plugins or web search, or attach files:

- accepted fields: `model`, `messages`, `tools`, `tool_choice`, `parallel_tool_calls`,
  `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `response_format`, `reasoning`,
  `stream`, `stream_options` (anything else is dropped without an error);
- roles `system`, `developer` (sent as `system`), `user`, `assistant`, `tool`; images only as
  `https` links or base64 PNG, JPEG, GIF and WebP data URLs, and only when a model that reads
  images is available;
- at most 128 tools, 4,096 messages and 4 MB of body; `max_tokens` is capped (16,384) and
  defaults to 8,192;
- usage is always requested from the upstream, so quotas settle on real token counts.

**Non-streamed answer.** A normal chat completion, plus `x-encode-model` naming the model that
answered.

**Streamed answer** (`"stream": true`):

```text
HTTP/1.1 200
content-type: text/event-stream
x-encode-quota-remaining: 141
x-encode-quota-reset: 1792800000000

: keepalive

: encode-model acme/big:free

data: {"id":"gen-…","model":"acme/big:free","choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"id":"gen-…","model":"acme/big:free","choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}

data: [DONE]
```

- `: keepalive` comments arrive every 5 seconds while the gateway connects to a model or
  moves on to another one. Count them as liveness. The gateway gives a request up to 50
  seconds to produce its first content.
- `: encode-model <id>` names the model about to stream. Each chunk's `model` repeats it.
- **The commit point.** Until a model has produced its first real content, any failure moves
  on to other free models without the client seeing it. After that the stream is committed:
  the client never sees a different model mid-answer, and the gateway never splices two.
- **Admission comes first.** Exhausted quotas, a busy free tier and an unavailable pool are
  plain HTTP errors **before** any `200`, even when `stream` is true, so a client treats
  them like any other failed request and moves to its next tier.
- **A stream that fails** after it began ends with one in-band error chunk and no `[DONE]`:

  ```text
  data: {"error":{"message":"The free models are busy. Try again shortly.","type":"upstream_error","code":"upstream_unavailable","retry_after":30}}
  ```

  If the upstream reported an error chunk of its own first, the client sees that one, then
  the gateway's. A stream that ends with neither `[DONE]` nor a finish reason was cut off,
  and the gateway reports it as a failure rather than a clean end.
- `x-encode-quota-remaining` (requests left today) and `x-encode-quota-reset` (the next UTC
  midnight, epoch milliseconds) ride on every chat response.

## Errors

Every error is JSON, with the same body in an HTTP response and in a stream chunk:

```json
{ "error": { "message": "…", "type": "rate_limit_error", "code": "rate_limited", "retry_after": 12 } }
```

`retry_after` is in seconds and mirrors the `retry-after` header. Messages are written for
the user and never contain a token, a prompt or an upstream response. `errorAction(code)` in
`@encode/gateway-protocol` returns what a client does for every code, and codes a newer
gateway adds are treated as transient (`backoff`).

| Action | Meaning | Codes |
| --- | --- | --- |
| `refresh` | Get a new access token, retry once | `token_expired` |
| `sign_in` | The session is gone: ask the user to sign in | `auth_required`, `invalid_token`, `invalid_grant` |
| `wait` | Retry after `retry_after` | `rate_limited`, `concurrency_limited`, `free_tier_busy` |
| `next_tier` | The free tier cannot serve this account now: use the next provider in the role's list | `daily_quota_exhausted`, `token_quota_exhausted`, `free_tier_exhausted`, `service_disabled`, `account_suspended`, `account_not_eligible`, `signup_closed` |
| `backoff` | Transient: back off, then use the next tier | `upstream_unavailable`, `upstream_error`, `upstream_timeout`, `internal_error` |
| `update` | This build is too old | `client_outdated` |
| `fix` | The request is wrong; sending it again fails again | `invalid_request`, `model_not_found`, `request_too_large`, `unsupported_media_type`, `not_found`, `method_not_allowed` |

The statuses are `400` for `invalid_request` and `model_not_found`, `401` for the sign-in
codes, `403` for suspended, not eligible and signup closed, `413`, `415`, `426`, `429` for
the limits, `503` for exhaustion and `service_disabled`, and `502`, `504` and `500` for the
upstream and internal failures. The table in the package is the source of truth.

## Limits

Defaults, all settings in `wrangler.jsonc` or secrets (see `apps/gateway/README.md`):

| Limit | Default | Notes |
| --- | --- | --- |
| Requests per account per day | 150 | Resets at UTC midnight; shown by `x-encode-quota-*` |
| Requests per account per minute | 10 | Over the limit is `rate_limited`, with the seconds to wait |
| Input and output tokens per account per day | 8,000,000 and 800,000 | Settled on real usage. A request that failed upstream before the account got anything is handed back, up to 20 a day |
| Concurrent streams per account | 2 | `concurrency_limited` |
| Requests for everyone per day | 950 | OpenRouter allows 1,000 free-model requests a day once the account has bought $10 of credit |
| Requests for everyone per minute | 18 | OpenRouter allows 20. A request over the pace waits up to 8 seconds in the gateway, then gets `free_tier_busy` |

As the day's global budget runs down, each account's share shrinks toward a floor (fair
share), so the first users of the day cannot take it all. Round-the-clock or machine-speed use
is flagged and held to a quarter of the limits for 24 hours, or until an operator clears it. Per-address limits
apply to sign-in (10 starts an hour, 30 polls and 30 refreshes a minute).

## What the gateway logs

Metadata only: an HMAC of the account id, the model, token counts, latency, the outcome and
the request id. Never prompts, completions, tool arguments, tokens, keys or the device id.
`GET /v1/status` returns the data policy text to show before the first free request: free
models are run by providers that may log prompts and train on them, so private work belongs
on the user's own key.
