# eNCode threat model

Version 1, 2026-10-21, written with M0. It covers the desktop app as built from this
repository. The free-tier gateway and accounts (M5), the editor and documents (M4), and the
permission rules, trust, hooks, checkpoints and MCP client (M3) have their own sections at the
end. The CLI and the router get theirs when they land.

Review this document whenever a change touches a trust boundary below, and at the end of
every milestone.

## What we protect

| Asset | Why it matters |
| --- | --- |
| The user's machine | The agent runs commands and writes files. Code execution under the user's account is the worst outcome. |
| Source code and secrets in the workspace | They include `.env` files, credentials, private code, and git remotes with tokens. |
| Model API keys | Keys are paid credentials, and a stolen key bills the user. |
| The user's other data | That covers files outside the workspace, local services, and cloud metadata endpoints. |
| Sessions and settings | Users lose work if these are corrupted or lost. |
| Our free-tier OpenRouter key | Abuse costs money and can get the account banned. It lives only in the gateway. |

## Who we defend against

1. **Content the agent reads.** This is the most likely attacker. A repository, a web page,
   a dependency's README or a tool's output can carry instructions aimed at the model
   (prompt injection). The model is treated as confused, not malicious: anything it decides
   to do is checked by policy, not trusted.
2. **A hostile repository.** A folder the user opens may contain planted executables,
   `.git/config` entries that start programs, symlinks out of the workspace, or skill and
   instruction files.
3. **A hostile web page** in the browser panel, or one fetched by `web_fetch`.
4. **A network attacker** between eNCode and a model provider. Providers are reached over
   HTTPS, except the local servers the user configures.
5. **The supply chain.** That means npm packages, GitHub Actions and the Electron binary.
6. **A malicious contributor** whose pull request hides behavior in source that reads
   differently from how it runs.

Out of scope for v1:
- an attacker with administrator or root rights, or physical access;
- malware already running as the same user. This is noted where it weakens a control;
- the data practices of the model provider the user chooses. For the free tier the gateway
  publishes its data policy (`GET /v1/status`) for the app to show.

## Trust boundaries

```
 untrusted content ──► model ──► agent loop ──► approval policy ──► tools ──► OS / disk / network
 (repo, web, output)    (confused deputy)       (decideApproval)      (main process)

 renderer (sandboxed) ──IPC, sender-checked──► main process ──► keychain, files, child processes
 browser panel iframe ──✕ no preload, IPC refused
```

1. **Model output to tools.** Every tool call passes `decideApproval`
   ([ADR 0004](../adr/0004-command-approval-from-one-grammar.md)). Ask and Plan modes never
   edit or run.
2. **Renderer to main.** IPC is accepted only from the main window's top frame showing the
   app's own page ([ADR 0010](../adr/0010-renderer-isolation.md)).
3. **Main to network.** Model requests go to the profile's base URL with the key bound to
   that origin ([ADR 0008](../adr/0008-api-keys-in-the-os-keychain-only.md)). `web_fetch`
   reaches public addresses only, after per-site approval
   ([ADR 0007](../adr/0007-web-fetch-asks-per-site.md)).
4. **Workspace to programs.** Programs come only from absolute `PATH` entries, never from
   the workspace ([ADR 0005](../adr/0005-programs-from-absolute-path-entries.md)).
5. **Repository to CI.** The workflow token is read-only and actions are pinned by hash
   ([ADR 0012](../adr/0012-windows-first-ci.md)).
6. **Main process to the agent host.** The agent runs in a utility process the main process
   supervises ([ADR 0030](../adr/0030-the-agent-runs-in-a-host-that-clients-drive.md)). Neither
   end trusts the other's messages: envelopes are shape-checked and params are validated against a
   schema before any handler runs. The host asks for a key only when a model call starts, and the
   key vault stays in the main process.

## Threats and controls

