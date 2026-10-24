# 0096. Before the agent finishes, its changes are scanned and read by the Reviewer, and a plan is read before the person sees it

- Status: Accepted, builds on 0064, 0094 and 0095
- Date: 2026-10-24

## Context

0073 and 0095 hold a finished request to the language servers, the project's checks and what the reply claims. What
none of them see:

- a change that typechecks and passes the tests but is wrong: a part of the request left undone, a case it gets wrong
  (an empty list, zero, a missing record), an error swallowed, a caller it breaks that no test covers;
- the mistakes that are easy to make and costly to ship: a key written into the code, SQL or a shell line joined from
  a value, `eval` of input, TLS checks turned off, and, in a FiveM resource, a server event that pays out whatever
  amount the client sends;
- a plan that misses a case, which the person reads, approves and then gets built.

A strong model catches most of this itself. A cheap or free one, which most testers will use, does not, and the
person learns of it after the answer. The Review tab's Ask the Reviewer (0064) already reads a change well, but only
when the person asks.

## Decision

### The scan of the added lines

When the main agent in Code mode ends a request that wrote files, after the language servers and the project's checks
(0073, 0095), eNCode reads the lines the request added (`packages/core/src/diff-scan.ts`). Only added lines count, so
code that was there before is not the agent's to answer for, and generated, vendored and lock files are not read. It
reads shapes, not meaning, so each rule is narrow:

- **secret**: a provider's key shape, a private key block, or a long literal assigned to a name like `apiKey`,
  `DB_PASSWORD` or `client_secret`. Placeholders (`your-token-here`, `xxxx`, `****`, `<...>`, `changeme`), values from
  the environment, `.env` files and test files are left out, and the finding shows the line with the value masked;
- **sql**: a query call of the language (JavaScript, Python, Go, Lua's oxmysql, ghmattimysql and mysql-async) whose
  first argument joins SQL text with a value (`+`, `..`, `${}`, an f-string, `%`, `.format`, `string.format`,
  `fmt.Sprintf`). A tagged template,
  `$1`/`?`/`%s` with a separate argument, and joins of text that is not SQL pass;
- **command**: a shell line joined from a value: `exec`/`execSync`, `os.system`, `subprocess` with `shell=True`,
  `os.execute`, `io.popen`, FiveM's `ExecuteCommand`, Go's `exec.Command("sh", "-c", ...)`;
- **eval**: JavaScript's `eval` of something other than a literal, Python's `eval`/`exec`/`yaml.load` without a safe
  loader, Lua's `load`/`loadstring`; **html**: `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`,
  `dangerouslySetInnerHTML`, Svelte's `{@html}`, Vue's `v-html` or jQuery's `.html()` set from a value; **tls**: certificate checks turned off (`rejectUnauthorized: false`,
  `verify=False`, `InsecureSkipVerify: true`, `NODE_TLS_REJECT_UNAUTHORIZED=0`), outside test files;
- **FiveM**, in server files (a `server` folder or file name, `sv_`, `_server`): in a handler the request added
  (`RegisterNetEvent`, `RegisterServerEvent` with `AddEventHandler`, `lib.callback.register`, ESX and QBCore callbacks,
  `onNet`), read to its end and at most 200 lines:
  - a payout (money, items, weapons: `addMoney`, `AddItem`, `addInventoryItem`, ...) from a parameter the client
    sent, with no comparison of it and no lookup by it (`Config.Items[item]`) or clamp before;
  - an action on a player the client names (`GetPlayerFromId(target)`, `GetPlayer(target)`) with no permission or
    distance check (`IsPlayerAceAllowed`, a group or admin check, `#(coordsA - coordsB)`);
  - and, in client files, `TriggerServerEvent`/`emitNet` that sends a price, cost or reward.

At most 12 findings, each a line, a file and why it matters. They go back to the agent once a request: "eNCode's scan of
the lines your changes added found what is often a security bug: ... Fix each, or say in your reply why it is safe
here." A notice tells the person. The scan runs unless **Settings → Agent → Checks** is set to never, and every rule
reads a line of at most 2,000 characters in linear time (a test holds it to that on hostile input).

### The Reviewer before the agent finishes

Then, once a request that changed code, the Reviewer reads it before the person sees the answer
(`packages/core/src/review.ts`):

