# 0148. A request that asks for the debugger lists it, and the fix rule names the function

- Status: Accepted, builds on 0136, 0145, 0146 and 0147
- Date: 2026-10-26

## Context

Part 2 of the paid re-run ran on 4e8994b with `openrouter:@preset/deepseek-v4-1-1017` at `--effort max`. It found two
things.

- **The model never saw the debugger.**
  - The first debugging run was `debug-csv-record`, whose request says "Use the debugger". It failed its `used` check,
    while its other checks passed.
  - `Debug` is deferred (0145), so the first request's tool list did not have it. ToolSearch's description named it,
    among the tools that can be loaded. The model never searched, read the code instead, and fixed the parser right.
  - The reference run passes only because it calls ToolSearch `select:Debug` first.
- **regression-guard passed 2 of 5**, against 1 of 3 before 0147. All three failures left `slug('a  -  b')` as `a---b`.
  - Run 1 used its last steps on an issue the Reviewer raised, accented letters.
  - Run 3 never tried a dash between spaces.
  - Run 2 found the case and called it "a known quirk, unchanged and not asked for", since the old code gave it too.
    0147's rule says to fix such a result "even if it was there before". The model still filed it under the next
    rule, "Mention an unrelated bug you notice; do not fix it".
  - Runs 4 and 5 found the case and folded the dashes themselves. Run 4 named `Hello - World`.

## Decision

- **A request that asks for the debugger lists `Debug`** (`asksForDebugger` in `packages/tools/src/debug.ts`, the
  loop's `toolsLoaded`).
  - These words ask for it: "debugger", "debugging", "breakpoint", "step through", and "debug" followed by it, this,
    that, the, why, what, how or where.
  - "debug logging", "DEBUG mode" and "the debug build" do not.
  - The person's last three requests are read. Once one asks, `Debug` stays listed for the session, as a tool loaded
    twice does in 0136, so the tool list and its cache hold.
  - It is listed only where the folder has a debugger, and only for the main agent, as before.
  - A request that does not ask still finds it through ToolSearch.
- **The rule names the function and the excuse** (`SYSTEM_PROMPT`):
  - It now reads: "A wrong result your own checks show from a function you changed is part of the problem, even when
    the old code gave it too: fix it and say so, rather than offer to or call it a known quirk. Mention a bug
    elsewhere; do not fix it."
  - "From a function you changed" takes in the line the change did not touch: the `\s+` the old `slug` turned into a
    dash.
  - The prompt is 2 characters shorter, at 6,780.

## Consequences

- A model that does not search for tools now gets the debugger when the person asks for it. In a session without a
  prompt cache, the listed tool costs its definition on every step from then on.
- The two neutral debugging tasks are unchanged: their requests do not ask, and the model still chooses.
- **Still open.** A small model's choices vary from run to run. Five runs of regression-guard, and three of each task
  that asks for the debugger, measure this on the paid bench after the merge.

## Verification

- `debug-tool.test.ts`:
  - a session lists `Debug` from the request that asks for it, and for the four requests after it, past the window of
    the last three;
  - the request before it does not list it;
  - the words that ask and the words that do not.
- `bench.test.ts`: a debugging task whose request asks for the debugger passes its `used` check with no ToolSearch
  call, and its first request lists `Debug`.
- `prompt.test.ts`: the rule word for word.
