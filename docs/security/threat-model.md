# eNCode threat model

Version 1, 2026-10-21, written with M0, and updated on 2026-10-22 when the desktop app moved
onto the agent host (T23 to T25, R11), when the Browser tab began lifting framing rules
(T29, R13) and when every model call moved onto the router (T35 to T38, R16). It covers the
desktop app as built from this repository. The free-tier gateway and accounts (M5), the editor and documents (M4), and the
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
3. **A hostile web page** in the browser panel, or one fetched by `WebFetch`.
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
   that origin ([ADR 0008](../adr/0008-api-keys-in-the-os-keychain-only.md)). `WebFetch`
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
| T1 | Prompt injection makes the agent run a harmful command | Four approval policies. Auto review runs a proven read-only line whose real paths stay inside and whose programs live outside the workspace (0004), and puts any other command through fixed checks and then a Reviewer model before the person is asked; a model's yes never widens what the checks allow (0059). Subagents inherit the policy (0006). Every command runs in the operating system's sandbox, which limits what it can change whatever the policy (0063). | Partial (R1, R2, RP9) |
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
| T18 | Source that reads differently from how it runs (bidi controls, zero-width characters) | `scripts/check-sources.mjs` in CI, and the command policy asks for lines containing them (0004, 0012). What a file write or a command adds is scanned too, and the findings are shown on the card, in the step and to the model (0060). | Mitigated |
| T19 | A compromised dependency, action or Electron download | Frozen lockfile, one-day minimum release age, skipped install scripts, actions pinned by hash, read-only CI token, checksum-verified Electron download | Partial (R9) |
| T20 | Abuse of the free tier's shared key | The key never ships in the client. Gateway quotas, a `:free`-only cost firewall and a kill switch (0020). Threats G1 to G15 below. | Partial (GR1) |
| T21 | A tampered build or update | Code signing and signed updates | Planned, M6 |
| T22 | Runaway runs, rate limits and hung streams | Step cap, output caps and timeouts on commands and fetches | Partial (R10) |
| T23 | Lost or corrupted sessions | Append-only logs in an owner-only folder, so a crash costs at most the line being written (0031). Settings and the key vault use atomic private writes. | Partial (R11) |
| T24 | A crash or a hang in the agent takes the app, or the conversation, with it | The agent runs in its own process, restarted with a growing pause, and the user is told which sessions were mid-turn (0030). Sessions are append-only logs: a crash costs at most the line being written (0031). | Mitigated |
| T25 | Hostile or malformed messages between the main process and the host | Both ends check the envelope and validate params against a schema before a handler runs. Errors cross as a code and a message, never a stack (0030). | Mitigated |
| T26 | The agent's shell finds credentials in its environment | Commands run with the user's environment minus variables that look like keys or tokens, with programs found only in absolute `PATH` entries, and the command travels in a private script file (0005, 0011). On Linux and macOS the sandbox also hides the usual credential folders and takes out the variables that lead to the person's agents and keyrings (0063). | Partial (R1, RP12) |
| T27 | Text in a file or a web page poses as an instruction from eNCode | The system prompt is fixed. What changes arrives as reminders added by the host, and web results are labelled untrusted with a closing tag neutralised (0032). Labels are advisory. | Partial (R2) |
| T28 | Conversation logs expose secrets the agent read | Logs live in an owner-only folder, are never uploaded, and nothing may send one without asking (0031). | Partial (R12) |
| T29 | A page in the Browser tab reaches the app, or the tab drops a protection the page relied on | The page is another origin, in a frame sandboxed without top navigation, and it has no bridge. Only the responses of the main window's own sub-frames lose X-Frame-Options and `frame-ancestors`, so the tab can show them; every other header and directive stays, and no other request is touched. | Partial (R13) |
| T30 | The agent clicks and types in a program that runs commands or holds credentials: a terminal, an editor's terminal, a password manager, a system tool | The Computer tool never operates them. `decideApproval` refuses them under every policy, Full access included, and the backend marks eNCode's own window (by process id and program path) and programs running as administrator, and never works on them (0050, 0053). | Partial (R14) |
| T31 | Text on screen steers the model into input the user did not want, or into sending what cannot be taken back | The first use of each application asks, with a warning for browsers, chat and mail. Screen text arrives inside `<screen_content>` marked as data. Keys that leave the window and typing into password fields are refused, a turn is capped at 150 inputs, and moving the mouse or typing stops the agent until the user speaks (0050). | Partial (R2, R14) |
| T32 | Screenshots are kept or sent where they should not be | Images are marked transient: no log ever holds one, only the newest is kept and sent, and a model that cannot read images gets none. The picture the helper takes paints over every window of another program in front of the window and every password field (0050, 0053). | Mitigated |
| T33 | Two chats drive the mouse at once and act on each other's screens | One chat at a time sends input; another is told the desktop is busy, and the hold ends after 30 seconds without input, on stop or on close (0050). | Mitigated |
| T34 | A log or a diagnostics report that a tester sends to someone else carries a key, a conversation or the user's name | Every log line is scrubbed before it is kept: keys and tokens by shape, the stored keys by value, e-mail addresses and user names in paths. A report holds no file contents, conversations or remembered folders, is scrubbed again with the keys read fresh, is written only where the user says and is never sent by eNCode (0051). | Partial (R15) |
| T35 | A key reaches a place the person did not choose: the agent host's configuration, a log, or another server than the one it belongs to | The host's configuration carries a revision number for each key and never a key. When the router needs one it asks the main process, naming the origin it is about to call, and the main process answers only for the origin of that profile's address. An address is `https://`, or `http://` for a server on this computer, with no user name, password, query or fragment: the dialog says so, the model list request (which carries the key) refuses anything else before it is made, and the router drops the connection with the same words. A changed address drops the stored key (0052). | Partial (R16) |
| T36 | A model call is billed that the person did not choose: a paid model behind a free one, a second key's account, a free model that turns out to charge | Free only is on until the person chooses a model that costs money, and choosing one asks first. In that mode the router refuses every model that is not free. It never falls from a free model to a paid one, or from one key's account to another's, and a model that was billed although it was listed free counts as paid from then on, with a notice (0023, 0024, 0052). | Partial (R16) |
| T37 | A refused key, a spent balance or a paused connection goes unnoticed, or the same notice floods the person | The router's alerts reach the interface as one notice each, the same one at most once a minute, with a button to the Settings tab that helps. Settings → Roles lists every connection's state and what is paused until when (0052). | Mitigated |
| T38 | The router's saved state exposes a prompt or a key | `eNCode-models.json` holds health, cooldowns, free-request tallies and learned prices. It is written atomically with owner-only permissions every 30 seconds and at shutdown, and holds no prompt, reply or key (0052). | Mitigated |
| T39 | The desktop helper is replaced or altered, or reads what the user types | The helper is built on the machine from sources that are in the repository and embedded in the app, into a folder named by their hash; the hash of the built file is recorded beside it and checked before every start, so a changed or half-written copy is built again, never run. It starts with a short list of environment variables and no network code, and its input hooks read only the "injected" flag of an event (never a key, a position or text) and exist only while an action runs (0053). | Partial (R17) |
| T40 | The agent works on the person's computer and they cannot tell, or cannot make it stop | Computer use is off until the person turns it on in Settings. While a session uses it, a banner is in front of everything, without taking the keyboard, with a Stop button and Ctrl+Alt+Esc, a combination registered only for that time and one the Computer tool refuses to press. Stop cancels every session that uses the computer, the way the chat's Stop does; the person's own mouse or keyboard stops the agent too (0053, 0054). | Partial (R18) |
| T41 | The banner is read, clicked or spoofed by the agent, or its page is used to reach the app | The banner is left out of screenshots and, as a window of eNCode, is never used by the Computer tool. Its page runs one script allowed by hash under `default-src 'none'`, in a sandboxed process with a session of its own that grants no permission and cancels every request, and cannot navigate or open windows. The main process answers only the banner's own top frame on its four channels, and the renderer's channels refuse it (0054). | Mitigated |
| T42 | A web search key reaches a place the person did not choose: the host's configuration, a log, a redirect, or another address | The key is sealed by the keychain under `search:<provider>` like a model key, or held in memory only, and is among the secrets logs and reports are scrubbed of. The host's configuration names the provider and carries no key; the host asks the main process for it at each search, in a request that allows Brave, Tavily and Exa and nothing else, and holds it for the length of the request. Addresses are fixed in the code (there is no setting for one), and a request that carries a key follows no redirect (0058). | Partial (R5, R19) |
| T43 | The words the agent searches for go to a service the person did not pick, or a failing search quietly moves to another provider | One provider is chosen in Settings, and a search never moves to another: a failure says what happened and points to Settings. The first search of a session asks and names the provider's host, and choosing another provider asks again (0007, 0058). Full access skips the question (R1). | Partial (R1) |
| T44 | A search result (a title, a snippet, an address) carries instructions, markup or a non-web address | Results are cut to eight, with a title and a snippet of bounded length, tags and entities taken out of the words, only http and https addresses kept, and the model's allowed and blocked domains applied again to what comes back. The list reaches the model inside the untrusted web content block with its closing tag neutralised (0032, 0058). Labels are advisory (R2). | Partial (R2) |

## Residual risks

Each item names what remains, why it is acceptable for now, and who closes it.

- **R1. Full access means full access.** Under that policy nothing asks. It is an explicit
  user choice, labeled in the composer.
  - The operating system's sandbox bounds it
    ([0063](../adr/0063-the-agents-commands-run-in-the-operating-systems-sandbox-and-the-person-is-told-what-it-does-not-hold-back.md)):
    under every policy, Full access included, a command changes only the project folders, a
    temp folder and the package caches, on Linux, macOS and Windows. On Windows it can still
    read, use the network and end other programs (RP12).
  - Where the sandbox is off or cannot start, approvals are the only control, and the Sandbox
    screen says so.
- **R2. Prompt injection inside allowed actions.** Injected text can still steer which
  allowed files the agent reads and what it writes inside the workspace.
  - Untrusted web content is labeled, but labels are advisory.
  - Compaction summaries are produced from transcripts that may contain injected text, and
    the summary sits in a user message (0009). The summarizer is told the transcript is
    data, and approvals still gate every action.
  - Owner: M3. Workspace trust is built ([0041](../adr/0041-folder-settings-grant-only-when-approved.md))
    and so is the reviewer gate ([0059](../adr/0059-auto-review-asks-a-model-about-low-risk-commands-behind-checks-the-model-cannot-overrule.md)).
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
- **R11. Session persistence.** The agent host appends each record to the session's log as it
  happens, off the UI thread, and syncs the file to disk when the session closes, not after
  every record. A crash of the app or the host costs at most the line being written. A power cut
  or a system crash can cost what the operating system had not yet written.
  - Owner: hardening, a sync at the end of each turn.
  - Status: the prototype's single synchronous session file is gone with the switch to the host
    (0030, 0031).
