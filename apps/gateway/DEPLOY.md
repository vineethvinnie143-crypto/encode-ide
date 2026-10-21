# Deploying the gateway

**Nothing here has been done.** No Cloudflare, GitHub or OpenRouter account has been touched, no
secret exists, and nothing is deployed. This is the checklist for the person who owns those
accounts. Allow about an hour. Every command runs from `apps/gateway` after `pnpm install` at
the repository root, and `pnpm exec wrangler` is the pinned Wrangler.

Never commit a key, a token or a `.dev.vars` file. Secrets go in with `wrangler secret put` and
into a password manager, and nowhere else.

## The OpenRouter key

The free tier runs on one OpenRouter key, and that key is the Worker secret `OPENROUTER_API_KEY`.
It serves your own use and every other user's, because everyone reaches the free tier through the
gateway.

- **It lives in one place.** You set it with `wrangler secret put` on your own machine. It is never in
  the app, the repository, `wrangler.jsonc`, `.dev.vars`, CI, a log, an issue or a chat. The app holds
  a short-lived session, never the key, so shipping a build does not ship the key.
- **Only the gateway uses it, and only for `:free` models.** The gateway builds every upstream
  request itself and refuses to send anything else (`src/core/firewall.ts`, checked again just
  before each request and by tests). A client cannot choose a model.
- **A key that has been pasted anywhere is exposed.** That covers a chat message, an issue, a commit and
  a screenshot, and anyone who can read them can use the key. If the key you meant to use has been shared
  like that, put a credit limit on it now, and replace it with a new key (step 3) before the gateway
  serves anyone but you. Open its Activity on OpenRouter's Keys page first to look for requests you
  did not make, then delete it. Paste the new key only at the `wrangler secret put` prompt and into your
  password manager.
- **The key itself carries a $0 credit limit** (step 3), so OpenRouter refuses anything that would
  cost money even if everything above failed. The gateway also alerts if the key ever shows spend.
- **Use a different key for your own work.** To use free models in the app yourself before the gateway
  exists, make a second key and put it in Settings (the app seals it in the OS keychain). Then each
  key can be revoked on its own, and the gateway's Activity shows only the gateway's traffic.

## Decisions to make first