- one call to the model of the Review role, with no tools, so it reads and changes nothing. It is given the person's
  last three requests (the last one whole up to 4,000 characters), the agent's reply, the project's checks after the
  last change in words ("`npm test` passed"), the scan's notes, and the request's changes as numbered hunks with ten
  lines of context, the way the Review tab sends them: 120,000 characters at most, lock and minified files named but
  not sent, a binary or very large file named with why, keys masked;
- the request's changes are every part of it: the request and each message the person sent while the agent worked
  (each has its own checkpoint), merged by file, first version before and last after;
- it answers in Ask the Reviewer's shape (0064), findings tied to a line with P0 to P3, plus `untested`: the cases the
  change must handle that no test in it covers, at most five;
- P0 and P1 findings go back to the agent, with the P2s beside them ("Also worth a look"). The untested cases go back
  when the project has a test check and the request changed no test file ("Add tests for them to the project's tests,
  and run them"). The reminder starts "The Reviewer read your changes before the person sees them. It saw only the
  change, so read the code before you act on what it says." and ends "If a finding is wrong, say why in your reply.";
- anything else is only a notice: "The Reviewer read the changes and found no problem." or "... smaller points: ...".
  A Reviewer that cannot answer in four minutes, is paused, or answers in a way eNCode cannot read lets the answer
  through with a notice saying so.

Its tokens count in the request's cost. Findings on a file the change does not hold are dropped, and every text from
the answer is flattened and cut short before it reaches the agent.

### The plan before the person reads it

When the main agent calls ExitPlanMode, once a request, the Reviewer reads the plan against the request first (two
minutes at most; the call shows as "Reviewing"). Its gaps (a part of the request not covered, a case the plan will get
wrong, a caller it breaks, a step with no way back, no way to check the result, a FiveM handler that will trust the
client; at most five) go to the agent as the tool's result: "Revise the plan to cover them, or say in it why one does
not apply, then call ExitPlanMode again." The person sees only the revised plan, with a notice. A sound plan, or a
Reviewer that cannot answer, lets the plan through as it is.

### When it runs

**Settings → Agent → Reviewer**: for smaller models (default), always, or never (`reviewWork` in the app, `review` in
the core: `auto`, `on`, `off`). `auto` asks the Reviewer when the main model needs the full guide (0094), or when the
Review role has a model of its own; a strong model reviewing itself adds cost and little else. The Review role follows
Main unless the person chose a model for it (0052), so the change goes to no model the person did not pick, and never
to the free pool unless they chose it.

### The finish gates and `attempt_completion`

A model that ends with `attempt_completion` instead of a reply without calls is now held to the same gates: the
language servers, the checks, the scan, the claims and the Reviewer. Before, it skipped them all. The order is the
language servers, the checks and the scan (Code mode), the claims (any mode), then the Reviewer (Code mode); the first
that sends the agent back ends the round.

### Where the code lives

The Review tab's prompt and parser (`code-review.ts`) move from the desktop to `@encode/core`, which both use; the
core depends on `@encode/diff` for the hunks. The benchmark's reference and replay runs turn the Reviewer off, as
they do the checks (0095): their scripted models cannot answer a round they did not script.

## Consequences

- A cheap model's request that changed code now gets a second reading before the person sees it, by the model the
  person picked for the Review role, and the commonest security mistakes are caught without any model. It costs one
  more call per request (and one per plan), and a round when something is found.
- A strong model alone pays nothing by default; the person can turn the Reviewer on for it, or off for all.
- `diff-scan.test.ts` holds each rule to cases it must find and cases it must pass, the added lines only, the FiveM
  handlers, and linear time; `review-gate.test.ts` holds the loop to the scan's send-back, the review's prompt and
  send-back, the untested cases, the notices, `auto`, `attempt_completion` and the plan; the desktop end-to-end run
  has the Reviewer find a division by an empty list's length and the agent fix it before the reply.
- Open:
  - The scan reads one line at a time: a query built over several lines, or a value that reaches a call through a
    variable, is not traced. The Reviewer sees it, when it runs.
  - The Reviewer runs once a request: the fix after a send-back is checked by the language servers and the project's
    checks, not read again.
  - The scan's words and the Reviewer's instructions are English; it reads code in any language.