- **R12. Logs keep what the agent saw.** A session log holds file contents, command output and
  anything the user typed, secrets included, and nothing prunes it (0031). It is as exposed as
  the user's own files, and same-user malware reads those too (R5).
  - Owner: M1, a storage view with explicit deletion.
- **R13. The Browser tab is a frame of the app window.** A site that forbids framing is shown
  anyway (T29), which also lets it be framed by a page it did not choose to be framed by,
  inside this window only. The frame keeps `allow-same-origin` with scripts, as any site
  needs, so a page can read its own cookies and storage, and it can still open pop-ups.
  - Owner: the browser view of UI-7, which is its own surface with its own session, permission
    denial and no header rewriting.
- **R14. Desktop control is as strong as the user's own hands.** Under Full access nothing asks
  before a program is used, and under the other policies one click allows a program for the whole
  session. A browser the user is signed in to can send, buy or delete in their name, and a click
  that did what the model meant can still be what an injected page wanted.
  - The never list is by program file name, so a copy of a terminal under another name is not
    caught. The backend marks windows by what they are (console windows, elevated processes), which
    narrows this, and the owner of the list is the Windows backend's record.
  - Owner: the Windows backend (0053 masks other programs' windows and password fields in
    screenshots), and the banner and stop key (0054) that tell the person and let them end it.
- **R15. A report is scrubbed by shape.** A key of a kind nobody has seen, that eNCode does not hold, can
  get through; and a log line can name a file or folder when something went wrong with it. The report says so and is
  plain text, so the tester reads it before sending it.
  - Owner: whoever adds a log line, who logs no content; the patterns grow with the services eNCode talks to.
- **R16. Free models and the key in the host.** A free model's provider may keep and learn from what is sent to it, and OpenRouter
  routes a free request to whichever provider has room, so eNCode cannot tell which one. The dialog and Settings → Roles say so, and
  "Only use free models" does not mean private. The key is also in the host's memory for the length of one request: a compromised
  host can ask for any key, but only for the origin its profile points at, and cannot read the key store. What a provider lists
  as free is its own word, which the router distrusts only after a bill proves it wrong.
  - Owner: the gateway (0020), which will serve the free models from a key of ours, and a per-model "may train on prompts" flag
    from OpenRouter's catalog if it ever offers one.
- **R17. The desktop helper runs with the user's rights, from a folder the user's other programs can write.** The check of the
  built file against its recorded hash catches a damaged or half-written copy; it does not stop a program that already runs as
  the user from replacing both the file and the record, and such a program can do everything the helper can without it. An
  antivirus program may also block a helper it has never seen, which stops the tool and is reported as such. While an action
  runs, the helper's input hooks are the only code in eNCode that sees every keystroke and mouse event of the machine; they read
  one flag of each and nothing else, and a reviewer should check that it stays so.
  - Owner: the Windows backend (0053), and whoever changes `helper/Input.cs`.
- **R18. The banner can be covered, and the key can be taken.** A window that is always on top, or a full-screen program that has
  the display to itself, can hide the banner; the banner is on the screen eNCode is on, not on every screen; and another
  program may hold Ctrl+Alt+Esc, in which case the banner shows no key and only the button stops the agent. Stopping ends a turn,
  it does not undo what the agent already did. None of this lets the agent act without the person having turned the feature
  on and allowed each application, and the person's own input stops it from inside the helper.
  - Owner: the banner window (`electron/computer-overlay.ts`, 0054).
- **R19. A web search key is in the host for the length of a search, and a compromised host can ask for it again.** The
  main process answers `searchKey` for the three providers that use one, to the host and to nothing else, and cannot tell
  a search from a request made to send the key away; the host is the process that reads web pages and tool output. The
  key opens searches on the person's account with that provider and nothing else, which is also what a model key held by
  the same host for the length of a call opens at its provider (0052). Use a key with a spending limit.
  - Owner: whoever changes `electron/agent-host/runtime.ts`. The OS sandbox (0063) confines the agent's commands, not
    the host.

## Verification

- Unit tests cover the command policy, the egress table, program resolution, the key vault,
  private files, compaction and the provider. They include property tests with fixed seeds,
  and each security fix was mutation-checked.
- The end-to-end smoke runs on every pull request on Windows. It checks:
  - the approval cards;
  - a key stored through the real `safeStorage` reaching the provider, and never the
    renderer;
  - Plan-mode subagents unable to write;
  - the `WebFetch` approval and private-address refusal;
  - the `WebSearch` approval naming the host of the provider chosen in Settings, a change of provider applying to the
    next search, and a search key sealed on disk and never handed to the page (0058);
  - compaction after an overflow refusal;
  - what the model is sent (the project's instructions arrive as a reminder, never in the
    system prompt) and the session logs on disk (owner-only, no key in them);
  - the About box and a diagnostics report, which must hold no key that was just stored.
  - the first start (the Connect dialog, a model of one's own checked with a real tool call through the router, the model
    menu and the Roles tab), and a provider call whose key was asked for by origin (0052).
