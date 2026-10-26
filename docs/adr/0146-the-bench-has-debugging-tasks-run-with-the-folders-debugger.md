# 0146. The bench has debugging tasks, run with the folder's debugger

- Status: Accepted, builds on 0092, 0143 and 0145
- Date: 2026-10-26

## Context

0145 gave the agent a `Debug` tool, but only the desktop app gives it a debugger. The bench builds its agent on the
same host and `Workspaces` scope as the app, without a debugger, so the tool was never offered there. No task asked
for debugging either. So nothing could measure whether a model gets anything out of the tool. Vineeth asked for a
paid run of only the debugger and of the tasks that failed last time.

Two more things stood in the way:
- The bench declines every approval. A debug start always asks under Workspace Write.
- A run only starts in a folder the person trusts, and a bench folder is never trusted.

## Decision

- **`"debug": true` in task.json** (`packages/bench/src/task.ts`, `run.ts`). A debugging task's run:
  - gets the folder's debugger, as the app has it. Its runs go in the run's own folder and start from the same
    environment as the agent's commands.
  - is trusted, as a person who debugs a folder has trusted it. Trust changes one other thing: git runs unasked.
  - has the agent's debug starts approved, as the person would approve them. Every other approval is still declined
    with the note of 0139.
  - Tasks without the flag run as before, so earlier reports still compare.
- **A `used` check** passes when each named tool did its job in at least one of the model's calls. Declined calls and
  eNCode's own calls do not count. A task whose request asks for the debugger checks `"tools": ["Debug"]`.
- **Four tasks**, tagged `debugger`, all Node.js. Node.js debugging needs no install, so they run on every machine and
  in CI. Each has 30 steps: a debugging session takes about ten, and the Reviewer's round must still fit after it.
  - `debug-discount-rule` asks for the debugger. The rules' percentages are text, so `"15" > "5"` is false and the
    wrong rule wins. The hidden test runs the report on the shop's rules and on another export.
  - `debug-menu-crash` does not mention the debugger. An ES module throws a TypeError while it loads, because a page
    comes before its parent. The hidden test checks the menu, a chain listed from its deepest page up, and the order of
    pages.
  - `debug-csv-record` asks for the debugger. Among 300 records, a quoted name with a comma moves the region of two of
    them. The hidden test checks the totals, every record, doubled quotes and empty fields.
  - `debug-ledger-async` is TypeScript and does not mention the debugger. `forEach(async ...)` returns before any entry
    is applied. Applying them all at once loses updates, so only applying them in order passes.
- **The reference runs use the tool.** The discount, menu and CSV references start a run, read a stop and stop the
  run. The bench's tests therefore prove the approval, the trust and the `used` check on the real Node.js debugger,
  on every platform.

### What building the tasks found in the debugger

- **"Stop on uncaught exceptions" lets an ES module's load error through.**
  - V8 counts an error thrown while an ES module loads as caught, because Node.js's module loader catches it in order
    to report it. A probe of V8 shows `uncaught: false` on that pause, with the same frames as an error the program
    catches itself. The two can only be told apart after the program goes on, so no setting can stop at that throw
    and only there.
  - The run still ends with the error and its stack printed. The agent's report of such a run now says so: "Start
    again with stopOn "all" to stop where it is thrown."
  - "Every exception" stops at the throw. TESTING says this for the person's Debug tab.
- **A stop showed only the innermost block's values.**
  - V8 lists a frame's scopes from the innermost out: a loop's block, then the function's own.
  - The report read only the first scope, so a stop in a loop showed the loop's variable alone.
  - It now reads the block scopes out to the function's own, or to the module's, as one list. An inner name hides an
    outer one, as it does in the program. The heading names the scopes, for example "Values (Block, Local, frame
    #0)".
  - Python, Go and LLVM's debuggers list "Locals" first, so their reports are as before.

## Consequences

- `pnpm bench run --tag debugger` measures the debugger on a model. A default run now has 22 tasks. Reports compare
  per task, so this does not upset comparisons with earlier runs.
- **What this does not measure.** Python, Go, C, C++ and Rust need their debuggers installed, so no task uses them.
  A model that solves a neutral task without the debugger still passes. The report's `Debug` calls say how often it
  reached for it.

## Verification

- `bench.test.ts`:
  - the four reference runs pass, and the projects as shipped fail their checks;
  - a debugging task has its start approved and a command declined;
  - the same script without the flag fails its `used` check;
  - task.json refuses a bad `debug` and a bad `used`.
- `debug-agent.test.ts`, against the real Node.js debugger: an ES module that throws as it loads ends with the advice
  under `uncaught`, and under `all` it stops at the throw with the block's and the function's values.