Status: **Mitigated** in M0, **Partial** (a residual risk is listed below), or **Planned**
(with the milestone).

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| T1 | Prompt injection makes the agent run a harmful command | Four approval policies, and Auto review allows only proven read-only lines whose real paths stay inside and whose programs live outside the workspace (0004). Subagents inherit the policy (0006). | Partial (R1, R2) |
| T2 | Data leaves in a URL after an injection | First fetch per site asks in every mode and policy but Full access (0007) | Mitigated |
| T3 | SSRF to localhost, the LAN or cloud metadata | Public addresses only, checked at connect time against every resolved address. Same-host redirects, size and time caps (0007). | Mitigated |
| T4 | A repository's git config starts a program (fsmonitor, bare repo discovery) | `core.fsmonitor=false` and `safe.bareRepository=explicit` on every git eNCode runs (0004) | Partial (R3, R4) |
| T5 | A planted `git.exe`, `node.exe` or `.cmd` runs because of its name | Absolute `PATH` entries only, `NoDefaultCurrentDirectoryInExePath`, and Auto review asks when a program resolves inside the workspace (0004, 0005) | Mitigated |
| T6 | File tools escape the workspace through `..`, symlinks, junctions or short names | Paths resolved against the root, real-path checks, deletes confined to the root and sent to the OS trash | Mitigated |
| T7 | The agent plants a git hook, fsmonitor setting or skill for later | Writes to `.git` and `.eNCode` ask under every policy but Full access, in every Windows spelling and on the real path (0004) | Mitigated |
| T8 | API keys read from disk | Sealed by the OS keychain or kept in memory only. Never `plain:`, owner-only files, leftovers removed (0008). | Partial (R5) |
| T9 | A key sent to another server by an edited base URL | Keys are bound to the server origin, and changing the origin drops the key (0008) | Mitigated |
| T10 | A key reaches the renderer, a log or a session file | The renderer learns only whether a key exists. Keys are never persisted outside the vault. | Partial (R6) |
| T11 | Model output injects script into the renderer | Hand-written markdown renderer that escapes everything and allows only a list of tags and protocols. CSP without inline script or eval (0010). | Partial (R7) |
| T12 | A page in the browser panel calls the bridge | No preload in frames, and IPC sender checks refuse child frames and foreign URLs (0010) | Mitigated |
| T13 | An environment variable points the installed app at a hostile page | `VITE_DEV_SERVER_URL` is ignored when packaged (0010) | Mitigated |
| T14 | eNCode's binary is used to run arbitrary code (`ELECTRON_RUN_AS_NODE`, `--inspect`, `NODE_OPTIONS`) | None yet | Planned, M6 (R8) |
| T15 | A broken transcript makes providers refuse every request | Pairing invariant, repair on load, every call answered (0009) | Mitigated |
| T16 | A too-long prompt is sent repeatedly or the session dies | Compaction before each request, and a single compact-and-resend on overflow (0009) | Mitigated |
| T17 | A subagent does what its parent may not | Same mode, policy, approvals and cancellation as the parent (0006) | Mitigated |
| T18 | Source that reads differently from how it runs (bidi controls, zero-width characters) | `scripts/check-sources.mjs` in CI, and the command policy asks for lines containing them (0004, 0012) | Mitigated |
| T19 | A compromised dependency, action or Electron download | Frozen lockfile, one-day minimum release age, skipped install scripts, actions pinned by hash, read-only CI token, checksum-verified Electron download | Partial (R9) |
| T20 | Abuse of the free tier's shared key | The key never ships in the client. Gateway quotas, a `:free`-only cost firewall and a kill switch (0020). Threats G1 to G15 below. | Partial (GR1) |
| T21 | A tampered build or update | Code signing and signed updates | Planned, M6 |
| T22 | Runaway runs, rate limits and hung streams | Step cap, output caps and timeouts on commands and fetches | Partial (R10) |
| T23 | Lost or corrupted sessions | Atomic private writes | Partial (R11) |
| T24 | A crash or a hang in the agent takes the app, or the conversation, with it | The agent runs in its own process, restarted with a growing pause, and the user is told which sessions were mid-turn (0030). Sessions are append-only logs: a crash costs at most the line being written (0031). | Mitigated once the app uses the host (M1) |
| T25 | Hostile or malformed messages between the main process and the host | Both ends check the envelope and validate params against a schema before a handler runs. Errors cross as a code and a message, never a stack (0030). | Mitigated once the app uses the host (M1) |
| T26 | The agent's shell finds credentials in its environment | Commands run with the user's environment minus variables that look like keys or tokens, with programs found only in absolute `PATH` entries, and the command travels in a private script file (0005, 0011). | Partial (R1) |
| T27 | Text in a file or a web page poses as an instruction from eNCode | The system prompt is fixed. What changes arrives as reminders added by the host, and web results are labelled untrusted with a closing tag neutralised (0032). Labels are advisory. | Partial (R2) |
| T28 | Conversation logs expose secrets the agent read | Logs live in an owner-only folder, are never uploaded, and nothing may send one without asking (0031). | Partial (R12) |

## Residual risks

Each item names what remains, why it is acceptable for now, and who closes it.

- **R1. Full access means full access.** Under that policy nothing asks. It is an explicit
  user choice, labeled in the composer.
  - Owner: M3 adds OS sandboxing (Seatbelt, bubblewrap) to bound it on macOS and Linux. It is
    the next M3 pull request, after the one that holds the rules, trust, hooks, checkpoints and
    MCP client.
  - Windows has no equivalent yet. Approvals are the only control there, and the plan's risk
    table says so.