- The same run packages the app, then starts the unpacked program, the portable program and the
  installed program (installing and uninstalling it silently) and checks that the bundled
  interface loads, the build names its commit, and the agent process answers (0051).

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
are libraries with their own tests. The permission rules, workspace trust, "Always allow" and
the Permissions screen are wired into the app (0055, P11 to P13), and so are hooks, checkpoints
and rewind (0056, P14 to P17) and the MCP client with its screen (0057, P18 to P22). The
operating system's sandbox is P29 to P34 (0063). Web search providers have their
rows in the main table (T42 to T44, 0058). The Reviewer, the scan for hidden characters and subagent
definitions with safe reads of repository files are P23 to P28 (0059 to 0061).

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| P1 | A cloned repository grants itself authority: allow rules, hooks, environment variables, MCP servers | Its restrictions apply, its grants wait for trust and for approval of that exact configuration by digest. A change from a pull or from the agent turns the grants off again (0041). | Mitigated for rules, environment, extra folders, hooks (0056) and MCP servers (0057) |
| P2 | A project's `.mcp.json` starts a program or contacts a site | A project server runs only in a trusted folder, after approval of its exact entry, and never replaces a server the user set up. A changed entry stops at once (0044). In the app the approval card names the command or address it would run (0057). | Mitigated (RP6) |
| P3 | An MCP result steers the model | Results are labeled as outside text, cut to size, stripped of control and invisible characters, and every call asks. A server's hints never decide anything, and sampling and elicitation are refused (0044). What a server says about itself reaches the model as labeled notes in the turn's reminders, cut to size, with the block's own tags defanged, and never in the system prompt (0057). | Partial (RP1) |
| P4 | An MCP server or its configuration leaks credentials | Stdio servers get an allowlisted environment, headers go only to the configured site, redirects are never followed, and `${VAR}` expands only in approved entries (0044). The approval card names the variables and headers an entry sets or reads, never their values (0057). | Mitigated (RP2) |
| P5 | A command line hides a second command from the rules (`;`, `&&`, `$(...)`, wrappers, here-documents, `bash < script`, redirects) | Rules are judged over the parsed commands: a deny or ask on any command decides the line, an allow needs a rule for every command, run-time words never satisfy a literal, and a redirect that writes is never allowed by a Bash rule (0040). | Mitigated; the shell assessor is in the app (RP3 for what text cannot see) |
| P6 | A path rule is sidestepped by spelling: `..`, extra slashes, case on Windows | Paths are normalized before matching (`.` and `..` resolved), and Windows matching ignores case (0040). The file tools ask the rules about the real path. | Mitigated for the file tools; partial for shell words (RP3) |
| P7 | A hook that broke, hangs or loops waves a call through or stalls the agent | A `PreToolUse` hook that cannot run or times out denies the call, every hook has a timeout and its whole process tree is stopped, and `Stop` hooks may send the agent back three times at most (0042). A hook also stops with the turn, and where there is no shell to run it in a guard denies (0056). | Mitigated in the app (RP6) |
| P8 | Rewind overwrites the user's work or writes outside the workspace | Changed files are conflicts and need force. Each target is checked on its real path (inside the workspace, never in `.git` or `.encode`), restored bytes are checked against their hash, and the rewind is journaled first (0043). In the app the dialog lists every file with what would happen, flags what changed since the agent wrote it, and overwrites that only when the person ticks it; a rewind runs only while the session is idle (0056). | Mitigated (RP4) |
| P9 | A rewind plan is altered on its way through the UI | The plan carries a fingerprint, and applying it re-derives everything from the manifest and the disk (0043). The page sends only the fingerprint and the choice, the main process checks the request's shape, and a plan the files have moved past is refused as stale (0056). | Mitigated |
| P10 | "Always allow" saves a rule wider than the user expects, or damages a settings file | `suggestRule` proposes a prefix only for everyday commands, the exact command for shells, interpreters and the like, and nothing for lines no rule can describe. `saveRule` validates the rule, refuses a file it cannot read as settings, writes atomically, and approves a folder's new digest only if it was approved just before (0040, 0041). The card shows the exact rules it will write and where, and the default is the person's private settings (0055). | Mitigated |
| P11 | A settings file that cannot be read, or an entry that cannot be understood, leaves the app on defaults that allow what the file denied | The folder's snapshot is `broken` and every tool refuses with the reason; the Permissions screen and the banner above the composer say what is wrong. Reads are retried, and a missing file is not broken (0055). | Mitigated |
| P12 | The assessor, the card and the Permissions screen disagree because each read the files on its own, or a stale picture decides | One snapshot per folder serves all three and is rebuilt when the text of any watched file differs from the text it was built from. A rule saved by "Always allow" applies after the card has been answered, and the notice says whether it applies now or waits (0055). | Mitigated |
| P13 | The page, or something it loads, trusts a folder or saves a rule | Trust, approve, revoke and rule changes are one IPC handler that serves only the app's top frame and checks the action's shape and size; trusting a home folder or a drive root needs a second confirmation; the agent has no tool for any of it, and a write into `.encode/` changes the folder's digest, so what it grants waits for the person (0010, 0055). | Mitigated |
| P14 | A `PreToolUse` guard is silently missing: its settings cannot be read, or an entry under it is skipped as a typo | A hooks value or an entry under `PreToolUse` (or a misspelling of it) that cannot be understood makes the folder `broken`, and every tool refuses with the reason instead of carrying on without the guard (0042, 0056). | Mitigated |
| P15 | A hook from a cloned repository runs code the person never read | A folder's hooks run only when the folder is trusted and its settings, as they are now, were approved; the Permissions screen shows the text that waits. They run with the person's rights, in the agent's environment with secret-looking variables removed unless the settings name them (0041, 0056). | Mitigated (RP6) |
| P16 | The record of what the agent changes fails, and either stops a guard from running or makes a rewind promise what it cannot do | The recording hooks come first and cannot throw: a failure is told once and the person's hooks still run. The write itself is refused, naming the file, when its earlier version cannot be kept, so a change that cannot be taken back is not made (0056). | Mitigated |
| P17 | A rewind cuts the conversation while files are still wrong, or runs while the agent writes | The conversation is cut only when every file went back, and a rewind holds the session so no turn starts in the middle and the dialog is disabled while the agent works (0056). | Mitigated |
| P18 | Opening a cloned folder, or the screen that lists its MCP servers, starts a program the person never read | Looking starts nothing: the banner reads with `start: false`, which brings no server in line with the files and reports from the settings and the person's approvals alone. A server starts when a chat is opened in the folder, and only if the settings allow it: the person's own, or a project's after the folder is trusted and that exact entry was approved. A server that waits never starts (0057). | Mitigated |
| P19 | A server keeps running from an entry that is no longer the approved one: a pull or the agent changed `.mcp.json` | One hub per folder follows the folder's snapshot, read again before every turn and every tool call. A changed entry has a new digest: its server stops at once and waits for approval again. While the snapshot is broken no server runs. "Approve" carries the digest the card showed and is refused when the entry changed since, when the folder is not trusted, or when nothing waits (0044, 0055, 0057). | Mitigated |
| P20 | The agent writes `.mcp.json` to get a program started | A write to the top-level `.mcp.json` asks whatever a rule says, and "Always allow" offers no Edit rule for it. A written entry is new to the digest, so it waits for approval anyway; a write under `.encode/` is protected already (0041, 0057). | Mitigated |
| P21 | The page, or something it loads, starts, approves or restarts a server | Report and act are IPC handlers for the app's top frame and for the open folder only. The host checks an action before doing anything (the type from a list, a name the configuration allows, a digest of 64 hexadecimal characters). The agent has no tool for it, and approving needs the folder trusted (0010, 0057). | Mitigated |
| P22 | Turning a server off damages a settings file, or costs the folder the approval of its grants | The name goes into `disabledMcpjsonServers` only, which takes permission away and is left out of what a folder's approval covers (0041). The file is read as JSON first and written atomically; one that cannot be read is never overwritten. A project's server is turned off in the person's own local settings, not in the shared file (0057). | Mitigated |
| P23 | Under Auto review a model approves a command that does harm: it was fooled by text the agent read, or it is weak | Fixed checks come first and never read what the model said, so a command that is privileged, networked by hand, outside the project, destructive in git, publishing or unreadable is never put to it. The Reviewer sees only the person's last requests and the one command, answers in a fixed format, and approves only with low risk. Whatever it approves is inside the project and local (0059). | Partial (RP9, R1) |
| P24 | Text in the command or the files asks the Reviewer to approve ("the user already agreed") | The action is data in a tag with a random suffix, and the Reviewer's instructions say to ignore anything in it that addresses the Reviewer. It is not given files, tool results, web pages or the conversation, only the person's own words. A command that looks planted by what the agent read is to be declined, and the reasons are shown (0059). | Partial (RP9) |
| P25 | The Reviewer is down, slow, off-format or declining everything, and the agent stalls or is waved through | Every failure puts the question to the person: no model for the role, 20 seconds without an answer, an answer that is not the format, a command too long to read. The Reviewer then stays quiet for 30 seconds, and three declines in a row stop it until the person answers one. Stopping the turn is not taken for a failure (0059). | Mitigated |
| P26 | The agent writes invisible or look-alike characters into a file or a command and the person approves what they cannot read | The lines a call adds are scanned for direction controls, invisible, tag and control characters, stray variation selectors and look-alike letters. The findings are on the approval card, in the step and in a note to the model, and quote the text with markers instead of the characters (0060). | Partial (RP10) |
| P27 | A cloned repository uses its agent, skill or instruction files to read another file on the disk (a link to a key), to hang eNCode (a named pipe) or to flood it (a huge file) | Those files are read as regular files of bounded size, without following links, without blocking, with at most 64 agent files per folder, and only if the folder stays inside the project once links are resolved. The user's own folders may use links (0061). | Partial (RP11) |
| P28 | A subagent definition from a repository grants more than the parent has or runs without end | A definition can only narrow its tools; the tools no subagent may have stay excluded; the mode, policy, approvals and Reviewer are the parent's; its step limit can shorten the run and never lengthen it past the person's own (0006, 0061). | Mitigated |
| P29 | A command changes what lies outside the project: the person's documents and settings, what runs at sign-in, the registry | Every command the agent runs is confined by the operating system: only the project folders, their git directories, a temp folder and the package caches are writable, under every approval policy (0063). | Mitigated on Linux and Windows; macOS until it has run on a Mac (RP16) |
| P30 | A command plants what runs later outside the sandbox: a git hook, git's configuration, the folder's settings, an MCP server | Those paths stay read-only inside the writable folders on every system. On Windows they are marked again before every command, and that hold is best effort, which the Sandbox screen says. A repository without a hooks folder gets an empty one first (0063). | Partial (RP12, RP14) |
| P31 | The sandbox holds less than the person is told, or is off without their knowing | Each engine must pass a test at start (a write inside allowed, one outside refused); one that fails is unavailable, with its reason on the Sandbox screen, and the settings can require the sandbox so that no command runs without it. The screen names the engine and says in a sentence each thing it does not hold back on this system (0063). | Mitigated |
| P32 | A repository's settings turn the sandbox off or widen it | A folder's files can only tighten it. `allowWrite` and `allowRead` are read from the person's own settings only, and a key a folder may not set is ignored and reported (0041, 0063). | Mitigated |
| P33 | The agent takes a command out of the sandbox | Only the person can let a command run outside it: it asks under every policy, Full access included, Read Only refuses it, and no rule, "Always allow" or Reviewer answers for the person. The settings can forbid asking (0063). | Mitigated |
| P34 | Preparing a folder on Windows opens more than the project to commands | A whole drive or share, the home folder and what holds it, the folders where programs keep their settings, Windows' own folders, and the helper's and the program's folders are refused. The folders marked are listed in the sandbox's state, and `release` takes the marks off (0063). | Partial (RP13) |

### Residual risks

- **RP1. Labels on MCP results are advisory.** A server can still put instructions in a result.
  The control is that every call asks, with the server and tool named, and that a result
  cannot change a permission.
- **RP2. `${VAR}` in an approved project MCP entry can send an environment value to the URL
  the entry configures.** The approval card names the variables the entry reads and the
  headers and variables it sets (0057), so the person decides knowing it; the values are
  never shown.
- **RP3. Rules read shell words as text.** A link inside the workspace that points at a denied
  file is not recognised in a shell word, and PowerShell 5.1's `-Recurse` follows directory
  junctions. The file tools resolve real paths before they consult the rules.
  - Owner: the OS sandbox (0063), which bounds what a shell word can reach for writing on every system, and for
    reading on Linux and macOS.
- **RP4. Checkpoints see only the file tools.** A shell command's side effects are not
  recorded, the agent must be idle while a rewind runs, and file modes and owners are not
  saved. Redo restores files, not the conversation. The Rewind dialog says so every time.
- **RP5. MCP over HTTP has no OAuth.** A server that needs it does not connect. Redirects are not
  followed, so a server behind one fails instead of leaking headers.
- **RP6. Hooks and approved MCP servers run with the user's full rights.** That is what they are
  for. A folder cannot install one without the user's approval, and the sandbox (0063) does not
  cover them: it confines the agent's commands.
- **RP7. Closed.** The MCP client was not in the app until 0057; P2 to P4 and the server
  halves of P1 and P4 now act in the product.
- **RP8. A folder's chats share its servers.** A server that keeps state keeps one state for
  all of them, so what one chat made it hold, another chat's calls can see. A server also runs
  for up to five minutes after the folder's last chat is closed. Turning a server off, or
  taking back its approval, stops it for every chat at once.
- **RP9. The Reviewer is a model.** It can approve something it should not, or decline something fine. What it can
  approve is bounded by the fixed checks (inside the project, local, no publishing, no network by hand), and a wrong
  decline costs the person one re-ask. The checks read a command's words, not the program behind them: code the agent
  writes and then runs (a `package.json` script it edited, then `npm run build`) reaches the Reviewer by its name. The
  Reviewer is told to ask when a command runs software the project does not already use, and the edit is in the thread,
  but neither contains it.
  - Owner: the OS sandbox (0063, R1), which bounds what such code can change. Where it is off or cannot start, work on
    code you do not trust under Workspace Write.
- **RP10. The scan warns and does not refuse.** A file built by a shell command or a generator is outside it, and a
  person can approve a card that lists findings. The model is told to remove what it did not mean to write.
- **RP11. Other files a repository can fill are not yet read with the same care.** `.encode/settings*.json` and
  `.mcp.json` are read by `@encode/config` and `@encode/mcp` with a plain read: a link in them is followed and a named
  pipe blocks the reader.
  - Owner: the hardening step after the sandbox.
- **RP12. On Windows the sandbox holds writes only.** A command can read what the person can read, use the network and
  end the person's other programs, so a key or a file it can read it can also send. Its hold on the protected paths
  is best effort: they cannot be written, but the folders around them are the command's to change. The Sandbox screen
  says each of these in a sentence. Linux holds all of it back and macOS reads, the network and the protected paths.
  - Owner: none planned. Hiding files and blocking the network for one program need more than a program without
    administrator rights can set up. Where a project's hooks or settings matter, keep approvals on (Workspace Write or
    Auto review): a command that changes them is still asked about.
- **RP13. The marks on Windows stay.** A folder the sandbox marked can be written by any program of the person's that
  runs at the low integrity level, not only by eNCode's commands, until the marks are taken off. Few programs run at
  that level, and the folders that may be marked leave out the home folder, drives, settings folders and Windows' own.
  - Owner: UI-6, a way to take the marks off from the Sandbox screen (`release` exists).