| Decision | Recommendation |
| --- | --- |
| Cloudflare plan | **Workers Paid** (about $5 a month). The Free plan allows 10 ms of CPU per request, and parsing a long streamed answer can pass that. Durable Objects, D1 and KV work on both, and usage at 1,000 chats a day is far inside what the paid plan includes. |
| The gateway's address | Start on `https://encode-gateway.<your-subdomain>.workers.dev`. Put a custom domain on it before any build is released, because the address is baked into the app. |
| Who may sign up | `allowlist`: your own GitHub login first, then testers. `open` only after a beta. |
| OpenRouter credit | Buy **$10 of credit once**. It raises the free-model allowance from 50 to 1,000 requests a day for the whole account, and is never spent by `:free` models. |
| OpenRouter privacy | Free models are served by providers that may log and train on prompts. Allowing that on the account unlocks more of them (step 5), and the app tells users so ([data policy](../../docs/gateway-protocol.md#what-the-gateway-logs)). This is a choice about your users' data, so it is yours to make. |
| Alerts | An incoming webhook for Slack or Discord (optional, step 9). |

## 1. Cloudflare

1. Create or open the Cloudflare account, turn on two-factor sign-in, and subscribe to **Workers Paid**.
2. Sign in the pinned Wrangler:

   ```bash
   pnpm exec wrangler login
   ```

3. Create the database and the key-value namespace. Each prints an id.

   ```bash
   pnpm exec wrangler d1 create encode-gateway
   pnpm exec wrangler kv namespace create CONFIG
   ```

   Put the D1 `database_id` and the KV `id` into `wrangler.jsonc`, replacing the all-zero
   placeholders. While they are placeholders, `wrangler deploy` fails, so an unfinished setup
   cannot go out by accident.

4. Create the tables:

   ```bash
   pnpm exec wrangler d1 migrations apply DB --remote
   ```

## 2. GitHub sign-in

1. GitHub, Settings, Developer settings, OAuth Apps, **New OAuth App**.
   - Application name: `eNCode` (users see it when they approve).
   - Homepage URL: any `https` page about the product. For the authorization callback URL, which
     the form requires and the device flow never uses, enter the same address.
2. On the app's page, tick **Enable Device Flow**. Copy the **Client ID**.
3. Do **not** generate a client secret. The gateway uses the device flow, which needs none, and
   asks GitHub for no scopes, so users approve read access to their public profile and nothing else.
4. In `wrangler.jsonc` `vars`, set `GITHUB_CLIENT_ID` to the client id and `ALLOWED_GITHUB_LOGINS`
   to your login, plus any testers' logins, separated by commas.

GitHub allows 50 code submissions an hour per OAuth app. That is plenty for a beta. A public
release should add a loopback web flow before it needs more.

## 3. OpenRouter

1. Create the account that will own the free tier. Use a dedicated email address and two-factor sign-in.
2. Buy $10 of credit (Credits page). It is bought once, as above.
3. If the key you planned to use was ever pasted into a chat, an issue or a file, this is where you replace it
   (see above): use the new key from the next item, and delete the old one when you are done.
4. Create a new API key (Keys page) named `encode-gateway-free` with a **credit limit of $0**. The gateway
   only ever sends `:free` models, so the key should never spend, and a key with no credit cannot
   pay for anything. The cron job also raises a critical `paid_usage` alert as soon as the key
   shows any spend.
   - OpenRouter does not document whether a key at a $0 limit still serves `:free` models. Step 6 tells
     you. If it fails with a 402 and the `payment_required` alert (the key is "out of credit") while the
     account has credit, raise the limit to **$1** and run step 6 again.
5. Copy the key once, into your password manager. Do not paste it anywhere else.

## 4. Settings and secrets

Generate two random values and keep both in the password manager. The first signs tokens. The second is the
operator API's password, so you will need it again:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Deploy once so the Worker exists. It answers `internal_error` ("not configured correctly") until
the secrets are in, which is the intended failure mode:

```bash
pnpm exec wrangler deploy
```

The first deploy may ask you to register a `workers.dev` subdomain. Then set the secrets. Each
command prompts for the value, and each one redeploys:

```bash
pnpm exec wrangler secret put OPENROUTER_API_KEY   # the new key from step 3, pasted at the prompt
pnpm exec wrangler secret put GATEWAY_SECRET       # the first random value
pnpm exec wrangler secret put ADMIN_TOKEN          # the second random value
```

`ALERT_WEBHOOK_URL` (step 9) is optional. `APP_URL` goes in `wrangler.jsonc` with the other variables;
it is sent to OpenRouter as the app's address and is not a secret. The full list of settings is in the
[README](README.md#configuration).

## 5. OpenRouter privacy and which free models work

OpenRouter's privacy settings and guardrails decide which free models may serve your account. A
free model whose provider may train on prompts is refused unless you allow it, with an error like
`HTTP 404: 0 endpoints out of 1 requested are available matching your guardrail restrictions and data
policy ... Free model training`. On OpenRouter, open Settings, Privacy (and the workspace guardrails)
and allow the free endpoints that may train on or publish inputs. OpenRouter keeps separate settings
for free and paid models. Without that, only the free models that do not train work.

A few free models are reserved for apps that OpenRouter lists at openrouter.ai/apps, and answer
`HTTP 403: ... is only available on agentic harnesses`. Set `APP_URL` (step 4) to eNCode's public
address so OpenRouter can attribute the traffic to the app. Whether eNCode gets listed is OpenRouter's decision.

A live check on 2026-10-21 found 18 free models in OpenRouter's list, and only 1 of the first 6 answered
before these settings were changed. You do not have to get this perfect. The gateway retires a model
that is closed to your key for 15 minutes at a time, never shows the refusal to a user, and serves from the
models that work. `GET /admin/metrics` shows each model's outcomes, and step 6 shows which one answered.

## 6. Check it

Wait five minutes for the cron job to fill the free pool, or force it. Use your `ADMIN_TOKEN`
for the second command:

```bash
curl https://<your-gateway>/v1/status
curl -X POST https://<your-gateway>/admin/pool/sync -H "authorization: Bearer <ADMIN_TOKEN>"
```

Then run the walkthrough the app performs. It prints a code: open the link it shows and approve as
an allowlisted GitHub account.

```bash
node scripts/try-gateway.mjs https://<your-gateway> "Say hello"
```

You should see the free tier available, two models, `Signed in as <you>`, an answer from a
model whose id ends in `:free`, and `Signed out (204)`. Then:

- `GET /admin/status` and `GET /admin/metrics` show the request and the model that served it.
- On OpenRouter, the Activity page shows that request with a cost of $0 and the key's usage
  stays at zero.
- `pnpm exec wrangler tail` shows JSON events (`chat`, `device_poll`) and no prompts or tokens.

If the answer fails, read the code in the message. `free_tier_busy` or `upstream_unavailable`
right after setup usually means the pool is empty (sync it) or step 5 is not done.
`free_tier_exhausted` with the message "unavailable for a few minutes" means OpenRouter refused the
key itself (the `key_refused` or `payment_required` alert says which). Check the secret, and see the
$0 limit note in step 3.

## 7. Before anyone else uses it

- Add testers: `POST /admin/allowlist` with `{"login":"<github login>"}`, or list them in
  `ALLOWED_GITHUB_LOGINS` and deploy.
- Add a Cloudflare rate limiting rule for the path `/admin/*` (Security, WAF), or turn the API
  off when you are not operating the gateway with `pnpm exec wrangler secret delete ADMIN_TOKEN`.
  The token is long and compared in constant time, but it has no throttle of its own.
- Give the address to the app: it is the `gatewayUrl` that `@encode/accounts` and the router's free-tier profile are
  configured with.
- Read the [threat model](../../docs/security/threat-model.md#the-free-tier-gateway-and-accounts) again with the live
  system in mind, and fix anything that no longer matches.

## 8. Day to day

The [README](README.md#operating-it) has the admin API, the alerts and the runbooks:
the kill switch, suspending an account, rotating `GATEWAY_SECRET` and the OpenRouter key, and
blocking a bad model.

To change a non-secret setting, edit `wrangler.jsonc` and run `pnpm exec wrangler deploy`.
To return to the previous version, run `pnpm exec wrangler rollback`. To turn the free tier off
at once, use `PUT /admin/kill-switch`, or set `KILL_SWITCH` to `true` and deploy.

## 9. Alerts (optional)

Create an incoming webhook in Slack or Discord, then:

```bash
pnpm exec wrangler secret put ALERT_WEBHOOK_URL
```

Alerts arrive within five minutes of the cause, each at most once a day. The README lists them
and what to do about each.

## What this costs

The Workers Paid plan is the fixed cost. OpenRouter charges nothing for `:free` requests. The $10
of credit is bought once and stays on the account. Nothing else here is billed at this scale.

## Taking it down

Switch the free tier off first (`PUT /admin/kill-switch`). `pnpm exec wrangler delete` removes the
Worker. Delete the D1 database and the KV namespace from the Cloudflare dashboard, and delete the
OpenRouter key and the GitHub OAuth app. Users' own keys never touch the gateway, so they are
unaffected.