- **R2. Prompt injection inside allowed actions.** Injected text can still steer which
  allowed files the agent reads and what it writes inside the workspace.
  - Untrusted web content is labeled, but labels are advisory.
  - Compaction summaries are produced from transcripts that may contain injected text, and
    the summary sits in a user message (0009). The summarizer is told the transcript is
    data, and approvals still gate every action.
  - Owner: M3. Workspace trust is built ([0041](../adr/0041-folder-settings-grant-only-when-approved.md));
    the reviewer gate follows in the next M3 pull request.
- **R3. Git in a folder whose `.git/config` someone else wrote.** Under Auto review,
  "read-only" git commands such as `git diff`, `git log -p` and `git show` can still start
  programs configured in that file: `diff.external`, textconv drivers, clean filters, a
  pager. The status bar's `git status` can run clean filters too.
  - This needs a hostile `.git/config`, which a clone does not deliver but a copied or
    shared folder can.
  - Owner: M3 workspace trust. Done in the libraries: the bash and PowerShell policies ask
    for git unless the folder is trusted (the trust store is in `@encode/config`) and eNCode's
    git settings are in effect (`core.fsmonitor=false`, `safe.bareRepository=explicit`).
    It acts in the product once the core adopts the new assessor and passes `trusted` (RP7).
- **R4. Repository discovery above the workspace.** Opening a subfolder of a repository
  makes git use the parent's `.git`. Then `git show HEAD:../other/file` can read committed
  files outside the opened folder.
  - Owner: M3. Done in the libraries: a git command asks when its repository starts above the
    workspace (the disk check, `confirmOnDisk`), and `<rev>:<path>` operands that name `..` or
    an absolute path ask. It acts in the product once the core adopts them (RP7).
- **R5. Same-user malware can decrypt keys.** DPAPI and the macOS Keychain protect keys
  against other users and offline disk theft, not against code already running as the user.
  Accepted, as for every desktop app.
- **R6. Provider error messages.** Request errors include up to 600 characters of the
  provider's response, and some providers echo a masked fragment of the key. Low impact.
  - Owner: M2 router, which normalizes errors and redacts anything key-shaped.
- **R7. A renderer compromise is total.** The bridge exposes files and commands, so script
  execution in the renderer equals code execution. Defense in depth still to add:
  - runtime validation of IPC arguments;
  - a packaged-build CSP whose `connect-src` drops `https:` and localhost (the renderer
    makes no network requests itself).
  - Owner: M4, with the renderer rework.
- **R8. Electron fuses are not set.** `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
  `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar` and embedded asar integrity
  validation must be flipped when packaging is reworked.
  - Owner: M6.
- **R9. Build tools run with full access.** Vite, esbuild and TypeScript execute during
  install and build on developer machines and in CI. They are pinned through the lockfile and
  the minimum release age, but not sandboxed. electron-builder downloads its own tooling
  when packaging (not run in CI yet).
  - Owner: M6, with reproducible packaging.
- **R10. Provider resilience.** There is no backoff on 429 and 5xx, no first-token or idle
  watchdog on streams, and no failover.
  - Owner: M2 router (breakers, cooldowns, watchdogs, mid-stream failover).
- **R11. Session persistence.** Sessions are written synchronously on the main thread, so
  large sessions block the UI. A capture cut short by Stop is persisted only with a later
  event, and nothing is flushed on quit.
  - Owner: M1 JSONL sessions (append-only, flushed per event).
  - Status: `@encode/core` has the store (0031). This closes when the app runs on it.
- **R12. Logs keep what the agent saw.** A session log holds file contents, command output and
  anything the user typed, secrets included, and nothing prunes it (0031). It is as exposed as
  the user's own files, and same-user malware reads those too (R5).
  - Owner: M1, a storage view with explicit deletion.

## Verification

- Unit tests cover the command policy, the egress table, program resolution, the key vault,
  private files, compaction and the provider. They include property tests with fixed seeds,
  and each security fix was mutation-checked.
- The end-to-end smoke runs on every pull request on Windows. It checks:
  - the approval cards;
  - a key stored through the real `safeStorage` reaching the provider, and never the
    renderer;
  - Plan-mode subagents unable to write;
  - the web_fetch approval and private-address refusal;
  - compaction after an overflow refusal.

## The free-tier gateway and accounts

Version 1, 2026-10-21, written with M5. It covers `apps/gateway`, `packages/accounts` and
`packages/gateway-protocol`
([0020](../adr/0020-the-free-tier-runs-behind-our-own-gateway.md),
[0021](../adr/0021-sessions-are-rotating-device-bound-refresh-tokens.md),
[0022](../adr/0022-connect-openrouter-with-pkce-on-a-loopback-listener.md)). Nothing is
deployed yet. The controls below are verified by tests and by running the Worker locally, and
the first deploy should be followed by a review of this section.

### What we protect here

| Asset | Why it matters |
| --- | --- |
| The free-tier OpenRouter key | Whoever holds it spends our budget and can get the account banned. |
| The shared free budget | OpenRouter allows 1,000 free requests a day for the whole account. Draining it ends the free tier for everyone. |
| Spend on the key | The key must never pay for a request. Any credit used is a bug or an attack. |
| Sessions | An access token acts as one account for an hour, a refresh token for months. |
| Account data | GitHub id, login and avatar, plus session hashes. No prompts, completions or GitHub tokens. |
| The gateway's secrets | `GATEWAY_SECRET` signs tokens, and `ADMIN_TOKEN` opens the operator API. |

Who we defend against: a user who wants more than their share, by script or with many
accounts; someone holding a copy of another user's session; a client that sends crafted
requests; a network attacker between the app and the gateway; a local process or web page that
can reach a loopback port; and anyone who can read the gateway's logs.

### Trust boundaries

```
 app ──HTTPS, bearer token──► gateway (Worker) ──our key──► OpenRouter ──► free providers
  │                             ├─ Durable Objects: account quotas, daily budget, address limits
  │                             ├─ D1: accounts, session hashes, allowlist
  │                             ├─ KV: kill switch, model pool, overrides
  │                             └─ device flow ──► GitHub (identity only, no scopes)
  └─ loopback listener ◄── browser ◄── OpenRouter consent page   (Connect OpenRouter; no gateway)