- **RP14. What does not exist yet is not held.** A protected path that is missing when a command starts can be created
  by it. What it creates under `.encode/` or in `.mcp.json` waits for the person's approval anyway (0041, 0057), and a
  missing hooks folder is made before the first command. Not yet protected: the git folders of submodules under
  `.git/modules`, and hooks that a repository's git configuration places inside the project (husky's `.husky/`), whose
  changes show in the diff.
  - Owner: the hardening step.
- **RP15. Git Bash on Windows is outside the sandbox.** With "Run commands in PowerShell" off, commands run in Git Bash
  unconfined, and the screen says so. Git's hook scripts and, by default, its ssh use Git Bash's runtime and can fail
  inside the sandbox while a Git Bash is open; the agent then asks to run that command outside.
  - Owner: none; it is how that runtime is built.
- **RP16. The Seatbelt profile has not run on a Mac.** The test at start keeps a profile that does not hold from being
  used, and the screen then says the sandbox is unavailable.
  - Owner: the first Mac build.

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
- `@encode/workspace` tests the snapshot: rebuilds only on changed text, a failing read retried,
  a broken file that refuses everything and heals when fixed, a deny entry that cannot be
  understood failing closed, the trust and approval flow, and the actions the screen may take
  (shape, size and scope checked). Its hook and rewind tests cover hooks that wait for trust,
  settings read again before a prompt, the agent's environment, a guard that cannot be read
  stopping the folder, a write refused when its earlier version cannot be kept, a failing record
  that is told once and still lets prompt hooks run, and a plan the files moved past. Its MCP
  tests cover the hub with an in-memory transport: a project's server waiting for trust and
  then for approval, a changed entry stopping its server, the folder's files followed, the key
  of the tools staying put across a reconnect, turning off and on (and the file that still
  turns it off), broken settings running nothing, a server that fails or is slow, a look that
  starts nothing, hubs shared by sessions and closed when idle, and the shape of every action
  the screen may send.
- The end-to-end run drives the app: a command asks, "Always allow" saves one rule in the
  private file and trusts the folder, the same command then runs unasked and a different one
  asks, settings that arrive from a pull wait behind a banner and the Permissions screen shows
  them before they are approved, a rule is added and removed by hand, and trust is taken back.
  A second scenario runs a folder's hooks: they stay quiet until the folder is trusted, then log
  the prompt and each change of a file, and a guard refuses a command before it can ask. Through
  the Rewind dialog the agent's changes to one request go back (files only), Undo brings them
  back, a file the person edited since is left alone unless overwriting is ticked, and "Code and
  conversation" puts the request back in the composer. A third scenario runs MCP servers with a
  real child process: the banner names the project's server that waits and a look starts
  nothing, the screen shows the person's own server running and the project's one waiting (its
  approval blocked until the folder is trusted), approving starts it and lists its tools, the
  agent calls them (a tool is asked about by name, and "Always allow" saves one rule for that
  tool only), the server's notes reach the model as labeled outside text, turning a server off
  and on writes the settings file and stops and starts the process, and changing the entry
  stops the server and asks again.
- The tests for the Reviewer (0059) cover the fixed checks in both shells (what passes, what stops, and that a stopped
  line stays stopped under quoting, spacing and wrappers), the Reviewer's prompt, parsing and every failure path, and in
  the loop and the session: a decline reaching the model and not the person, a doubt becoming a card, a repeat served
  from memory, a session grant and a hook that asked skipping the Reviewer, subagents using the parent's, and the
  streak. The scan for hidden characters (0060) and the reading of repository files (0061) have their own tests,
  including links and named pipes where the system will create them.
- An Auto review scenario in the end-to-end run answers the Reviewer from the fake provider: a command is approved and
  runs, one is declined and does not, one is passed to the person on a card that says so, and a force-push is stopped
  by the fixed checks without the Reviewer being asked. It also checks what the Reviewer was sent: no tools, the request
  and one action, nothing else.
- The sandbox (0063): the policy, the settings and how they merge, the bubblewrap arguments and the Seatbelt profile
  are unit tests, and bubblewrap runs for real on Linux where user namespaces are allowed (writes inside and not
  outside, the protected paths, hidden credentials, a private `/tmp`, other processes out of reach). On Windows the
  engine runs in CI against the real helper: writes, deletes and renames inside the project; writes outside it, in the
  Startup folder and in the registry refused; writes, deletes and replacements of the protected files refused; a git
  commit; nested programs; a leftover program ended; the start-up cost; the marks taken off again. The shell,
  workspace and screen tests cover the PowerShell default, a folder that cannot turn it off, leaving the sandbox only
  with the person's answer, and every sentence the screen shows.
- CI runs all of it on Windows. The packages were also type-checked against the core pull
  request's seams in a scratch merge.

## The Review tab and the git eNCode runs itself (UI-4)

Written with the pull request that added `@encode/git` and the Review tab
([0064](../adr/0064-the-review-tab-reads-git-itself-and-stages-a-hunk-the-way-git-add-p-does.md)). It covers the git
commands eNCode runs on the person's behalf: reading a review, staging, unstaging and reverting files and hunks,
committing and pushing. The agent's own git commands are the shell's (T-rows and P29 to P34).

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| G1 | The renderer, or a page that got into it, makes the main process run git with arguments of its choosing | The renderer sends scopes, actions and a message, never arguments. Each is checked in the main process: known kinds, branch names that cannot read as options, commit ids, hunk ids and fingerprints of fixed shapes, paths without NUL under 4 KB, a message under 64 KB. A path must name a file the scope lists and resolve inside the repository; options end at `--` or `--end-of-options`, and paths are taken literally. | Mitigated |
| G2 | A repository's config starts a program when eNCode reads it | Every command carries `core.fsmonitor=false` and `safe.bareRepository=explicit`, which outrank every config file; reads run with `GIT_OPTIONAL_LOCKS=0`, so `git status` does not rewrite the index and run its hook; `log.showSignature=false`. Diffs are eNCode's own, so no diff driver or textconv runs. | Mitigated |
| G3 | The wrong program, or another repository, is used | git is found on PATH by absolute path, never a `git.exe` in the folder. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, the object-store variables, `GIT_EXTERNAL_DIFF` and `GIT_DIFF_OPTS` are dropped. No terminal prompt can hang a command, and each has a time limit and an output limit. | Mitigated |
| G4 | An action changes something other than what the person saw: the file changed since, or the hunk would land elsewhere | Each file carries a fingerprint of both sides as shown; an action reads them again and refuses when they differ, and a hunk must still be found in the fresh diff and still fit. Actions run one at a time. A hunk is put into the index by the same code that drew it. | Mitigated |
| G5 | A revert destroys work | Revert all asks first. A revert keeps the files' bytes (up to 8 MB each, the last 20 reverts) and Undo puts them back when nothing changed them since; a new file goes to the Recycle Bin. | Partial (GR1) |
| G6 | Committing or pushing runs code the agent planted | Hooks and filters run on commit, push and staging, as they do for the person's own git. The sandbox keeps the agent's commands from writing `.git/hooks` and `.git/config` (P29 to P34), on Windows best effort. | Partial (GR2) |
| G7 | A drafted commit message is steered by the changes it describes | The changes, file names and subjects are framed as data and the model is told to ignore instructions in them. The draft is only text in a box: nothing is committed until the person presses Commit, and the drafting model has no tools. | Mitigated |
| G8 | Review comments reach the agent as instructions the person did not write | Comments are typed by the person; the quoted line is marked as a quote. Sending them is a press of Send, shown in the thread like any message. | Mitigated |
| G9 | A large or hostile review freezes the window | Files over 2 MB, or past 48 MB read in one review, are listed without lines; a diff that runs out of time is marked approximate; the list draws only the rows on screen and a line shows at most 2,000 characters. Text reaches the DOM as text nodes. | Mitigated |

### Residual risks

- **GR1. A revert of a file over 8 MB cannot be undone,** and neither can one whose file changed again after it.
  - Owner: none planned; the Recycle Bin covers new files, and git still has what was committed or staged.
- **GR2. Hooks run on commit.** On Windows the sandbox holds `.git/hooks` and `.git/config` best effort (RP12), a
  command run outside the sandbox with the person's answer can write them, and the git folders of submodules and hooks
  a repository keeps inside the project (husky's `.husky/`) are not held yet (RP14). Changes to the latter show in the
  review before a commit runs them.
  - Owner: the hardening step.
- **GR3. Pushing uses the person's credentials** through git's credential helper, which may show its own window. The
  Review tab pushes only the current branch, to its upstream or to `origin`.
  - Owner: none; it is the person's push.

### Verification

- `@encode/git` runs against real repositories made in a temporary folder: staging, unstaging and reverting single
  hunks while the rest stays, a stale picture refused, undo refused when the file moved on, endings kept on both sides,
  renames, binary and large files, submodules, filters that force whole files, a repository opened from a folder
  inside it, commit messages drafted from the staged changes within a budget, and the hunk header written as git
  writes it. Its parsers (status, raw diff, objects) and hunk code have unit and property tests.
- The main process's checks of every request have their own tests (branch names, commits, hunks, paths, messages).
- The renderer's model of the list (rows, heights, wrapping by columns, folding, comments, paths between the folder and
  the repository) is unit tested.
- The end-to-end run makes the demo folder a repository and drives the tab: the change shows with its colours, one of
  two hunks is staged and git agrees, it is committed with the message typed over the drafted one, a file is reverted
  and Ctrl+Z brings it back.

## The Turn view: reverting from the agent's record (UI-4b)

Written with the pull request that added the Review tab's Last turn view
([0065](../adr/0065-the-turn-view-reads-the-agents-record-and-writes-back-only-over-what-the-person-saw.md)). It
covers the new write path: the person reverting part of what one request changed, written by the agent host from the
checkpoint record, with no git involved.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| V1 | The renderer, or a page that got into it, uses the review to write a file of its choosing | The renderer names a session, a request and an action on a file it was shown; it never sends a path to write or bytes. The main process checks the ids' shape, reads the record again and finds the file in it; the host's schema checks the hashes, the limits and the file name, and accepts bytes only as an `ArrayBuffer`. The host then writes only a file the record tracks, by absolute path, inside the workspace and outside `.git` and `.encode`, checked on its real path. | Mitigated |
| V2 | A revert undoes work done after the picture was taken (a later request, the person, a formatter) | Every action carries the fingerprint of the file as shown; the main process refuses when the record and the disk give another one. The host writes only while the file holds the hash the person saw. A file a later request changed again is read only. | Mitigated |
| V3 | A revert races the agent's own writes | The view is read only while the conversation's agent works; a write is refused then, and holds the session while it runs, so no turn starts in the middle. | Mitigated |
| V4 | A revert cannot be taken back | The host keeps the bytes it replaces in the record before writing (up to the 20 MB it keeps of any file; a larger file is read only), and Undo puts them back over the bytes the revert wrote. The undo list lives until the app closes. | Partial (VR1) |
| V5 | The record and a later rewind disagree, and the person's revert is flagged as someone else's edit, or overwritten | A review write is recorded as a `wrote` line of its own, so both the review and the Rewind dialog take it as what eNCode last left there. | Mitigated |
| V6 | A huge request freezes the window or fills memory | The view shows up to 2 MB per file and 48 MB per request; the rest is listed without lines. A file too large to show is hashed without its bytes being held. | Mitigated |
| V7 | Files outside the workspace, which the record does not keep, are written | They are listed by path with nothing read, and are read only. | Mitigated |

### Residual risks

- **VR1. Undo of a revert lasts until the app closes.** The kept copies stay in the record, but the list of what can be
  undone is not saved; after a restart a revert is taken back by hand or with the Rewind dialog of a later request.
  - Owner: none planned.
- **Changes made by commands are not in the record** (as for the Rewind dialog, P8), so the view does not show them.

### Verification

- The checkpoint service's tests cover the versions a request's files had (found, left, changed again by a later
  request or by someone else), the limits and the reasons a version is not read, files outside the workspace, writes
  only over the expected hash with the replaced bytes kept, kept copies put back, made folders removed, and a rewind
  after a review write finding no conflict.
- The host's tests carry a request's changes and a write across a port, bytes included, and refuse every other shape.
- The main process's Turn view is tested with a fake record: hunks, files and everything reverted and undone, a stale
  picture refused with nothing written, read-only files, and a busy session.
- The end-to-end run opens the view from the change card in a folder without git, reverts one change and deletes a
  created file, and Undo brings each back; the change card's Undo then opens the Rewind dialog on the files alone.

## Mentions, the palette and slash commands (UI-5a)

Written with the pull request that added the command palette and the message box's `/`, `@` and `$` pickers
([0066](../adr/0066-what-a-message-mentions-comes-from-the-core-under-the-tools-rules-and-the-palette-runs-the-menus-actions.md)).
It covers the new read path: files and skills that come with a message without a tool call.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| W1 | A mention reads a file the agent would have had to ask for (`@~/.ssh/id_ed25519`, `@C:\secrets.txt`, a file a rule refuses) | The renderer only writes text; the core resolves mentions when the message is sent. A file comes only from inside the workspace or an extra root, or when a rule allows it, and never when a rule denies or asks (the folder's rules are brought up to date first, on the real path). Anything else is named in a "Not attached" list, so the model reads it through Read, where the rules and the approval apply. | Mitigated |
| W2 | A mentioned file's text poses as the person's instructions | It comes in a `<mentioned_files>` block that calls it the project's text, not instructions, apart from the person's words; the thread, the title, the request digest and compaction treat the block as eNCode's. Labels are advisory. | Partial (R2) |
| W3 | Mentions fill the context or the bill | At most 8 files and folders, 100,000 characters each and 120,000 in all, read the way Read reads them (no images, PDFs, notebooks, binary or very large files); a folder lists up to 200 entries; a file mentioned again unchanged comes as one line. Skills: at most 3, 32,000 characters each, and one already in the conversation comes as a short note. | Mitigated |
| W4 | `$name` brings instructions a rule keeps from the agent | A rule about `Skill(name)` that is not an allow leaves the skill to the Skill tool, where it applies. Skills come only from the person's folder and the workspace's `.encode/skills`, as the Skill tool finds them. | Mitigated |
| W5 | Text in the message, or a code sample, attaches a file nobody pointed at | Mentions inside code spans and blocks are ignored; only whole words that start with `@` or `$` count, and a path that does not exist is left as text. | Mitigated |
| W6 | A palette entry or slash command does something its menu item would not, or while it should not | The palette and the slash commands run the command registry's actions, under the same enabled checks as the menus; a word that is no command is not sent at the first Enter. | Mitigated |
| W7 | The agent is stopped by a stray Esc | The first Esc only arms Stop and says so; a second within 1.5 s stops. An Esc a field, menu, picker or card used does not count, and approvals and questions keep Esc for themselves. | Mitigated |

### Residual risks

- **A mention inside the workspace is read without asking**, as Read is under every policy: a repository's own files
  can still carry instructions (R2).

### Verification

- The core's tests cover finding mentions (quotes, trailing punctuation, code spans), files and folders attached,
  "Unchanged" on a repeated mention, the notes for a denied, asked, non-text and outside file, an allow rule for a file
  outside, skills called once and again, a long skill cut, and the limit of three; the session's test sends a message
  with both and has the model edit the mentioned file without a Read.
- The renderer's tests cover the pickers' triggers, ranking and writing, the palette's ranking and recent picks, every
  slash command having a runner, and the command map (Ctrl+K and Ctrl+Shift+P, Alt+M, nothing bound twice).
- The end-to-end run opens the palette from the message box, runs Session status from it and from `/status`, refuses an
  unknown command at the first Enter, opens a settings page found by its words and the model list with Alt+M, sends a
  message with a file and a skill picked from the lists and checks both reached the model and the edit needed no Read,
  and stops a streaming answer with Esc twice after one Esc did not.

## Steering, effort, the Reviewer, find and changing shortcuts (UI-5b)

Written with the pull request that lets a message steer a running turn, sets the reasoning effort per role, asks the
Review role's model about a change, finds words in a session and lets the person change any shortcut
([0067](../adr/0067-steering-goes-through-what-a-request-goes-through-the-reviewer-reads-the-change-as-data-and-a-shortcut-leaves-typing-alone.md)).
The new paths are a message that enters a running turn, a change sent to a model that reads it as text, and a settings
entry that decides what a key does.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| K1 | A message that steers a running turn skips what a request goes through | Each waiting message goes through the `userPromptSubmit` hook, where a block drops it with a notice, brings what it mentions under W1 to W5, and is stored as an entry of the session with an id the client chose: a fresh UUID no entry has, or the call is refused. | Mitigated |
| K2 | A steering message is lost, or reaches the model twice, when the turn ends as it is sent | The loop stops taking messages where it decides the turn ends; what no step took goes back to the client, which sends it as the next request. A message is either in the turn, with its entry, or in the next request, never both. At most 20 wait. | Mitigated |
| K3 | An effort level runs up the bill or breaks requests | Levels are kept per role, known roles and levels only; the host puts the role's level on that role's requests, and the adapters send it only to models with a dial. A role left out is left to its model. The level shows on the chip and in /status. | Mitigated |
| K4 | The change under review instructs the Reviewer ("approve this", "say nothing about auth.ts") | One request with no tools, so the Reviewer can only answer. The instructions call the change and its file names data. Each file sits in a block whose end tag carries 12 random hex characters the change cannot guess. The reply must be JSON: at most 12 findings, each on a file of the review and a line number, with capped text; the rest is dropped. Findings are comments the person reads, and only the person sends them to the agent. | Partial (R2) |
| K5 | The Reviewer is sent more than the change, or text that should not leave the machine | It reads only the change the person chose in the Review tab, as hunks with 10 lines of context, up to 120,000 characters; lock files, minified files, source maps, binary and very large files are named, not read. It goes to the model the person set for the Review role, through the router (0052). | Partial (residual below) |
| K6 | Find changes the thread or what it shows | Find reads the page's text and marks it with the CSS Custom Highlight API: no element is added and nothing is sent or run. It opens folds only while it looks, and marks at most 1,000 matches. | Mitigated |
| K7 | A settings entry binds a key that takes over typing, a field's keys, Windows' keys or the computer tool's stop | The main process keeps only command ids (no `__proto__`) with up to 4 printable ASCII chords, up to 300 entries. The registry refuses, wherever the file came from, a chord without Ctrl or Alt that is no function key, the Windows key, Ctrl+C, X, V, Z, Y, A, Ctrl+Shift+Z, Ctrl+Enter, Ctrl with the keys that move by words, Alt+F4, Alt+Tab, Alt+Space, Alt+Esc, Alt with the number pad, Ctrl+Esc, Ctrl+Shift+Esc, Ctrl+Alt+Delete, Shift+F10, Ctrl+Alt+Esc and Ctrl+Alt with a key AltGr types, and the chords of commands that cannot change. Ctrl+Alt+Esc also stays a global shortcut of the main process (0054), out of the renderer's reach. | Mitigated |
| K8 | One key does two things, or a changed shortcut fires inside a field that needed the key | A chord goes to one command: the person's choice takes it from the command that ships with it, and the first command named keeps a chord named twice. A key a field already used (Ctrl+Enter in a comment, the editor's keys, the terminal prompt's Enter, Tab and arrows) stays the field's. | Mitigated |

### Residual risks

- **A review is advice.** A change written to mislead can still steer what the Reviewer says, or keep it from seeing a
  problem, so "no findings" is not a pass (R2).
- **The Reviewer reads what changed, secrets included.** A tracked file such as `.env` that changed is sent like any
  other file to the model of the Review role. Asking the Reviewer is the person's own act, on the model they chose.
- **A steering message has the person's authority**, like any message they type: text pasted into it from elsewhere
  carries that authority too.

### Verification

- The core's tests take a steering message between two steps and after a text-only reply, keep roles alternating, run
  the hook (and drop a blocked message with the hook's reason), bring mentions, refuse a used or malformed id, and take
  nothing once the turn is past taking it; the store's tests show the Steering row and send what a request did not take
  as the next one.
- The settings and model tests keep known roles and levels only; the runtime's test puts the role's level on that
  role's requests; the adapters' tests send it only to models with a dial.
- The Reviewer's tests frame the change with a nonce the text cannot close, number the lines, leave lock and minified
  files unread, keep to the budget, read JSON from fences and repair slips, keep only findings on a file of the review,
  and cap their number and length.
- Find's tests fold case and white space, map matches back across text nodes, never run a match across blocks, cap the
  marks, and open only the folds that hold the words.
- The shortcut tests refuse every chord K7 names and take ordinary ones, keep a chord with one command, ignore what a
  settings file must not change, and check change, add, remove, reset and the list; the settings tests keep only
  well-formed entries across a restart.
- The end-to-end run steers a running turn, sets the effort and finds it on the request the model got, asks the
  Reviewer and sees its findings on the lines, ready to send, finds words in a folded work log and steps through the
  matches, and changes a shortcut: refused with the reason, taken, asked before moving, working at once, in the menus
  and after a restart, and put back with Reset all and its Undo.

## The Settings page, chats and Windows notices (UI-6a)

Written with the pull request that turns Settings into a page over the app, keeps each change as it is made, adds
chats (sessions in a folder of their own) and tells the person through Windows when a request finishes or the agent
needs them
([0068](../adr/0068-settings-is-a-page-that-keeps-each-change-as-it-is-made-and-a-chat-is-a-session-in-a-folder-of-its-own.md)).
The new paths are a folder every chat writes in, text that Windows keeps after eNCode closes, a page that shares the
window with a waiting approval, and a power request.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| S1 | The window makes chats work in a folder the person did not choose | The chats folder is taken only from the system's folder dialog, shown by the main process. A settings save never carries it, and a path in the settings file must be a whole path of reasonable length on this computer or it is no choice. | Mitigated |
| S2 | The chats folder gives every chat too much reach: a whole drive, the home folder, or eNCode's own folder, where a write needing no approval could change its settings, keys or sessions | Those are refused from the dialog and read as no choice from the file: a drive or share root, the home folder, and a folder that holds eNCode's profile folder or lies in it. The protected `.encode` and `.git` rules apply in the chats folder as in any project. | Mitigated (residual below) |
| S3 | A chat's tools run in the last project, or with no folder's rules | A chat's session is made with the chats folder as its root, and the host binds a session with a root to it, whatever folder is open: its scope, permissions, trust and sandbox are the chats folder's. New chat opens that folder first and makes nothing when that is refused (an agent works, an unsaved file is kept). | Mitigated |
| S4 | A Windows notice shows what the agent wrote, or an error quoting code, paths or keys, and Windows keeps it after eNCode closes | A notice's title is the session's name (one line, at most 80 characters) and its text is one of eNCode's own sentences; a summary passes only when it is eNCode's "Stopped after N steps". Never the model's reply or an error's text. Clicking one only opens the session it names. | Partial (residual below) |
| S5 | Leaving the Settings page, or a key on it, answers an approval waiting under it | The thread is inert under the page. The approval card ignores Enter and Esc while the page or a dialog is open, the Esc that leaves the page goes to no other listener, and the card ignores an Esc something else used, so an approval that came up while the page was open waits. | Mitigated |
| S6 | A change kept at once stores a value the main process should refuse, or a fast series of changes ends on an older one | The page saves through the same `settings:save` as before, where every field is checked and only known values are kept. The window applies only the answer to its latest save. A key is stored only with its Save key button. | Mitigated |
| S7 | Keeping awake holds off sleep for good (a laptop in a bag) | eNCode asks Windows not to suspend (`prevent-app-suspension`, the screen may still turn off) only while an agent thinks or runs a command, never while it waits for the person, and lets go 15 s after the last one stops or when the switch is turned off. | Mitigated |
| S8 | The test hook that writes notices to a file is a way to write a file | `ENCODE_NOTICES_FILE` is read only when eNCode is not packaged, as `ENCODE_HOME` is. | Mitigated |

### Residual risks

- **Any other folder the person picks for chats gets that reach.** Under Workspace Write every chat can write there
  without asking, as a project folder can be written.
- **eNCode's own folder is refused for chats, not yet everywhere.** Opened as a project, it would let the agent write
  eNCode's settings under Workspace Write; keeping the agent out of it whatever folder is open is part of hardening.
- **A session's name can hold what the person typed first**, or a name a model gave it, and that is a notice's title.
- **Sessions from before projects have no folder** and still work in the folder that is open; they are listed under
  Chats.

### Verification

- The settings tests take the chats folder only from the dialog's path, refuse a relative or malformed path, a drive
  root, the home folder, eNCode's folder, a folder in it and one that holds it, and read each of those from the file
  as no choice; they keep the send key and the notice settings only as known values.
- The attention tests keep the model's text and errors out of notices, hold a finish back while another request
  starts within 2 s, flash only while the agent waits in the background, and keep the computer awake only while an
  agent works, with the 15 s grace.
- The send key, sections, palette and sidebar tests choose the keys that send, find settings by the start of their
  words, list single settings only for a query, and keep the chats folder out of the projects.
- The end-to-end run opens the page from the message box where it was left, finds a setting from the page and from the
  palette and lands on it with the focus, keeps changes without Save, sends with Ctrl+Enter only once it is chosen,
  sends a test notice, starts a chat with Ctrl+Alt+O in the chats folder, opens the page while the chat's approval comes
  up, presses Enter and Esc and finds the approval still waiting, reads the finished notice (the chat's name, "Finished.",
  none of the agent's words), and archives, restores and deletes the chat from the page.

## Planning first, the looking hooks, notebooks and PDFs (Parity 1)

Written with the pull request that adds EnterPlanMode, the Notification, SessionEnd and SubagentStart hooks,
NotebookEdit and PDF reading
([0069](../adr/0069-the-agent-asks-before-planning-hooks-hear-what-it-waits-for-and-pdfs-are-read-by-encodes-own-reader.md)).
The new paths are a parser that reads any PDF the agent opens, PDF pages sent to the model's provider, the person's
scripts run when the agent waits or a session ends, and a tool that writes inside notebooks.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| F1 | A PDF exhausts memory or time: a stream that inflates to gigabytes, objects nested without end, a content stream of millions of operators, a form that draws itself | Every decoder stops at 48 MB a stream and 256 MB a read; parsing stops 64 levels deep; a page runs at most 2,000,000 operators and forms 10 deep with no cycles; a read stops after 20 s and yields every 40 ms, so the app stays responsive; files over 100 MB are refused before they are loaded. A limit leaves the page marked as read in part. | Mitigated |
| F2 | A crafted PDF crashes the reader and takes the agent's step down with it | The reader's own errors become a refusal with a reason ("could not be read as a PDF: ..."), a page that fails becomes a page read in part, and offsets, lengths and counts from the file are checked before use. Unknown filters are refused, image filters never decoded. | Mitigated (residual below) |
| F3 | A PDF's text carries instructions to the model | It is a tool result like any file's text, with no more authority than Read's other output. ActualText and glyph maps can make the text differ from what a viewer shows, as they can in any reader. | Residual (as for every file the agent reads) |
| F4 | Pages of a PDF go to the provider when the person did not expect it | Only after the agent read the file, which Read's rules govern (a file outside the workspace asks), only to the model that answered, and only pages that have figures or scans, at most 10 a read and 10 MB. The copy holds what those pages draw: links, form fields, metadata, thumbnails and other pages are left behind. | Mitigated |
| F5 | A password-protected PDF is opened, or its restrictions removed | Only files with an empty user password open, which any viewer opens. The copy sent to a model is not encrypted, so the author's print and copy restrictions do not travel with it; it is never written to disk. | Accepted |
| F6 | Megabytes of PDF pile up in the session log or the context | The log keeps each document's text only, compaction replaces old documents with their text, and the context estimate counts 1,800 tokens a page. | Mitigated |
| F7 | NotebookEdit damages a notebook or changes more than one cell | It splices only the cell's bytes into the file as it was read, refuses a file changed since, keeps the writer's layout, and shows the cell's change as a diff, asking where any write would; a notebook whose cells cannot be followed is written whole and the diff shows it. Edit and MultiEdit refuse notebooks. | Mitigated |
| F8 | A Notification or SessionEnd hook holds eNCode up, or a failing one breaks a session | These hooks only look: their exit codes stop nothing, their failures become a notice, a SessionEnd hook may hold a quit 5 s and other endings 15 s, and every hook keeps its timeout and is stopped with its process tree. The idle notice is one timer per session, cleared by the next turn or a stop. | Mitigated |
| F9 | A SubagentStart hook steers a subagent | Its output is context before the subagent's task, as SessionStart's is for the main agent; the hook is the person's (or a trusted folder's, under P15) code, so it has the person's authority. | Accepted |
| F10 | The model switches to plan mode behind the person's back, or out of it | EnterPlanMode asks under Workspace Write and stricter, says what plan mode does, and runs only in code mode; leaving plan mode still needs the plan approved (ExitPlanMode). Plan mode only takes tools away. | Mitigated |

### Residual risks

- **The PDF reader is new code facing hostile input.** It is written in a memory-safe language and bounded, but a
  file that makes it read text wrongly, or slowly up to its limits, will exist. Fuzzing it is part of hardening.
- **Text can differ from what a viewer shows.** Fonts without maps, ActualText and invisible text (a scan's OCR layer
  is invisible on purpose) are read as the file says.
- **A scan without a text layer** is only readable by a model that reads PDFs; there is no OCR.

### Verification

- The PDF tests read files from Chromium, LibreOffice and ReportLab and compare their text, outline and layout;
  open RC4 40 and 128 bit, AES-128 and AES-256 files made by pypdf and refuse one with a password; read a damaged table,
  a file with no table, object streams behind a predicted cross-reference stream, Type 0 fonts with ToUnicode ranges
  and surrogate pairs, glyph names, forms (one that draws itself), inline images holding "EI", ActualText and
  overprinted bold; stop a 64 MB stream, cut a page at its time limit, and keep to the character and page budgets.
- The copy of chosen pages is read back by the reader and opened by pypdf and pdftotext; it keeps rotation, drops
  links and encryption, and gives up over its size limit.
- Read's tests check the outline, pages, the note on what is left, the attachment for a model that reads PDFs and the
  note for one that does not; the adapter tests send the document inside the tool result (Anthropic) or as a file after
  it (chat completions) and its text otherwise; the router learns a refusal and asks the same model once more; the
  session test keeps the document out of the log.
- The NotebookEdit tests keep every byte outside the cell, across line endings, indentation, string sources, ASCII
  escaping and missing ids; the hook tests check the notification kinds and order, no idle notice after a stop, the
  SessionEnd reasons, a session never started owing none, and SubagentStart's context; the session tests check the
  plan card, a refusal with a note, and a session grant.
- The end-to-end run shows the plan card with its own buttons and goes ahead on the person's word, reads page 2 of a
  PDF and changes a notebook cell from the fake provider's scenario, and checks the row that says so.

## Problems in plain words (Clean errors)

Written with the pull request that says every failure in a sentence with what can be done, and folds what the
provider or the system said under Details
([0070](../adr/0070-a-problem-is-said-in-a-sentence-with-what-can-be-done-and-what-the-provider-said-is-folded-under-it.md)).
The new paths are provider text kept in the session log and shown in the window, a Retry that runs a request again,
and renderer errors written to the log.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| C1 | A provider echoes the key back in an error, and it reaches the chat, a toast, the session log or a report | The router redacts the keys it sent from every message and detail; `redactSecrets()` also takes out anything shaped like a key or a credential before details are stored or shown; the log's own redaction runs again on write. The smoke checks a refused key's Details hold `[redacted]` and not the key. | Mitigated |
| C2 | Details give away the person's user name or folders when a tester shares a screenshot or a report | The home folder becomes `~` in details, as in the log and Diagnostics. | Mitigated |
| C3 | A provider's error text is crafted to look like an instruction from eNCode | It never makes the sentence: the sentence comes from the kind of failure, and the text sits in a Details fold in the code font, shown as text. | Mitigated |
| C4 | Details grow without bound in the session log | Cut at 4,000 characters, with the stack at 12 frames. | Mitigated |
| C5 | Retry runs something the person did not ask for | It runs only the request that did not finish, under the same mode, rules and approvals, and refuses when the last request finished or the session is busy. Nothing new is sent as the person. | Mitigated |
| C6 | A raw error slips into the interface through new code | One filter, `errorText()`, for every failure the window shows, and a test that fails the build when a renderer file reads an error's message or stack, or makes text of a caught error. | Mitigated |
| C7 | Renderer errors written to the log carry secrets | Renderer console errors go to the main process log, which redacts keys and the home folder as for every line. | Mitigated |

### Residual risks

- **A key in a form no pattern knows** and not one eNCode sent (another service's token pasted into a prompt) can
  reach details. The patterns cover the common shapes; the keys eNCode holds are always removed.
- **The sentence can be less precise than the provider's text.** A provider that reports a new kind of failure is said
  as "not available right now" until eNCode learns it; the Details fold keeps the original.

### Verification

- The router's test makes every failure kind and skip reason a sentence that names the model or the provider and has
  no status, JSON or class name in it; a refused key's alert has a plain message and a redacted detail.
- The core tests run eight pauses through a session and check the entry's sentence, actions, retry time and redacted
  details, a thrown error's internal problem with its stack in the details and the log, the empty and context ends,
  switch and wait notices, hook failures, and Retry (one user entry, the problem resolved, kept after reopening).
- The renderer's test scans every source for raw error text; `errorText()` and `shownError()` tests cover the IPC
  wrapper, stacks, key shapes and faults.
- The end-to-end run makes the fake provider refuse the key with a key-shaped string in its JSON, checks the card's
  sentence, its Open Settings and Switch model buttons and its redacted Details, then sends empty replies, presses
  Retry once the provider answers again, and checks the answer arrives with the request sent once.

## Work in the background (Parity 2)

Written with the pull request that adds subagents in the background, SendMessage, Monitor and ScheduleWakeup
([0071](../adr/0071-work-goes-on-in-the-background-and-what-it-reports-reaches-the-agent-between-steps-or-in-a-turn-of-its-own.md)).
The new paths are turns that start without a message from the person, output of long-running commands read by the
model, subagents that outlive the turn that started them, and sessions opened at startup for their wake-ups.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| B1 | Background news starts turn after turn and spends the person's money (a chatty log, a loop of wake-ups) | At most twenty turns of news in a row, then the session says so and waits for the person; news gathers a second before a turn; at the end of a turn news waits for a turn of its own instead of extending the one that runs; a monitor's lines come in batches of at most 50 lines and 6,000 characters; one wake-up per session, at least 60 s ahead. Stop holds all of it until the person writes. | Mitigated |
| B2 | A monitored command, or a subagent's report, carries instructions to the model | The news reaches the model in a system reminder that says the user did not write it, with no more authority than a tool result; it runs no UserPromptSubmit hook, and the chat never shows it as the person's message. | Residual (as for every command output the agent reads) |
| B3 | Work in the background escapes the rules the turn works under | A monitor runs through the same shell, sandbox and approval check as a background Bash command; a subagent keeps the mode, policy, rules and grants of the session, and its approvals come to the person on the usual card. | Mitigated |
| B4 | A subagent in the background waits on the person forever, or its card is lost when the turn ends | Its approvals and questions are marked `background` and stay when the turn ends; the session shows awaiting approval with no turn running; Stop refuses what it waits on; the Jobs tab and KillShell stop the subagent; starting over stops it. | Mitigated |
| B5 | Background work runs on after the person thinks it stopped | Stop holds news and takes back the wake-up; the Jobs tab lists every command, monitor, subagent and wake-up with Stop or Cancel; the header chip says what runs; starting over and rewinding stop monitors, subagents and the wake-up, and silence background commands (a dev server outlives a rewind, and stays in the Jobs tab with Stop); quitting stops every command and monitor with its process tree. | Mitigated |
| B6 | Too much runs at once (process or memory exhaustion) | At most four subagents and eight monitors in the background a session, an inbox of at most 60 items, monitor lines cut at 1,000 characters and output tails kept short. | Mitigated |
| B7 | A wake-up opens a session the person archived, or runs while eNCode is closed | `resumeWakeups()` opens only sessions that are not archived, and only when eNCode starts; a late wake-up says it is late. Nothing runs while eNCode is closed. | Mitigated |
| B8 | SendMessage continues a subagent of another session, or one that never existed | Agent ids are looked up in the session's own pool; an unknown id is refused with its reason. | Mitigated |

### Residual risks

- **A turn can start while the person is away.** It is bounded and shown, but it is a model request the person did not
  send at that moment. Wake-ups and background subagents are the agent's choice, under the same policy as everything
  else it does.
- **A model can ignore the end of a batch** ("12 more lines not sent") and draw conclusions from part of a log.

### Verification

- The core tests start a background subagent and check its report reaches the agent in a turn of its own, between two
  steps of a running turn, or with the next message; a message sent to it while it works; continuing it after it
  ended and after a restart; an interrupted one named after eNCode closed; the person's stop told without a wake; the
  agent's own stop with no notice; its approval kept after the turn and refused by Stop; starting over; the limit of
  four. Commands and monitors: an ended command's tail, batches with what was left out, the time limit, and the limit
  of twenty turns. Wake-ups: once with its prompt, after a restart and late, cancelled by the agent, by the person and
  by Stop.
- The store tests keep subagent messages and compactions by agent id, the latest agent and wake-up records with the
  index's `wakeAt`, and drop them with a rewind; the host test opens sessions that wait for a wake-up.
- The tool tests check Monitor, ScheduleWakeup, SendMessage, Task in the background and KillShell on a subagent, and
  that the background tools come only where there is background work and wait for ToolSearch.
- The renderer tests keep a background card when the turn ends and word the Jobs cards and the header chip.
- The end-to-end run starts a subagent in the background from the fake provider, sees its command ask on a card tagged
  Background with no turn running, the header say "1 agent running" and the Jobs tab show it with its type; approves
  it, and checks its report starts a turn of its own with no message of the person's.

## Worktrees and language servers (Parity 3)

Written with the pull request that adds EnterWorktree and ExitWorktree, eNCode's language server client, the LSP and
LSPEdit tools, errors after every edit with the error gate, and the editor's marks
([0073](../adr/0073-worktrees-are-made-by-encode-with-hooks-off-and-language-servers-run-in-trusted-folders-for-the-editor-and-the-agent.md)).
The new paths are git run by eNCode for the agent, and long-running programs found in the project or on the PATH that
read the project, hear the editor's unsaved text and answer the agent.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| W1 | A hook the agent wrote (a project's own hook folder, such as husky's) runs outside the sandbox when eNCode makes or removes a worktree | eNCode runs git itself with fixed arguments and `core.hooksPath` pointed at a folder that does not exist; the agent's text never becomes a git command line. | Mitigated |
| W2 | A worktree name escapes the project (`../x`, an absolute path) or breaks git (`a.lock`) | A name is one plain path segment, at most 64 characters, that is also a valid branch name; the folder is always `.encode-worktrees/<name>` in the project. | Mitigated |
| W3 | The agent removes work that is not merged anywhere | `remove` refuses while the worktree has changes not committed or commits only on its branch, and says what they are; `discard_changes` is judged as the `git worktree remove --force` command it stands for, so it asks as that command does. | Mitigated |
| W4 | A worktree, a whole copy of the project, floods the file list, search and `git status`, or a rewind leaves the shell in a folder that is gone | The folder is kept out of the file list, Quick Open and search, and out of `git status` by `info/exclude`; the session keeps the worktree in its log and lets go of one whose folder is gone, with a notice. | Mitigated |
| L1 | A project runs code through a language server (TypeScript plugins in `tsconfig.json`, Rust build scripts, a server in `node_modules/.bin`) | Servers start only in folders the person trusts, and only while Settings > Language servers is on; the project's own `node_modules/.bin` is looked in only then; taking trust back stops the servers. | Mitigated (trust is the line, as for hooks and MCP servers) |
| L2 | A server reads API keys from its environment | Servers start with the agent's environment minus anything that looks like a secret; eNCode's own keys live in the keychain and never in an environment. | Mitigated |
| L3 | A Windows `.cmd` shim is used to run a command line through cmd.exe | eNCode never starts a `.cmd`: it reads the script an npm or pnpm shim names, which must sit inside the shim's `node_modules`, and starts it with Node directly, without a shell. Anything else is not a server. | Mitigated |
| L4 | A hostile or broken server exhausts memory or hangs eNCode | The client closes a connection on a header that never ends or a message over 64 MB; documents over 8 MB are not given; the agent keeps at most 64 documents open; every request has a time limit and an abort; a server that keeps crashing is reported and left stopped for a while. | Mitigated |
| L5 | A server changes files on its own (`workspace/applyEdit`) or an edit plan reaches outside the project | A server may ask for an edit only while a command eNCode runs for an approved code action is running, and only of that action's file; LSPEdit applies the plan it showed, only when every file still reads as the server saw it, never outside the project, and through the checkpoint seam so Rewind can put it back. | Mitigated |
| L6 | What a server reports carries instructions to the model | Diagnostics reach the model in a system reminder as the servers' findings, at most 400 characters a message and a few files and lines at a time; the model is told they are about its changes, nothing more. | Residual (as for every tool result) |
| L7 | The renderer gives the servers a file outside the folder, or the text of a folder that is no longer open | The main process resolves every path the editor names inside the open folder and drops anything else; the agent host keeps the editor's documents per folder and closes them when the folder changes; the hub ignores a file outside its root. | Mitigated |
| L8 | Marks that no longer hold mislead the person (a server stopped, trust was taken back) | The hub takes back a server's marks when it stops, crashes or loses its folder's trust, and a file's marks when it closes; the editor drops all marks when the folder changes. | Mitigated |
| L9 | The error gate sends the agent back again and again and spends the person's money | Once a turn by default, at most three times when set to, or never; the chat says each time; the model may answer that the errors are expected. | Mitigated |

### Residual risks

- **A server in a trusted folder can do anything the person can.** Trust is the person's word that the project is
  theirs or one they accept; a server on the PATH is one the person installed.
- **The editor's unsaved text reaches the servers.** That is what a language server is for; it stays on the computer.
- **A model can ignore what the servers report.** The gate sends it back, and it may still finish with errors once the
  rounds are used.

### Verification

- The git tests make a worktree in a real repository with a hook that would write a file, and check the hook did not
  run; they check names, what removing would lose, removing with and without discarding, and `info/exclude`.
- The core tests keep a session in a worktree across a restart, a reset and a rewind, and let go of one whose folder is
  gone; the tool tests check EnterWorktree and ExitWorktree, and that removing with `discard_changes` asks.
- The lsp tests run a language server written for them over the real wire format: framing and its limits, document
  sync by version, every lookup, rename and code action plans with each file's text before and after, refused edits,
  lazy start, idle stop, crash restart, the marks the editor is given and taken back, and servers looked for again once
  the folder is trusted. The discovery tests read npm and pnpm shims and refuse one that points outside its package.
- The workspace and agent host tests take the editor's documents by their paths in the folder, ignore one outside it,
  and give marks only once the folder is trusted and servers are on; the core tests tell the model what an edit
  broke, send it back once, and tell it when the errors are fixed.
- The end-to-end run puts a test server in the demo project's `node_modules/.bin` the way npm does: the editor shows
  no marks and says the folder is not trusted; once it is trusted the open file's error and warning are drawn and
  counted, a mark tells its message when pointed at, typing adds a mark and undo takes it back; Settings > Language
  servers says the server runs, found in the project; the agent writes a file with an error, is told so, is sent back
  by the gate and fixes it; the diagnostics report lists the server; taking trust back stops it.

## The editor's language features (Editor and language intelligence 1)

Written with the pull request that adds suggestions, snippets, parameter hints, hover documentation, the symbol's
other places, go to definition and implementation, the peek of definitions and references, and Back and Forward to the
editor
([0074](../adr/0074-the-editor-asks-the-language-servers-through-checked-questions-and-draws-their-answers-with-its-own-widgets.md)).
The new paths are questions from the renderer to the folder's language servers, and what the servers write for people
drawn in the app's page.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| A1 | What a server writes (hover, a suggestion's details, a signature's documentation) puts markup or script in the app's page | Markdown goes through the app's renderer, which escapes everything first and allows only its own tags; links only to `http(s)` and `mailto`, which open outside the app; code blocks are coloured from escaped text by the editor's own tokenizers; plain text is escaped. | Mitigated |
| A2 | A compromised renderer asks about a file outside the folder, or sends a question built to break the host | The main process rebuilds each question field by field (a kind from a fixed set, counts within bounds, a trigger character of one character, the open signature at most 64 KB) and makes the path the folder's own; anything else gets no answer. The host resolves the file inside the folder's root again. | Mitigated |
| A3 | A suggestion changes more than it shows: an edit elsewhere over the text being typed, or an import that lands after the person moved on | Edits that overlap where the item goes are left out; an import that comes once the item was chosen goes in only within three seconds and only while the document can still be followed to it; the item and its edits are one step of the undo history. | Mitigated |
| A4 | A snippet reads what it should not (the clipboard, the environment) or runs something | Snippets are parsed by eNCode's own parser; the variables are the file's and the date's only; the clipboard is never read and nothing runs. | Mitigated |
| A5 | A server floods the editor or keeps it waiting | At most 5,000 suggestions, 50 signatures, 2,000 highlights and 1,000 places an answer; documentation and code are cut; only the rows in sight are drawn; every request has a time limit, and a newer question of the same kind cancels an older one. | Mitigated |
| A6 | An answer for older text lands in newer text (a suggestion in the wrong place, a stale hover) | A question waits for the change being made and for the changes sent before it; answers are dropped when the document or the file shown has changed; a suggestion's place is followed through what was typed since it was asked. | Mitigated |
| A7 | Going to a definition opens a file outside the folder (a library, a system header) in the editor | Such a place is not opened: the person is told where it is, and a peek shows its path; previews read files only through the workspace calls the file list uses. | Mitigated |

### Residual risks

- **A server can describe a symbol misleadingly.** What it writes is shown as its own words, in its own card; it is
  not run and does not reach the agent through these features.
- **A link a server wrote opens in the browser when clicked.** Only `http(s)` and `mailto` links are drawn as links.

### Verification

- The editor tests parse snippets (stops, placeholders, choices, mirrors, variables, transforms, broken ones) and
  match suggestions fuzzily; the renderer tests rank items, plan where an item and its edits go (left out when they
  overlap), and say why a feature has no answer; the keymap tests check that a snippet takes Tab first and that an
  editor's own bindings come before the built-in ones.
- The main process tests rebuild questions and refuse malformed ones; the lsp tests run completion, resolve,
  signature help, hover, highlights and the places of a symbol against a server written for them; the workspace tests
  answer for the editor's text as it is, give places their line's text, cancel an older question of the same kind and
  answer nothing for a file outside the folder.
- The end-to-end run uses a test server that answers all of these the way a real one does: hover shows the symbol's
  code, the symbol's other places are marked, F12 and Ctrl+click go to the definition and Back and Forward return,
  Shift+F12 opens the peek with both places and the file marked, Esc closes it and Enter goes, a word typed brings
  suggestions and Enter takes one, `(` shows the parameters and `,` moves to the next, Ctrl+Space and a snippet's
  placeholder is typed over and Tab goes to its end, and an item filled in when chosen shows its details and brings
  its import.

## Changes the language servers make in the editor (Editor and language intelligence 2)

Written with the pull request that adds rename with a preview, code actions with the lightbulb, organize imports,
formatting, the Problems panel and F8 to the editor
([0075](../adr/0075-a-change-a-language-server-plans-is-checked-whole-goes-into-the-editor-or-onto-the-disk-and-can-be-seen-first-and-taken-back.md)).
The new paths are changes the renderer asks for (`code:edit`), the plans the folder's servers make for them, the
commands the servers run, and the files the host writes, creates, moves and deletes for them.

### Threats and controls

| # | Threat | Controls | Status |
| --- | --- | --- | --- |
| E1 | A compromised renderer asks for a change built to reach outside the folder or to break the host | The main process rebuilds each change field by field (a kind from a fixed set, counts within bounds, a new name of one line without control characters and at most 500 characters, at most eight short dotted kinds of action, at most 2,000 open files, each made the folder's own) and makes its file the folder's own; anything else gets no change. The host resolves the file inside the folder's root again. | Mitigated |
| E2 | A server's plan writes, creates, moves or deletes a file outside the folder | Every file of a plan is checked by its real path to be inside the folder before anything is written; a plan with one outside is refused whole. | Mitigated |
| E3 | A change writes over the person's unsaved work, or over text the server did not read | A file with unsaved changes in the editor is changed in the editor only, and only if the editor's text is what the server read; it is never moved, replaced or deleted. Every other file is written only while it still holds what the server read; an open file too large for the servers is not touched. | Mitigated |
| E4 | A change is half made: some files written, then a failure | The whole plan is checked against the files as they are before anything is written; a write that fails takes back the ones before it. | Mitigated |
| E5 | A server runs a command the person did not choose, or sends edits when nobody asked | A command runs only when it is the chosen action's and the server lists it as its own; `workspace/applyEdit` is accepted only while a command eNCode asked to run is running, and goes through the same checks as any plan; at any other time it is refused. One command at a time per server, a minute at most. | Mitigated |
| E6 | An action is taken that is not the one the person saw (a stale list, a forged number) | Actions are chosen by the number of the newest list the editor was given and their place in it; any other list is refused. A preview is applied only by its id, within ten minutes, and only the newest preview is held. | Mitigated |
| E7 | Taking a change back loses work done since | A change is taken back whole only while every file and document it touched still holds what it left, within ten minutes; otherwise nothing is taken back and the person is told which file changed and to use Undo in each file. | Mitigated |
| E8 | A file's encoding or line breaks are changed by a change (a CRLF file turned to LF, an ANSI file written as UTF-8) | Edits go on the file's own text, the server's line breaks take the file's own, and the file is written in its own encoding; a character an ANSI file cannot hold refuses the change. | Mitigated |
| E9 | Formatting changes text the person typed after it was asked for, or holds a save | Formatting edits go in only while the document is the text they were made for, as one undo step; a save waits at most 1.5 s for the server and then saves the file as it is. Format on save and on type are off until the person turns them on. | Mitigated |
| E10 | A server floods a preview or the editor | A preview shows at most 200 lines a file and 2,000 in all, each cut at 300 characters, and says when lines are left out; a server's list is read up to 100 actions, and its edits up to 20,000 an answer; every request has a time limit. | Mitigated |

### Residual risks

- **A change to closed files is written to disk at once.** It is not a checkpoint of the agent's; the notice's Undo
  takes it back for ten minutes, and git after that.
- **A server can plan a change that is wrong.** eNCode checks where a change goes, not what it means; the preview
  shows every line before it is made, for the person to judge.
- **A command runs the server's own code.** That is what a language server is; it already runs in a folder the
  person trusts (0073).

### Verification

- The workspace tests change unsaved documents in the editor and saved and closed files on disk, keeping their
  encoding and line breaks; refuse a whole plan, writing nothing, when any part of it does not hold; make, move and
  delete files and put them all back; refuse to take a change back once something it touched has changed; show a
  plan line by line; and rename, take a quick fix and a command's edits, and format, through a folder's servers.
- The lsp tests prepare a rename and say why one cannot be made in the server's words, keep the editor's actions apart
  from the agent's, narrow them by kind, plan or run the chosen one, and format a document, a range and as it is
  typed, keeping its line breaks. The main process tests rebuild changes and questions and refuse malformed ones.
- The renderer tests order F8 across files and round, filter the Problems list, put actions in their sections, and
  apply and take back the servers' edits in the editor's documents.
- The end-to-end run uses a test server that renames, offers fixes, refactorings and source actions, runs a command
  that sends its edit, and formats: F8 and Shift+F8 go across files and round and Esc puts the message away, the
  Problems panel lists, filters and opens a problem, the lightbulb shows, Ctrl+. lists the fixes with the preferred
  first and Enter takes it (written to disk, the file not marked unsaved), F2 refuses a bad name with the server's
  reason, Shift+Enter previews a rename across two files and Apply makes it, its notice's Undo takes it back, a
  refactoring's command makes its change, Shift+Alt+O organizes the imports and Shift+Alt+F formats with Ctrl+Z
  taking it back, and format on type and on save act once turned on in Settings.