```

1. **App to gateway.** HTTPS only (loopback HTTP in development). The app sends a bearer
   token, never a key. The gateway trusts nothing in a request except what the token proves.
2. **Gateway to OpenRouter.** The only place the free-tier key is used. The request is rebuilt
   from an allowlist and checked again before it is sent.
3. **Gateway to GitHub.** Identity only. The GitHub token is used once to read the user's id
   and dropped.
4. **Operator to gateway.** The `/admin` API behind `ADMIN_TOKEN`, and the Cloudflare account
   that holds the secrets.
5. **Browser to loopback listener.** Connect OpenRouter receives a one-time code on the user's
   machine.

### Threats and controls

Status: **Mitigated**, or **Partial** (a residual risk is listed below).

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| G1 | The free-tier key is read from the app, the repository, a log or a response | It exists only as a Worker secret. The app and the repository hold none: `.dev.vars` is git-ignored and its example holds placeholders. The gateway refuses to serve with a missing or malformed secret instead of falling back. The gateway's own error messages are fixed wording. The one place upstream text reaches a client is the reason for a rejected request: it is cut to 300 characters, with the key and anything shaped like one masked first. After a stream's first content, the model's bytes are relayed as they come. They originate behind OpenRouter, which authenticates our key before any provider sees the request, so the key is not in them. Tests feed back upstream answers that echo the key and check that nothing reaches the client or the log, and that logs never contain the key, tokens, the device id, a GitHub token or a prompt. A key that was ever pasted into a chat, an issue or a commit is replaced before it is deployed (DEPLOY.md). | Mitigated |
| G2 | A client reaches paid models or paid features through the proxy | The client cannot name a model. The request is rebuilt from an allowlist, models come from a pool of `:free` ids with zero pricing (at most three fallbacks), and `assertFreeOnly` checks the final body before it is sent. There is no provider routing, no plugins, no web search and no files. The cron raises a critical `paid_usage` alert if the key spent any credit, and the key's credit limit ($0, or $1 if OpenRouter needs it) makes OpenRouter refuse anything that would cost money if the firewall ever failed (DEPLOY.md). | Mitigated |
| G3 | One account drains the shared budget | Admission runs before any upstream call: requests a minute and a day, tokens a day, concurrent streams with leases that expire. A global daily ceiling (950) and a per-minute pacer (18) sit below OpenRouter's limits. Fair share shrinks each account's limits as the day's budget runs down. Accounts active round the clock, or pinned at the per-minute limit, are flagged and held to a quarter for a day. Refunds after upstream failures are capped at 20 a day. | Mitigated |
| G4 | One person makes many accounts | Sign-up is an allowlist until opened. GitHub accounts must be users and at least 30 days old. Sign-in is limited per address, and the global ceiling bounds the total whatever the number of accounts. | Partial (GR1) |
| G5 | A forged or stolen access token | HMAC-SHA256 under a derived key, checked in constant time, with claims validated and a one-hour life. A revoked session is refused at once by the account's Durable Object. Quotas bind to the account, so a stolen token adds no capacity. | Mitigated |
| G6 | A stolen refresh token | Single use, rotated on every refresh, stored only as a SHA-256, bound to the device id. A spent token is honored for 120 seconds, and after that its reuse ends the session on every device. Thirty days unused or 180 in all ends it anyway. | Partial (GR2) |
| G7 | A user is tricked into approving an attacker's sign-in code | The OAuth app asks for no scopes, so the attacker gets that user's free-tier quota and learns their GitHub login, not access to repositories. The app opens only the pinned `github.com` verification link, and an operator can sign the account out everywhere. | Partial (GR3) |
| G8 | The operator API is guessed or abused | Off unless `ADMIN_TOKEN` (at least 32 characters) is set. The token is compared in constant time, every failure looks like a missing route, actions are logged by name without bodies, and pool overrides accept only `:free` ids. | Partial (GR4) |
| G9 | Prompts or identities leak through the gateway | No prompts or completions are kept. Logs hold an HMAC of the account id, the model, counts, latency and the outcome. Addresses serve only as HMAC bucket names for rate limits. OpenRouter receives the HMAC as `user`, never the login. The data policy is published at `GET /v1/status`. | Partial (GR5) |
| G10 | The gateway is used as an open relay or to reach internal addresses | It requests only the configured GitHub and OpenRouter origins (HTTPS, loopback HTTP in development only) and the optional alert webhook. Clients cannot supply a URL. Image links go to the provider and are never fetched by the gateway. | Mitigated |
| G11 | Oversized or endless requests exhaust the Worker | Limits on body (4 MB), messages, tools and parts. Output tokens are capped. There is a 50 second first-content budget, an idle timeout and a 9 minute ceiling. The upstream is aborted when the client leaves, and lease expiry frees the slot of a crashed request. | Mitigated |
| G12 | Abuse or a failing provider needs a stop | A kill switch (variable or KV), account suspension and sign-out, model block and pin overrides, per-model cooldowns, and alerts to a webhook. | Mitigated |
| G13 | A hostile or intercepted gateway answer reaches the app | `@encode/accounts` accepts HTTPS (or loopback HTTP) only, refuses redirects, caps response sizes, checks the shape of tokens, pins the verification link to `github.com` and strips control and bidirectional characters from messages shown to users. | Mitigated |
| G14 | Session tokens leak from the user's machine | Tokens and the device id live in a `SecretStore` backed by the OS keychain (0008), never in settings, logs or the renderer. The state the UI reads holds no token. A saved session that cannot be parsed counts as signed out. | Partial (R5) |
| G15 | Another process or web page attacks the OpenRouter callback port | PKCE with S256, a constant-time `state` check, a `Host` check against DNS rebinding, GET only, one use, a random port and a short life, with strict response headers. The main process makes the exchange, and the key goes straight to the key vault (0022). | Mitigated |

### Residual risks

- **GR1. Many accounts, one person.** The allowlist, the account-age check and per-address
  limits raise the cost, but someone with several aged GitHub accounts gets several shares.
  The global ceiling bounds the total and fair share keeps the day usable for others.
  - Owner: M6 beta. Watch flagged accounts and the metrics, and add another signal before
    sign-up opens to everyone.
- **GR2. A copied session plus its device id.** Same-user malware can read both from the
  keychain and refresh once as that device. The real app's next refresh then presents a spent
  token and the session ends everywhere. Accepted, as for keys (R5).
- **GR3. Device-code phishing.** The user is told to check the code against the one shown in
  eNCode. With no scopes the damage is limited to that user's free-tier quota.
- **GR4. One bearer token opens the operator API.** It is long, compared in constant time and
  can be left unset. It has no per-address throttle of its own, so add a Cloudflare rate
  limiting rule on `/admin/*` if the API stays on (DEPLOY.md).
- **GR5. Providers and the gateway see prompts.** Free providers can log and train on what
  they receive, and a compromised gateway could read prompts in flight. The gateway stores
  none. The app must show `data_policy` before the first free request and point private work
  at the user's own key.
  - Owner: the app's UI and router work.
- **GR6. One Cloudflare account and one OpenRouter account hold everything.** Taking either
  over takes the free tier. Use two-factor sign-in and tokens scoped to this Worker, and
  rotate the secrets after anyone leaves (DEPLOY.md).
- **GR7. The kill switch in KV takes about a minute to reach every location.** Setting
  `KILL_SWITCH` and redeploying is immediate. Accepted.

### Verification

- The gateway core has unit tests for tokens, sign-in and refresh (including grace, reuse and
  device mismatch), chat streaming and failover, the cost firewall (with property tests),
  quotas, the global budget, the pool, the admin API, the cron job and configuration.
- `accounts-client.test.ts` runs the real `@encode/accounts` against the real gateway core,
  in process: sign-in, single-flight refresh, lost answers, replay after the grace window,
  device mismatch, sign-out, suspension and a scan of the gateway log for secrets.
- `packages/accounts` tests the loopback listener's refusals (wrong state, wrong host, wrong
  method, second use), PKCE, the saved session's parser and the HTTP hardening.
- `pnpm --filter @encode/gateway test:workers` runs the Worker in `wrangler dev` (workerd with
  local Durable Objects, D1 and KV) against fake OpenRouter and GitHub servers. It walks
  through sign-in, streaming, failover, refresh, sign-out, the cron job, the kill switch and a
  suspension, then checks every request the fake OpenRouter received against the firewall's
  promises. CI runs it on Windows.

## The editor and documents

Version 1, 2026-10-21, written with M4. It covers `packages/text`, `packages/diff`,
`packages/editor`, `packages/editor-view` and the desktop app's open documents
([0033](../adr/0033-the-editor-is-our-own-engine.md),
[0034](../adr/0034-documents-live-outside-the-ui-store.md)). The terminal, the language
server client and the review of the agent's edits get their entries when they land.

### What we protect here

| Asset | Why it matters |
| --- | --- |
| The user's unsaved work | An edit that exists only in memory. Losing it, or writing it over a newer file, cannot be undone. |
| The files on disk | A save writes the document's text to a path. It must be the file the user opened, in the project they opened it in. |
| What the user sees | Review depends on the screen showing what the file holds. If text can read differently from how it is stored, a reviewer approves code they did not read. |
| The renderer | File content is untrusted input to the code that draws it, and the renderer holds the bridge (R7). |
| The window's responsiveness | A file that freezes the editor costs the user their session. |

Who we defend against: a repository or a pull request that hides behavior in text, which the
agent reads as well as the user; a file that is huge or built to be slow; text that arrives
through the clipboard or a drop; and programs the user runs (the agent, a formatter, git)
writing to a file that is open.

### Trust boundaries

```
 disk ──workspace.read (UTF-8, 12 MiB cap)──► open documents ──► editor state ──► view ──► DOM (text nodes only)
 view ──edits──► editor state ──► snapshot ──workspace.write (path resolved in main)──► disk
 clipboard, drop ──text/plain only──► view
```

1. **Disk to document.** The main process reads the file. It refuses files over 12 MiB and
   files that are binary or not valid UTF-8, so the editor never holds bytes it cannot write
   back.
2. **Document to screen.** Text reaches the DOM as text nodes. The characters that would make
   it read differently never reach the DOM at all: the view draws a marker in their place.
3. **Document to disk.** A save sends a workspace-relative path and the text. The main process
   resolves the path against the root and checks it (T6, T7). The path was the one the
   document was opened under, and documents are dropped when the project changes.

### Threats and controls

Status: **Mitigated**, or **Partial** (a residual risk is listed below).

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| E1 | A file reads differently from how it runs, or hides text: bidi controls, zero-width and filler characters, hidden ASCII in the tag block (T18 for the repository's own sources) | Control, bidi, zero-width, filler and tag characters are drawn as labelled markers (`U+202E`) and the character itself never reaches the DOM. Every line is laid out in stored order (`unicode-bidi: bidi-override`), so a bidi control that did slip through could not reorder what follows. Markers take the place of the characters in cursor movement and clicks, and copying still copies the real text. | Partial (ER1, ER2) |
| E2 | File content, a paste or a drop runs as markup or script in the renderer | The view writes text nodes and class names only. Highlighting yields token kinds as numbers, never markup. Paste and drop take `text/plain` and nothing else, and dropped files are left to the main process, which cancels navigation (0010). CSP without inline script or eval. | Mitigated |
| E3 | A save lands in the wrong file or project | Documents are keyed by workspace-relative path. Renaming a file or folder moves its documents, deleting one closes them, and opening, switching or closing the project settles unsaved changes and then drops every document. The main process resolves every write against the workspace root (T6). | Mitigated |
| E4 | Edits are lost without the user deciding so | "Unsaved" is derived from the text and the history point, never a flag that can go stale. A save marks exactly the snapshot it wrote, so typing during the write stays unsaved. Closing a tab, the others or all of them, and changing project, ask first. Undo history survives tab switches and the panel being hidden. | Partial (ER6) |
| E5 | A file changes on disk under an open document (the agent, a formatter, git), and the editor shows or saves stale text | A change the workspace watcher or the agent reports reaches a document without unsaved changes as a line diff of its own, so the cursor and scroll stay and it can be undone. A document with unsaved changes keeps the user's text, and its save first reads the file and compares it with the text last read or written there. If someone else changed it, the save asks before overwriting. Cancel leaves the changes unsaved. | Partial (ER3, ER4) |
| E6 | A huge or pathological file freezes the window | Files over 12 MiB do not open. Only the lines in view are drawn, long lines in pieces, and the scroll range is scaled so a million-line file scrolls natively. Highlighting runs on a time budget, stops where states converge, and tokenizes at most the first 10,000 characters of a line. Counting find results is time-sliced. | Partial (ER5) |
| E7 | The editor reaches beyond itself: clipboard, drag and drop | The clipboard is read and written only inside the user's own copy, cut and paste events, on the hidden textarea. A drag that carries files is not handled by the editor. | Mitigated |

### Residual risks

- **ER1. Right-to-left text is shown in stored order.** That is deliberate: the display
  cannot be used to disguise code. It costs readability for Hebrew, Arabic and similar
  scripts.
  - Owner: M4. An opt-in view that reorders text but keeps every marker is possible later.
- **ER2. Look-alikes and invisible variation selectors are not marked.** Letters that look
  alike across scripts (Cyrillic `a` for Latin `a`), a no-break space, an ideographic space
  and the braille blank draw like the characters they imitate. Variation selectors (U+FE00 to
  U+FE0F, U+E0100 to U+E01EF) are invisible, but emoji and some Japanese text need them, so
  marking them would flag ordinary text.
  - The agent reads these files too. Stripping or flagging hidden characters in what tools
    return to the model belongs to the agent's side, not to the editor.
  - Owner: M3 (reviewer gate: flag identifiers that mix scripts, report hidden characters in
    diffs), and M4 for an opt-in "show non-ASCII" mode.
- **ER3. A change on disk while a document has unsaved changes is not shown.** The editor
  keeps the user's text and the save asks before overwriting, but the prompt only names the
  file: there is no comparison to look at. The check and the write are two steps, so a change
  in the milliseconds between them is lost. The watcher can miss events too (it stops on an
  error and skips some folders), which the save-time check covers.
  - Owner: M4 follow-up. A "compare with disk" view built on the review machinery, and a
    write that fails when the file's modification time moved.
- **ER4. Encoding and line-ending fidelity.** Files are UTF-8 only. A byte order mark is
  dropped on save, a file with mixed line endings is written back with one (CRLF if any line
  has it), and a lone carriage return becomes a line feed. Git shows these as changes.
  - Owner: M4 follow-up. Keep the encoding, the byte order mark and each line's ending in
    the document.
- **ER5. A user-supplied regular expression can backtrack for as long as it likes.** Counting
  is time-sliced between matches, but nothing can interrupt one `RegExp` call in the
  renderer, so a pattern with catastrophic backtracking on a long line freezes the window
  until it returns. The pattern is the user's own.
  - Owner: M4. Run the counting in a worker with a deadline, or refuse nested quantifiers.
- **ER6. Unsaved text is held in memory only.** A crash or a killed process loses what was
  typed since the last save. There is no recovery file.
  - Owner: M4 follow-up, with the conflict check: write recoverable copies of dirty
    documents to the profile folder.

### Verification

- `@encode/text`, `@encode/diff` and `@encode/editor` have unit and property tests: change
  sets against a plain-string model, diffs that reproduce their target and hunks that apply and
  unapply, editing commands, history, search, the highlighter (including where it stops) and
  `reload`.
- `line.test.ts` checks that control, bidi, filler and tag characters become markers of their
  own and that highlighting never loses a character, in nine languages. `docs.test.ts` covers
  the open documents: unsaved from the text, saves that outlive typing, changes from outside
  (the cursor stays and the document is never reported as edited), whether the file is still
  the one that was read, and renames.
- 34 browser scenarios drive the view in a real Chromium over the DevTools protocol: caret and
  mouse, a million and a half lines, IME, the clipboard, long lines, find and replace, review,
  fractional display scaling, a hidden container, switching documents and the Tab escape. One
  checks that none of the characters the markers stand for is in the DOM. CI runs them on
  Windows.
- The end-to-end smoke types into the real app, saves, undoes and checks the file on disk,
  checks that a change from disk keeps the cursor, the discard prompts and that a file
  changed behind the editor's back is not overwritten until the user says so (Cancel writes
  nothing, Overwrite does), and opens the editor's own menu.

## Permission rules, trust, hooks, checkpoints and the MCP client (M3)

Written with the pull request that added `@encode/config`, `@encode/hooks`,
`@encode/checkpoints` and `@encode/mcp` and extended `@encode/permissions`. These packages
are libraries with their own tests; the core wires them in after it merges (RP7). The OS
sandbox, search providers, subagent definitions and the reviewer gate are later M3 pull
requests and get their rows when they land.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| P1 | A cloned repository grants itself authority: allow rules, hooks, environment variables, MCP servers | Its restrictions apply, its grants wait for trust and for approval of that exact configuration by digest. A change from a pull or from the agent turns the grants off again (0041). | Partial (RP7) |
| P2 | A project's `.mcp.json` starts a program or contacts a site | A project server runs only in a trusted folder, after approval of its exact entry, and never replaces a server the user set up. A changed entry stops at once (0044). | Partial (RP7) |
| P3 | An MCP result steers the model | Results are labeled as outside text, cut to size, stripped of control and invisible characters, and every call asks. A server's hints never decide anything, and sampling and elicitation are refused (0044). | Partial (RP1) |
| P4 | An MCP server or its configuration leaks credentials | Stdio servers get an allowlisted environment, headers go only to the configured site, redirects are never followed, and `${VAR}` expands only in approved entries (0044). | Partial (RP2) |
| P5 | A command line hides a second command from the rules (`;`, `&&`, `$(...)`, wrappers, here-documents, `bash < script`, redirects) | Rules are judged over the parsed commands: a deny or ask on any command decides the line, an allow needs a rule for every command, run-time words never satisfy a literal, and a redirect that writes is never allowed by a Bash rule (0040). | Partial (RP7) |
| P6 | A path rule is sidestepped by spelling: `..`, extra slashes, case on Windows | Paths are normalized before matching (`.` and `..` resolved), and Windows matching ignores case (0040). | Partial (RP3) |
| P7 | A hook that broke, hangs or loops waves a call through or stalls the agent | A `PreToolUse` hook that cannot run or times out denies the call, every hook has a timeout and its whole process tree is stopped, and `Stop` hooks may send the agent back three times at most (0042). | Partial (RP6) |
| P8 | Rewind overwrites the user's work or writes outside the workspace | Changed files are conflicts and need force. Each target is checked on its real path (inside the workspace, never in `.git` or `.encode`), restored bytes are checked against their hash, and the rewind is journaled first (0043). | Mitigated (RP4) |
| P9 | A rewind plan is altered on its way through the UI | The plan carries a fingerprint, and applying it re-derives everything from the manifest and the disk (0043). | Mitigated |
| P10 | "Always allow" saves a rule wider than the user expects, or damages a settings file | `suggestRule` proposes a prefix only for everyday commands, the exact command for shells, interpreters and the like, and nothing for lines no rule can describe. `saveRule` validates the rule, refuses a file it cannot read as settings, writes atomically, and approves a folder's new digest only if it was approved just before (0040, 0041). | Mitigated |

### Residual risks

- **RP1. Labels on MCP results are advisory.** A server can still put instructions in a result.
  The control is that every call asks, with the server and tool named, and that a result
  cannot change a permission.
- **RP2. `${VAR}` in an approved project MCP entry can send an environment value to the URL
  the entry configures.** The approval card must name the variables the entry reads.
  - Owner: the app's approval card.
- **RP3. Rules read shell words as text.** A link inside the workspace that points at a denied
  file is not recognised in a shell word, and PowerShell 5.1's `-Recurse` follows directory
  junctions. The file tools resolve real paths before they consult the rules.
  - Owner: the OS sandbox (next M3 pull request) on macOS and Linux. Windows keeps prompts.
- **RP4. Checkpoints see only the file tools.** A shell command's side effects are not
  recorded, the agent must be idle while a rewind runs, and file modes and owners are not
  saved. Redo restores files, not the conversation.
- **RP5. MCP over HTTP has no OAuth.** A server that needs it does not connect. Redirects are not
  followed, so a server behind one fails instead of leaking headers.
- **RP6. Hooks and approved MCP servers run with the user's full rights.** That is what they are
  for. A folder cannot install one without the user's approval, and the sandbox will not cover
  them.
- **RP7. The packages are not in the app yet.** Until the core adopts them (the wiring pull
  request, now that the core is in `main`), none of P1 to P10 acts in the product. `docs/m3-integration.md` lists the
  wiring.
  - Owner: the integration pull request.

### Verification

- `@encode/permissions` tests the rules engine, with fixed-seed property tests where a rule
  has a definition to check against: the line splitter (bash and PowerShell), prefix and
  wildcard matching, run-time words, redirects, fed commands, path normalization, and
  `suggestRule` (every suggestion parses, allows its own line and nothing more).
- `@encode/config` tests settings loading, the held-back grants, digests that ignore key order,
  trust that is not inherited, MCP server approval, the atomic store, and `saveRule`.
- `@encode/hooks` runs real child processes for exit codes, JSON answers, timeouts and tree kills.
- `@encode/checkpoints` is tested against an in-memory disk, against a model of the definition
  under random sessions with and without outside edits (mutations of the service make it fail),
  and on a real disk including links and private file modes.
- `@encode/mcp` talks to an in-memory server, a real HTTP server (JSON, event streams, sessions,
  legacy SSE, redirects) and a real child process, and checks names, configuration, approval,
  the adapter and the manager's restarts.
- CI runs all of it on Windows. The packages were also type-checked against the core pull
  request's seams in a scratch merge.
